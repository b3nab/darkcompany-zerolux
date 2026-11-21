import { useEffect, useState } from "react";
import { kernelId, probeKernel } from "@zerolux/chat";
import Discovery from "../modules/zerolux-discovery";
import type { Announced } from "../modules/zerolux-discovery";

/** A kernel on this phone's network, checked: its address answers as the instance it announces. */
export interface NetworkKernel {
  id: string;
  name: string;
  /** The computer it runs on, as it announces itself. */
  computer: string;
  /** Its address, as Connect takes it. */
  address: string;
}

async function verify(found: Announced): Promise<NetworkKernel | undefined> {
  const scheme = found.txt.scheme === "https" ? "https" : "http";
  const address = `${scheme}://${found.address}:${found.port}`;
  try {
    if (kernelId(await probeKernel(address)) !== found.txt.id) return undefined;
  } catch {
    return undefined;
  }
  return {
    id: found.txt.id!,
    name: found.txt.name || found.service,
    computer: found.service,
    address,
  };
}

/**
 * The kernels on this phone's network, found as they announce themselves and kept while their
 * address answers as the same instance; and how the search goes: `denied` when the person
 * refused the local network.
 */
export function useNetworkKernels(enabled = true) {
  const [kernels, setKernels] = useState<Record<string, NetworkKernel>>({});
  const [state, setState] = useState<
    "searching" | "ready" | "denied" | "failed"
  >("searching");
  useEffect(() => {
    if (!enabled) return;
    const listening = [
      Discovery.addListener("found", (found) => {
        void verify(found).then(
          (kernel) =>
            kernel &&
            setKernels((all) => ({ ...all, [found.service]: kernel })),
        );
      }),
      Discovery.addListener("lost", ({ service }) =>
        setKernels(({ [service]: _, ...rest }) => rest),
      ),
      Discovery.addListener("state", (event) => setState(event.state)),
    ];
    Discovery.start();
    return () => {
      Discovery.stop();
      listening.forEach((subscription) => subscription.remove());
    };
  }, [enabled]);
  return { kernels: Object.values(kernels), state };
}
