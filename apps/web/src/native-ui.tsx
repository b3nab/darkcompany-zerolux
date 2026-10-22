import { createContext, useContext, useRef, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { ChevronLeftIcon } from "lucide-react";
import { lucideIcon } from "./lucide-icon";
import { FolderInput } from "./folder-input";
import { MenuEntries, WithMenu, dragFrom, useDropOn } from "./native-menus";
import { Page, Section } from "./native-page";
import { Table } from "./native-table";
import type { Actor } from "@zerolux/chat";
import type { MenuEntry, Tone, UiComponents } from "@zerolux/ui";
import { cn } from "cn";
import { MessageText } from "@/components/message-text";
import { ActorMark } from "@/components/presence";
import { useWidth } from "@/components/side-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export { lucideIcon } from "./lucide-icon";

/** Inside a Split's list, rows are the panel's own: compact, without a frame. */
const InPanel = createContext(false);

/** A "…" that opens what a row or a card can do, as its right click does. */
function MoreMenu({ entries, label }: { entries: MenuEntry[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            className="text-faint opacity-0 transition-opacity group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <MenuEntries entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The workspace's people and agents, for the avatars extensions' views show. */
export const UiActors = createContext<Actor[]>([]);

const tones: Record<Tone, string> = {
  default: "",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-attention",
  danger: "text-destructive",
};

/** A field's label above it, when it has one. */
function Labelled({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  if (!label) return children;
  return (
    <Field className="gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </Field>
  );
}

/** `@zerolux/ui`'s components, drawn with this app's. */
/** How narrow and how wide a Split's list can be dragged, in pixels. */
const SPLIT_MIN = 192;
const SPLIT_MAX = 480;

export const uiComponents: UiComponents = {
  Stack: ({ direction = "column", gap = 12, align, children }) => (
    <div
      className={cn(
        "flex min-w-0",
        direction === "row" ? "flex-row flex-wrap" : "flex-col",
        align === "start" && "items-start",
        align === "center" && "items-center",
        align === "end" && "items-end",
        align === "stretch" && "items-stretch",
      )}
      style={{ gap }}
    >
      {children}
    </div>
  ),
  Text: ({ tone = "default", size = "md", mono, children }) => (
    <p
      className={cn(
        size === "sm" ? "text-xs" : "text-sm",
        mono && "font-mono",
        tones[tone],
      )}
    >
      {children}
    </p>
  ),
  Heading: ({ level = 2, children }) => {
    const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
    return (
      <Tag
        className={cn(
          "font-semibold tracking-tight",
          level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm",
        )}
      >
        {children}
      </Tag>
    );
  },
  Markdown: ({ children }) => <MessageText text={children} />,
  Button: ({ title, onPress, variant = "secondary", disabled, busy }) => (
    <Button
      size="sm"
      variant={
        variant === "primary"
          ? "default"
          : variant === "danger"
            ? "destructive"
            : variant === "ghost"
              ? "ghost"
              : "outline"
      }
      disabled={disabled || busy}
      onClick={onPress}
      className="self-start"
    >
      {busy && <Spinner data-icon="inline-start" />}
      {title}
    </Button>
  ),
  IconButton: ({ icon, label, onPress, disabled }) => {
    const Drawn = lucideIcon(icon);
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onPress}
      >
        <Drawn />
      </Button>
    );
  },
  Icon: ({ name, size = 16, tone = "default" }) => {
    const Drawn = lucideIcon(name);
    return (
      <Drawn aria-hidden size={size} className={cn("shrink-0", tones[tone])} />
    );
  },
  Input: ({
    value,
    onChange,
    label,
    placeholder,
    multiline,
    secure,
    disabled,
    autoFocus,
    onSubmit,
  }) => (
    <Labelled label={label}>
      {multiline ? (
        <Textarea
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          value={value}
          type={secure ? "password" : "text"}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              onSubmit
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
    </Labelled>
  ),
  Select: ({ value, options, onChange, label, placeholder, disabled }) => (
    <Labelled label={label}>
      <NativeSelect
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder && (
          <NativeSelectOption value="" disabled>
            {placeholder}
          </NativeSelectOption>
        )}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Labelled>
  ),
  Switch: ({ value, onChange, label, disabled }) => (
    <label className="flex items-center gap-2 text-sm">
      <Switch
        checked={value}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
      />
      {label}
    </label>
  ),
  List: function List({ children }) {
    return useContext(InPanel) ? (
      <ul className="flex flex-col gap-0.5 px-2">{children}</ul>
    ) : (
      <ul className="flex flex-col divide-y rounded-md border">{children}</ul>
    );
  },
  ListItem: function ListItem({
    title,
    subtitle,
    leading,
    accessory,
    onPress,
    selected,
    menu,
    drag,
    onDrop,
  }) {
    const panel = useContext(InPanel);
    const drop = useDropOn(onDrop);
    const body = (
      <>
        {leading}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", panel ? "text-[13.5px]" : "text-sm")}>
            {title}
          </span>
          {subtitle && (
            <span className="truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          )}
        </span>
      </>
    );
    // What it holds after its title keeps its own press: a menu in it opens the menu only.
    return (
      <WithMenu
        entries={menu}
        render={
          <li
            {...(drag && dragFrom(() => [drag]))}
            {...drop.props}
            className={cn(
              "group/row flex items-center gap-3",
              panel
                ? "min-h-8 rounded-sm px-2 py-1 text-muted-foreground hover:text-foreground [&_svg]:text-faint"
                : "px-3 py-2",
              onPress && "transition-colors hover:bg-accent",
              // Open beside the list: more than a hover, a mark at its edge too.
              selected &&
                (panel
                  ? "bg-accent text-foreground shadow-[inset_2px_0_0_var(--color-foreground)] [&_svg]:text-foreground"
                  : "bg-accent shadow-[inset_2px_0_0_var(--color-primary)]"),
              drop.over && "bg-ring/15 ring-1 ring-ring/60",
            )}
          />
        }
      >
        {onPress ? (
          <button
            type="button"
            aria-current={selected || undefined}
            onClick={onPress}
            className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:underline"
          >
            {body}
          </button>
        ) : (
          body
        )}
        {accessory}
        {menu?.length ? (
          <MoreMenu entries={menu} label={`${title} actions`} />
        ) : null}
      </WithMenu>
    );
  },
  Table,
  Badge: ({ tone = "default", children }) => (
    <Badge variant="outline" className={cn("shrink-0", tones[tone])}>
      {children}
    </Badge>
  ),
  Divider: () => <Separator />,
  Empty: ({ children }) => (
    <p className="text-sm text-muted-foreground">{children}</p>
  ),
  // Only what the view carries: nothing loads from elsewhere.
  Image: ({ src, alt, height }) =>
    src.startsWith("data:image/") ? (
      <img
        src={src}
        alt={alt}
        style={height ? { height } : undefined}
        className="max-h-80 max-w-full rounded-md border object-contain"
      />
    ) : null,
  Card: function DrawnCard({
    title,
    onPress,
    selected,
    menu,
    drag,
    onDrop,
    children,
  }) {
    const drop = useDropOn(onDrop);
    return (
      <WithMenu
        entries={menu}
        render={
          <Card
            size="sm"
            {...(drag && dragFrom(() => [drag]))}
            {...drop.props}
            className={cn(
              "group/row relative",
              selected && "ring-2 ring-ring",
              drop.over && "bg-ring/10 ring-1 ring-ring/60",
            )}
            {...(onPress && {
              role: "button",
              tabIndex: 0,
              // Its own buttons and fields keep their press, and so does a menu it opened elsewhere.
              onClick: (event: React.MouseEvent) => {
                const target = event.target as Element;
                if (
                  event.currentTarget.contains(target) &&
                  !target.closest("button, a, input, select, textarea, label")
                )
                  onPress();
              },
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onPress();
                }
              },
              className: cn(
                "group/row relative cursor-pointer transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                selected && "ring-2 ring-ring",
                drop.over && "bg-ring/10 ring-1 ring-ring/60",
              ),
            })}
          />
        }
      >
        {title ? (
          <CardHeader className="flex items-center gap-2">
            <CardTitle className="flex-1">{title}</CardTitle>
            {menu?.length ? (
              <MoreMenu entries={menu} label={`${title} actions`} />
            ) : null}
          </CardHeader>
        ) : menu?.length ? (
          // Without a title, its "…" waits in the corner, over nothing it hides.
          <span className="absolute top-1.5 right-1.5 z-1">
            <MoreMenu entries={menu} label="Card actions" />
          </span>
        ) : null}
        <CardContent className="flex flex-col gap-3">{children}</CardContent>
      </WithMenu>
    );
  },
  Tabs: ({ items, value, onChange }) => (
    <Tabs value={value} onValueChange={(next) => onChange(String(next))}>
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  ),
  // A dialog here; a sheet on a phone.
  Sheet: ({ open, onClose, title, children }) => (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">{children}</div>
      </DialogContent>
    </Dialog>
  ),
  Spinner: ({ size = "md" }) => (
    <Spinner className={size === "sm" ? "size-3" : "size-4"} />
  ),
  Avatar: function Avatar({ actorId, size = "md" }) {
    const actor = useContext(UiActors).find((one) => one.id === actorId);
    return (
      <ActorMark
        kind={actor?.kind === "human" ? "human" : "agent"}
        name={actor?.name ?? "?"}
        className={size === "sm" ? "size-6 text-[10px]" : undefined}
      />
    );
  },
  Split: function Split({ label, actions, list, detail, open, onBack }) {
    const width = useWidth(`split-${label}`, 248);
    const [drawn, setDrawn] = useState(width.kept);
    const size = (pixels: number) => {
      const kept = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pixels));
      setDrawn(kept);
      width.resized(kept);
    };
    // A screen of its own, as Chat's and the Console's: the list as a panel at the side, all
    // the way down, and what is open beside it.
    return (
      <div data-screen className="@container flex min-h-0 min-w-0 flex-1">
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col @2xl:grid @2xl:grid-cols-[var(--split-list)_auto_minmax(0,1fr)]"
          style={{ "--split-list": `${drawn}px` } as React.CSSProperties}
        >
          <nav
            aria-label={label}
            className={cn(
              "flex min-h-0 min-w-0 flex-col overflow-y-auto bg-sidebar/40 pb-3",
              open && "@max-2xl:hidden",
            )}
          >
            <header className="flex items-center justify-between gap-2 pt-4 pr-3 pb-2.5 pl-4">
              <h2 className="truncate text-lg font-semibold tracking-tight">
                {label}
              </h2>
              <div className="flex items-center gap-0.5">{actions}</div>
            </header>
            <InPanel.Provider value>{list}</InPanel.Provider>
          </nav>
          {/* Dragged or moved with the arrows; kept as the app keeps its columns' widths. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`${label} width`}
            aria-valuenow={drawn}
            aria-valuemin={SPLIT_MIN}
            aria-valuemax={SPLIT_MAX}
            tabIndex={0}
            onPointerDown={(event) => {
              const from = event.clientX - drawn;
              const handle = event.currentTarget;
              handle.setPointerCapture(event.pointerId);
              const move = (next: PointerEvent) => size(next.clientX - from);
              handle.addEventListener("pointermove", move);
              handle.addEventListener(
                "pointerup",
                () => {
                  handle.removeEventListener("pointermove", move);
                  width.keep();
                },
                { once: true },
              );
            }}
            onKeyDown={(event) => {
              const by = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
              if (!by) return;
              event.preventDefault();
              size(drawn + by);
              width.keep();
            }}
            className="group/handle hidden w-px cursor-col-resize touch-none justify-center bg-border outline-none after:absolute after:-inset-x-1.5 after:inset-y-0 relative hover:bg-ring focus-visible:bg-ring @2xl:flex"
          />
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              !open && "@max-2xl:hidden",
            )}
          >
            <Button
              variant="ghost"
              size="sm"
              className="m-2 self-start @2xl:hidden"
              onClick={onBack}
            >
              <ChevronLeftIcon />
              {label}
            </Button>
            {detail}
          </div>
        </div>
      </div>
    );
  },
  Columns: ({ children }) => (
    <div className="grid auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
      {children}
    </div>
  ),
  DateInput: ({ value, onChange, label, placeholder, disabled }) => (
    <Labelled label={label}>
      <Input
        type="date"
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-fit"
      />
    </Labelled>
  ),
  Menu: ({ label, icon = "ellipsis", items }) => {
    const Drawn = lucideIcon(icon);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              title={label}
            />
          }
        >
          <Drawn />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <MenuEntries entries={items} />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
  Page,
  Section,
  FolderInput,
  FileButton: function FileButton({
    title,
    onFiles,
    multiple,
    variant = "secondary",
    busy,
    disabled,
  }) {
    const picker = useRef<HTMLInputElement>(null);
    const Button = uiComponents.Button;
    return (
      <>
        <input
          ref={picker}
          type="file"
          hidden
          multiple={multiple}
          onChange={(event) => {
            const files = picked(event.target.files);
            // The same file can be picked again.
            event.target.value = "";
            if (files.length) onFiles(files);
          }}
        />
        <Button
          title={title}
          variant={variant}
          busy={busy}
          disabled={disabled}
          onPress={() => picker.current?.click()}
        />
      </>
    );
  },
  DropZone: function DropZone({ onFiles, label, disabled, children }) {
    const [over, setOver] = useState(false);
    // Entering a child leaves the parent: what is held is counted, not each crossing.
    const depth = useRef(0);
    const held = (event: React.DragEvent) =>
      !disabled && event.dataTransfer.types.includes("Files");
    return (
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (!held(event)) return;
          event.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(event) => {
          if (held(event)) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!held(event)) return;
          depth.current -= 1;
          if (depth.current <= 0) setOver(false);
        }}
        onDrop={(event) => {
          if (!held(event)) return;
          event.preventDefault();
          depth.current = 0;
          setOver(false);
          const files = picked(event.dataTransfer.files);
          if (files.length) onFiles(files);
        }}
      >
        {children}
        {over && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium">
            {label}
          </div>
        )}
      </div>
    );
  },
};

/** Files as a view gets them: each with its name. */
const picked = (list: FileList | null) =>
  [...(list ?? [])].map((file) => ({ file, name: file.name }));
