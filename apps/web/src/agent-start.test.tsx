import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentLaunchSettings, setKernelFetch, useChat } from "@zerolux/chat";
import type { Chat } from "@zerolux/chat";

afterEach(() => setKernelFetch());

for (const harness of ["claude", "codex", "pi"] as const) {
  for (const override of [false, true]) {
    test(`${harness} creation ${override ? "forwards model and effort" : "leaves blank launch choices unset"}`, async () => {
      const requests: { url: string; init: RequestInit }[] = [];
      setKernelFetch(async (url, init = {}) => {
        requests.push({ url, init });
        return Response.json(
          url.endsWith("/chat/sessions") ? { sessions: [] } : {},
        );
      });
      let chat: Chat | undefined;
      function Probe() {
        // SSR does not run effects or connect realtime; only the chosen action runs.
        chat = useChat(false, "https://fixture.example.test");
        return null;
      }
      renderToStaticMarkup(<Probe />);
      const input = {
        name: "Agent",
        workspace: "/fixture/project",
        ...agentLaunchSettings(
          override ? " fixture-model " : "",
          override ? " high " : " ",
        ),
      };
      if (harness === "claude")
        await chat!.startClaude({ ...input, permission_mode: "plan" });
      else if (harness === "codex") await chat!.startCodex(input);
      else await chat!.startPi(input);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url).toBe(
        `https://fixture.example.test/api/chat/${harness}-sessions`,
      );
      expect(requests[0]!.init.method).toBe("POST");
      expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
        name: "Agent",
        workspace: "/fixture/project",
        ...(override ? { model: "fixture-model", effort: "high" } : {}),
        ...(harness === "claude" ? { permission_mode: "plan" } : {}),
      });
      expect(requests[1]!.url).toBe(
        "https://fixture.example.test/api/chat/sessions",
      );
    });
  }
}
