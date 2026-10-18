import { sessionBlocks, subagentName, useSessionEvents } from "@zerolux/chat";
import type { ChatSession, Subagent } from "@zerolux/chat";
import type { ChatTitle } from "@/components/tool-call";
import { SessionBlocks } from "@/components/session-blocks";
import { Button } from "@/components/ui/button";
import { Pane } from "./SessionCode";

/**
 * A subagent's work, read like a session's: its own record, all of it as the session's grows,
 * with earlier work on request.
 */
export function SubagentPanel({
  session,
  subagent,
  grown,
  chatTitle,
  close,
}: {
  session: ChatSession;
  subagent: Subagent;
  /** Where the session's record ends: the subagent's is read again as it grows. */
  grown: number | undefined;
  chatTitle?: ChatTitle;
  close: () => void;
}) {
  const { events, error, more, earlier } = useSessionEvents(
    session.id,
    grown,
    subagent.id,
  );
  const blocks = sessionBlocks(events);
  return (
    <Pane
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{subagentName(subagent)}</span>
          {subagent.kind && subagent.kind !== subagentName(subagent) && (
            <span className="shrink-0 font-mono text-[11px] font-normal text-faint">
              {subagent.kind}
            </span>
          )}
        </span>
      }
      close={close}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {subagent.description && (
          <p className="text-sm text-muted-foreground">
            {subagent.description}
          </p>
        )}
        {more && (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            onClick={earlier}
          >
            Show earlier work
          </Button>
        )}
        <SessionBlocks blocks={blocks} chatTitle={chatTitle} />
        {!blocks.length && !error && (
          <p className="text-sm text-faint">Nothing recorded yet.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Pane>
  );
}

/** The subagents the session started, the latest first, each opened beside its work. */
export function SubagentList({
  subagents,
  open,
}: {
  subagents: Subagent[];
  open: (id: string) => void;
}) {
  return (
    <section
      aria-label="Subagents"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <h3 className="text-sm font-medium">
        Subagents
        <span className="ml-1.5 font-mono text-[11px] text-faint">
          {subagents.length}
        </span>
      </h3>
      <ul className="flex flex-col">
        {subagents.map((subagent) => (
          <li key={subagent.id}>
            <button
              type="button"
              onClick={() => open(subagent.id)}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
            >
              <span className="truncate text-sm">{subagentName(subagent)}</span>
              {subagent.description &&
                subagent.description !== subagentName(subagent) && (
                  <span className="truncate text-xs text-muted-foreground">
                    {subagent.description}
                  </span>
                )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
