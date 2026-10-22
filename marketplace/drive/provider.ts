/**
 * Storage's provider for Google Drive, over Drive's REST API: each location is a folder of a
 * Drive (all of My Drive, a folder, or a shared drive), shown as Drive holds it, with the files
 * shared with the person too when they are in it. Paths are names, as in Drive; Google's own
 * documents are read exported to Office formats. Deleting puts a file in Drive's trash. What
 * each operation does, with any `fetch` and any token.
 */
import { join } from "node:path";

export const API = "https://www.googleapis.com/drive/v3";
export const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER = "application/vnd.google-apps.folder";
const ALL = "supportsAllDrives=true";

/** What Google's own documents are read as. */
export const EXPORTS: Record<string, { type: string; extension: string }> = {
  "application/vnd.google-apps.document": {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  "application/vnd.google-apps.presentation": {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
  "application/vnd.google-apps.drawing": {
    type: "application/pdf",
    extension: "pdf",
  },
  "application/vnd.google-apps.script": {
    type: "application/vnd.google-apps.script+json",
    extension: "json",
  },
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface Entry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  modified?: number;
  content_type?: string;
  id: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
}

const FIELDS = "id,name,mimeType,size,modifiedTime,parents";

/** A folder's ID from its address, or the ID itself; all of My Drive when empty. */
export function folderId(given: string) {
  const text = given.trim();
  if (!text) return "root";
  const found =
    text.match(/folders\/([A-Za-z0-9_-]+)/) ??
    text.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const id = found?.[1] ?? text;
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error("Give a Drive folder's address or ID");
  return id;
}

/**
 * Where Google sends the person back: the kernel's address as their device reached it. Google
 * takes only this computer's own addresses, or HTTPS.
 */
export function returnTo(origin: string | undefined) {
  if (!origin) return undefined;
  const address = new URL(origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
  if (address.protocol === "https:" || local) return origin;
  throw new Error(
    "Google signs in only on the computer ZeroLux runs on, or over HTTPS",
  );
}
/** A path within a location: `a/b`, never leaving it. */
export function clean(path: string) {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === ".."))
    throw new Error("Invalid path");
  return parts.join("/");
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));
const join2 = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;
/** A name in a Drive query. */
const quoted = (text: string) =>
  `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function ok(response: Response, what: string) {
  if (response.ok) return response;
  let reason = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    reason = body.error?.message ? `: ${body.error.message}` : "";
  } catch {
    // No reason given.
  }
  throw new Error(`Google Drive did not ${what} (${response.status})${reason}`);
}

const entry = (file: DriveFile, path: string): Entry =>
  file.mimeType === FOLDER
    ? {
        name: file.name,
        path,
        kind: "folder",
        id: file.id,
        modified: Date.parse(file.modifiedTime ?? "") || undefined,
      }
    : {
        name: file.name,
        path,
        kind: "file",
        id: file.id,
        size: file.size === undefined ? undefined : Number(file.size),
        modified: Date.parse(file.modifiedTime ?? "") || undefined,
        content_type: EXPORTS[file.mimeType]?.type ?? file.mimeType,
      };

/** One location's Drive: its root folder, and how it is reached. */
export function drive(
  root: string,
  token: () => Promise<string>,
  folder: () => string,
  call: Fetch = fetch,
) {
  // Where each path was found, while this process runs.
  const known = new Map<string, string>([["", root]]);
  const headers = async (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${await token()}`,
    ...extra,
  });
  const get = async <T>(url: string, what: string) =>
    (await (
      await ok(await call(url, { headers: await headers() }), what)
    ).json()) as T;
  const send = async <T>(
    url: string,
    method: string,
    body: unknown,
    what: string,
  ) =>
    (await (
      await ok(
        await call(url, {
          method,
          headers: await headers({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        }),
        what,
      )
    ).json()) as T;

  const children = async (id: string) => {
    const files: DriveFile[] = [];
    let page: string | undefined;
    do {
      const query = encodeURIComponent(
        `${quoted(id)} in parents and trashed = false`,
      );
      const found = await get<{ files: DriveFile[]; nextPageToken?: string }>(
        `${API}/files?q=${query}&fields=nextPageToken,files(${FIELDS})&pageSize=1000&${ALL}&includeItemsFromAllDrives=true${page ? `&pageToken=${page}` : ""}`,
        "list the folder",
      );
      files.push(...found.files);
      page = found.nextPageToken;
    } while (page);
    return files;
  };
  const child = async (parent: string, name: string) => {
    const query = encodeURIComponent(
      `name = ${quoted(name)} and ${quoted(parent)} in parents and trashed = false`,
    );
    const found = await get<{ files: DriveFile[] }>(
      `${API}/files?q=${query}&fields=files(${FIELDS})&pageSize=10&${ALL}&includeItemsFromAllDrives=true`,
      "find the file",
    );
    // Drive allows two of one name: the folder first, then the oldest listed.
    return (
      found.files.find((file) => file.mimeType === FOLDER) ?? found.files[0]
    );
  };
  /** A path's file, walking down from the location's folder. */
  const find = async (path: string): Promise<DriveFile | undefined> => {
    path = clean(path);
    if (!path) return { id: root, name: "", mimeType: FOLDER };
    let parent = known.get(parentOf(path));
    if (!parent) {
      const above = await find(parentOf(path));
      if (!above || above.mimeType !== FOLDER) return undefined;
      parent = above.id;
    }
    const file = await child(parent, leaf(path));
    if (file) known.set(path, file.id);
    else known.delete(path);
    return file;
  };
  const must = async (path: string) => {
    const file = await find(path);
    if (!file) throw new Error(`\`${clean(path)}\` is not there`);
    return file;
  };
  const forget = (path: string) => {
    for (const kept of [...known.keys()])
      if (kept === path || kept.startsWith(`${path}/`)) known.delete(kept);
  };
  const folderAt = async (path: string) => {
    const file = await must(path);
    if (file.mimeType !== FOLDER)
      throw new Error(`\`${path}\` is not a folder`);
    return file.id;
  };
  /** Sends a file's bytes, to a new file or over an existing one, resumably. */
  const upload = async (
    from: string,
    target: { id?: string; name?: string; parent?: string },
  ) => {
    const started = await ok(
      await call(
        target.id
          ? `${UPLOAD}/files/${target.id}?uploadType=resumable&${ALL}`
          : `${UPLOAD}/files?uploadType=resumable&${ALL}`,
        {
          method: target.id ? "PATCH" : "POST",
          headers: await headers({ "content-type": "application/json" }),
          body: JSON.stringify(
            target.id ? {} : { name: target.name, parents: [target.parent] },
          ),
        },
      ),
      "take the file",
    );
    const session = started.headers.get("location");
    if (!session) throw new Error("Google Drive gave no address for the file");
    const file = Bun.file(from);
    return (await (
      await ok(
        await call(
          `${session}${session.includes("?") ? "&" : "?"}fields=${FIELDS}`,
          {
            method: "PUT",
            headers: { "content-length": String(file.size) },
            body: file,
          },
        ),
        "keep the file",
      )
    ).json()) as DriveFile;
  };
  /** Copies a file, or a folder with what it holds, under a parent. */
  const copy = async (
    file: DriveFile,
    parent: string,
    name: string,
  ): Promise<DriveFile> => {
    if (file.mimeType !== FOLDER)
      return send<DriveFile>(
        `${API}/files/${file.id}/copy?fields=${FIELDS}&${ALL}`,
        "POST",
        { name, parents: [parent] },
        "copy the file",
      );
    const made = await send<DriveFile>(
      `${API}/files?fields=${FIELDS}&${ALL}`,
      "POST",
      { name, mimeType: FOLDER, parents: [parent] },
      "make the folder",
    );
    for (const inner of await children(file.id))
      await copy(inner, made.id, inner.name);
    return made;
  };

  return {
    check: async () => {
      const about = await get<{ user?: { emailAddress?: string } }>(
        `${API}/about?fields=user(emailAddress)`,
        "say who is signed in",
      );
      await folderAt("");
      return { account: about.user?.emailAddress ?? null };
    },
    list: async (path: string) => {
      path = clean(path);
      const id = await folderAt(path);
      const files = await children(id);
      for (const file of files) known.set(join2(path, file.name), file.id);
      return {
        entries: files
          .map((file) => entry(file, join2(path, file.name)))
          .sort(
            (a, b) =>
              Number(a.kind !== "folder") - Number(b.kind !== "folder") ||
              a.name.localeCompare(b.name),
          ),
      };
    },
    stat: async (path: string) => entry(await must(path), clean(path)),
    /** A copy in the extension's folder, which the kernel removes once sent. */
    read: async (path: string) => {
      const file = await must(path);
      if (file.mimeType === FOLDER) throw new Error(`\`${path}\` is a folder`);
      const exported = EXPORTS[file.mimeType];
      if (!exported && file.mimeType.startsWith("application/vnd.google-apps."))
        throw new Error(`${file.name} cannot be read outside Google Drive`);
      const response = await ok(
        await call(
          exported
            ? `${API}/files/${file.id}/export?mimeType=${encodeURIComponent(exported.type)}`
            : `${API}/files/${file.id}?alt=media&${ALL}`,
          { headers: await headers() },
        ),
        "give the file",
      );
      const local = join(folder(), `.read-${crypto.randomUUID()}`);
      await Bun.write(local, response);
      return {
        path: local,
        temporary: true,
        content_type: exported?.type ?? file.mimeType,
        name: exported ? `${file.name}.${exported.extension}` : file.name,
      };
    },
    write: async (path: string, from: string) => {
      path = clean(path);
      if (!path) throw new Error("Name the file");
      const existing = await find(path);
      if (existing?.mimeType === FOLDER)
        throw new Error(`\`${path}\` is a folder`);
      const written = existing
        ? await upload(from, { id: existing.id })
        : await upload(from, {
            name: leaf(path),
            parent: await folderAt(parentOf(path)),
          });
      known.set(path, written.id);
      return entry(written, path);
    },
    mkdir: async (path: string) => {
      path = clean(path);
      let parent = root;
      let walked = "";
      let made: DriveFile = { id: root, name: "", mimeType: FOLDER };
      for (const name of path.split("/").filter(Boolean)) {
        walked = join2(walked, name);
        made =
          (await find(walked)) ??
          (await send<DriveFile>(
            `${API}/files?fields=${FIELDS}&${ALL}`,
            "POST",
            { name, mimeType: FOLDER, parents: [parent] },
            "make the folder",
          ));
        if (made.mimeType !== FOLDER)
          throw new Error(`\`${walked}\` is a file`);
        known.set(walked, made.id);
        parent = made.id;
      }
      return entry(made, path);
    },
    move: async (from: string, to: string) => {
      from = clean(from);
      to = clean(to);
      if (await find(to)) throw new Error(`\`${to}\` is already there`);
      const file = await must(from);
      const before = await folderAt(parentOf(from));
      const after = await folderAt(parentOf(to));
      const moves =
        before === after ? "" : `&addParents=${after}&removeParents=${before}`;
      const moved = await send<DriveFile>(
        `${API}/files/${file.id}?fields=${FIELDS}&${ALL}${moves}`,
        "PATCH",
        { name: leaf(to) },
        "move the file",
      );
      forget(from);
      known.set(to, moved.id);
      return entry(moved, to);
    },
    copy: async (from: string, to: string) => {
      to = clean(to);
      if (await find(to)) throw new Error(`\`${to}\` is already there`);
      const copied = await copy(
        await must(from),
        await folderAt(parentOf(to)),
        leaf(to),
      );
      known.set(to, copied.id);
      return entry(copied, to);
    },
    /** Into Drive's trash, where it can be restored. */
    delete: async (path: string) => {
      path = clean(path);
      if (!path) throw new Error("The location itself is not deleted");
      const file = await must(path);
      await send(
        `${API}/files/${file.id}?${ALL}`,
        "PATCH",
        { trashed: true },
        "delete the file",
      );
      forget(path);
      return {};
    },
    /** Names that hold the words, within the location: up to 50. */
    search: async (query: string) => {
      const words = query.trim();
      if (!words) return { entries: [] };
      const q = encodeURIComponent(
        `name contains ${quoted(words)} and trashed = false`,
      );
      const found = await get<{ files: DriveFile[] }>(
        `${API}/files?q=${q}&fields=files(${FIELDS})&pageSize=100&${ALL}&includeItemsFromAllDrives=true&corpora=allDrives`,
        "search",
      );
      // Each one's path, up to the location's folder; those outside it are left out.
      const top =
        root === "root"
          ? (
              await get<DriveFile>(
                `${API}/files/root?fields=id`,
                "find My Drive",
              )
            ).id
          : root;
      const names = new Map<string, { name: string; parents?: string[] }>();
      const pathOf = async (
        file: { id: string; name: string; parents?: string[] },
        depth = 0,
      ): Promise<string | undefined> => {
        if (file.id === top) return "";
        const parent = file.parents?.[0];
        if (!parent || depth > 30) return undefined;
        let above = names.get(parent);
        if (!above) {
          if (parent === top) return file.name;
          try {
            above = await get<DriveFile>(
              `${API}/files/${parent}?fields=id,name,parents&${ALL}`,
              "find the folder",
            );
          } catch {
            return undefined;
          }
          names.set(parent, above);
        }
        const upper = await pathOf({ id: parent, ...above }, depth + 1);
        return upper === undefined ? undefined : join2(upper, file.name);
      };
      const entries: Entry[] = [];
      for (const file of found.files) {
        const path = await pathOf(file);
        if (path) entries.push(entry(file, path));
        if (entries.length >= 50) break;
      }
      return { entries };
    },
  };
}
