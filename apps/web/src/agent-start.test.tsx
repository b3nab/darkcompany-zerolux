import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentLaunchSettings, setKernelFetch, useChat } from "@zerolux/chat";
import type { Chat, NewSession } from "@zerolux/chat";

afterEach(() => setKernelFetch());

/** The chat hook against a fixture kernel, recording every request it makes. */
function fixture() {
  const requests: { url: string; init: RequestInit }[] = [];
  setKernelFetch(async (url, init = {}) => {
    requests.push({ url, init });
    return Response.json(
      url.endsWith("/sessions") && !init.body
        ? { sessions: [] }
        : { actor: null, session: { id: "s-1" } },
    );
  });
  let chat: Chat | undefined;
  function Probe() {
    // SSR does not run effects or connect realtime; only the chosen action runs.
    chat = useChat(false, "https://fixture.example.test");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { chat: chat!, requests };
}

for (const harness of ["claude-code", "codex", "pi"] as const) {
  for (const override of [false, true]) {
    test(`${harness} creation ${override ? "forwards model and effort" : "leaves blank launch choices unset"}`, async () => {
      const { chat, requests } = fixture();
      const common = {
        name: "Agent",
        workspace: "/fixture/project",
        ...agentLaunchSettings(
          override ? " fixture-model " : "",
          override ? " high " : " ",
        ),
      };
      const input: NewSession =
        harness === "claude-code"
          ? { harness, ...common, permission_mode: "plan" }
          : { harness, ...common };
      await chat.createSession(input);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url).toBe(
        "https://fixture.example.test/api/sessions",
      );
      expect(requests[0]!.init.method).toBe("POST");
      expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
        harness,
        name: "Agent",
        workspace: "/fixture/project",
        ...(override ? { model: "fixture-model", effort: "high" } : {}),
        ...(harness === "claude-code" ? { permission_mode: "plan" } : {}),
      });
      expect(requests[1]!.url).toBe(
        "https://fixture.example.test/api/sessions",
      );
    });
  }
}

test("a session opens without an agent, and the owner pins, renames or archives it", async () => {
  const { chat, requests } = fixture();
  await chat.createSession({ harness: "pi", workspace: "/fixture/project" });
  expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
    harness: "pi",
    workspace: "/fixture/project",
  });
  await chat.attach("found-1");
  expect(requests[2]!.url).toBe(
    "https://fixture.example.test/api/sessions/attach",
  );
  expect(JSON.parse(requests[2]!.init.body as string)).toEqual({
    discovered_session_id: "found-1",
  });
  await chat.input("s-1", "Then the docs", "queue");
  expect(requests.at(-1)!.url).toBe(
    "https://fixture.example.test/api/sessions/s-1/input",
  );
  expect(JSON.parse(requests.at(-1)!.init.body as string)).toEqual({
    text: "Then the docs",
    mode: "queue",
  });
  // A waiting input is rewritten or taken out of the queue.
  await chat.editQueued("s-1", "q/1", "Then the README");
  expect(requests.at(-1)!.url).toBe(
    "https://fixture.example.test/api/sessions/s-1/queue/q%2F1",
  );
  expect(requests.at(-1)!.init.method).toBe("PATCH");
  expect(JSON.parse(requests.at(-1)!.init.body as string)).toEqual({
    text: "Then the README",
  });
  await chat.removeQueued("s-1", "q/1");
  expect(requests.at(-1)!.init.method).toBe("DELETE");
  expect(requests.at(-1)!.init.body).toBeUndefined();
  await chat.updateSession("s-1", { pinned: true, title: "Release" });
  const change = requests.at(-1)!;
  expect(change.url).toBe("https://fixture.example.test/api/sessions/s-1");
  expect(change.init.method).toBe("PATCH");
  expect(JSON.parse(change.init.body as string)).toEqual({
    pinned: true,
    title: "Release",
  });
});
