import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";

// A packaged workspace with a denied microphone; no device, OS settings or kernel is touched.
const page = new Window({ url: "https://fixture.example.test" });
const globals = {
  window: page,
  document: page.document,
  navigator: page.navigator,
  HTMLElement: page.HTMLElement,
  HTMLButtonElement: page.HTMLButtonElement,
  HTMLIFrameElement: page.HTMLIFrameElement,
  Element: page.Element,
  Node: page.Node,
  MutationObserver: page.MutationObserver,
  getComputedStyle: page.getComputedStyle.bind(page),
  IS_REACT_ACT_ENVIRONMENT: true,
  MediaRecorder: class {},
};
const originals = Object.keys(globals).map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("./components/composer");
afterAll(async () => {
  await page.happyDOM.abort();
  for (const [key, desc] of originals)
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
});

test("the composer opens settings only on request, retries capture once, and dismisses the notice without sending or losing the draft", async () => {
  let opens = 0,
    sends = 0,
    captures = 0;
  const opened = Promise.withResolvers<void>();
  Object.assign(page, {
    zeroluxDesktop: { platform: "macos" },
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        if (cmd !== "open_microphone_settings")
          throw new Error("Unexpected native command");
        opens++;
        opened.resolve();
      },
    },
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        captures++;
        throw new DOMException("", "NotAllowedError");
      },
    },
  });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const draft = crypto.randomUUID();
  const click = (button: HTMLButtonElement) =>
    act(async () => {
      button.click();
    });
  const notice = () => container.querySelector('[role="alert"]')?.parentElement;
  try {
    await act(async () =>
      root.render(
        <Composer
          label="Fixture"
          placeholder=""
          text={draft}
          setText={() => {
            throw new Error("Unexpected draft edit");
          }}
          open
          busy={false}
          send={() => {
            sends++;
          }}
          voice={{
            transcription: true,
            send: async () => {
              sends++;
            },
          }}
        />,
      ),
    );
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Dictate"]',
      )!,
    );
    expect(captures).toBe(1);
    expect(opens).toBe(0);
    const [settings, retry] = Array.from(notice()!.querySelectorAll("button"));
    await click(settings!);
    await opened.promise;
    expect(opens).toBe(1);
    expect(captures).toBe(1);
    await click(retry!);
    expect(captures).toBe(2);
    expect(opens).toBe(1);
    // The second denial has its own notice, without dismissing any other composer error.
    await click(
      notice()!.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss voice error"]',
      )!,
    );
    expect(notice()).toBeUndefined();
    const box = container.querySelector("textarea")!;
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe(draft);
    expect([sends, captures, opens]).toEqual([0, 2, 1]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
