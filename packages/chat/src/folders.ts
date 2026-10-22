import { kernelUrl, request } from "./client";

/** A folder of the kernel's computer and the folders in it, for its person to choose one. */
export interface FolderListing {
  path: string;
  name: string;
  /** Null at the top of the disk. */
  parent: string | null;
  home: string | null;
  folders: { name: string; path: string; hidden: boolean }[];
  /** More than one listing gives: the first ones by name. */
  truncated: boolean;
}

/** The folders inside `path` on the kernel's computer, or inside its home without one. */
export const readFolders = (path?: string, kernel = kernelUrl()) =>
  request<FolderListing>(
    kernel,
    path ? `/folders?path=${encodeURIComponent(path)}` : "/folders",
  );
