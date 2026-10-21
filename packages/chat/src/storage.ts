import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request, requestFile } from "./client";
import { listenUi } from "./extension-ui";
import { runAction, useExtensions } from "./extensions";

/** The extension that keeps the workspace's files. */
export const STORAGE = "zerolux.storage";

/** A file Storage keeps, uploaded by a person or written by an agent. */
export interface StoredFile {
  id: string;
  name: string;
  /** The folder it sits in; empty at the top. */
  folder: string;
  size: number;
  content_type: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** The chat it is shared in, if any. */
  conversation_id: string | null;
}

/** A file a message links to, by its id and the name the link gives it. */
export interface FileLink {
  id: string;
  name: string;
}

const input = (value: Record<string, unknown>) =>
  encodeURIComponent(JSON.stringify(value));

// Every list of shared files on screen, read again as soon as files are sent from here.
const readers = new Set<() => void>();

/** Files sent to Storage, in a folder or shared in a chat: the files as it keeps them. */
export async function uploadFiles(
  // A browser's File, or any named Blob (a phone reads its files into Blobs).
  files: (Blob & { name: string })[],
  place: { folder?: string; conversation_id?: string } = {},
  kernel = kernelUrl(),
) {
  const kept: StoredFile[] = [];
  for (const file of files)
    kept.push(
      (
        await request<{ result: StoredFile }>(
          kernel,
          `/ext/${STORAGE}/upload/file?input=${input(place)}&name=${encodeURIComponent(file.name)}`,
          file,
        )
      ).result,
    );
  readers.forEach((read) => read());
  return kept;
}

/**
 * Whether Storage is enabled and running, and files sent through it: a failure throws, and
 * stays in `error`.
 */
export function useStorage(kernel = kernelUrl()) {
  const { extensions } = useExtensions(kernel);
  const available = Boolean(
    extensions?.some((e) => e.id === STORAGE && e.enabled && e.running),
  );
  const [error, setError] = useState("");
  const upload = useCallback(
    async (
      files: (Blob & { name: string })[],
      place: { folder?: string; conversation_id?: string } = {},
    ) => {
      setError("");
      try {
        return await uploadFiles(files, place, kernel);
      } catch (e) {
        setError(errorMessage(e));
        throw e;
      }
    },
    [kernel],
  );
  return { available, upload, error };
}
export type Storage = ReturnType<typeof useStorage>;

/** A file as a message links to it: `[name](zerolux:file/<id>)`. */
export const fileLink = (file: FileLink) =>
  `[${file.name.replace(/[[\]]/g, "")}](zerolux:file/${file.id})`;

/** A message's text with the files it shares linked below it. */
export const withFiles = (text: string, files: FileLink[]) =>
  [text.trim(), ...files.map(fileLink)].filter(Boolean).join("\n");

const LINK = /\[([^\]]*)\]\(zerolux:file\/([^)\s]+)\)/g;

/**
 * The files a message links to, and its text without the links that stand alone on a line;
 * a link inside a sentence stays there as its name.
 */
export function linkedFiles(text: string) {
  const files: FileLink[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const found = [...line.matchAll(LINK)];
    for (const [, name = "", id = ""] of found) files.push({ id, name });
    if (found.length && !line.replace(LINK, "").trim()) continue;
    kept.push(line.replace(LINK, "$1"));
  }
  return { text: kept.join("\n").trim(), files };
}

/**
 * The files shared in a chat, by id, for what a link to one shows: read again when Storage
 * says they changed, and when its notices may have been missed.
 */
export function useSharedFiles(
  conversation_id: string | undefined,
  kernel = kernelUrl(),
) {
  const { available } = useStorage(kernel);
  const [files, setFiles] = useState<Map<string, StoredFile>>(new Map());
  useEffect(() => {
    if (!available || !conversation_id) return setFiles(new Map());
    let shown = true;
    const read = () =>
      void runAction(STORAGE, "files", { conversation_id }, kernel).then(
        (result) =>
          shown &&
          setFiles(
            new Map(
              ((result as { files?: StoredFile[] }).files ?? []).map((f) => [
                f.id,
                f,
              ]),
            ),
          ),
        () => undefined,
      );
    read();
    readers.add(read);
    const stop = listenUi((notice) => {
      if (
        notice.type === "resync" ||
        (notice.type === "extension.event" &&
          notice.event === `${STORAGE}/changed`)
      )
        read();
    });
    return () => {
      shown = false;
      readers.delete(read);
      stop();
    };
  }, [available, conversation_id, kernel]);
  return files;
}

/** A file's bytes from Storage, with its name. */
export const downloadFile = (id: string, kernel = kernelUrl()) =>
  requestFile(kernel, `/ext/${STORAGE}/download?input=${input({ id })}`);

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
export function fileKind(file: Pick<StoredFile, "content_type">): FileKind {
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
