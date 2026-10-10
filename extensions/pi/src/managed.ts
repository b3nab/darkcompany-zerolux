import { realpath } from "node:fs/promises";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  controlRequest,
  readControlDescriptor,
  type ControlDescriptor,
} from "@zerolux/bridge";
import {
  piResumeArgs,
  savePiProfile,
  type PiExecutionProfile,
} from "./execution-profile.ts";

export interface NativeMetadata {
  pid: number;
  session_file?: string;
  profile?: string;
  agent_dir?: string;
  runner?: string;
}
interface Proof {
  descriptor: ControlDescriptor;
  native: string;
  file: string;
  workspace: string;
  path: string;
  /** The host routes pi's yes/no questions to the owner itself (asks `turn` here). */
  dialogs: boolean;
}
const key = Symbol.for("zerolux.pi.managed-proof");
const globals = globalThis as typeof globalThis & { [key]?: Proof };

/** Runs before ZeroLux's wake hook. No credential resolution or model request. */
export async function verifyManaged(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<Proof | undefined> {
  const path = process.env.ZEROLUX_PI_RUNNER;
  if (!path) return undefined;
  const file = await realpath(ctx.sessionManager.getSessionFile()!);
  const workspace = await realpath(ctx.cwd);
  const native = ctx.sessionManager.getSessionId();
  const old = globals[key];
  if (
    old &&
    old.path === path &&
    old.native === native &&
    old.file === file &&
    old.workspace === workspace
  )
    return old;
  const descriptor = await readControlDescriptor(path);
  const actual = await controlRequest(descriptor, "describe");
  const model = actual.model as { provider?: string; id?: string } | undefined;
  if (
    ctx.mode !== "rpc" ||
    descriptor.pid !== process.ppid ||
    actual.kind !== "pi-runner" ||
    actual.native_pid !== process.pid ||
    actual.native_session_id !== native ||
    actual.workspace !== workspace ||
    actual.session_file !== file ||
    actual.cli_version !== VERSION ||
    (actual.creating !== true &&
      (model?.provider !== ctx.model?.provider ||
        model?.id !== ctx.model?.id ||
        actual.thinking !== pi.getThinkingLevel())) ||
    !ctx.model ||
    !ctx.modelRegistry.hasConfiguredAuth(ctx.model)
  )
    throw new Error(
      "Native pi startup did not preserve its entrusted identity, profile or configured authentication",
    );
  // Existing hosts can outlive an application update; their original guard stays valid.
  if (actual.guard_version === 1)
    await controlRequest(descriptor, "verify", {
      native_pid: process.pid,
      session_file: file,
      cli_version: VERSION,
      model: { provider: ctx.model.provider, id: ctx.model.id },
      thinking: pi.getThinkingLevel(),
      auth_configured: true,
    });
  const proof = {
    descriptor,
    native,
    file,
    workspace,
    path,
    dialogs: actual.dialogs === 1,
  };
  globals[key] = proof;
  return proof;
}

export async function canPairManaged(proof: Proof | undefined) {
  if (!proof) return;
  const state = await controlRequest(proof.descriptor, "describe");
  if (state.phase !== "running" || state.native_pid !== process.pid)
    throw new Error("The pi execution host has not confirmed startup");
}
/**
 * The links this pi holds, and where the host may ask this extension about them (its own
 * control descriptor): a host routing pi's questions asks `turn` there at that moment.
 */
export async function reportManagedLinks(
  proof: Proof | undefined,
  ids: string[],
  control?: string,
) {
  if (proof)
    await controlRequest(proof.descriptor, "links", {
      native_pid: process.pid,
      link_ids: ids,
      ...(control ? { control } : {}),
    });
}

/** Persist terminal launch intent on its native host, not in the kernel or chat. */
export async function nativeMetadata(
  ctx: ExtensionContext,
  proof?: Proof,
): Promise<NativeMetadata> {
  const metadata: NativeMetadata = { pid: process.pid };
  const named = ctx.sessionManager.getSessionFile?.();
  if (!named) return metadata;
  try {
    const file = await realpath(named);
    const workspace = await realpath(ctx.cwd);
    const agentDir = await realpath(getAgentDir());
    metadata.session_file = file;
    metadata.agent_dir = agentDir;
    if (proof) {
      // The host clears its pre-exec pending marker only after get_state verifies startup.
      metadata.profile = proof.descriptor.profile as string;
      metadata.runner = proof.path;
      return metadata;
    }
    const profile: PiExecutionProfile = {
      version: 1,
      nativeSessionId: ctx.sessionManager.getSessionId(),
      file,
      workspace,
      agentDir,
      cliVersion: VERSION,
      lastPid: process.pid,
      args: [],
    };
    try {
      profile.args = piResumeArgs(process.argv.slice(2));
    } catch (error) {
      profile.unavailable =
        error instanceof Error
          ? error.message
          : "Native launch options could not be captured";
    }
    if (process.env.PI_CODING_AGENT_SESSION_DIR)
      profile.sessionDir = await realpath(
        process.env.PI_CODING_AGENT_SESSION_DIR,
      );
    if (process.env.PI_OFFLINE !== undefined)
      profile.offline = process.env.PI_OFFLINE;
    metadata.profile = await savePiProfile(profile);
  } catch {
    // A native terminal remains usable. Missing continuity evidence never authorizes a cold start.
  }
  return metadata;
}
