import { useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/** A file in the company's storage, uploaded by a person or written by an agent. */
export interface StoredFile {
  id: string;
  name: string;
  /** The folder it sits in; empty at the top. */
  folder: string;
  size: number;
  content_type: string;
  created_by: string;
  updated_at: number;
  /** The chat it was shared in, if any. */
  conversation_id: string | null;
}

// TODO: kernel: storage, announced as the "storage-v1" capability. `GET /storage/files` lists
// the files; `POST /storage/files?name=&folder=&conversation_id=` stores the request body as a
// new file by the caller and answers it; `GET /storage/files/{id}/content` serves it with its
// type; a `storage.changed` event tells clients to list again.

/** Where a file's content is served, to open or download it. */
export const fileUrl = (file: StoredFile, kernel = kernelUrl()) =>
  `${kernel}/api/storage/files/${encodeURIComponent(file.id)}/content`;

/** The company's files; a kernel without storage leaves the list empty. */
export function useStorage(enabled: boolean, kernel = kernelUrl()) {
  // Bound for its whole life, as a chat is: files never go to another kernel.
  const [server] = useState(kernel);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState("");
  const list = async () =>
    setFiles(
      (await request<{ files: StoredFile[] }>(server, "/storage/files")).files,
    );
  const report = (work: Promise<unknown>) =>
    work.then(
      () => setError(""),
      (e: unknown) => setError(errorMessage(e)),
    );
  useEffect(() => {
    if (enabled) void report(list());
    // `list` only uses state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return {
    /** The kernel has storage: files can be listed and uploaded. */
    available: enabled,
    files,
    error,
    /** Stores files as their uploader, in a folder or in a chat, then lists again. */
    upload: (
      // A browser's File, or any named Blob (a phone reads its files into Blobs).
      uploads: (Blob & { name: string })[],
      place: { folder?: string; conversation_id?: string } = {},
    ) =>
      report(
        (async () => {
          for (const file of uploads) {
            const query = new URLSearchParams({ name: file.name });
            if (place.folder) query.set("folder", place.folder);
            if (place.conversation_id)
              query.set("conversation_id", place.conversation_id);
            await request(server, `/storage/files?${query}`, file);
          }
          await list();
        })(),
      ),
  };
}
export type Storage = ReturnType<typeof useStorage>;

/** What kind of file it is, for its icon. */
export type FileKind =
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "sheet"
  | "code"
  | "text"
  | "file";
export function fileKind(file: StoredFile): FileKind {
  const [type, subtype = ""] = file.content_type.split("/");
  if (type === "image" || type === "audio" || type === "video") return type;
  if (/zip|tar|gzip|compressed/.test(subtype)) return "archive";
  if (/csv|spreadsheet|excel/.test(subtype)) return "sheet";
  if (/json|javascript|typescript|rust|python|xml|x-sh/.test(subtype))
    return "code";
  if (type === "text" || /pdf|markdown|document|msword/.test(subtype))
    return "text";
  return "file";
}
export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
