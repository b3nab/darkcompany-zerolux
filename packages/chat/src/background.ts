import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import { spanLabel } from "./session-events";

/** A command a session runs in the background, in its folder on the kernel's computer. */
export interface BackgroundCommand {
  id: string;
  session_id: string;
  command: string;
  folder: string;
  status: "running" | "exited" | "stopped" | "lost";
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  /** When the session was given how it ended. */
  told_at: number | null;
  error: string | null;
}

/** A piece of a background command's output from an offset, and where to read on. */
export interface BackgroundOutput {
  start: number;
  text: string;
  next: number;
  /** How long the output is now. */
  end: number;
}

/** The kernel's notice that a background command started, ended or was stopped. */
export interface BackgroundNotice {
  type: "background_command.changed";
  background_command_id: string;
  session_id: string;
  status: BackgroundCommand["status"];
}

const states: Record<BackgroundCommand["status"], string> = {
  running: "Running",
  exited: "Exited",
  stopped: "Stopped",
  lost: "Lost",
};

/** A background command in a few words: how it stands, with its exit code, and how long it ran. */
export function backgroundState(command: BackgroundCommand, now = Date.now()) {
  const end = command.status === "running" ? now : command.ended_at;
  return [
    command.status === "exited" && command.exit_code !== null
      ? `Exited ${command.exit_code}`
      : states[command.status],
    end === null ? null : spanLabel(end - command.started_at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Output as plain text: without the escape codes a terminal reads (colors, cursor moves), and
 * with each line as a carriage return last rewrote it, as a progress bar ends.
 */
export const plainOutput = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(
      /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g,
      "",
    )
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n");

/** How much of a background command's output is kept to show: its end. */
const KEPT = 200_000;
/** How often a running background command's output is read. */
const EVERY = 1000;

const listeners = new Map<string, Set<() => void>>();

/** A session's background command changed: its lists read again. */
export function backgroundNotice(notice: BackgroundNotice) {
  listeners.get(notice.session_id)?.forEach((read) => read());
}

/** Notices may have been missed, as after a reconnection: every list reads again. */
export function backgroundResync() {
  listeners.forEach((reads) => reads.forEach((read) => read()));
}

const sessionPath = (id: string) =>
  `/sessions/${encodeURIComponent(id)}/background-commands`;
const commandPath = (id: string) =>
  `/background-commands/${encodeURIComponent(id)}`;

/**
 * A session's background commands, newest first, read again when one changes; and its
 * person's way to run and stop them. Nothing is read without a session.
 */
export function useBackgroundCommands(
  sessionId: string | undefined,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    commands?: BackgroundCommand[];
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<{ background_commands: BackgroundCommand[] }>(
            kernel,
            sessionPath(sessionId),
          ).then(
            ({ background_commands }) =>
              setRead({ session, commands: background_commands }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.session === session ? was : { session }),
                error: errorMessage(error),
              })),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => {
    if (sessionId === undefined) return;
    void reload();
    const read = () => void reload();
    const reads = listeners.get(sessionId) ?? new Set();
    reads.add(read);
    listeners.set(sessionId, reads);
    return () => {
      reads.delete(read);
      if (!reads.size) listeners.delete(sessionId);
    };
  }, [sessionId, reload]);
  const current = read?.session === session ? read : undefined;
  // The command as the kernel answered, once the list has it too.
  const andReload = async (
    work: Promise<{ background_command: BackgroundCommand }>,
  ) => {
    const { background_command } = await work;
    await reload();
    return background_command;
  };
  return {
    commands: current?.commands,
    error: current?.error ?? "",
    reload,
    run: (command: string) =>
      andReload(request(kernel, sessionPath(sessionId!), { command })),
    stop: (id: string) =>
      andReload(request(kernel, `${commandPath(id)}/stop`, {})),
  };
}

/** Where reading a background command's output stands: the last part read, and the offset to go on. */
export interface BackgroundReading {
  text: string;
  next: number;
}

/**
 * Reads a background command's output on from where `at` stands to the end there is now, in the kernel's
 * bounded pieces, keeping its last part.
 */
export async function readBackgroundOutput(
  id: string,
  at: BackgroundReading,
  kernel = kernelUrl(),
) {
  for (;;) {
    const from = at.next;
    const { output } = await request<{ output: BackgroundOutput }>(
      kernel,
      `${commandPath(id)}?after=${from}`,
    );
    // Another read took this piece meanwhile, and goes on from there.
    if (at.next !== from) return at;
    const moved = output.next > at.next;
    at.text = (at.text + output.text).slice(-KEPT);
    at.next = output.next;
    // A character cut at the end waits for the next read.
    if (!moved || output.next >= output.end) return at;
  }
}

/**
 * A background command's output as it grows, its last part kept: read on every second while it runs,
 * and once more when it has ended.
 */
export function useBackgroundOutput(
  id: string | undefined,
  running: boolean,
  kernel = kernelUrl(),
) {
  const key = `${kernel}\n${id}`;
  const [shown, setShown] = useState<{
    key: string;
    text: string;
    error?: string;
  }>();
  // Where reading goes on: kept across the command's end, started over for another one.
  const reading = useRef({ key: "", text: "", next: 0 });
  useEffect(() => {
    if (id === undefined) return;
    if (reading.current.key !== key)
      reading.current = { key, text: "", next: 0 };
    const at = reading.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readOn = async () => {
      try {
        await readBackgroundOutput(id, at, kernel);
        if (!stopped) setShown({ key, text: at.text });
      } catch (error) {
        if (!stopped)
          setShown({ key, text: at.text, error: errorMessage(error) });
      }
      if (running && !stopped) timer = setTimeout(() => void readOn(), EVERY);
    };
    void readOn();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, running, kernel, key]);
  const current = shown?.key === key ? shown : undefined;
  return { text: current?.text ?? "", error: current?.error ?? "" };
}
