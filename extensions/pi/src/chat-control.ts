import { LocalControl, type NativeSettingsSnapshot } from "@zerolux/bridge";

export interface LiveDescription {
  native_session_id: string;
  workspace: string;
  title: string;
  busy: boolean;
  paired: boolean;
  /** This pi accepts a link per workspace; a kernel may hire it while another holds a link. */
  multi_workspace?: boolean;
  /** The ZeroLux sessions whose links this pi holds now: a kernel relinks only a lost one. */
  links?: string[];
}
export interface PairRequest {
  base_url: string;
  token: string;
  executable: string;
  native_session_id: string;
  workspace: string;
  /** The ZeroLux workspace the kernel serves; a relink must come from the same one. */
  workspace_id?: string;
}
export interface TakeoverRequest {
  session_id: string;
  workspace_id: string;
  session_file: string;
  check?: boolean;
}
export interface ControlHost {
  describe(): LiveDescription;
  /** Every pi session on this machine, from the pi SDK: what ZeroLux may offer to hire. */
  sessions(): Promise<unknown[]>;
  pair(request: PairRequest): Promise<string>;
  stop(linkId: string): Promise<void>;
  update?(linkId: string, revision: string): Promise<{ pending: boolean }>;
  settings?(
    linkId: string | undefined,
    values: unknown,
    check: boolean,
  ): Promise<NativeSettingsSnapshot>;
  takeover?(request: TakeoverRequest): Promise<{ accepted: boolean }>;
  /** Stops the native turn in progress, whoever started it, for the owner of a link. */
  interrupt?(linkId: string): Promise<{ interrupted: boolean }>;
  /** The owner's own input for a link's session: native user input, not a chat message. */
  input?(linkId: string, text: string): Promise<void>;
  /**
   * Whose work the running turn is, across every link of this pi: the delivery of the one
   * chat feeding it and that link's ID, or no delivery. Asked by a host that routes pi's
   * questions, at the moment pi asks one.
   */
  turn?(): { delivery: string | null; link_id?: string; fingerprint?: string };
}

/** pi's local control: the kernel lists its sessions, pairs a link, and stops it. */
export class ChatControl extends LocalControl {
  constructor(registry: string, host: ControlHost) {
    super(
      registry,
      {
        describe: () => ({ ...host.describe() }),
        async handle(method, request) {
          if (method === "sessions") return { sessions: await host.sessions() };
          if (method === "settings" && host.settings) {
            if (
              (request.link_id !== undefined &&
                typeof request.link_id !== "string") ||
              (request.check !== undefined &&
                typeof request.check !== "boolean")
            )
              throw new Error("Invalid settings request");
            return {
              settings: await host.settings(
                request.link_id as string | undefined,
                request.values,
                request.check === true,
              ),
            };
          }
          if (method === "update" && host.update) {
            if (
              typeof request.link_id !== "string" ||
              !request.link_id ||
              typeof request.revision !== "string" ||
              !/^[a-f0-9]{64}$/.test(request.revision)
            )
              throw new Error("Invalid integration update request");
            return host.update(request.link_id, request.revision);
          }
          if (method === "turn")
            return { ...(host.turn?.() ?? { delivery: null }) };
          if (method === "input" && host.input) {
            if (
              typeof request.link_id !== "string" ||
              !request.link_id ||
              typeof request.text !== "string" ||
              !request.text.trim()
            )
              throw new Error("Invalid input request");
            await host.input(request.link_id, request.text);
            return {};
          }
          if (method === "interrupt" && host.interrupt) {
            if (typeof request.link_id !== "string" || !request.link_id)
              throw new Error("Invalid interrupt request");
            return host.interrupt(request.link_id);
          }
          if (method === "stop" && typeof request.link_id === "string") {
            await host.stop(request.link_id);
            return {};
          }
          if (method === "takeover" && host.takeover) {
            if (
              ["session_id", "workspace_id", "session_file"].some(
                (key) => typeof request[key] !== "string" || !request[key],
              ) ||
              (request.check !== undefined &&
                typeof request.check !== "boolean")
            )
              throw new Error("Incomplete takeover request");
            return host.takeover(request as unknown as TakeoverRequest);
          }
          if (method !== "pair") throw new Error("Unknown control operation");
          const fields = [
            "base_url",
            "token",
            "executable",
            "native_session_id",
            "workspace",
          ] as const;
          if (
            fields.some(
              (key) => typeof request[key] !== "string" || !request[key],
            )
          )
            throw new Error("Incomplete pairing request");
          return {
            link_id: await host.pair(request as unknown as PairRequest),
          };
        },
      },
      "pi",
    );
  }
}
