import { useEffect, useRef } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Announcements, Modifier, UniqueIdentifier } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "cn";
import {
  BlocksIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessagesSquareIcon,
  MoonIcon,
  NetworkIcon,
  PhoneIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  StampIcon,
  SunIcon,
  UserIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  creationDateLabel,
  homeLabel,
  isThread,
  unreadIn,
  workspaceAge,
  useUiPieces,
} from "@zerolux/chat";
import type { Chat } from "@zerolux/chat";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";
import { agentPresence } from "./presence";
import { reportSections } from "./app-menu";
import { useAuthentication } from "./AuthGate";
import { macKeys } from "./desktop";
import { useElsewhere, useHere, WorkspaceMark } from "./instance";
import { pieceIcon } from "./extension-view";
import { stored } from "./stored";
import { useTheme } from "./theme";
import { Mark } from "@/components/brand";
import { Lamp } from "@/components/lamp";
import { ActorMark } from "@/components/presence";
import type { Tone } from "@/components/presence";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type Kernel = {
  tone: Tone;
  label: string;
  host: string;
  version?: string;
};

/**
 * The workspace's bar, as in Teams, ClickUp and VS Code: one icon per section, and at the
 * bottom the theme. The open section's icon opens and closes its panel (`toggle` says whether
 * there was one).
 */
export function Sidebar({
  chat,
  toggle,
}: {
  chat: Chat;
  toggle: () => boolean;
}) {
  // Pages the workspace's extensions bring, after ZeroLux's own sections.
  const pages = useUiPieces("page");
  const unread = chat.conversations.filter(
    (c) => !isThread(c) && unreadIn(c) > 0,
  ).length;
  const pending = chat.approvals.filter((a) => a.status === "pending").length;
  return (
    <nav
      aria-label="Workspace"
      className="flex min-h-0 flex-1 flex-col items-center gap-1 pb-2.5"
    >
      {/* As tall as the page's header, so their lines meet. */}
      <Link
        to="/"
        aria-label="ZeroLux home"
        className="mb-1.5 grid h-12 w-full shrink-0 place-items-center border-b"
      >
        <Mark className="size-6" />
      </Link>
      <Sections
        sections={[
          { to: "/", end: true, icon: LayoutDashboardIcon, label: homeLabel() },
          { to: "/console", icon: SquareTerminalIcon, label: "Console" },
          {
            to: "/approvals",
            icon: StampIcon,
            label: "Approvals",
            count: pending,
            attention: true,
          },
          {
            to: "/chats",
            icon: MessagesSquareIcon,
            label: "Chat",
            count: unread,
            toggle,
          },
          { to: "/meetings", icon: PhoneIcon, label: "Meetings" },
          { to: "/team", icon: UsersIcon, label: "Team", toggle },
          { to: "/org", icon: NetworkIcon, label: "Org" },
          ...pages.map((piece) => ({
            to: `/x/${encodeURIComponent(piece.extension)}/${encodeURIComponent(piece.name)}`,
            icon: pieceIcon(piece),
            label: piece.title,
          })),
          { to: "/extensions", icon: BlocksIcon, label: "Extensions" },
        ]}
      />
      <div className="mt-auto flex flex-col items-center gap-1 pt-4">
        <ThemeSwitch />
      </div>
    </nav>
  );
}

type Section = {
  /** Where it goes, which names it in the order kept. */
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  attention?: boolean;
  /** For a section with a panel: opens or closes it, and says whether it did. */
  toggle?: () => boolean;
};

const order = stored<string[]>(
  "zerolux-bar-order",
  [],
  (value): value is string[] =>
    Array.isArray(value) && value.every((to) => typeof to === "string"),
);

/**
 * The sections in the order the person put them; one never placed, as a page of an extension
 * just installed, stays after the section it follows in `sections`.
 */
export function arranged(sections: string[], kept: string[]) {
  const placed = kept.filter((to) => sections.includes(to));
  sections.forEach((to, at) => {
    if (!placed.includes(to))
      placed.splice(at && placed.indexOf(sections[at - 1]!) + 1, 0, to);
  });
  return placed;
}

// Along the bar only.
const alongTheBar: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * The sections, each moved where the person wants it, as icons in the Dock: dragged, or
 * picked up with Space and moved with the arrows. Enter and a click still open them.
 */
