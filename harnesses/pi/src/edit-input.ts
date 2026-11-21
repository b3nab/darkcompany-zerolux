import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Selecting a user input in /tree goes to its parent, even for the first input. Only
 * command contexts expose that operation; the command carries no user text or history. */
export function inputEditor(pi: ExtensionAPI) {
  const pending = new Map<
    string,
    (ctx: ExtensionCommandContext) => Promise<void>
  >();
  const dispatch = (id: string, ctx: ExtensionCommandContext) =>
    pending.get(id)?.(ctx);
  const edit = async (
    ctx: ExtensionContext,
    entry: string,
    at: number,
    text: string,
    linked: () => boolean,
  ) => {
    const session = ctx.sessionManager.getSessionId();
    const target = ctx.sessionManager.getBranch().find((e) => e.id === entry);
    if (target?.type !== "message" || target.message.role !== "user")
      throw new Error("This input is no longer on the current branch");
    const images =
      typeof target.message.content === "string"
        ? []
        : target.message.content.filter((part) => part.type === "image");
    if (!ctx.isIdle()) {
      ctx.abort();
      while (!ctx.isIdle() && linked())
        await new Promise((done) => setTimeout(done, 25));
    }
    if (!linked()) throw new Error("The session is no longer connected");
    const id = randomUUID();
    const done = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      if (pending.delete(id))
        done.reject(new Error("pi did not take the edit command"));
    }, 4000);
    pending.set(id, async (command) => {
      pending.delete(id);
      clearTimeout(timer);
      try {
        if (
          !linked() ||
          command.sessionManager.getSessionId() !== session ||
          !command.sessionManager.getBranch().some((e) => e.id === entry)
        )
          throw new Error("The session changed before the edit");
        // Navigating to the current leaf is a no-op in pi. Give a last user message a child first.
        if (command.sessionManager.getLeafId() === entry)
          pi.appendEntry("zerolux-edit-anchor", {});
        const result = await command.navigateTree(entry, { summarize: false });
        if (
          result.cancelled ||
          command.sessionManager.getLeafId() !== target.parentId
        )
          throw new Error("pi did not return to this input");
        // Its old branch stays in pi's tree. Readers of the append-only file show only the edit.
        pi.appendEntry("zerolux-input-edited", { at });
        pi.sendUserMessage(
          images.length ? [{ type: "text", text }, ...images] : text,
          { expandPromptTemplates: true },
        );
        done.resolve();
      } catch (error) {
        done.reject(error);
      }
    });
    try {
      pi.sendUserMessage(`/zerolux-chat edit-input ${id}`, {
        expandPromptTemplates: true,
      });
      await done.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  return { edit, dispatch };
}
