/** A file Storage keeps, as its actions give it. */
export interface StoredFile {
  id: string;
  name: string;
  /** `a/b`, or empty at the top. */
  folder: string;
  size: number;
  content_type: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  conversation_id: string | null;
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
export function fileIcon(file: StoredFile) {
  const type = file.content_type;
  if (type.startsWith("image/")) return "file-image";
  if (type.startsWith("video/")) return "file-video";
  if (type.startsWith("audio/")) return "file-audio";
  if (type === "application/pdf" || type.startsWith("text/"))
    return "file-text";
  if (/zip|tar|gzip|compressed/.test(type)) return "file-archive";
  if (/json|javascript|typescript|xml/.test(type)) return "file-code";
  if (/sheet|csv|excel/.test(type)) return "file-spreadsheet";
  return "file";
}

/** The folders right inside `folder`, by name, from every folder that holds files. */
export function subfolders(folders: string[], folder: string) {
  const prefix = folder ? `${folder}/` : "";
  const names = new Set<string>();
  for (const path of folders)
    if (path.startsWith(prefix) && path !== folder) {
      const name = path.slice(prefix.length).split("/")[0];
      if (name) names.add(name);
    }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** A folder within another, as a path. */
export const within = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;