function Sections({ sections }: { sections: Section[] }) {
  const placed = arranged(
    sections.map((section) => section.to),
    order.use(),
  );
  const named = (id: UniqueIdentifier) =>
    sections.find((section) => section.to === id)?.label ?? "";
  // The desktop's menu opens them by their place, with ⌘1…9.
  useEffect(() =>
    reportSections(placed.map((to) => ({ path: to, label: named(to) }))),
  );
  const at = (id: UniqueIdentifier) =>
    `${placed.indexOf(String(id)) + 1} of ${placed.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${named(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${named(active.id)} is at ${at(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      `${named(active.id)} dropped${over ? ` at ${at(over.id)}` : ""}.`,
    onDragCancel: ({ active }) => `${named(active.id)} put back.`,
  };
  const sensors = useSensors(
    // A few pixels first: a click opens the section.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter follows the link.
      keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape"] },
    }),
  );
  // The click that ends a drag by the pointer does not open the section.
  const dragged = useRef(false);
  return (
    <div
      className="flex flex-col items-center gap-1"
      onPointerDownCapture={() => {
        dragged.current = false;
      }}
      onClickCapture={(event) => {
        if (dragged.current) event.preventDefault();
        dragged.current = false;
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[alongTheBar]}
        accessibility={{ announcements }}
        onDragStart={({ activatorEvent }) => {
          dragged.current = activatorEvent instanceof PointerEvent;
        }}
        onDragEnd={({ active, over }) => {
          if (over && active.id !== over.id)
            order.set(
              arrayMove(
                placed,
                placed.indexOf(String(active.id)),
                placed.indexOf(String(over.id)),
              ),
            );
        }}
      >
        <SortableContext items={placed} strategy={verticalListSortingStrategy}>
          {placed.map((to) => (
            <Item key={to} {...sections.find((s) => s.to === to)!} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function Item({
  to,
  end,
  icon: Icon,
  label,
  count,
  attention,
  toggle,
}: Section) {
  const open = useMatch({ path: to, end: !!end }) !== null;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: to });
  return (
    <NavLink
      ref={setNodeRef}
      to={to}
      end={end}
      {...listeners}
      // A link stays one: only how to move it is added.
      aria-describedby={attributes["aria-describedby"]}
      draggable={false}
      data-dragging={isDragging || undefined}
      style={{
        transform: transform
          ? `translate3d(0, ${transform.y}px, 0)`
          : undefined,
        transition,
      }}
      onClick={(event) => {
        if (open && toggle?.()) event.preventDefault();
      }}
      className="relative flex w-14 shrink-0 flex-col items-center gap-1 rounded-md pt-2 pb-1.5 text-[10.5px] leading-none text-muted-foreground outline-none transition-[color,background-color,scale,box-shadow] before:absolute before:inset-y-2.5 before:-left-1.5 before:w-0.75 before:rounded-full hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-[current=page]:before:bg-primary data-dragging:z-10 data-dragging:scale-110 data-dragging:bg-accent data-dragging:shadow-lg [&>svg]:size-5 [&>svg]:text-faint aria-[current=page]:[&>svg]:text-primary"
    >
      <Icon aria-hidden />
      <span className="max-w-full truncate">{label}</span>
      {!!count && (
        <span
          data-attention={attention || undefined}
          className="absolute top-0.5 right-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[10px] font-medium text-background tabular-nums data-attention:bg-primary data-attention:text-primary-foreground data-attention:shadow-[0_0_10px_-2px_var(--color-human)]"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </NavLink>
  );
}

/** A panel's title and its one action, as at the top of the chat list. */
function PanelHeader({
  title,
  action,
}: {
  title: string;
  action: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between px-4 pt-4 pb-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {action}
    </header>
  );
}

const row =
  "flex h-8 w-full shrink-0 items-center gap-2.5 rounded-sm px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground";
const add =
  "grid size-7 place-items-center rounded-sm text-faint transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent [&>svg]:size-4";

/** A count of requests, as on the bar. */
function Count({ count }: { count: number }) {
  return (
    <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-[10px] font-medium text-primary-foreground tabular-nums">
      {count > 99 ? "99+" : count}
    </span>
  );
}

const unreadDot = "size-1.5 shrink-0 rounded-full bg-foreground";

/**
 * The workspace you are in, how old it is and how many work in it; and the kernel's others,
 * each with what waits in it, to go to (in a new tab with ⌘ or Ctrl).
 */
export function WorkspaceMenu({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const here = useHere();
  const elsewhere = useElsewhere(here);
  const members = activeActors(workspace.actors).length;
  const info = workspace.workspace;
  const { name } = info;
  const line = `${workspaceAge(info)} · ${members} member${members === 1 ? "" : "s"}`;
  const all =
    here && here.instance.workspaces.length > 1 ? here.instance.workspaces : [];
  const waiting = Object.values(elsewhere);
  const requests = waiting.reduce((sum, w) => sum + w.requests, 0);
  const unread = waiting.some((w) => w.unread > 0);
  const key = macKeys() ? "⌃" : "Alt+";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={`${name} · ${line}${requests ? ` · ${requests} waiting elsewhere` : ""}`}
            className="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent aria-expanded:bg-accent"
          />
        }
      >
        <WorkspaceMark name={name} />
        <span className="truncate text-[13.5px] font-semibold">{name}</span>
        {requests > 0 ? (
          <Count count={requests} />
        ) : (
          unread && <span aria-hidden className={unreadDot} />
        )}
        <ChevronsUpDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-faint"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-[13.5px] font-semibold text-foreground">
              {name}
            </span>
            <span
              title={creationDateLabel(info)}
              className="truncate font-mono text-[11px] font-normal"
            >
              {line}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <SettingsIcon />
            Administration
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/team")}>
            <UsersIcon />
            Team
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/team/hire")}>
            <UserPlusIcon />
            Hire an agent
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {all.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate font-mono text-[11px] font-normal">
                {globalThis.location?.host}
              </DropdownMenuLabel>
              {all.map((other, at) => {
                const current = other.id === here!.workspace.id;
                const waits = elsewhere[other.id];
                return (
                  <DropdownMenuItem
                    key={other.id}
                    render={
                      current ? undefined : (
                        <a href={`/w/${encodeURIComponent(other.id)}/`} />
                      )
                    }
                  >
                    <WorkspaceMark name={other.name} className="size-5" />
                    <span className="truncate">{other.name}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {!!waits?.requests && <Count count={waits.requests} />}
                      {!!waits?.unread && (
                        <span aria-label="Unread" className={unreadDot} />
                      )}
                      {current && <CheckIcon aria-label="Open" />}
                      {at < 9 && (
                        <DropdownMenuShortcut>
                          {key}
                          {at + 1}
                        </DropdownMenuShortcut>
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The panel of Team: your agents, lit while they work; each one opens its profile. */
export function AgentList({
  workspace,
  chat,
  owner,
}: {
  workspace: Workspace;
  chat: Chat;
  owner: Actor;
}) {
  const agents = activeActors(workspace.actors).filter(
    (a) => a.kind === "agent" && a.owner_id === owner.id,
  );
  return (
    <section aria-label="Your agents" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Your agents"
        action={
          <Link to="/team/hire" aria-label="Hire an agent" className={add}>
            <PlusIcon />
          </Link>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {agents.map((agent) => {
          const presence = agentPresence(agent.id, chat.sessions);
          return (
            <NavLink
              key={agent.id}
              to={`/team/${agent.id}`}
              className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent aria-[current=page]:bg-accent"
            >
              <ActorMark
                kind="agent"
                name={agent.name}
                className="size-8 text-xs"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-[13px]">
                  {agent.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {presence.label}
                </span>
              </span>
              <Lamp kind="agent" state={presence.tone} className="size-1.5" />
            </NavLink>
          );
        })}
        {agents.length === 0 && (
          <Link to="/team/hire" className={row}>
            <UserPlusIcon className="size-4 text-faint" />
            Hire an agent
          </Link>
        )}
      </div>
    </section>
  );
}

const light: Record<Tone, string> = {
  working: "bg-success shadow-[0_0_6px_var(--color-success)]",
  connected: "bg-success shadow-[0_0_6px_var(--color-success)]",
  connecting: "animate-pulse bg-faint",
  attention: "bg-destructive",
  stopped: "bg-faint",
};

/**
 * The window's status bar, as in VS Code's: whether ZeroLux answers and its version, with the
 * computer it runs on on hover.
 */
export function StatusBar({ kernel }: { kernel: Kernel }) {
  return (
    <footer
      role="status"
      data-tone={kernel.tone}
      title={kernel.host}
      className="col-span-full flex h-6 shrink-0 items-center gap-3 border-t border-sidebar-border bg-sidebar px-3 text-[11.5px] text-muted-foreground"
    >
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", light[kernel.tone])}
        />
        {kernel.label}
      </span>
      {kernel.version && (
        <span className="font-mono text-faint">v{kernel.version}</span>
      )}
    </footer>
  );
}

/** Night or daylight, in one click. */
function ThemeSwitch() {
  const { resolved, chooseLight } = useTheme();
  const other = resolved === "dark" ? "light" : "dark";
  const label = other === "light" ? "Switch to daylight" : "Switch to night";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => chooseLight(other)}
    >
      {other === "light" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

/** You: your profile, your settings, the workspace's administration, and signing out. */
export function UserMenu({ owner }: { owner: Actor }) {
  const navigate = useNavigate();
  const authentication = useAuthentication();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`${owner.name}, profile and settings`}
            title={owner.name}
            className="ml-1 rounded-full transition-opacity hover:opacity-80"
          />
        }
      >
        <ActorMark kind="human" name={owner.name} className="size-7" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium text-foreground">
              {owner.name}
            </span>
            <span className="text-[11.5px] font-normal">Owner</span>
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => navigate("/profile")}>
            <UserIcon />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/settings")}>
            <SlidersHorizontalIcon />
            My settings
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <SettingsIcon />
            Administration
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {authentication && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={authentication.busy}
              onClick={() => void authentication.signOut()}
            >
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
