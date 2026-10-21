import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "@zerolux/chat";
import type { UiPiece } from "@zerolux/chat";
import { componentNames } from "./components";
import type { UiComponents } from "./components";
import {
  callAction,
  eventName,
  moduleHost,
  receiveFile,
  sendFile,
  uiModule,
} from "./host";
import type { Here } from "./host";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";
const piece: UiPiece = {
  extension: "aspen.board",
  space: "session",
  name: "cards",
  title: "Cards",
  view: { kind: "native", entry: "ui/native/cards.js" },
};
const here: Here = {
  piece,
  context: { session_id: "s1" },
  kernel,
  save: async () => {},
  actors: [],
};
const schema = {
  type: "object",
  properties: { session_id: { type: "string" }, title: { type: "string" } },
};

/** A kernel that notes each request and answers with `answer`. */
function fake(answer: () => Response) {
  const asked: { url: string; method: string; body: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    asked.push({
      url: String(url),
      method: init?.method ?? "GET",
      body:
        init?.body instanceof Blob
          ? await init.body.text()
          : init?.body && JSON.parse(String(init.body)),
    });
    return answer();
  });
  return asked;
}

test("a view's action runs in its extension, with the place it shows in where asked", async () => {
  const asked = fake(() => Response.json({ result: { id: "1" } }));
  expect(await callAction(here, "add", { title: "A" }, schema)).toEqual({
    id: "1",
  });
  await callAction(here, "add", { title: "B" });
  expect(asked.map((a) => [a.url, a.body])).toEqual([
    [`${kernel}/api/ext/aspen.board/add`, { session_id: "s1", title: "A" }],
    // An action that does not ask for the place does not get it.
    [`${kernel}/api/ext/aspen.board/add`, { title: "B" }],
  ]);
});

test("a file goes to an action as it is, and an action's file comes back with its name", async () => {
  const sent = fake(() => Response.json({ result: { kept: true } }));
  const file = new Blob(["hello"], { type: "text/plain" });
  expect(
    await sendFile(
      here,
      "upload",
      file,
      "notes 1.txt",
      { folder: "x" },
      schema,
    ),
  ).toEqual({ kept: true });
  const url = new URL(sent[0]!.url);
  expect(url.pathname).toBe("/api/ext/aspen.board/upload/file");
  expect(JSON.parse(url.searchParams.get("input")!)).toEqual({
    session_id: "s1",
    folder: "x",
  });
  expect(url.searchParams.get("name")).toBe("notes 1.txt");
  expect(sent[0]!.body).toBe("hello");

  const given = fake(
    () =>
      new Response("bytes", {
        headers: {
          "Content-Disposition":
            "inline; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        },
      }),
  );
  const got = await receiveFile(here, "download", { id: "7" });
  expect(got.name).toBe("résumé.pdf");
  expect(await got.blob.text()).toBe("bytes");
  expect(given[0]!.method).toBe("GET");
  expect(JSON.parse(new URL(given[0]!.url).searchParams.get("input")!)).toEqual(
    { id: "7" },
  );
});

test("an extension's own event may be named short; another's needs its full name", () => {
  expect(eventName("aspen.board", "changed")).toBe("aspen.board/changed");
  expect(eventName("aspen.board", "birch.notes/saved")).toBe(
    "birch.notes/saved",
  );
});

test("a view's bundle runs once the app defines its module host, and gets only the modules it is given", () => {
  const react = { marker: "react" };
  let running: string | undefined = "address-1";
  const host = moduleHost({ react }, () => running);
  (0,
  eval)(`globalThis.__zeroluxModule("ui/native/cards.js", function (module, exports, require) {
    exports.default = function Cards() { return null; };
    exports.seen = require("react");
  })`);
  const view = host.view("address-1");
  expect(typeof view).toBe("function");
  // A bundle that asks for anything else stops with what it may use.
  running = "address-2";
  expect(() =>
    (0,
    eval)(`globalThis.__zeroluxModule("ui/native/x.js", function (module, exports, require) {
      require("react-native");
    })`),
  ).toThrow("A view may use only react, not react-native");
  // One that gives no view says so.
  expect(() =>
    (0, eval)(`globalThis.__zeroluxModule("ui/native/y.js", function () {})`),
  ).toThrow("ui/native/y.js gives no view");
  expect(host.view("address-2")).toBeUndefined();
});

test("an app gives every component a view may draw with", () => {
  const some = { Stack: () => null } as unknown as UiComponents;
  expect(() => uiModule(some)).toThrow("The app lacks Text");
  const all = Object.fromEntries(
    componentNames.map((name) => [name, () => null]),
  ) as unknown as UiComponents;
  const ui = uiModule(all);
  expect(Object.keys(ui)).toEqual(
    expect.arrayContaining([...componentNames, "useAction", "useActionResult"]),
  );
});
