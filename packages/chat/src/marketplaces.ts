import { useEffect } from "react";
import { ApiError, kernelUrl, request } from "./client";
import { kernelOrigin } from "./credentials";
import { extensionsNotice } from "./extensions";
import { sharedRead, useSharedRead } from "./shared-read";

/**
 * A marketplace every workspace of the instance installs from: this computer's own
 * (`computer`, which stays, with no name or date) or one the instance added.
 */
export interface InstanceMarketplace {
  url: string;
  name: string | null;
  added_at: number | null;
  computer: boolean;
}
interface Marketplaces {
  marketplaces: InstanceMarketplace[];
  /** The account adds and removes them: it administers the instance. */
  administers: boolean;
}

/** The instance's marketplaces, at the kernel's root; null from a kernel without them. */
const readMarketplaces = (kernel: string) =>
  request<Marketplaces>(kernel, "/marketplaces").catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });

/**
 * The marketplaces of the instance a kernel address belongs to, and whether the account may
 * change them; `marketplaces` is null for a kernel without them.
 */
export function useMarketplaces(kernel = kernelUrl(), enabled = true) {
  const origin = kernelOrigin(kernel);
  const { read, reload } = useSharedRead(readMarketplaces, origin, enabled);
  useEffect(() => {
    if (enabled) void sharedRead(readMarketplaces, origin, true);
  }, [origin, enabled]);
  return {
    marketplaces:
      read?.items === undefined
        ? undefined
        : (read.items?.marketplaces ?? null),
    administers: read?.items?.administers ?? false,
    error: read?.error ?? "",
    reload,
  };
}

/** Its list and every workspace's catalog, read again: they changed. */
async function changed(origin: string) {
  extensionsNotice();
  await sharedRead(readMarketplaces, origin);
}

/** Adds a marketplace for the whole instance, by its address: `https://`, or `file://` on the kernel's computer. */
export async function addMarketplace(kernel: string, url: string) {
  const origin = kernelOrigin(kernel);
  const { marketplace } = await request<{ marketplace: InstanceMarketplace }>(
    origin,
    "/marketplaces",
    { url: url.trim() },
  );
  await changed(origin);
  return marketplace;
}

/** Removes a marketplace the instance added; what was installed from it stays. */
export async function removeMarketplace(kernel: string, url: string) {
  const origin = kernelOrigin(kernel);
  await request(origin, "/marketplaces", { url }, undefined, "DELETE");
  await changed(origin);
}
