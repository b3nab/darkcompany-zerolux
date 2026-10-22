/** A location: a provider with its configuration and account, as Storage shows it. */
export interface Location {
  id: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  capabilities: string[];
  /** Where chat attachments go. */
  default: boolean;
  /** ZeroLux's own, which stays. */
  own?: boolean;
  /** Whether its provider is installed and enabled. */
  available: boolean;
  /** False until the person signs in, for a provider that asks it. */
  signed_in?: boolean;
  account?: string | null;
  /** What went wrong with it last. */
  error?: string | null;
}

/** A field a provider asks for, to add a location of it. */
export interface Field {
  key: string;
  label: string;
  /** `folder` is a folder on the kernel's computer, chosen by browsing it. */
  type: "text" | "secret" | "choice" | "boolean" | "folder";
  required?: boolean;
  description?: string;
  options?: { value: string; label: string }[];
}

/** A provider: Storage's own folder, or another extension's service. */
export interface Provider {
  provider: string;
  extension: string;
  title: string;
  description?: string;
  fields?: Field[];
  sign_in?: boolean;
  capabilities?: string[];
  error?: string;
}

/** A file or a folder of a location, as its service holds it. */
export interface Entry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  modified?: number;
  content_type?: string;
  /** In search results, the location it is in. */
  location?: string;
}

/** A file shared in a chat, as chats show it. */
export interface StoredFile {
  id: string;
  name: string;
  size: number;
  content_type: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  conversation_id: string | null;
  location: string;
  path: string;
}

/** A size as people read it. */
export function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** When, as a date: the time today, the day this year, the full date before. */
export function when(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The Lucide icon for a file, by its kind. */
export function fileIcon(file: { kind?: string; content_type?: string }) {
  if (file.kind === "folder") return "folder";
  const type = file.content_type ?? "";
  if (type.startsWith("image/")) return "file-image";
  if (type.startsWith("video/")) return "file-video";
  if (type.startsWith("audio/")) return "file-audio";
  if (type === "application/pdf" || type.startsWith("text/"))
    return "file-text";
  if (/zip|tar|gzip|compressed/.test(type)) return "file-archive";
  // Office spreadsheets are XML too: `…spreadsheetml.sheet`.
  if (/sheet|csv|excel/.test(type)) return "file-spreadsheet";
  if (/json|javascript|typescript|xml/.test(type)) return "file-code";
  return "file";
}

/** The Lucide icon of a provider. */
export function providerIcon(provider: string) {
  switch (provider) {
    case "folder":
      return "hard-drive";
    case "drive":
      return "cloud";
    case "s3":
      return "database";
    default:
      return "folder-cog";
  }
}

/** A location's state, in a few words; none when it is ready. */
export function state(location: Location) {
  if (!location.available) return "Provider not installed";
  if (location.signed_in === false) return "Not signed in";
  if (location.error) return location.error;
  return "";
}

/** A path within a location, from a folder and a name. */
export const within = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;

export const parent = (path: string) => path.split("/").slice(0, -1).join("/");

export const leaf = (path: string) => path.split("/").pop() ?? path;

/** What a person filled in for a provider's fields: empty secrets are left as they were. */
export function filled(fields: Field[], values: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "secret" && !String(value ?? "").trim()) continue;
    if (value !== undefined) config[field.key] = value;
  }
  return config;
}

/**
 * The required fields still empty. Changing a location, `kept` is what it has: its fields count
 * as given, and its secrets, which the provider keeps, are left as they are when empty.
 */
export function missing(
  fields: Field[],
  values: Record<string, unknown>,
  kept?: Record<string, unknown>,
) {
  return fields.filter(
    (field) =>
      field.required &&
      !String(values[field.key] ?? "").trim() &&
      !(kept && field.type === "secret") &&
      !String(kept?.[field.key] ?? "").trim(),
  );
}

/** What a file is, as people call it: by its type, else by its name's ending. */
export function kind(entry: Pick<Entry, "kind" | "name" | "content_type">) {
  if (entry.kind === "folder") return "Folder";
  const type = entry.content_type ?? "";
  const ending = entry.name.includes(".")
    ? entry.name.split(".").pop()!.toLowerCase()
    : "";
  const named: Record<string, string> = {
    pdf: "PDF document",
    doc: "Word document",
    docx: "Word document",
    xls: "Spreadsheet",
    xlsx: "Spreadsheet",
    csv: "Spreadsheet",
    ppt: "Presentation",
    pptx: "Presentation",
    md: "Markdown",
    txt: "Text",
    zip: "Archive",
    json: "JSON",
  };
  if (named[ending]) return named[ending]!;
  if (type.startsWith("image/"))
    return `${(ending || type.slice(6)).toUpperCase()} image`;
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Audio";
  if (type.startsWith("text/")) return "Text";
  return ending ? `${ending.toUpperCase()} file` : "File";
}

/** How a folder's entries are sorted: by a column, either way. */
export interface Sort {
  key: "name" | "kind" | "size" | "modified";
  descending?: boolean;
}

/** Folders first, then by the column chosen; names break ties, ignoring case. */
export function sorted(entries: Entry[], sort: Sort) {
  const byName = (a: Entry, b: Entry) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  const by: Record<Sort["key"], (a: Entry, b: Entry) => number> = {
    name: byName,
    kind: (a, b) => kind(a).localeCompare(kind(b)),
    size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
    modified: (a, b) => (a.modified ?? 0) - (b.modified ?? 0),
  };
  const way = sort.descending ? -1 : 1;
  return [...entries].sort(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") ||
      way * by[sort.key](a, b) ||
      byName(a, b),
  );
}
