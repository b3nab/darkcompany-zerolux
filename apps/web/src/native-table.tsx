import { useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import type { MenuEntry, MenuItem, TableProps, TableRow } from "@zerolux/ui";
import { cn } from "cn";
import { MenuEntries, WithMenu, dragFrom, useDropOn } from "./native-menus";
import { lucideIcon } from "./lucide-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** A key pressed as a menu writes its shortcut: `⌘⌫`, `⇧⌘N`, `F2`. */
function pressed(event: React.KeyboardEvent) {
  const key =
    { Backspace: "⌫", Delete: "⌦", Enter: "⏎", Escape: "⎋" }[event.key] ??
    (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [
    event.ctrlKey && !isMac ? "⌘" : "",
    event.altKey ? "⌥" : "",
    event.shiftKey ? "⇧" : "",
    event.metaKey ? "⌘" : "",
    key,
  ].join("");
}

/** Every item of a menu with keys of its own, submenus' too. */
const shortcuts = (entries: MenuEntry[] = []): MenuItem[] =>
  entries.flatMap((entry) =>
    "title" in entry
      ? [...(entry.shortcut ? [entry] : []), ...shortcuts(entry.items)]
      : [],
  );

function Row({
  row,
  columns,
  chosen,
  menu,
  press,
  open,
  choose,
  carried,
}: {
  row: TableRow;
  columns: TableProps["columns"];
  chosen: boolean;
  menu?: MenuEntry[];
  press: (event: React.MouseEvent) => void;
  open: () => void;
  choose: () => void;
  carried: () => string[];
}) {
  const drop = useDropOn(row.onDrop);
  return (
    <WithMenu
      entries={menu}
      onOpen={choose}
      render={
        <tr
          aria-selected={chosen}
          data-row={row.id}
          onClick={press}
          onDoubleClick={open}
          {...(row.drag && dragFrom(carried))}
          {...drop.props}
          className={cn(
            "cursor-default select-none [&>td]:h-10 [&>td]:border-b [&>td]:border-border/60 [&>td]:px-3 [&>td]:text-muted-foreground [&>td:first-child]:pl-5 [&>td:first-child]:text-foreground",
            "hover:[&>td]:bg-accent/60",
            chosen &&
              "[&>td]:bg-ring/15 [&>td]:text-foreground hover:[&>td]:bg-ring/20 [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-ring)]",
            drop.over &&
              "[&>td]:bg-ring/10 outline-1 -outline-offset-1 outline-ring/60 outline-dashed",
          )}
        />
      }
    >
      {columns.map((column) => (
        <td
          key={column.key}
          className={cn(
            "whitespace-nowrap",
            column.align === "end" && "text-right font-mono text-xs",
          )}
        >
          {row.cells[column.key]}
        </td>
      ))}
    </WithMenu>
  );
}

/** A row as an icon named by its first column, as in Finder's icons. */
function Tile({
  row,
  name,
  chosen,
  menu,
  press,
  open,
  choose,
  carried,
}: {
  row: TableRow;
  name: React.ReactNode;
  chosen: boolean;
  menu?: MenuEntry[];
  press: (event: React.MouseEvent) => void;
  open: () => void;
  choose: () => void;
  carried: () => string[];
}) {
  const drop = useDropOn(row.onDrop);
  const Icon = lucideIcon(row.icon ?? "file");
  return (
    <WithMenu
      entries={menu}
      onOpen={choose}
      render={
        <li
          role="row"
          aria-selected={chosen}
          data-row={row.id}
          onClick={press}
          onDoubleClick={open}
          {...(row.drag && dragFrom(carried))}
          {...drop.props}
          className={cn(
            "flex cursor-default flex-col items-center gap-2 rounded-lg p-3 text-center select-none hover:bg-accent/60",
            chosen && "bg-ring/15 hover:bg-ring/20",
            drop.over && "bg-ring/10 outline-1 outline-ring/60 outline-dashed",
          )}
        />
      }
    >
      <span className="grid size-16 place-items-center rounded-xl bg-accent text-muted-foreground [&_svg]:size-8 [&_svg]:stroke-[1.4]">
        <Icon />
      </span>
      <span
        className={cn(
          "line-clamp-2 max-w-full rounded px-1 text-[12.5px] leading-snug break-words",
          chosen && "bg-ring text-background",
        )}
      >
        {name}
      </span>
    </WithMenu>
  );
}

/** What can be done with everything chosen, along the bottom; Esc or ✕ lets it go. */
function SelectionBar({
  count,
  entries,
  clear,
}: {
  count: number;
  entries: MenuEntry[];
  clear: () => void;
}) {
  const items = entries.filter((entry): entry is MenuItem => "title" in entry);
  return (
    <div className="sticky bottom-4 z-10 mx-auto mt-auto flex w-fit items-center gap-1 rounded-lg border bg-popover py-1.5 pr-1.5 pl-3.5 text-sm shadow-lg">
      <span className="mr-2 font-medium">{count} selected</span>
      {items.map((item) => {
        const Icon = item.icon ? lucideIcon(item.icon) : undefined;
        const look = cn(
          item.tone === "danger" && "text-destructive hover:text-destructive",
        );
        return item.items ? (
          <DropdownMenu key={item.title}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="sm" className={look} />}
            >
              {Icon && <Icon data-icon="inline-start" />}
              {item.title}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-44">
              <MenuEntries entries={item.items} />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            key={item.title}
            variant="ghost"
            size="sm"
            disabled={item.disabled}
            onClick={item.onPress}
            className={look}
          >
            {Icon && <Icon data-icon="inline-start" />}
            {item.title}
          </Button>
        );
      })}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Deselect"
        title="Deselect"
        onClick={clear}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * Rows chosen as in Finder: a click, ⌘ for more, ⇧ for a range, the arrows, ⌘A, Esc; a double
 * click or Enter opens. A right click on a chosen row acts on all of them.
 */
export function Table({
  columns,
  rows,
  selected = [],
  onSelect,
  selectionMenu,
  sort,
  onSort,
  empty,
  view = "list",
}: TableProps) {
  // Where a range starts, the row last pressed without ⇧, and where it ends now.
  const [anchor, setAnchor] = useState<string>();
  const [end, setEnd] = useState<string>();
  const frame = useRef<HTMLDivElement>(null);
  const ids = rows.map((row) => row.id);
  const many = selected.length > 1;
  const menuOf = (row: TableRow) =>
    many && selected.includes(row.id) && selectionMenu?.length
      ? selectionMenu
      : row.menu;
  const choose = (next: string[], from?: string) => {
    if (from !== undefined) {
      setAnchor(from);
      setEnd(from);
    }
    onSelect?.(next);
  };
  const range = (to: string) => {
    const from = ids.indexOf(anchor ?? to);
    const at = ids.indexOf(to);
    return ids.slice(Math.min(from, at), Math.max(from, at) + 1);
  };
  const press = (row: TableRow) => (event: React.MouseEvent) => {
    if (!onSelect) return row.onOpen?.();
    if (event.shiftKey) {
      setEnd(row.id);
      choose(range(row.id));
    } else if (event.metaKey || event.ctrlKey)
      choose(
        selected.includes(row.id)
          ? selected.filter((id) => id !== row.id)
          : [...selected, row.id],
        row.id,
      );
    else choose([row.id], row.id);
  };
  const keys = (event: React.KeyboardEvent) => {
    const at = ids.indexOf(end ?? selected.at(-1) ?? "");
    // Icons are a grid: up and down go a line of them at a time.
    const tiles = [...(frame.current?.querySelectorAll("[data-row]") ?? [])];
    const across =
      view === "icons"
        ? tiles.filter(
            (tile) =>
              (tile as HTMLElement).offsetTop ===
              (tiles[0] as HTMLElement | undefined)?.offsetTop,
          ).length || 1
        : 1;
    const step = {
      ArrowDown: across,
      ArrowUp: -across,
      ...(view === "icons" && { ArrowRight: 1, ArrowLeft: -1 }),
    }[event.key];
    if (step && ids.length) {
      event.preventDefault();
      const to = ids[Math.min(ids.length - 1, Math.max(0, at + step))]!;
      if (event.shiftKey && onSelect) {
        setEnd(to);
        onSelect(range(to));
      } else choose([to], to);
      frame.current
        ?.querySelector(`[data-row="${CSS.escape(to)}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "a" && (event.metaKey || event.ctrlKey) && onSelect) {
      event.preventDefault();
      return onSelect(ids);
    }
    if (event.key === "Escape" && selected.length) return onSelect?.([]);
    const one = rows.find((row) => row.id === selected[0]);
    if (event.key === "Enter" && selected.length === 1 && one?.onOpen) {
      event.preventDefault();
      return one.onOpen();
    }
    // A menu's keys act on what is chosen: all of it, or the one row.
    const done = shortcuts(many ? selectionMenu : one?.menu).find(
      (item) => item.shortcut === pressed(event) && !item.disabled,
    );
    if (done?.onPress) {
      event.preventDefault();
      done.onPress();
    }
  };
  const carried = (row: TableRow) => () =>
    selected.includes(row.id)
      ? rows.flatMap((one) =>
          selected.includes(one.id) && one.drag ? [one.drag] : [],
        )
      : [row.drag!];
  if (!rows.length && empty)
    return <p className="px-5 py-8 text-sm text-muted-foreground">{empty}</p>;
  const shared = (row: TableRow) => ({
    row,
    chosen: selected.includes(row.id),
    menu: menuOf(row),
    press: press(row),
    open: () => row.onOpen?.(),
    choose: () =>
      onSelect && !selected.includes(row.id) && choose([row.id], row.id),
    carried: carried(row),
  });
  return (
    <div
      ref={frame}
      tabIndex={0}
      role="grid"
      aria-multiselectable={!!onSelect}
      onKeyDown={keys}
      className="relative flex flex-1 flex-col outline-none"
    >
      {view === "icons" ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 p-4">
          {rows.map((row) => (
            <Tile
              key={row.id}
              name={row.cells[columns[0]?.key ?? ""]}
              {...shared(row)}
            />
          ))}
        </ul>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {columns.map((column) => {
                const sorted = sort?.key === column.key;
                const Arrow = sort?.descending
                  ? ChevronDownIcon
                  : ChevronUpIcon;
                return (
                  <th
                    key={column.key}
                    aria-sort={
                      sorted
                        ? sort.descending
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                    className={cn(
                      "sticky top-0 z-1 border-b bg-background/90 px-3 pt-2.5 pb-2 text-left text-xs font-medium whitespace-nowrap text-faint backdrop-blur first:pl-5",
                      column.align === "end" && "text-right",
                    )}
                  >
                    {onSort ? (
                      <button
                        type="button"
                        onClick={() =>
                          onSort({
                            key: column.key,
                            descending: sorted && !sort.descending,
                          })
                        }
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          sorted && "text-foreground",
                        )}
                      >
                        {column.title}
                        {sorted && <Arrow className="size-3" />}
                      </button>
                    ) : (
                      column.title
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row key={row.id} columns={columns} {...shared(row)} />
            ))}
          </tbody>
        </table>
      )}
      {many && selectionMenu?.length ? (
        <SelectionBar
          count={selected.length}
          entries={selectionMenu}
          clear={() => onSelect?.([])}
        />
      ) : null}
    </div>
  );
}
