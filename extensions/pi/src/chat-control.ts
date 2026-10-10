import { LocalControl } from "@zerolux/bridge";

export interface LiveDescription {
  native_session_id: string;
  workspace: string;
  title: string;
  busy: boolean;
  paired: boolean;
  /** This pi accepts a link per workspace; a kernel may hire it while another holds a link. */
  multi_workspace?: boolean;
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
  takeover?(request: TakeoverRequest): Promise<{ accepted: boolean }>;
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
          if (method === "turn")
            return { ...(host.turn?.() ?? { delivery: null }) };
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
