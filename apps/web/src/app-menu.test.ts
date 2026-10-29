import { expect, test } from "bun:test";
import { keyLabel, pressed } from "./app-menu";

const key = (key: string, held: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...held,
});

test("a shortcut is pressed with exactly its keys, on Windows and Linux", () => {
  expect(
    pressed("CmdOrCtrl+Shift+O", key("O", { ctrlKey: true, shiftKey: true })),
  ).toBe(true);
  expect(pressed("CmdOrCtrl+Shift+O", key("o", { ctrlKey: true }))).toBe(false);
  expect(
    pressed("CmdOrCtrl+K", key("k", { ctrlKey: true, altKey: true })),
  ).toBe(false);
  expect(pressed("CmdOrCtrl+K", key("k", { metaKey: true }))).toBe(false);
  expect(pressed("Alt+Left", key("ArrowLeft", { altKey: true }))).toBe(true);
  expect(pressed("CmdOrCtrl++", key("=", { ctrlKey: true }))).toBe(true);
  expect(
    pressed("CmdOrCtrl++", key("+", { ctrlKey: true, shiftKey: true })),
  ).toBe(true);
  expect(pressed("CmdOrCtrl+-", key("-", { ctrlKey: true }))).toBe(true);
  expect(pressed("F11", key("F11"))).toBe(true);
});

test("a shortcut is written as each system writes it", () => {
  expect(keyLabel("Alt+CmdOrCtrl+N", true)).toBe("⌥⌘N");
  expect(keyLabel("Alt+CmdOrCtrl+N", false)).toBe("Ctrl+Alt+N");
  expect(keyLabel("Alt+Left", false)).toBe("Alt+←");
  expect(keyLabel("CmdOrCtrl++", true)).toBe("⌘+");
});
