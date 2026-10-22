import { cloneElement, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import type { MenuEntry, MenuItem, PickedFile } from "@zerolux/ui";
import { lucideIcon } from "./lucide-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The system's choice of files, opened by a menu's line: the menu closes as it opens, so the
 * picker is its own, made for this once.
 */
function pickFiles(multiple: boolean, onFiles: (files: PickedFile[]) => void) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = multiple;
  picker.onchange = () => {
    const files = Array.from(picker.files ?? [], (file) => ({
      file,
      name: file.name,
    }));
    if (files.length) onFiles(files);
  };
  picker.click();
}

function Line({ item }: { item: MenuItem }) {
  const Icon = item.icon ? lucideIcon(item.icon) : undefined;
  // A choice shows whether it is the one made; anything else its icon.
  const lead =
    item.checked === undefined ? (
      Icon && <Icon />
    ) : (
      <CheckIcon className={item.checked ? undefined : "invisible"} />
    );
  if (item.items)
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={item.disabled}>
          {lead}
          {item.title}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-44">
          <MenuEntries entries={item.items} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  return (
    <DropdownMenuItem
      variant={item.tone === "danger" ? "destructive" : "default"}
      disabled={item.disabled}
      onClick={() => {
        const { onFiles } = item;
        if (onFiles) pickFiles(!!item.multiple, onFiles);
        else item.onPress?.();
      }}
    >
      {lead}
      {item.title}
      {item.shortcut && (
        <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  );
}

/**
 * A menu's lines, behind a button or a right click alike: groups under their names, lines
 * between them, submenus, choices and their keys.
 */
export function MenuEntries({ entries }: { entries: MenuEntry[] }) {
  const lines: ReactNode[] = [];
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]!;
    if ("divider" in entry) lines.push(<DropdownMenuSeparator key={at} />);
    else if ("section" in entry) {
      // A group's name heads what follows it, up to the next line or group.
      let end = at + 1;
      while (end < entries.length && "title" in entries[end]!) end++;
      lines.push(
        <DropdownMenuGroup key={at}>
          <DropdownMenuLabel>{entry.section}</DropdownMenuLabel>
          {(entries.slice(at + 1, end) as MenuItem[]).map((item, i) => (
            <Line key={i} item={item} />
          ))}
        </DropdownMenuGroup>,
      );
      at = end - 1;
    } else lines.push(<Line key={at} item={entry} />);
  }
  return lines;
}

/**
 * What it draws opens `entries` on a right click, as the system's own lists do; without any,
 * it is only itself.
 */
export function WithMenu({
  entries,
  render,
  onOpen,
  children,
}: {
  entries?: MenuEntry[];
  /** The element it is, a row or a card. */
  render: ReactElement<Record<string, unknown>>;
  /** Right before it opens: a row not chosen becomes the one chosen. */
  onOpen?: () => void;
  children?: ReactNode;
}) {
  if (!entries?.length) return cloneElement(render, undefined, children);
  return (
    <ContextMenu onOpenChange={(open) => open && onOpen?.()}>
      <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <MenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What a drag carries between rows and cards: their ids, as the view knows them. */
const CARRIED = "application/x-zerolux-items";

/** What is dragged from here: `ids`, the one held or every one chosen with it. */
export const dragFrom = (ids: () => string[]) => ({
  draggable: true,
  onDragStart: (event: React.DragEvent) => {
    event.dataTransfer.setData(CARRIED, JSON.stringify(ids()));
    event.dataTransfer.effectAllowed = "copyMove";
  },
});

/** Where dragged rows and cards land, lit while they are held over it. */
export function useDropOn(
  onDrop: ((ids: string[], copy: boolean) => void) | undefined,
) {
  const [over, setOver] = useState(false);
  if (!onDrop) return { over: false, props: {} };
  const held = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(CARRIED);
  return {
    over,
    props: {
      onDragOver: (event: React.DragEvent) => {
        if (!held(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        if (!held(event)) return;
        event.preventDefault();
        setOver(false);
        const ids: unknown = JSON.parse(event.dataTransfer.getData(CARRIED));
        if (Array.isArray(ids)) onDrop(ids.map(String), event.altKey);
      },
    },
  };
}
