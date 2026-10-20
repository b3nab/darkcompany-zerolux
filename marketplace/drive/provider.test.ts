import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, operations, TOKEN, UPLOAD } from "./provider.ts";

/** Google's sign-in and Drive, kept in memory. */
function google() {
  const files = new Map<
    string,
    { name: string; parents: string[]; bytes: string }
  >();
  let signedIn = 0;
  const call = async (url: string, init: RequestInit = {}) => {
    if (url === TOKEN) {
      signedIn++;
      return Response.json({ access_token: "t", expires_in: 3600 });
    }
    if (new Headers(init.headers).get("authorization") !== "Bearer t")
      return new Response(null, { status: 401 });
    if (url.startsWith(`${UPLOAD}/files`)) {
      const form = init.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      const id = `d${files.size + 1}`;
      files.set(id, {
        ...metadata,
        bytes: await (form.get("file") as Blob).text(),
      });
      return Response.json({ id });
    }
    if (url.startsWith(`${API}/files?q=`)) {
      const query = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
      const name = query.match(/name = '([^']+)'/)![1];
      const folder = query.match(/'([^']+)' in parents/)![1]!;
      const found = [...files].filter(
        ([, file]) => file.name === name && file.parents.includes(folder),
      );
      return Response.json({ files: found.map(([id]) => ({ id })) });
    }
    const id = url.slice(`${API}/files/`.length).split("?")[0]!;
    const file = files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (init.method === "DELETE") {
      files.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(file.bytes);
  };
  return { files, call, signedIn: () => signedIn };
}

test("a file is kept in the folder by its key, read back as a copy, and deleted", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zl-drive-"));
  try {
    const drive = google();
    const settings = {
      folder: "F",
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
    };
    const provider = operations(
      () => settings,
      () => folder,
      drive.call,
    );
    const source = join(folder, "upload");
    await writeFile(source, "bytes");
    await provider.put({ key: "f1", path: source, content_type: "text/plain" });
    expect([...drive.files.values()]).toEqual([
      { name: "f1", parents: ["F"], bytes: "bytes" },
    ]);
    const got = await provider.get({ key: "f1" });
    expect(await readFile(got.path, "utf8")).toBe("bytes");
    await provider.delete({ key: "f1" });
    expect(drive.files.size).toBe(0);
    await expect(provider.get({ key: "f1" })).rejects.toThrow(
      "not in the Drive folder",
    );
    // One sign-in serves until it expires.
    expect(drive.signedIn()).toBe(1);
    await expect(provider.get({ key: "it's" })).rejects.toThrow("Invalid key");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("without its folder and sign-in it says what to set", async () => {
  const provider = operations(
    () => ({ folder: "", clientId: "", clientSecret: "", refreshToken: "" }),
    () => "/tmp",
    google().call,
  );
  await expect(provider.get({ key: "f1" })).rejects.toThrow(
    "Google Drive's settings",
  );
});
