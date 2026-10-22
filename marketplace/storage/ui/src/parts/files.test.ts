import { expect, test } from "bun:test";
import {
  fileIcon,
  filled,
  missing,
  parent,
  size,
  state,
  within,
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
