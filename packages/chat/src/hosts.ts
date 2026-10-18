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
  /** False while an added computer waits to join with its code. */
  joined: boolean;
  /** Connected to the kernel now. */
  online: boolean;
}

/** One of one's computers added to the workspace, and the code it joins with: once, within ten minutes. */
export interface HostLink {
  host: Host;
  code: string;
}

/** What joins a computer with its code, run there; `kernel` is the address it reaches the kernel at. */
export const joinCommand = (kernel: string, code: string) =>
  `zerolux host join ${kernel.replace(/\/+$/, "")} ${code}`;

/**
 * Whether a person may start sessions on the kernel's own computer: theirs, or open to them.
 * Until the hosts are known (or from a kernel without them), `fallback` says, as whether the
 * person is the workspace's owner.
 */
export const startsHere = (
  hosts: Host[] | undefined,
  me: string | undefined,
  fallback = false,
) =>
  hosts
    ? hosts.some((host) => host.here && (host.person_id === me || host.open))
    : fallback;

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
    /** Adds one of one's computers: its host, waiting to join with the code. */
    link: (name?: string) =>
      request<HostLink>(kernel, "/hosts/link", { name }).then(async (link) => {
        await reload();
        return link;
      }),
    /** Removes an added computer: its connection closes and its secret stops working. */
    remove: (id: string) =>
      request(
        kernel,
        `/hosts/${encodeURIComponent(id)}`,
        undefined,
        undefined,
        "DELETE",
      ).then(() => reload()),
  };
}

/**
 * The added computer as the kernel last said, read again every few seconds until it is online:
 * nothing tells when it joins and connects.
 */
export function useHostJoining(
  link: HostLink | undefined,
  hosts: Host[] | undefined,
  reload: () => Promise<unknown>,
) {
  const host = link && hosts?.find((h) => h.id === link.host.id);
  const online = Boolean(host?.online);
  useEffect(() => {
    if (!link || online) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [link, online, reload]);
  return host;
}
