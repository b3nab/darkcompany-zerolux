import { useRef, useState } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  LoaderCircleIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { composerAction, dictated, useVoiceInput } from "@zerolux/chat";
import type { VoiceTargets } from "@zerolux/chat";
import { useRecorder } from "../recorder";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** What "+" adds to what goes: files, images. */
export interface ComposerAdd {
  label: string;
  icon: ReactNode;
  take: () => void;
}

/** Holding the primary button long enough opens its other ways to send. */
const HOLD = 450;

/**
 * Where you write, to a chat or a session: one card holding what goes with the text, the
 * text, and one row of controls ending in the primary button, the only filled one. It
 * records while empty, sends with text, and interrupts a working agent; dictation and
 * recording take the text's place, then its words come.
 */
export function Composer({
  label,
  placeholder,
  text,
  setText,
  extra = false,
  open,
  busy,
  working = false,
  blocked = false,
  box,
  textarea,
  form,
  above,
  chips,
  add,
  settings,
  meter,
  error,
  send,
  later,
  interrupt,
  voice,
}: {
  /** Names the box for screen readers. */
  label: string;
  placeholder: string;
  text: string;
  setText: (text: string) => void;
  /** Something goes besides the text, as images: Send stands even with no words. */
  extra?: boolean;
  /** It can be written to. */
  open: boolean;
  busy: boolean;
  /** The agent works: with the box empty the primary button interrupts it. */
  working?: boolean;
  /** What is written cannot go, as too long: Send waits. */
  blocked?: boolean;
  box?: Ref<HTMLTextAreaElement>;
  /** The text's own keys, pasting and selection, as each composer reads them. */
  textarea?: Pick<
    ComponentProps<"textarea">,
    "onKeyDown" | "onPaste" | "onSelect"
  >;
  form?: Pick<ComponentProps<"form">, "onDragOver" | "onDrop">;
  /** Above the card: the queue, the plan, suggestions. */
  above?: ReactNode;
  /** In the card, above the text: what goes with it. */
  chips?: ReactNode;
  add?: ComposerAdd[];
  /** In the row, after "+": the session's settings. */
  settings?: ReactNode;
  /** In the row, before the microphone: how full the context is. */
  meter?: ReactNode;
  error?: string;
  send: () => void;
  /** Other ways to send while the agent works, on holding the primary button. */
  later?: { queue: () => void; stop: () => void };
  interrupt?: () => void;
  /** Where speech goes; without transcription only a kept recording remains. */
  voice: Omit<VoiceTargets, "write">;
}) {
  const recorder = useRecorder();
  const speech = useVoiceInput(recorder, {
    ...voice,
    write: (said) => setText(dictated(text, said)),
  });
  const [holding, setHolding] = useState(false);
  const held = useRef<ReturnType<typeof setTimeout>>(undefined);
  const opened = useRef(false);
  const filled = !!text.trim() || extra;
  const canDictate = open && voice.transcription;
  const clock = `${Math.floor(recorder.seconds / 60)}:${String(recorder.seconds % 60).padStart(2, "0")}`;
  const ways = working && filled && later;

  const action = composerAction({
    filled,
    interruptible: working && !!interrupt,
    recordable: open && (voice.transcription || !!voice.keep),
    voice: speech.use,
    transcribing: speech.transcribing,
  });
  const primary = {
    write: {
      label: "Write it",
      icon: <CheckIcon />,
      take: () => void speech.finish(),
      disabled: false,
    },
    send: speech.use
      ? {
          label: "Send",
          icon: <ArrowUpIcon />,
          take: () => void speech.finish(),
          disabled: false,
        }
      : {
          label: "Send",
          icon: <ArrowUpIcon />,
          take: send,
          disabled: busy || !open || !filled || blocked,
        },
    transcribing: {
      label: "Transcribing",
      icon: <LoaderCircleIcon className="animate-spin" />,
      take: () => {},
      disabled: true,
    },
    interrupt: {
      label: "Interrupt",
      icon: <SquareIcon />,
      take: () => interrupt?.(),
      disabled: busy,
    },
    record: {
      label: "Record",
      icon: <AudioLinesIcon />,
      take: () => void speech.start("message"),
      disabled: busy,
    },
  }[action];

  const submits = action === "send" && !speech.use;
  const button = (
    <Button
      type={submits ? "submit" : "button"}
      size="icon-sm"
      aria-label={primary.label}
      title={primary.label}
      disabled={primary.disabled}
      className="size-8 shrink-0 rounded-full"
      onClick={(event) => {
        // A hold that opened the other ways to send is not a click.
        if (opened.current) {
          event.preventDefault();
          opened.current = false;
        } else if (!submits) primary.take();
      }}
      onPointerDown={() => {
        if (!ways) return;
        held.current = setTimeout(() => {
          opened.current = true;
          setHolding(true);
        }, HOLD);
      }}
      onPointerUp={() => clearTimeout(held.current)}
      onPointerLeave={() => clearTimeout(held.current)}
      onContextMenu={(event) => {
        if (!ways) return;
        event.preventDefault();
        setHolding(true);
      }}
    >
      {primary.icon}
    </Button>
  );

  return (
    <form
      {...form}
      className="flex flex-col gap-2 border-t px-3 pt-3 pb-3 md:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (submits && !primary.disabled) send();
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {above}
        {(error || speech.error) && (
          <p role="alert" className="text-xs text-destructive">
            {error || speech.error}
          </p>
        )}
        <div className="flex flex-col rounded-xl border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
          {chips && !speech.use && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">{chips}</div>
          )}
          {speech.use ? (
            <div
              role="status"
              className="flex min-h-11 items-center gap-2.5 px-3.5 pt-2.5 font-mono text-sm"
            >
              <span
                aria-hidden
                className="size-2.5 animate-pulse rounded-full bg-destructive"
              />
              {speech.use === "dictation" ? "Listening" : "Recording"} · {clock}
            </div>
          ) : speech.transcribing ? (
            <div
              role="status"
              className="flex min-h-11 items-center gap-2.5 px-3.5 pt-2.5 text-sm text-muted-foreground"
            >
              <LoaderCircleIcon className="size-4 animate-spin" />
              Transcribing…
            </div>
          ) : (
            <textarea
              {...textarea}
              ref={box}
              aria-label={label}
              rows={1}
              value={text}
              disabled={!open}
              placeholder={placeholder}
              onChange={(event) => {
                // Grows with the text, up to a few lines; then it scrolls.
                event.target.style.height = "auto";
                event.target.style.height = `${event.target.scrollHeight}px`;
                setText(event.target.value);
              }}
              className="max-h-48 min-h-11 resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-sm outline-none placeholder:text-faint disabled:opacity-60"
            />
          )}
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            {speech.use ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Discard"
                title="Discard"
                onClick={speech.discard}
              >
                <XIcon />
              </Button>
            ) : (
              <>
                {add && add.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={!open || speech.transcribing}
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Add"
                          title="Add"
                        />
                      }
                    >
                      <PlusIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      {add.map((item) => (
                        <DropdownMenuItem key={item.label} onClick={item.take}>
                          {item.icon}
                          {item.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {settings}
              </>
            )}
            <span className="flex-1" />
            {!speech.use && meter}
            {!speech.use && canDictate && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Dictate"
                title="Dictate"
                disabled={busy || speech.transcribing}
                onClick={() => void speech.start("dictation")}
              >
                <MicIcon />
              </Button>
            )}
            {ways ? (
              <DropdownMenu
                open={holding}
                onOpenChange={(open) => !open && setHolding(false)}
              >
                <span className="relative flex">
                  {button}
                  <DropdownMenuTrigger
                    nativeButton={false}
                    tabIndex={-1}
                    aria-hidden
                    render={
                      <span className="pointer-events-none absolute inset-0" />
                    }
                  />
                </span>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={later.queue}>
                    When the turn ends
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={later.stop}>
                    Stop and send
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              button
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

/** A picked image or file in the card, with its ✕. */
export function ComposerChip({
  children,
  remove,
  name,
}: {
  children: ReactNode;
  remove: () => void;
  name: string;
}) {
  return (
    <span className="relative">
      {children}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={remove}
        className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
