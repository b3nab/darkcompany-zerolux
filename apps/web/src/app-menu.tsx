import { useEffect, useState } from "react";
import { MenuIcon } from "lucide-react";
import {
  desktopConnection,
  drawsWindowControls,
  macKeys,
  useDesktopEvent,
} from "./desktop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

/** A command of the desktop's menu, its shortcut as the menu writes it: `CmdOrCtrl+Shift+N`. */
export interface MenuCommand {
  id: string;
  label: string;
  keys: string | null;
}

/** A section of the bar, opened by its place with ⌘1…9. */
export interface MenuSection {
  path: string;
  label: string;
}

const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
};

const arrows: Record<string, string> = { Left: "←", Right: "→" };

/** A shortcut's modifiers and its key, as the menu writes it: `CmdOrCtrl++` is ⌘ and +. */
function parts(keys: string) {
  const at = keys.endsWith("++") ? keys.length - 2 : keys.lastIndexOf("+");
  const key = at < 0 ? keys : keys.slice(at + 1);
  const held = at < 0 ? [] : keys.slice(0, at).split("+");
  return { key, has: (name: string) => held.includes(name) };
}

/** A shortcut as this system writes it: `⌥⌘N` on a Mac, `Ctrl+Alt+N` elsewhere. */
export function keyLabel(keys: string, mac = macKeys()) {
  const { key, has } = parts(keys);
  const shown = arrows[key] ?? key.toUpperCase();
  if (mac)
    return `${has("Ctrl") ? "⌃" : ""}${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${has("CmdOrCtrl") ? "⌘" : ""}${shown}`;
  return [
    (has("CmdOrCtrl") || has("Ctrl")) && "Ctrl",
    has("Alt") && "Alt",
    has("Shift") && "Shift",
    shown,
  ]
    .filter(Boolean)
    .join("+");
}

type Keys = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

/**
 * Whether the keys pressed are a shortcut, on Windows and Linux. `+` is also `=`, with or
 * without Shift, as browsers zoom.
 */
export function pressed(keys: string, event: Keys) {
  const { key, has } = parts(keys);
  const plus = key === "+" && (event.key === "+" || event.key === "=");
  return (
    event.ctrlKey === (has("CmdOrCtrl") || has("Ctrl")) &&
    event.altKey === has("Alt") &&
    (plus || event.shiftKey === has("Shift")) &&
    !event.metaKey &&
    (plus ||
      event.key.toLowerCase() ===
        (key === "Left" || key === "Right" ? `Arrow${key}` : key).toLowerCase())
  );
}

let sections: MenuSection[] = [];

/** The sections of the bar, in its order: the menu opens them by their place. */
export function reportSections(shown: MenuSection[]) {
  if (!desktopConnection()) return;
  const next = JSON.stringify(shown);
  if (next === JSON.stringify(sections)) return;
  sections = shown;
  void invoke("menu_sections", { sections: shown }).catch(() => {});
}

/** The window's menu, from its button or keys, where the window draws its own title bar. */
function openMenu(x = 8, y = 40) {
  void invoke("menu_popup", { x, y }).catch(() => {});
}

/**
 * The window's part in the desktop's menu: it runs the commands that are its own. On Windows
 * and Linux, where the menu is its button's, it also reads the shortcuts, and Alt or F10 opens
 * the menu. Gives the commands, for the list of shortcuts.
 */
export function useAppMenu(run: (id: string) => void) {
  useDesktopEvent("zerolux-command", run);
  const [commands, setCommands] = useState<MenuCommand[]>([]);
  useEffect(() => {
    if (desktopConnection())
      invoke<MenuCommand[]>("menu_commands").then(setCommands, () => {});
  }, []);
  useEffect(() => {
    if (!drawsWindowControls() || !commands.length) return;
    // Alt pressed and let go with nothing else opens the menu, as in Windows' own apps.
    let alone = false;
    const down = (event: KeyboardEvent) => {
      alone = event.key === "Alt" && !event.repeat;
      const bare =
        !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (event.key === "F10" && bare) {
        event.preventDefault();
        openMenu();
        return;
      }
      const at = /^Digit([1-9])$/.exec(event.code)?.[1];
      const id =
        at && event.ctrlKey && !event.altKey && !event.shiftKey
          ? sections[Number(at) - 1] && `go:${sections[Number(at) - 1]!.path}`
          : commands.find((c) => c.keys && pressed(c.keys, event))?.id;
      if (!id) return;
      event.preventDefault();
      void invoke("menu_run", { id }).catch(() => {});
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Alt" && alone) {
        event.preventDefault();
        openMenu();
      }
      alone = false;
    };
    const cancel = () => {
      alone = false;
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("pointerdown", cancel);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("pointerdown", cancel);
    };
  }, [commands]);
  return commands;
}

/** The menu's button, where the window draws its own title bar: Windows and Linux. */
export function MenuButton() {
  if (!drawsWindowControls()) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Main menu"
      title="Main menu"
      onClick={(event) => {
        const { left, bottom } = event.currentTarget.getBoundingClientRect();
        openMenu(left, bottom + 4);
      }}
    >
      <MenuIcon />
    </Button>
  );
}

/** Every shortcut of the app, as this system writes them. */
export function KeyboardShortcuts({
  commands,
  open,
  onOpenChange,
}: {
  commands: MenuCommand[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mac = macKeys();
  const rows: [string, string][] = [
    ...commands.flatMap((c): [string, string][] =>
      c.keys ? [[c.label.replace(/…$/, ""), keyLabel(c.keys, mac)]] : [],
    ),
    ["Sections by place", mac ? "⌘1…9" : "Ctrl+1…9"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="flex flex-col gap-1 text-sm">
          {rows.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between py-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <Kbd>{keys}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
