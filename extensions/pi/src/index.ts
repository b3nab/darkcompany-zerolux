import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Bridge } from "./bridge.ts";

export default function zerolux(pi: ExtensionAPI) {
  let bridge: Bridge | undefined;
  let commandBusy = false;
  let disposed = false;
  const unsubscribeQuery = pi.events.on(
    "zerolux:query-task-bridge",
    (request) => {
      if (
        request &&
        typeof request === "object" &&
        "reply" in request &&
        typeof request.reply === "function"
      )
        request.reply(
          Boolean(bridge?.connected || bridge?.busy || commandBusy),
        );
    },
  );

  // Registering this extension never starts a timer, process, connection, or model turn.
  pi.registerCommand("zerolux", {
    description:
      "ZeroLux BYOH: connect PROJECT_ID ACTOR_ID [URL] | take | status | disconnect",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The ZeroLux session bridge requires interactive pi",
          "warning",
        );
        return;
      }
      if (commandBusy) {
        ctx.ui.notify("A ZeroLux command is already in progress", "warning");
        return;
      }
      commandBusy = true;
      try {
        const [action, project, actor, url, extra] = args.trim().split(/\s+/);
        if (action === "status") {
          ctx.ui.notify(bridge?.describe() ?? "ZeroLux: disconnected", "info");
          return;
        }
        if (action === "disconnect") {
          await bridge?.disconnect();
          bridge = undefined;
          ctx.ui.notify(
            "ZeroLux disconnected. This pi conversation stays open.",
            "info",
          );
          return;
        }
        if (action === "connect" || action === "take") {
          let chatActive = false;
          pi.events.emit("zerolux:query-chat", {
            reply: (active: boolean) => {
              chatActive = active;
            },
          });
          if (chatActive)
            throw new Error(
              "Stop the ZeroLux chat link before connecting or claiming a task",
            );
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error(
            "Wait until pi is idle and its message queue is empty",
          );
        if (action === "connect" && project && actor && !extra) {
          if (bridge?.connected)
            throw new Error("Disconnect the current bridge first");
          const confirmed = await ctx.ui.confirm(
            "Connect this pi session to ZeroLux?",
            `Project: ${project}\nActor: ${actor}\nKernel: ${url ?? "http://127.0.0.1:4310"}\nWorkspace: ${ctx.cwd}\n\nThis shares the session ID and workspace path, not the conversation history or credentials. No task runs until /zerolux take.`,
          );
          if (!confirmed || disposed) return;
          const next = new Bridge({
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            isIdle: () => ctx.isIdle(),
            hasPendingMessages: () => ctx.hasPendingMessages(),
            send: (prompt) =>
              pi.sendUserMessage(prompt, { expandPromptTemplates: false }),
            abort: () => ctx.abort(),
            notify: (text, level) => ctx.ui.notify(text, level),
            status: (text) => ctx.ui.setStatus("zerolux", text),
          });
          bridge = next;
          try {
            await next.connect(project, actor, url ?? "http://127.0.0.1:4310");
          } catch (error) {
            await next.disconnect();
            if (bridge === next) bridge = undefined;
            throw error;
          }
          return;
        }
        if (action === "take" && !project) {
          const current = bridge;
          if (!current?.connected)
            throw new Error("Connect this session first");
          if (current.busy)
            throw new Error("This pi session already owns a task");
          const confirmed = await ctx.ui.confirm(
            "Execute the next queued ZeroLux task here?",
            `${current.describe()}\n\nThis starts model work with this session's existing tools, permissions and context. It can change files in your current workspace. Use a dedicated worktree. The final assistant text will be sent to ZeroLux for HUMAN review.`,
          );
          if (confirmed && !disposed && bridge === current)
            await current.take();
          return;
        }
        ctx.ui.notify(
          "Usage: /zerolux connect PROJECT_ID ACTOR_ID [URL] | take | status | disconnect",
          "info",
        );
      } catch (error) {
        if (!disposed) ctx.ui.notify(String(error), "error");
      } finally {
        commandBusy = false;
      }
    },
  });

  pi.on("message_end", (event) => {
    bridge?.message(event.message);
  });
  pi.on("agent_before_settle", (event) => {
    bridge?.beforeSettle(event.outcome);
  });
  pi.on("agent_settled", async () => {
    await bridge?.settled();
  });

  // Do not move a live task into a different branch/session. Disconnect explicitly first.
  const guard = (_event: unknown, ctx: ExtensionContext) => {
    if (bridge?.busy || commandBusy) {
      ctx.ui.notify(
        "Disconnect ZeroLux before changing this task's session or branch",
        "warning",
      );
      return { cancel: true };
    }
  };
  pi.on("session_before_switch", guard);
  pi.on("session_before_fork", guard);
  pi.on("session_before_tree", guard);
  pi.on("session_shutdown", async () => {
    disposed = true;
    unsubscribeQuery();
    const current = bridge;
    bridge = undefined;
    await current?.disconnect("Pi session closed, reloaded, or replaced");
  });
}
