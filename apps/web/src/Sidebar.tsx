import { useState } from "react";
import type { SubmitEvent } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router";
import { cn } from "cn";
import {
  ChevronsUpDownIcon,
  FolderIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  PhoneIcon,
  PlusIcon,
  SettingsIcon,
  SquareKanbanIcon,
  StampIcon,
  SunIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  creationDateLabel,
  errorMessage,
  homeLabel,
  isThread,
  renameWorkspace,
  workspaceAge,
} from "@zerolux/chat";
import type { Chat, Perform } from "@zerolux/chat";
import { activeActors, api } from "./api";
import type { Actor, Project, Workspace } from "./api";
import { agentPresence } from "./presence";
import { useTheme } from "./theme";
import type { Theme } from "./theme";
import { Mark } from "@/components/brand";
import { Lamp } from "@/components/lamp";
import { ActorMark } from "@/components/presence";
import type { Tone } from "@/components/presence";
import { Button } from "@/components/ui/button";
import { WorkspaceSettings } from "@/components/workspace-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
      <Item
        to="/chats"
        icon={MessagesSquareIcon}
        label="Chat"
        count={unread}
        toggle={toggle}
      />
      <Item
        to="/projects"
        icon={SquareKanbanIcon}
        label="Projects"
        toggle={toggle}
      />
      <Item to="/team" icon={UsersIcon} label="Team" toggle={toggle} />
      <Item to="/org" icon={NetworkIcon} label="Org" />
      <Item to="/meetings" icon={PhoneIcon} label="Meetings" />
      <Item to="/storage" icon={FolderIcon} label="Storage" />
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
export function WorkspaceMenu({
  workspace,
  busy,
  perform,
}: {
  workspace: Workspace;
  busy: boolean;
  perform: Perform;
}) {
  const navigate = useNavigate();
  const members = activeActors(workspace.actors).length;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const info = workspace.workspace;
  const { name } = info;
  const line = `${workspaceAge(info)} · ${members} member${members === 1 ? "" : "s"}`;
  return (
    <>
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
            <DropdownMenuItem
              onClick={() => {
                setError("");
                setEditing(true);
              }}
            >
              <SettingsIcon />
              Workspace settings
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
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (!busy && !saving) setEditing(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Workspace settings</DialogTitle>
            <DialogDescription>
              The company's name and creation date.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <WorkspaceSettings
              workspace={info}
              busy={busy || saving}
              error={error}
              save={async (name) => {
                setSaving(true);
                setError("");
                try {
                  await renameWorkspace(name);
                  setEditing(false);
                  await perform(async () => {});
                } catch (error) {
                  setError(errorMessage(error));
                } finally {
                  setSaving(false);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The panel of Projects: each project with the tasks still open; a new one starts here. */
export function ProjectList({
  workspace,
  busy,
  perform,
}: {
  workspace: Workspace;
  busy: boolean;
  perform: Perform;
}) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const open = (projectId: string) =>
    workspace.tasks.filter(
      (t) => t.project_id === projectId && t.status !== "done",
    ).length;

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await perform(async () => {
      const created = await api<Project>("/projects", {
        name: data.get("name"),
        description: data.get("description"),
      });
      navigate(`/projects/${created.id}`);
      setAdding(false);
    });
    if (ok) form.reset();
  }

  return (
    <section aria-label="Projects" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Projects"
        action={
          <button
            type="button"
            aria-label="New project"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
            className={add}
          >
            <PlusIcon />
          </button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {workspace.projects.map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}`} className={row}>
            <span
              aria-hidden
              className="grid size-4 shrink-0 place-items-center rounded-xs border border-input"
            >
              <span className="size-1.5 rounded-[1px] bg-agent" />
            </span>
            <span className="flex-1 truncate">{p.name}</span>
            {open(p.id) > 0 && (
              <span className="font-mono text-[11.5px] text-faint">
                {open(p.id)}
              </span>
            )}
          </NavLink>
        ))}
        {(adding || workspace.projects.length === 0) && (
          <form
            onSubmit={(e) => void create(e)}
            className="mt-1 flex flex-col gap-2.5 rounded-md border bg-card p-2.5"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                name="name"
                placeholder="ZeroLux"
                required
                maxLength={200}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-context">Context</Label>
              <Textarea
                id="project-context"
                name="description"
                placeholder="What are we building?"
                maxLength={20000}
                rows={3}
              />
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              Create project
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

/** The panel of Team: your agents, lit while they work; each one opens its chat. */
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
  const dm = (actorId: string) =>
    chat.conversations.find(
      (c) => c.kind === "dm" && c.members.some((m) => m.actor_id === actorId),
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
          const presence = agentPresence(
            agent.id,
            chat.sessions,
            workspace.connections,
          );
          const chatWith = dm(agent.id);
          return (
            <Row
              key={agent.id}
              to={chatWith ? `/chats/${chatWith.id}` : "/team"}
              className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent"
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
            </Row>
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

/** An agent's row: lit while its chat is open, never for the team page it falls back to. */
function Row({
  to,
  ...props
}: React.ComponentProps<typeof Link> & { to: string }) {
  return to.startsWith("/chats/") ? (
    <NavLink to={to} {...props} />
  ) : (
    <Link to={to} {...props} />
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
  const { resolved, choose } = useTheme();
  const other = resolved === "dark" ? "light" : "dark";
  const label = other === "light" ? "Daylight theme" : "Night theme";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => choose(other)}
    >
      {other === "light" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

/** You, the theme, and the team. */
function UserMenu({ owner }: { owner: Actor }) {
  const { theme, choose } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`${owner.name}, settings`}
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
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => choose(value as Theme)}
          >
            <DropdownMenuRadioItem value="system">
              <MonitorIcon />
              System
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <SunIcon />
              Daylight
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon />
              Night
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/team" />}>
          <UsersIcon />
          Team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
