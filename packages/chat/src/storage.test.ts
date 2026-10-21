import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import { downloadFile, linkedFiles, uploadFiles, withFiles } from "./storage";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";

test("files shared in a chat go to Storage one by one, with the chat and their names", async () => {
  const asked: { path: string; input: unknown; name: string | null }[] = [];
  setKernelFetch(async (url, init) => {
    const { pathname, searchParams } = new URL(String(url));
    asked.push({
      path: pathname,
      input: JSON.parse(searchParams.get("input") ?? "null"),
      name: searchParams.get("name"),
    });
    expect(init?.body).toBeInstanceOf(Blob);
    return Response.json({
      result: { id: `f${asked.length}`, name: searchParams.get("name") },
    });
  });
  const named = (name: string) =>
    Object.assign(new Blob(["x"], { type: "text/plain" }), { name });
  const kept = await uploadFiles(
    [named("plan.md"), named("a b.png")],
    { conversation_id: "general" },
    kernel,
  );
  expect(kept.map((f) => f.id)).toEqual(["f1", "f2"]);
  expect(asked).toEqual([
    {
      path: "/api/ext/zerolux.storage/upload/file",
      input: { conversation_id: "general" },
      name: "plan.md",
    },
    {
      path: "/api/ext/zerolux.storage/upload/file",
      input: { conversation_id: "general" },
      name: "a b.png",
    },
  ]);
});

test("a message's links to files come back as the files and the text around them", () => {
  const text = withFiles("Here they are", [
    { id: "f1", name: "plan.md" },
    { id: "f2", name: "photo [1].png" },
  ]);
  const read = linkedFiles(text);
  expect(read.files).toEqual([
    { id: "f1", name: "plan.md" },
    { id: "f2", name: "photo 1.png" },
  ]);
  expect(read.text).toBe("Here they are");
  // A link inside a sentence stays there as its name.
  const inline = linkedFiles("See [plan.md](zerolux:file/f1) first");
  expect(inline).toEqual({
    text: "See plan.md first",
    files: [{ id: "f1", name: "plan.md" }],
  });
  // Other links are the message's own.
  expect(linkedFiles("[docs](https://example.test)").files).toEqual([]);
  expect(withFiles("  ", [])).toBe("");
});

test("a file comes down from Storage with its name", async () => {
  let asked = "";
  setKernelFetch(async (url) => {
    asked = String(url);
    return new Response("hello", {
      headers: {
        "content-type": "text/plain",
        "content-disposition": "inline; filename*=UTF-8''plan%20v2.md",
      },
    });
  });
  const { blob, name } = await downloadFile("f1", kernel);
  expect(name).toBe("plan v2.md");
  expect(await blob.text()).toBe("hello");
  const { pathname, searchParams } = new URL(asked);
  expect(pathname).toBe("/api/ext/zerolux.storage/download");
  expect(JSON.parse(searchParams.get("input") ?? "")).toEqual({ id: "f1" });
});
