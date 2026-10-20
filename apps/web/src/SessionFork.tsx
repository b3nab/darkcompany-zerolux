import { useState } from "react";
import { HistoryIcon, PencilIcon } from "lucide-react";
import type { FilesRewind, Perform } from "@zerolux/chat";
import type { InputBlock } from "@/components/session-blocks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** A fork of the session, from all of it or from before the input at `at`, with words to start. */
export type Fork = (at?: number, text?: string) => Promise<boolean>;

/**
 * What the owner does from one of the session's inputs: write it again in a new session that
 * goes on from before it, this one left as it is; or, where the harness keeps checkpoints, put
 * the files back as they were before it, after seeing what that changes.
 */
export function InputActions({
  input,
  fork,
  rewind,
  busy,
  perform,
}: {
  input: InputBlock;
  /** Writing it again in a fork: its person's. */
  fork?: Fork;
  /** The files as they were before the input; with `dryRun`, only what that would change. */
  rewind?: (at: number, dryRun: boolean) => Promise<FilesRewind>;
  busy: boolean;
  perform: Perform;
}) {
  const [editing, setEditing] = useState<string>();
  const [rewinding, setRewinding] = useState<FilesRewind>();
  if (editing !== undefined)
    return (
      <form
        aria-label="Edit and send again"
        className="flex w-full max-w-[min(40rem,85%)] flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (editing.trim()) void fork?.(input.at, editing.trim());
        }}
      >
        <Textarea
          aria-label="Input"
          value={editing}
          rows={3}
          autoFocus
          onChange={(event) => setEditing(event.target.value)}
          className="text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing(undefined)}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !editing.trim()}>
            Send in a new session
          </Button>
        </div>
      </form>
    );
  if (rewinding)
    return (
      <div
        role="alert"
        className="flex max-w-[min(40rem,85%)] flex-col gap-2 rounded-md bg-attention/10 p-3 text-sm"
      >
        {rewinding.canRewind ? (
          <>
            <p>
              Rewind {rewinding.filesChanged?.length ?? 0}{" "}
              {rewinding.filesChanged?.length === 1 ? "file" : "files"} to
              before this input
              {rewinding.insertions !== undefined &&
                ` (+${rewinding.insertions} −${rewinding.deletions ?? 0})`}
              ?
            </p>
            {!!rewinding.filesChanged?.length && (
              <ul className="font-mono text-[11px] text-muted-foreground">
                {rewinding.filesChanged.map((file) => (
                  <li key={file} className="truncate">
                    {file}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>Cannot rewind: {rewinding.error}</p>
        )}
        <div className="flex gap-2">
          {rewinding.canRewind && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(
                  async () => void (await rewind!(input.at, false)),
                ).then((done) => done && setRewinding(undefined))
              }
            >
              Rewind
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRewinding(undefined)}
          >
            {rewinding.canRewind ? "Keep them" : "Close"}
          </Button>
        </div>
      </div>
    );
  return (
    <span className="flex gap-1 opacity-0 transition-opacity group-hover/input:opacity-100 focus-within:opacity-100">
      {fork && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-faint"
          disabled={busy}
          onClick={() => setEditing(input.text)}
        >
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
      )}
      {rewind && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-faint"
          disabled={busy}
          onClick={() =>
            void perform(async () => setRewinding(await rewind(input.at, true)))
          }
        >
          <HistoryIcon data-icon="inline-start" />
          Rewind files
        </Button>
      )}
    </span>
  );
}

/** A question asked in a fork of the session, so the session itself is not touched. */
export function AskOnTheSide({
  open,
  close,
  fork,
  busy,
}: {
  open: boolean;
  close: () => void;
  fork: Fork;
  busy: boolean;
}) {
  const [question, setQuestion] = useState("");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ask on the side</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim())
              void fork(undefined, question.trim()).then((done) => {
                if (!done) return;
                setQuestion("");
                close();
              });
          }}
        >
          <Textarea
            aria-label="Question"
            placeholder="Question"
            value={question}
            rows={3}
            autoFocus
            onChange={(event) => setQuestion(event.target.value)}
          />
          <Button type="submit" disabled={busy || !question.trim()}>
            Ask in a new session
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
