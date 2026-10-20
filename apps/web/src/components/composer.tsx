import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  LoaderCircleIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  audioLevel,
  composerAction,
  dictated,
  HOLD_MS,
  useVoiceInput,
} from "@zerolux/chat";
import type { VoiceTargets, VoiceUse } from "@zerolux/chat";
import { cn } from "cn";
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
/** How far left a held Dictate or Record is slid to drop its recording, in pixels. */
const CANCEL = 110;

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
  box?: RefObject<HTMLTextAreaElement | null>;
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
  const own = useRef<HTMLTextAreaElement>(null);
  const field = box ?? own;
  const speech = useVoiceInput(recorder, {
    ...voice,
    write: (said) => setText(dictated(text, said)),
  });
  const [holding, setHolding] = useState(false);
  const menuHold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const opened = useRef(false);
  // The box grows with its text, however it came (typed, dictated, a draft brought back),
  // up to a few lines; then it scrolls. Back from a recording, it is drawn anew.
  useLayoutEffect(() => {
    const at = field.current;
    if (!at) return;
    at.style.height = "auto";
    at.style.height = `${at.scrollHeight}px`;
  }, [field, text, speech.use, speech.transcribing]);
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
  // A tap records on until the next press; a hold records until it is released, and sliding
  // the held button left drops the recording. The pointer stays with the button, so the
  // release reaches it; a key press is a tap.
  const [held, setHeld] = useState<"mic" | "primary">();
  const [slide, setSlide] = useState(0);
  const [binned, setBinned] = useState(false);
  const touch = useRef<{
    x: number;
    timer?: ReturnType<typeof setTimeout>;
    dropped: boolean;
  }>(null);
  const letGo = () => {
    clearTimeout(touch.current?.timer);
    touch.current = null;
    setHeld(undefined);
    setSlide(0);
  };
  const talk = (
    use: VoiceUse,
    holder: "mic" | "primary",
  ): ComponentProps<"button"> => ({
    onPointerDown: (event) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      // A press that ends a recording is not held.
      const ending = !!speech.use;
      speech.press(use);
      touch.current = {
        x: event.clientX,
        dropped: false,
        timer: ending ? undefined : setTimeout(() => setHeld(holder), HOLD_MS),
      };
    },
    onPointerMove: (event) => {
      const at = touch.current;
      if (!held || !at || at.dropped) return;
      const dx = event.clientX - at.x;
      setSlide(Math.max(-CANCEL, Math.min(0, dx)));
      if (dx > -CANCEL) return;
      at.dropped = true;
      speech.discard();
      letGo();
      setBinned(true);
      navigator.vibrate?.(30);
      setTimeout(() => setBinned(false), 900);
    },
    onPointerUp: () => {
      const dropped = touch.current?.dropped;
      letGo();
      if (!dropped) speech.release();
    },
    onPointerCancel: () => {
      letGo();
      speech.release();
    },
    onClick: (event) => {
      if (event.detail !== 0) return;
      speech.press(use);
      speech.release();
    },
  });
  // The held button grows and follows the pointer; let go, it springs back.
  const lifted = (holder: "mic" | "primary") =>
    held === holder
      ? {
          className: "relative z-10 shadow-lg",
          style: {
            transform: `translateX(${slide}px) scale(1.18)`,
            transition: slide ? "none" : undefined,
          },
        }
      : undefined;
  const voiced =
    action === "record"
      ? talk("message", "primary")
      : speech.use
        ? talk(speech.use, "primary")
        : undefined;
  const button = voiced ? (
    <Button
      type="button"
      size="icon-sm"
      aria-label={primary.label}
      title={primary.label}
      disabled={primary.disabled}
      {...voiced}
      style={lifted("primary")?.style}
      className={cn(
        "size-8 shrink-0 rounded-full transition-transform duration-300 ease-[cubic-bezier(0.3,1.45,0.5,1)]",
        lifted("primary")?.className,
      )}
    >
      {primary.icon}
    </Button>
  ) : (
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
        menuHold.current = setTimeout(() => {
          opened.current = true;
          setHolding(true);
        }, HOLD);
      }}
      onPointerUp={() => clearTimeout(menuHold.current)}
      onPointerLeave={() => clearTimeout(menuHold.current)}
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
          {chips && !speech.use && !binned && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">{chips}</div>
          )}
          {binned ? (
            <div className="flex min-h-11 items-center px-3.5 pt-2.5">
              <Trash2Icon
                aria-label="Discarded"
                className="composer-bin size-5 text-destructive"
              />
            </div>
          ) : speech.use ? (
            <div
              role="status"
              className="flex min-h-11 items-center gap-2.5 px-3.5 pt-2.5 text-sm"
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive"
              />
              <span className="shrink-0 font-mono">
                {speech.use === "dictation" ? "Listening" : "Recording"} ·{" "}
                {clock}
              </span>
              <Wave level={recorder.level} />
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
              ref={field}
              aria-label={label}
              rows={1}
              value={text}
              disabled={!open}
              placeholder={placeholder}
              onChange={(event) => setText(event.target.value)}
              className="max-h-48 min-h-11 resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-sm outline-none placeholder:text-faint disabled:opacity-60"
            />
          )}
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            {speech.use && held ? (
              <span
                className="flex animate-in items-center gap-1 px-1.5 text-sm whitespace-nowrap text-muted-foreground fade-in duration-150"
                style={{
                  opacity: Math.max(0, Math.min(1, 1 + slide / (CANCEL * 0.9))),
                  transform: `translateX(${slide / 2}px)`,
                }}
              >
                <ChevronLeftIcon className="composer-nudge size-4 text-faint" />
                Slide to cancel
              </span>
            ) : speech.use || binned ? (
              !binned && (
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
              )
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
            {canDictate && speech.use !== "message" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Dictate"
                title="Dictate"
                aria-pressed={speech.use === "dictation"}
                disabled={busy || speech.transcribing}
                {...talk("dictation", "mic")}
                style={lifted("mic")?.style}
                className={cn(
                  "transition-transform duration-300 ease-[cubic-bezier(0.3,1.45,0.5,1)] aria-pressed:bg-destructive/12 aria-pressed:text-destructive",
                  lifted("mic")?.className,
                )}
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

/** How many bars the wave holds, and how often a new one comes in on the right. */
const BARS = 34;
const EVERY = 80;

/** What the microphone hears, as bars scrolling left: a new one every 80 ms, flat in silence. */
function Wave({ level }: { level: () => number }) {
  const [bars, setBars] = useState<number[]>(() => Array(BARS).fill(0));
  const read = useRef(level);
  read.current = level;
  useEffect(() => {
    const timer = setInterval(
      () => setBars((all) => [...all.slice(1), audioLevel(read.current())]),
      EVERY,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <span aria-hidden className="flex h-6 min-w-0 flex-1 items-center gap-0.5">
      {bars.map((bar, i) => (
        <i
          key={i}
          className="max-w-[3px] min-w-0.5 flex-1 rounded-full bg-foreground/70"
          style={{ height: `max(2px, ${bar * 100}%)` }}
        />
      ))}
    </span>
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
