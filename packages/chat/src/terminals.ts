import { kernelUrl, request } from "./client";

/** A shell the kernel runs in a session's folder, for its owner. */
export interface TerminalInfo {
  id: string;
  session_id: string;
  folder: string;
  cols: number;
  rows: number;
  /** How much output it has produced: the offset its next byte will have. */
  end: number;
  exit_code: number | null;
  ended: boolean;
}

/** A piece of its output after an offset, base64, and where to read on. */
export interface TerminalOutput {
  /** Where the output kept now begins: what came before it is gone. */
  start: number;
  data: string;
  next: number;
  ended: boolean;
}

/** The kernel's notice that a terminal produced more, or ended. */
export interface TerminalNotice {
  type: "terminal.output";
  terminal_id: string;
  session_id: string;
  end: number;
  ended: boolean;
}

const path = (id: string) => `/terminals/${encodeURIComponent(id)}`;

export const sessionTerminals = (sessionId: string, kernel = kernelUrl()) =>
  request<{ terminals: TerminalInfo[] }>(
    kernel,
    `/sessions/${encodeURIComponent(sessionId)}/terminals`,
  ).then(({ terminals }) => terminals);

export const openTerminal = (
  sessionId: string,
  size: { cols: number; rows: number },
  kernel = kernelUrl(),
) =>
  request<{ terminal: TerminalInfo }>(
    kernel,
    `/sessions/${encodeURIComponent(sessionId)}/terminals`,
    size,
  ).then(({ terminal }) => terminal);

/** What is typed, as text: keys and control characters as the terminal reads them. */
export const writeTerminal = (id: string, data: string, kernel = kernelUrl()) =>
  request<{ sent: boolean }>(kernel, `${path(id)}/input`, { data });

export const resizeTerminal = (
  id: string,
  size: { cols: number; rows: number },
  kernel = kernelUrl(),
) => request<{ terminal: TerminalInfo }>(kernel, `${path(id)}/resize`, size);

export const closeTerminal = (id: string, kernel = kernelUrl()) =>
  request<unknown>(kernel, path(id), undefined, undefined, "DELETE");

/** Reads a terminal's output after an offset, from the kernel. */
export const terminalReader =
  (id: string, kernel = kernelUrl()) =>
  (after: number) =>
    request<{ output: TerminalOutput }>(
      kernel,
      `${path(id)}?after=${after}`,
    ).then(({ output }) => output);

interface Followed {
  read: (after: number) => Promise<TerminalOutput>;
  write: (data: string) => void;
  ended: () => void;
  next: number;
  reading: boolean;
  /** A notice came while reading: read once more after. */
  again: boolean;
  done: boolean;
}
const followed = new Map<string, Followed>();

async function catchUp(id: string) {
  const terminal = followed.get(id);
  if (!terminal || terminal.reading || terminal.done) {
    if (terminal) terminal.again = true;
    return;
  }
  terminal.reading = true;
  try {
    // Pieces are bounded: read on until there is nothing more, in order.
    for (;;) {
      terminal.again = false;
      const output = await terminal.read(terminal.next);
      if (followed.get(id) !== terminal) return;
      if (output.data) terminal.write(output.data);
      const moved = output.next !== terminal.next;
      terminal.next = output.next;
      if (output.ended) {
        terminal.done = true;
        terminal.ended();
        return;
      }
      if (!moved && !terminal.again) return;
    }
  } catch {
    // The next notice, or reconnection, reads again.
  } finally {
    terminal.reading = false;
  }
}

/**
 * Follows a terminal's output, from all that is kept, in order: each piece goes to `write`
 * as base64, as a terminal emulator takes it; `ended` when the shell has exited. Returns the
 * way to stop following.
 */
export function followTerminal(
  id: string,
  read: (after: number) => Promise<TerminalOutput>,
  write: (data: string) => void,
  ended: () => void,
) {
  const terminal: Followed = {
    read,
    write,
    ended,
    next: 0,
    reading: false,
    again: false,
    done: false,
  };
  followed.set(id, terminal);
  void catchUp(id);
  return () => {
    if (followed.get(id) === terminal) followed.delete(id);
  };
}

/** The kernel's notice that a followed terminal has more: it reads on. */
export function terminalNotice(notice: TerminalNotice) {
  const terminal = followed.get(notice.terminal_id);
  if (terminal && (notice.end > terminal.next || notice.ended))
    void catchUp(notice.terminal_id);
}

/** After a reconnection, every followed terminal reads on: notices may have been missed. */
export function terminalResync() {
  followed.forEach((_, id) => void catchUp(id));
}
