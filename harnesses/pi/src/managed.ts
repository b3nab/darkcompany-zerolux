import { realpath } from "node:fs/promises";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  controlRequest,
  nativeProcess,
  readControlDescriptor,
  type ControlDescriptor,
} from "@zerolux/bridge";
import { piResumeArgs } from "./launch-args.ts";

/** What this pi says of itself when it pairs: enough for ZeroLux to start it again. */
export interface NativeMetadata {
  pid: number;
  session_file?: string;
  agent_dir?: string;
  /** The native options its terminal started it with. */
  args?: string[];
  /** The host ZeroLux runs it under, when it does. */
  runner?: string;
}
/** The host ZeroLux runs this pi under. */
interface Host {
  descriptor: ControlDescriptor;
  path: string;
  /** The host routes pi's questions to the owner itself (asks `turn` here). */
  dialogs: boolean;
}
const key = Symbol.for("zerolux.pi.managed-host");
const globals = globalThis as typeof globalThis & { [key]?: Host };

/** The host this pi runs under, when ZeroLux started it: none in a terminal. */
export async function managedHost(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: ExtensionContext,
): Promise<Host | undefined> {
  const path = process.env.ZEROLUX_PI_RUNNER;
  if (!path) return undefined;
  const old = globals[key];
  if (old?.path === path) return old;
  try {
    const descriptor = await readControlDescriptor(path);
    const actual = await controlRequest(descriptor, "describe");
    // Released hosts wait for the extension to report the native state before accepting RPC.
    // New hosts read it from pi itself; they need no acknowledgement.
    if (actual.guard_version === 1 && actual.phase === "starting") {
      const file = ctx.sessionManager.getSessionFile();
      if (!file || !ctx.model) return undefined;
      await controlRequest(descriptor, "verify", {
        native_session_id: ctx.sessionManager.getSessionId(),
        workspace: await realpath(ctx.cwd),
        native_pid: nativeProcess().pid,
        session_file: await realpath(file),
        cli_version: VERSION,
        model: { provider: ctx.model.provider, id: ctx.model.id },
        thinking: pi.getThinkingLevel(),
        auth_configured: ctx.modelRegistry.hasConfiguredAuth(ctx.model),
      });
    }
    return (globals[key] = {
      descriptor,
      path,
      dialogs: actual.dialogs === 1,
    });
  } catch {
    // Its host is not there to ask: this pi goes on as one in a terminal does.
    return undefined;
  }
}

/** Where the host may ask this extension whose turn it is: its own control. */
export async function reportManagedLinks(
  host: Host | undefined,
  ids: string[],
  control?: string,
) {
  if (host)
    await controlRequest(host.descriptor, "links", {
      native_pid: nativeProcess().pid,
      link_ids: ids,
      ...(control ? { control } : {}),
    }).catch(() => {});
}

/** What ZeroLux needs to start this session again: its file, pi's folder, its options. */
export async function nativeMetadata(
  ctx: ExtensionContext,
  host?: Host,
): Promise<NativeMetadata> {
  const metadata: NativeMetadata = { pid: nativeProcess().pid };
  const named = ctx.sessionManager.getSessionFile?.();
  if (!named) return metadata;
  metadata.session_file = await realpath(named).catch(() => named);
  metadata.agent_dir = await realpath(getAgentDir()).catch(() => getAgentDir());
  if (host) metadata.runner = host.path;
  else metadata.args = piResumeArgs(process.argv.slice(2));
  return metadata;
}
