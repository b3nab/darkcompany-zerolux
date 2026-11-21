import { NativeModule, requireNativeModule } from "expo";

/** A kernel announcing itself on the local network, where a connection to it can go. */
export interface Announced {
  /** The name it announces: its computer's. */
  service: string;
  /** Its TXT record: `id`, `name`, `version`, `api` and `scheme`. */
  txt: Record<string, string>;
  /** As a URL takes it: IPv4, or IPv6 in brackets. */
  address: string;
  port: number;
}

type Events = {
  found(kernel: Announced): void;
  lost(event: { service: string }): void;
  /** `denied`: the person refused the local network, so nothing can be found until allowed. */
  state(event: { state: "ready" | "denied" | "failed" }): void;
};

declare class ZeroluxDiscovery extends NativeModule<Events> {
  start(): void;
  stop(): void;
}

/** Finds ZeroLux kernels on the local network: Bonjour on iOS, Android's own discovery there. */
export default requireNativeModule<ZeroluxDiscovery>("ZeroluxDiscovery");
