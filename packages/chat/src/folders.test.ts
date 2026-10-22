import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import { readFolders } from "./folders";

afterEach(() => setKernelFetch());

test("the kernel's folders are read inside one, or inside its home", async () => {
  const asked: string[] = [];
  setKernelFetch(async (url) => {
    const { pathname, search } = new URL(String(url));
    asked.push(pathname + search);
    return Response.json({ path: "/Users/aspen", folders: [] });
  });
  await readFolders(undefined, "http://192.0.2.4:4400");
  await readFolders("/Users/aspen/Design Work", "http://192.0.2.4:4400");
  expect(asked).toEqual([
    "/api/folders",
    "/api/folders?path=%2FUsers%2Faspen%2FDesign%20Work",
  ]);
});
