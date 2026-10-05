import { LocalControl } from "@zerolux/bridge";

export interface LiveDescription {
  native_session_id: string;
  workspace: string;
  title: string;
  busy: boolean;
  paired: boolean;
}
export interface PairRequest {
  base_url: string;
  token: string;
  executable: string;
  native_session_id: string;
  workspace: string;
}
export interface ControlHost {
  describe(): LiveDescription;
  /** Every pi session on this machine, from the pi SDK: what ZeroLux may offer to hire. */
  sessions(): Promise<unknown[]>;
  pair(request: PairRequest): Promise<string>;
  stop(linkId: string): Promise<void>;
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
          if (method === "stop" && typeof request.link_id === "string") {
            await host.stop(request.link_id);
            return {};
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
