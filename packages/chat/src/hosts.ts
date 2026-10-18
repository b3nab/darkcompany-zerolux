import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/**
 * A computer that runs the workspace's sessions, and the person it is: only they create and
 * see sessions there, unless they open it to the others, who then run their own sessions on it
 * with their own harness accounts. Hosts start closed. `here`: the kernel answering runs on it.
 */
export interface Host {
  id: string;
  name: string;
  person_id: string;
  open: boolean;
  created_at: number;
  seen_at: number;
  here: boolean;
}

/** Whether a person may start sessions on the kernel's own computer: theirs, or open to them. */
export const startsHere = (hosts: Host[] | undefined, me: string | undefined) =>
  Boolean(
    hosts?.some((host) => host.here && (host.person_id === me || host.open)),
  );

/** The workspace's hosts, and the changes their persons make, each answered with the list. */
export function useHosts(kernel = kernelUrl()) {
  const [read, setRead] = useState<{
    kernel: string;
    hosts?: Host[];
    error?: string;
  }>();
  const reload = useCallback(
    () =>
      request<{ hosts: Host[] }>(kernel, "/hosts").then(
        ({ hosts }) => setRead({ kernel, hosts }),
        (error: unknown) => setRead({ kernel, error: errorMessage(error) }),
      ),
    [kernel],
  );
  useEffect(() => void reload(), [reload]);
  const current = read?.kernel === kernel ? read : undefined;
  return {
    hosts: current?.hosts,
    error: current?.error ?? "",
    reload,
    /** Its name, or whom it is open to: only its person changes them. */
    change: (id: string, change: { name?: string; open?: boolean }) =>
      request(
        kernel,
        `/hosts/${encodeURIComponent(id)}`,
        change,
        undefined,
        "PATCH",
      ).then(() => reload()),
  };
}
