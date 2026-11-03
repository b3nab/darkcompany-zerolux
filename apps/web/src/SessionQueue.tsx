import { useState } from "react";
import {
  GripVerticalIcon,
  ImageIcon,
  PencilIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type { InputMode, QueueItem, QueuedInput } from "@zerolux/chat";
import { Button } from "@/components/ui/button";

/**
 * How Enter sends: into ZeroLux's queue, for a turn of its own (at rest with nothing queued it
 * starts one at once); with ⌘ or Ctrl while the session works, into the turn in progress.
 */
export const sendModeOf = (
  keys: { metaKey: boolean; ctrlKey: boolean },
  working: boolean,
): InputMode => ((keys.metaKey || keys.ctrlKey) && working ? "steer" : "queue");

/** `ids` with the one at `from` moved to `to`: a queue put in a new order. */
export function moved(ids: string[], from: number, to: number) {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  if (id !== undefined) next.splice(to, 0, id);
  return next;
}

/** What can be done with a session's queue: by whoever may write to it. */
export interface QueueActions {
  edit: (item: QueueItem, text: string) => Promise<boolean>;
  remove: (item: QueueItem) => Promise<boolean>;
  /** Into the turn in progress, or a turn of its own at rest. */
  send: (item: QueueItem) => Promise<boolean>;
  order: (ids: string[]) => Promise<boolean>;
  clear: () => Promise<boolean>;
}

/**
 * Above the box: the inputs ZeroLux keeps for the session's next turns, in the order they will
 * go, one a turn. Each is rewritten in place, sent now, taken out or dragged to another place;
 * the whole queue emptied. Below them, the words already given to the turn in progress that the
 * harness has not taken yet.
 */
export function SessionQueue({
  queue,
  steering,
  busy,
  act,
}: {
  queue: QueueItem[];
  /** Inputs given to the running turn, its harness still to take them. */
  steering: QueuedInput[];
  busy: boolean;
  act?: QueueActions;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [dragged, setDragged] = useState<number>();
  const ids = queue.map((item) => item.id);
  const save = (item: QueueItem) => {
    const text = editing?.text.trim();
    if (text && act)
      void act.edit(item, text).then((done) => {
        if (done) setEditing(undefined);
      });
  };
  const move = (from: number, to: number) => {
    if (act && to >= 0 && to < queue.length && to !== from)
      void act.order(moved(ids, from, to));
  };
  if (!queue.length && !steering.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
      {queue.length > 0 && (
        <div className="flex items-center justify-between px-1 font-mono text-[11px] text-faint">
          <span>Queued · {queue.length}</span>
          {act && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act.clear()}
              className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <ol aria-label="Queue" className="flex flex-col gap-1.5">
        {queue.map((item, at) => (
          <li
            key={item.id}
            draggable={!!act && editing?.id !== item.id}
            onDragStart={(event) => {
              setDragged(at);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (dragged !== undefined) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged !== undefined) move(dragged, at);
              setDragged(undefined);
            }}
            onDragEnd={() => setDragged(undefined)}
            className={cn(
              "group/queued flex items-start gap-1.5 rounded-md border bg-card py-1.5 pr-1.5 pl-1 text-sm",
              dragged === at && "opacity-50",
            )}
          >
            {act && (
              <button
                type="button"
                aria-label="Move"
                title="Move"
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onKeyDown={(event) => {
                  if (!event.altKey) return;
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    move(at, at + (event.key === "ArrowUp" ? -1 : 1));
                  }
                }}
                className="mt-0.5 flex size-5 shrink-0 cursor-grab items-center justify-center text-faint hover:text-foreground"
              >
                <GripVerticalIcon className="size-3.5" />
              </button>
            )}
            {editing?.id === item.id ? (
              // Not a form: the stack sits inside the box's own.
              <div
                role="group"
                aria-label="Edit queued input"
                className="flex min-w-0 flex-1 flex-col gap-2"
              >
                <textarea
                  aria-label="Queued input"
                  value={editing.text}
                  autoFocus
                  rows={2}
                  onChange={(event) =>
                    setEditing({ id: item.id, text: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(undefined);
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      save(item);
                    }
                  }}
                  className="min-h-14 resize-none rounded-sm border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !editing.text.trim()}
                    onClick={() => save(item)}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-0.5 line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">
                {item.text}
              </p>
            )}
            {item.images.length > 0 && editing?.id !== item.id && (
              <span className="mt-1 flex shrink-0 items-center gap-1 font-mono text-[11px] text-faint">
                <ImageIcon aria-hidden className="size-3" />
                {item.images.length}
              </span>
            )}
            {act && editing?.id !== item.id && (
              <span className="flex shrink-0 gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Send now"
                  title="Send now"
                  disabled={busy}
                  onClick={() => void act.send(item)}
                >
                  <SendHorizontalIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit"
                  title="Edit"
                  disabled={busy}
                  onClick={() => setEditing({ id: item.id, text: item.text })}
                >
                  <PencilIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove"
                  title="Remove"
                  disabled={busy}
                  onClick={() => void act.remove(item)}
                >
                  <XIcon />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {steering.length > 0 && (
        <ul aria-label="Into this turn" className="flex flex-col gap-1.5">
          {steering.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground"
            >
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-faint">
                Into this turn
              </span>
              <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">
                {item.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
