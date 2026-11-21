import { afterAll, expect, jest, mock, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import type { Chat, ChatEvent } from "@zerolux/chat";

// `bun run test` uses --parallel: every file has its own globals and module registry.
const browser = new Window({ url: "https://fixture.example.test" });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
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
// The connection joins and stays live; the test speaks for the kernel through it.
type Heard = {
  readWhileDisconnected: () => Promise<void>;
  event: (event: ChatEvent) => void;
  sync: () => void;
  status: (status: "connecting" | "live" | "offline") => void;
};
let heard: Heard | undefined;
mock.module("../../../packages/chat/src/realtime", () => ({
  connectRealtime: (handlers: Heard) => {
    heard = handlers;
    handlers.status("live");
    handlers.sync();
    return () => {};
  },
}));

const { createRoot } = await import("react-dom/client");
const { setKernelFetch, useChat, useSessionEvents, sessionBlocks } =
  await import("@zerolux/chat");

afterAll(() => {
  jest.useRealTimers();
  setKernelFetch();
  for (const [key, descriptor] of previous)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
});

test("without LiveKit notices the Console observes the accepted input and turn over HTTP, without posting it again", async () => {
  const sessionId = crypto.randomUUID(),
    text = crypto.randomUUID();
  let posts = 0,
    advanced = false;
  setKernelFetch(async (url, init) => {
    const path = new URL(url, "https://fixture.example.test").pathname;
    if (init?.method === "POST") {
      if (!path.endsWith(`/sessions/${sessionId}/input`))
        throw new Error("Unexpected fixture write");
      posts++;
      return Response.json({});
    }
    if (path.endsWith("/events"))
      return Response.json({
        first: 0,
        next: advanced ? 100 : 0,
        end: advanced ? 100 : 0,
        events: advanced
          ? [
              {
                type: "input",
                at: 1,
                time: null,
                text,
                chat: null,
                delivery: null,
              },
            ]
          : [],
      });
    return Response.json({
      conversations: [],
      approvals: [],
      sessions: [
        {
          id: sessionId,
          status: "connected",
          activity: advanced ? "working" : "idle",
        },
      ],
    });
  });
  let chat!: Chat, blocks!: ReturnType<typeof sessionBlocks>;
  function Probe() {
    chat = useChat(true, "https://fixture.example.test");
    blocks = sessionBlocks(useSessionEvents(sessionId).events);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      heard!.status("offline");
      await chat.input(sessionId, text);
    });
    expect(chat.sentInputs(sessionId, blocks, [])).toHaveLength(1);
    advanced = true;
    await act(async () => {
      await heard!.readWhileDisconnected();
    });
    expect(chat.realtime).toBe("offline");
    expect(chat.sessions[0]?.activity).toBe("working");
    expect(chat.sentInputs(sessionId, blocks, [])).toHaveLength(0);
    expect(posts).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a read the kernel did not answer is tried again by itself, and its error goes with the answer", async () => {
  jest.useFakeTimers();
  let down = false;
  setKernelFetch(async (url) => {
    if (down) throw new TypeError("fixture: no answer");
    const path = new URL(url).pathname;
    return Response.json(
      path.endsWith("/livekit/token")
        ? { url: "ws://fixture.example.test", token: "t", expires_at: 0 }
        : { conversations: [], sessions: [], approvals: [] },
    );
  });
  let chat!: Chat;
  function Probe() {
    chat = useChat(true, "https://fixture.example.test");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  expect(chat.error).toBe("");
  expect(chat.realtime).toBe("live");
  // The connection is live, and one read fails: nothing else would read again.
  down = true;
  await act(async () => {
    heard!.event({
      event_id: "e1",
      type: "approval.changed",
      approval_id: "a",
    } as ChatEvent);
  });
  expect(chat.error).not.toBe("");
  // Still unanswered, it stays; nobody has to act for the next try.
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(chat.error).not.toBe("");
  down = false;
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(chat.error).toBe("");
  expect(chat.realtime).toBe("live");
  await act(async () => root.unmount());
});
