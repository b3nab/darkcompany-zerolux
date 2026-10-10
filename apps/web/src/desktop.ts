/** Optional desktop context. No native API or other workspace's configuration is exposed. */
declare global {
  interface Window {
    zeroluxDesktop?: Readonly<{
      profileId: string;
      workspaceId: string;
      managed?: boolean;
      kernelUrl?: string;
      platform?: "macos" | "windows" | "linux";
    }>;
    zeroluxWorkspaceState?: () => {
      canLeave: boolean;
      drafts: Record<string, string>;
    };
    zeroluxRestoredDrafts?: Record<string, string>;
  }
}

export function desktopConnection() {
  return typeof window !== "undefined" ? window.zeroluxDesktop : undefined;
}
