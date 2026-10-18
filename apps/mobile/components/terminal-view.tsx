"use dom";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { Ref } from "react";
import { useDOMImperativeHandle } from "expo/dom";
import type { DOMImperativeFactory, DOMProps } from "expo/dom";

/** What the app passes to the terminal's methods: JSON, as Expo carries it. */
type Json = Parameters<DOMImperativeFactory[string]>[number];

/** What the app tells the terminal. */
export interface TerminalHandle extends DOMImperativeFactory {
  /** Output as the kernel sends it, base64. */
  write: (data: Json) => void;
  /** A key from the app's row: an arrow by name, as the program asks for it, else its text. */
  press: (key: Json) => void;
  /** Empties it, for another shell. */
  reset: () => void;
}

// The ANSI colors on a light background, as VS Code's light terminal has them; the dark
// background keeps xterm's own.
const LIGHT = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

const ARROWS: Record<string, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/**
 * A session's terminal, drawn by xterm.js inside Expo's DOM component, as a terminal app
 * draws it: colors, cursor and scrollback. What is typed goes to `onData`; its size in
 * characters, whenever it changes, to `onSize`.
 */
export default function TerminalView({
  ref,
  colors,
  dark,
  onData,
  onSize,
  dom,
}: {
  ref: Ref<TerminalHandle>;
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
  };
  dark: boolean;
  onData: (data: string) => void;
  onSize: (cols: number, rows: number) => void;
  dom?: DOMProps;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>(null);
  // The latest callbacks, for handlers set once.
  const typed = useRef(onData);
  typed.current = onData;
  const sized = useRef(onSize);
  sized.current = onSize;
  useEffect(() => {
    if (!host.current) return;
    document.body.style.margin = "0";
    const terminal = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const data = terminal.onData((text) => typed.current(text));
    const resized = terminal.onResize(({ cols, rows }) =>
      sized.current(cols, rows),
    );
    fit.fit();
    sized.current(terminal.cols, terminal.rows);
    // The keyboard and the phone's turning change the room it has.
    const watch = new ResizeObserver(() => fit.fit());
    watch.observe(host.current);
    term.current = terminal;
    return () => {
      watch.disconnect();
      data.dispose();
      resized.dispose();
      terminal.dispose();
      term.current = null;
    };
  }, []);
  useEffect(() => {
    document.body.style.background = colors.background;
    if (term.current)
      term.current.options.theme = {
        ...(dark ? {} : LIGHT),
        background: colors.background,
        foreground: colors.foreground,
        cursor: colors.cursor,
        cursorAccent: colors.background,
        selectionBackground: colors.selection,
      };
  }, [
    colors.background,
    colors.foreground,
    colors.cursor,
    colors.selection,
    dark,
  ]);
  useDOMImperativeHandle(
    ref,
    () => ({
      write(data) {
        const bytes = Uint8Array.from(atob(String(data)), (c) =>
          c.charCodeAt(0),
        );
        term.current?.write(bytes);
      },
      press(key) {
        const terminal = term.current;
        if (!terminal) return;
        const arrow = ARROWS[String(key)];
        const prefix = terminal.modes.applicationCursorKeysMode
          ? "\x1bO"
          : "\x1b[";
        typed.current(arrow ? prefix + arrow : String(key));
      },
      reset() {
        term.current?.reset();
      },
    }),
    [],
  );
  void dom;
  return (
    // The padding is outside the host: xterm fits the host's own size.
    <div
      style={{
        height: "100vh",
        padding: "4px 6px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div ref={host} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
