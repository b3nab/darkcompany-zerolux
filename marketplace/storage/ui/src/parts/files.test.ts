import { expect, test } from "bun:test";
import {
  fileIcon,
  filled,
  kind,
  missing,
  parent,
  size,
  sorted,
  state,
  within,
  type Entry,
  type Field,
  type Location,
} from "./files";

test("paths are built and taken apart within a location", () => {
  expect(within("", "aspen")).toBe("aspen");
  expect(within("aspen", "birch")).toBe("aspen/birch");
  expect(parent("aspen/birch/cedar")).toBe("aspen/birch");
  expect(parent("aspen")).toBe("");
});

test("sizes read in the largest unit under 1024", () => {
  expect(size(512)).toBe("512 B");
  expect(size(1536)).toBe("1.5 KB");
  expect(size(25 * 1024 * 1024)).toBe("25 MB");
  expect(size(3 * 1024 ** 3)).toBe("3.0 GB");
});

const fields: Field[] = [
  { key: "bucket", label: "Bucket", type: "text", required: true },
  { key: "prefix", label: "Folder", type: "text" },
  { key: "key", label: "Key", type: "secret", required: true },
];

test("a secret left empty keeps the one already there", () => {
  expect(filled(fields, { bucket: "b", prefix: "", key: "" })).toEqual({
    bucket: "b",
    prefix: "",
  });
  expect(missing(fields, { bucket: "", key: "" }).map((f) => f.key)).toEqual([
    "bucket",
    "key",
  ]);
  // Changing a location: what it has counts as given, and its secret stays.
  expect(missing(fields, { bucket: "", key: "" }, { bucket: "b" })).toEqual([]);
  expect(missing(fields, { bucket: "", key: "" }, {})).toEqual([fields[0]!]);
});

test("a location says what keeps it from working", () => {
  const ready: Location = {
    id: "l",
    name: "Work",
    provider: "drive",
    config: {},
    capabilities: [],
    default: false,
    available: true,
  };
  expect(state(ready)).toBe("");
  expect(state({ ...ready, signed_in: false })).toBe("Not signed in");
  expect(state({ ...ready, error: "Drive refused (401)" })).toBe(
    "Drive refused (401)",
  );
  expect(state({ ...ready, available: false })).toBe("Provider not installed");
});

test("a file's icon says its kind, a spreadsheet's too", () => {
  const icon = (content_type: string) =>
    fileIcon({ kind: "file", content_type });
  expect(icon("video/mp4")).toBe("file-video");
  expect(
    icon("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  ).toBe("file-spreadsheet");
  expect(icon("application/json")).toBe("file-code");
  expect(fileIcon({ kind: "folder" })).toBe("folder");
});

test("folders come first, then the column chosen, either way", () => {
  const entries: Entry[] = [
    { name: "notes.md", path: "notes.md", kind: "file", size: 6, modified: 3 },
    { name: "Press", path: "Press", kind: "folder", modified: 1 },
    {
      name: "budget.xlsx",
      path: "budget.xlsx",
      kind: "file",
      size: 212,
      modified: 2,
    },
    { name: "assets", path: "assets", kind: "folder", modified: 4 },
  ];
  const names = (list: Entry[]) => list.map((entry) => entry.name);
  expect(names(sorted(entries, { key: "name" }))).toEqual([
    "assets",
    "Press",
    "budget.xlsx",
    "notes.md",
  ]);
  expect(names(sorted(entries, { key: "size", descending: true }))).toEqual([
    "assets",
    "Press",
    "budget.xlsx",
    "notes.md",
  ]);
  expect(names(sorted(entries, { key: "modified", descending: true }))).toEqual(
    ["assets", "Press", "notes.md", "budget.xlsx"],
  );
});

test("a file's kind reads as people call it", () => {
  expect(kind({ kind: "folder", name: "Press" })).toBe("Folder");
  expect(kind({ kind: "file", name: "Roadmap.pdf" })).toBe("PDF document");
  expect(
    kind({ kind: "file", name: "Logo.png", content_type: "image/png" }),
  ).toBe("PNG image");
  expect(kind({ kind: "file", name: "build.log" })).toBe("LOG file");
  expect(kind({ kind: "file", name: "README" })).toBe("File");
});
