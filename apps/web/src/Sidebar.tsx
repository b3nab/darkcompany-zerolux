import { Link, NavLink, useMatch, useNavigate } from "react-router";
import { cn } from "cn";
import {
  BlocksIcon,
  ChevronsUpDownIcon,
  FolderIcon,
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
  workspaceAge,
  useUiPieces,
} from "@zerolux/chat";
import type { Chat } from "@zerolux/chat";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";
import { agentPresence } from "./presence";
import { useAuthentication } from "./AuthGate";
import { pieceIcon } from "./extension-view";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type Kernel = {
  tone: Tone;
  label: string;
  host: string;
  version?: string;
};

/**
 * The workspace's bar, as in Teams, ClickUp and VS Code: the workspace on top, one icon per
 * section, and at the bottom search, the theme, the kernel and you. The open section's icon
 * opens and closes its panel (`toggle` says whether there was one).
 */
export function Sidebar({
  chat,
  owner,
  kernel,
  toggle,
}: {
  chat: Chat;
  owner: Actor;
  kernel: Kernel;
  toggle: () => boolean;
}) {
  // Pages the workspace's extensions bring, after Storage.
  const pages = useUiPieces("page");
  const unread = chat.conversations.filter(
    (c) => !isThread(c) && c.last_seq > (chat.seen[c.id] ?? 0),
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
      <Item to="/" end icon={LayoutDashboardIcon} label={homeLabel()} />
      <Item to="/console" icon={SquareTerminalIcon} label="Console" />
      <Item
        to="/chats"
        icon={MessagesSquareIcon}
        label="Chat"
        count={unread}
        toggle={toggle}
      />
      <Item to="/team" icon={UsersIcon} label="Team" toggle={toggle} />
      <Item to="/org" icon={NetworkIcon} label="Org" />
      <Item to="/meetings" icon={PhoneIcon} label="Meetings" />
      <Item to="/storage" icon={FolderIcon} label="Storage" />
      {pages.map((piece) => (
        <Item
          key={`${piece.extension}/${piece.name}`}
          to={`/x/${encodeURIComponent(piece.extension)}/${encodeURIComponent(piece.name)}`}
          icon={pieceIcon(piece)}
          label={piece.title}
        />
      ))}
      <Item to="/extensions" icon={BlocksIcon} label="Extensions" />
      <Item
        to="/approvals"
        icon={StampIcon}
        label="Approvals"
        count={pending}
        attention
      />
      <div className="mt-auto flex flex-col items-center gap-1 pt-4">
        <ThemeSwitch />
        <KernelStatus kernel={kernel} />
        <UserMenu owner={owner} />
      </div>
    </nav>
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
}: {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  attention?: boolean;
  /** For a section with a panel: opens or closes it, and says whether it did. */
  toggle?: () => boolean;
}) {
  const open = useMatch({ path: to, end: !!end }) !== null;
  return (
    <NavLink
      to={to}
      end={end}
      onClick={(event) => {
        if (open && toggle?.()) event.preventDefault();
      }}
      className="relative flex w-14 shrink-0 flex-col items-center gap-1 rounded-md pt-2 pb-1.5 text-[10.5px] leading-none text-muted-foreground outline-none transition-colors before:absolute before:inset-y-2.5 before:-left-1.5 before:w-0.75 before:rounded-full hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground aria-[current=page]:before:bg-primary [&>svg]:size-5 [&>svg]:text-faint aria-[current=page]:[&>svg]:text-primary"
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

/** The workspace you are in, how old it is and how many work in it. */
export function WorkspaceMenu({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const members = activeActors(workspace.actors).length;
  const info = workspace.workspace;
  const { name } = info;
  const line = `${workspaceAge(info)} · ${members} member${members === 1 ? "" : "s"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={`${name} · ${line}`}
            className="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-accent aria-expanded:bg-accent"
          />
        }
      >
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-sm border border-input bg-secondary text-xs font-semibold"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate text-[13.5px] font-semibold">{name}</span>
        <ChevronsUpDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-faint"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
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

/** Which kernel this is, whether it answers, and its version: a light, with words on hover. */
function KernelStatus({ kernel }: { kernel: Kernel }) {
  const details = [
    kernel.label,
    kernel.host,
    kernel.version && `v${kernel.version}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      role="status"
      data-tone={kernel.tone}
      title={details}
      className="grid size-9 place-items-center"
    >
      <span
        aria-hidden
        className={cn("size-2 rounded-full", light[kernel.tone])}
      />
      <span className="sr-only">{details}</span>
    </span>
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
function UserMenu({ owner }: { owner: Actor }) {
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
            className="mt-1 rounded-full transition-opacity hover:opacity-80"
          />
        }
      >
        <ActorMark kind="human" name={owner.name} className="size-8" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-52">
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
