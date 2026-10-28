import { expect, test } from "bun:test";
import {
  fileIcon,
  filled,
  missing,
  parent,
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
  expect(state({ ...ready, error: "Drive refused (401)" })).toBe(
    "Drive refused (401)",
  );
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
