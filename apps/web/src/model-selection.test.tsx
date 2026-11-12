import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { Window } from "happy-dom";

// `bun run test` uses --parallel: every file has its own globals and module registry.
// Bun 1.4.2 has no DOM environment flag. Install one before loading React DOM or Base UI.
const browser = new Window({ url: "https://fixture.example.test" });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  NodeFilter: browser.NodeFilter,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLIFrameElement: browser.HTMLIFrameElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  Document: browser.Document,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  KeyboardEvent: browser.KeyboardEvent,
  PointerEvent: browser.PointerEvent,
  InputEvent: browser.InputEvent,
  FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });

const { createRoot } = await import("react-dom/client");
const { lookWith, setKernelFetch, useSessionSettings } =
  await import("@zerolux/chat");
const { ModelSelect } = await import("./components/model-select");
type Settings = ReturnType<typeof useSessionSettings>;
let root: ReturnType<typeof createRoot> | undefined;
let settings: Settings;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  setKernelFetch();
  lookWith(
    () => true,
    () => {},
  );
});
afterAll(async () => {
  await browser.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const snapshot = (model: string) => ({
  values: { model, effort: null },
  models: [{ value: "native-known", label: "Fixture", efforts: [] }],
  editable: ["model"],
});

function Probe({
  id = "a",
  picker = false,
  disabled = false,
}: {
  id?: string;
  picker?: boolean;
  disabled?: boolean;
}) {
  settings = useSessionSettings(id, "", "https://fixture.example.test");
  return picker ? (
    <ModelSelect
      value={settings.data?.values.model ?? ""}
      models={settings.data?.models ?? []}
      custom
      disabled={disabled}
      onOpen={settings.refresh}
      onChange={(model) => {
        void settings.apply({ model });
      }}
    />
  ) : null;
}

async function render(node: ReactNode) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(node));
}

async function openPicker() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[role="combobox"]',
  );
  expect(input).not.toBeNull();
  return input!;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

test("typing and cancelling keep the model; Enter and selecting submit one confirmed change", async () => {
  let model = "native-known";
  const changes: unknown[] = [];
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") {
      const change = JSON.parse(String(init.body)) as { model: string };
      changes.push(change);
      model = change.model;
    }
    return Response.json(snapshot(model));
  });
  await render(<Probe picker />);
  let input = await openPicker();
  await type(input, "native-cancelled");
  expect(changes).toHaveLength(0);
  await key(input, "Escape");
  expect(changes).toHaveLength(0);
  expect(settings.data?.values.model).toBe("native-known");

  input = await openPicker();
  await type(input, "native-new");
  expect(changes).toHaveLength(0);
  await key(input, "Enter");
  expect(changes).toEqual([{ model: "native-new" }]);
  expect(settings.data?.values.model).toBe("native-new");

  await openPicker();
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="option"][data-value="native-known"]')!
      .click();
  });
  expect(changes).toEqual([{ model: "native-new" }, { model: "native-known" }]);
  expect(settings.data?.values.model).toBe("native-known");
});

test("disabling an open model picker prevents both keyboard and pointer changes", async () => {
  const changes: unknown[] = [];
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") changes.push(JSON.parse(String(init.body)));
    return Response.json(snapshot("native-known"));
  });
  await render(<Probe picker />);
  const input = await openPicker();
  await type(input, "native-new");
  await render(<Probe picker disabled />);
  await key(input, "Enter");
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="option"][data-value="native-new"]')!
      .click();
  });
  expect(changes).toHaveLength(0);
  expect(settings.data?.values.model).toBe("native-known");
});

function pendingKernel() {
  const pending: {
    url: string;
    method: string;
    finish(model: string): void;
  }[] = [];
  setKernelFetch(
    (url, init) =>
      new Promise<Response>((resolve) => {
        pending.push({
          url,
          method: init?.method ?? "GET",
          finish: (model) => resolve(Response.json(snapshot(model))),
        });
      }),
  );
  return {
    pending,
    finish: (index: number, model: string) =>
      act(async () => pending[index]!.finish(model)),
  };
}

test("a foreground read started before a PATCH confirmation cannot undo that confirmation", async () => {
  const { pending, finish } = pendingKernel();
  let foreground = true;
  let changed = () => {};
  lookWith(
    () => foreground,
    (listener) => {
      changed = listener;
    },
  );
  await render(<Probe />);
  await finish(0, "native-old");
  let applying: Promise<unknown>;
  await act(async () => {
    applying = settings.apply({ model: "native-new" });
  });
  await act(async () => {
    foreground = false;
    changed();
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    foreground = true;
    changed();
  });
  expect(pending.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
  await finish(1, "native-new");
  await applying!;
  await finish(2, "native-old");
  expect(settings.data?.values.model).toBe("native-new");
  expect(settings.loading).toBe(false);
});

test("a previous session's delayed PATCH does not invalidate the next session's read", async () => {
  const { pending, finish } = pendingKernel();
  await render(<Probe id="a" />);
  await finish(0, "native-a");
  let applying: Promise<unknown>;
  await act(async () => {
    applying = settings.apply({ model: "native-new-a" });
  });
  await render(<Probe id="b" />);
  expect(new URL(pending[2]!.url).pathname).toBe("/api/sessions/b/settings");
  await finish(1, "native-new-a");
  await applying!;
  await finish(2, "native-b");
  expect(settings.data?.values.model).toBe("native-b");
  expect(settings.loading).toBe(false);
});
