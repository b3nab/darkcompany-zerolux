import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, drive, FOLDER, folderId, returnTo, UPLOAD } from "./provider.ts";

interface File {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes: string;
  trashed?: boolean;
}

/** Drive, kept in memory: enough of its REST API for a location. */
function memory() {
  const files = new Map<string, File>();
  let next = 1;
  const add = (file: Omit<File, "id">) => {
    const id = `f${next++}`;
    files.set(id, { id, ...file });
    return files.get(id)!;
  };
  const shown = (file: File) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.mimeType === FOLDER ? undefined : String(file.bytes.length),
    parents: file.parents,
  });
  const sessions = new Map<
    string,
    { id?: string; name?: string; parent?: string }
  >();
  const call = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    if (
      !url.startsWith("upload-session:") &&
      headers.get("authorization") !== "Bearer t"
    )
      return new Response(null, { status: 401 });
    const path = url.split("?")[0]!;
    const query = new URL(url.replace(/^upload-session:/, "https://x/"))
      .searchParams;
    if (url.startsWith("upload-session:")) {
      const session = sessions.get(path)!;
      const bytes = await new Response(init.body as Blob).text();
      const file = session.id
        ? Object.assign(files.get(session.id)!, { bytes })
        : add({
            name: session.name!,
            parents: [session.parent!],
            mimeType: "text/plain",
            bytes,
          });
      return Response.json(shown(file));
    }
    if (path.startsWith(`${UPLOAD}/files`)) {
      const id = path.slice(`${UPLOAD}/files/`.length) || undefined;
      const body = JSON.parse(String(init.body)) as {
        name?: string;
        parents?: string[];
      };
      const session = `upload-session:${sessions.size}`;
      sessions.set(session, { id, name: body.name, parent: body.parents?.[0] });
      return new Response(null, {
        headers: { location: `${session}?upload_id=1` },
      });
    }
    if (path === `${API}/files` && method === "GET") {
      const q = query.get("q")!;
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const name = q.match(/name = '([^']+)'/)?.[1];
      const contains = q.match(/name contains '([^']+)'/)?.[1];
      const found = [...files.values()].filter(
        (file) =>
          !file.trashed &&
          (!parent || file.parents.includes(parent)) &&
          (!name || file.name === name) &&
          (!contains || file.name.includes(contains)),
      );
      return Response.json({ files: found.map(shown) });
    }
    if (path === `${API}/files` && method === "POST") {
      const body = JSON.parse(String(init.body));
      return Response.json(shown(add({ ...body, bytes: "" })));
    }
    if (path === `${API}/about`)
      return Response.json({ user: { emailAddress: "ben@example.com" } });
    const [id, verb] = path.slice(`${API}/files/`.length).split("/");
    const file = id === "root" ? files.get("root") : files.get(id!);
    if (!file)
      return Response.json(
        { error: { message: "Not found" } },
        { status: 404 },
      );
    if (verb === "export")
      return new Response(`exported as ${query.get("mimeType")}`);
    if (verb === "copy") {
      const body = JSON.parse(String(init.body));
      return Response.json(shown(add({ ...file, ...body })));
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init.body));
      Object.assign(file, body);
      const removed = query.get("removeParents");
      if (removed) file.parents = [query.get("addParents")!];
      return Response.json(shown(file));
    }
    if (query.get("alt") === "media") return new Response(file.bytes);
    return Response.json(shown(file));
  };
  files.set("root", {
    id: "root",
    name: "My Drive",
    mimeType: FOLDER,
    parents: [],
    bytes: "",
  });
  return { files, add, call };
}

test("a location shows its Drive folder as it is, and changes it there", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zl-drive-"));
  try {
    const google = memory();
    const team = google.add({
      name: "Team",
      mimeType: FOLDER,
      parents: ["root"],
      bytes: "",
    });
    google.add({
      name: "plan.md",
      mimeType: "text/markdown",
      parents: [team.id],
      bytes: "# Plan",
    });
    google.add({
      name: "Budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [team.id],
      bytes: "",
    });
    google.add({
      name: "Elsewhere.txt",
      mimeType: "text/plain",
      parents: ["root"],
      bytes: "",
    });
    const location = drive(
      team.id,
      async () => "t",
      () => folder,
      google.call,
    );

    expect(await location.check()).toEqual({ account: "ben@example.com" });
    const listed = await location.list("");
    expect(listed.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["Budget", "file"],
      ["plan.md", "file"],
    ]);
    // Google's own documents are read in an Office format.
    const budget = await location.read("Budget");
    expect(budget.name).toBe("Budget.xlsx");
    expect(await readFile(budget.path, "utf8")).toContain("spreadsheetml");

    const source = join(folder, "upload");
    await writeFile(source, "notes");
    await location.mkdir("Q3/Reports");
    const written = await location.write("Q3/Reports/notes.txt", source);
    expect(written).toMatchObject({
      path: "Q3/Reports/notes.txt",
      kind: "file",
    });
    const read = await location.read("Q3/Reports/notes.txt");
    expect(await readFile(read.path, "utf8")).toBe("notes");
    // Written again: the same Drive file, with the new bytes.
    await writeFile(source, "notes, again");
    const again = await location.write("Q3/Reports/notes.txt", source);
    expect(again.id).toBe(written.id);

    const moved = await location.move("plan.md", "Q3/plan.md");
    expect(moved.path).toBe("Q3/plan.md");
    await expect(location.stat("plan.md")).rejects.toThrow("not there");
    await location.copy("Q3", "Q3 copy");
    expect(
      (await location.list("Q3 copy")).entries.map((entry) => entry.name),
    ).toEqual(["Reports", "plan.md"]);
    expect(
      (await location.search("plan")).entries.map((entry) => entry.path).sort(),
    ).toEqual(["Q3 copy/plan.md", "Q3/plan.md"]);
    // Deleting puts it in Drive's trash.
    await location.delete("Q3 copy");
    expect(
      [...google.files.values()].find((file) => file.name === "Q3 copy")
        ?.trashed,
    ).toBe(true);
    await expect(location.stat("Q3 copy")).rejects.toThrow("not there");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a folder is given by its address or its ID", () => {
  expect(folderId("")).toBe("root");
  expect(
    folderId("https://drive.google.com/drive/folders/1AbC_d-9?usp=sharing"),
  ).toBe("1AbC_d-9");
  expect(folderId("1AbC")).toBe("1AbC");
  expect(() => folderId("no spaces allowed")).toThrow();
});

test("Google sends the person back only to this computer, or over HTTPS", () => {
  expect(returnTo("http://127.0.0.1:4310")).toBe("http://127.0.0.1:4310");
  expect(returnTo("http://localhost:4310")).toBe("http://localhost:4310");
  expect(returnTo("https://zerolux.example")).toBe("https://zerolux.example");
  expect(returnTo(undefined)).toBeUndefined();
  expect(() => returnTo("http://192.168.0.118:4310")).toThrow("HTTPS");
});
