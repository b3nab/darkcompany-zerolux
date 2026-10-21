import { expect, test } from "bun:test";
import { size, subfolders, within } from "./files";

test("a folder shows the folders right inside it, intermediate ones too", () => {
  const folders = ["aspen", "aspen/birch", "aspen/birch/cedar", "maple/olive"];
  expect(subfolders(folders, "")).toEqual(["aspen", "maple"]);
  expect(subfolders(folders, "aspen")).toEqual(["birch"]);
  expect(subfolders(folders, "maple")).toEqual(["olive"]);
  expect(subfolders(folders, "aspen/birch/cedar")).toEqual([]);
  // A name that only starts like the folder is not inside it.
  expect(subfolders(["aspen2/birch"], "aspen")).toEqual([]);
  expect(within("", "aspen")).toBe("aspen");
  expect(within("aspen", "birch")).toBe("aspen/birch");
});

test("sizes read in the largest unit under 1024", () => {
  expect(size(512)).toBe("512 B");
  expect(size(1536)).toBe("1.5 KB");
  expect(size(25 * 1024 * 1024)).toBe("25 MB");
  expect(size(3 * 1024 ** 3)).toBe("3.0 GB");
});
