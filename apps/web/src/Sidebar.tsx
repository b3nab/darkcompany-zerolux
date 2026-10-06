import { useState } from "react";
import type { SubmitEvent } from "react";
import { Link, NavLink, useNavigate } from "react-router";
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
  SearchIcon,
  SettingsIcon,
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
import { Wordmark } from "@/components/brand";
import { Lamp } from "@/components/lamp";
import { ActorMark, Eyebrow } from "@/components/presence";
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type Kernel = {
  tone: Tone;
  label: string;
  host: string;
  version?: string;
};

const item =
  "flex h-7.5 w-full items-center gap-2.5 rounded-sm px-2 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-faint aria-[current=page]:[&>svg]:text-primary";

/** The workspace's rail: where you are, where to go, who works with you, and the kernel. */
export function Sidebar({
  workspace,
  chat,
  owner,
  kernel,
  busy,
  perform,
  search,
}: {
  workspace: Workspace;
  chat: Chat;
  owner: Actor;
  kernel: Kernel;
  busy: boolean;
  perform: Perform;
  search: () => void;
}) {
  const actors = activeActors(workspace.actors);
  const unread = chat.conversations.filter(
    (c) => !isThread(c) && c.last_seq > (chat.seen[c.id] ?? 0),
  ).length;
  const pending = chat.approvals.filter((a) => a.status === "pending").length;
  const agents = actors.filter(
    (a) => a.kind === "agent" && a.owner_id === owner.id,
  );
  const dm = (actorId: string) =>
    chat.conversations.find(
      (c) => c.kind === "dm" && c.members.some((m) => m.actor_id === actorId),
    );

  return (
    <nav
      aria-label="Workspace"
      className="flex min-h-0 flex-1 flex-col gap-0.5"
    >
      <Link
        to="/"
        aria-label="ZeroLux home"
        className="mb-3 self-start px-2 pt-1.5"
      >
        <Wordmark />
      </Link>
      <WorkspaceMenu
        workspace={workspace}
        members={actors.length}
        busy={busy}
        perform={perform}
      />
      <button
        type="button"
        onClick={search}
        className="mb-2.5 flex h-7.5 items-center gap-2 rounded-sm border border-input bg-card px-2.5 text-[13px] text-faint transition-colors hover:border-faint/60 hover:text-muted-foreground"
      >
        <SearchIcon aria-hidden className="size-3.5" />
        Search or run
        <KbdGroup className="ml-auto">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </button>
      <Item to="/" end icon={LayoutDashboardIcon} label={homeLabel()} />
      <Item to="/chats" icon={MessagesSquareIcon} label="Chat" count={unread} />
      <Item to="/storage" icon={FolderIcon} label="Storage" />
      <Item to="/org" icon={NetworkIcon} label="Org" count={actors.length} />
      <Item to="/meetings" icon={PhoneIcon} label="Meetings" />
      <Item
        to="/approvals"
        icon={StampIcon}
        label="Approvals"
        count={pending}
        attention
      />
      <Projects workspace={workspace} busy={busy} perform={perform} />
      <Section
        title={
          <Link to="/team" className="transition-colors hover:text-foreground">
            Your agents
          </Link>
        }
        action={
          <Link
            to="/team/hire"
            aria-label="Hire an agent"
            className="grid size-6 place-items-center rounded-sm text-faint transition-colors hover:bg-accent hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </Link>
        }
      >
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
              title={presence.label}
              className={item}
            >
              <ActorMark
                kind="agent"
                name={agent.name}
                className="size-4.5 text-[9px]"
              />
              <span className="truncate font-mono text-[13px]">
                {agent.name}
              </span>
              <Lamp
                kind="agent"
                state={presence.tone}
                className="ml-auto size-1.5"
              />
            </Row>
          );
        })}
        {agents.length === 0 && (
          <Link to="/team/hire" className={item}>
            <UserPlusIcon />
            Hire an agent
          </Link>
        )}
      </Section>
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <KernelStatus kernel={kernel} />
        <UserBar owner={owner} />
      </div>
    </nav>
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

function Item({
  to,
  end,
  icon: Icon,
  label,
  count,
  attention,
}: {
  to: string;
  end?: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  attention?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={item}>
      <Icon aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {!!count && (
        <span
          data-attention={attention || undefined}
          className="font-mono text-[11.5px] text-faint tabular-nums data-attention:grid data-attention:h-4.5 data-attention:min-w-4.5 data-attention:place-items-center data-attention:rounded-xs data-attention:bg-primary data-attention:px-1.5 data-attention:font-medium data-attention:text-primary-foreground data-attention:shadow-[0_0_10px_-2px_var(--color-human)]"
        >
          {count}
        </span>
      )}
    </NavLink>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 flex flex-col gap-0.5">
      <div className="mb-1 flex h-6 items-center justify-between pr-1 pl-2">
        <Eyebrow>{title}</Eyebrow>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The workspace you are in, how old it is and how many work in it. */
function WorkspaceMenu({
  workspace,
  members,
  busy,
  perform,
}: {
  workspace: Workspace;
  members: number;
  busy: boolean;
  perform: Perform;
}) {
  const navigate = useNavigate();
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
              className="mb-1.5 flex w-full items-center gap-2.5 rounded-sm p-1.5 text-left transition-colors hover:bg-accent aria-expanded:bg-accent"
            />
          }
        >
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-md border border-input bg-secondary text-[13px] font-semibold"
          >
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13.5px] font-semibold">{name}</span>
            <span
              title={creationDateLabel(info)}
              className="truncate font-mono text-[11px] text-faint"
            >
              {line}
            </span>
          </span>
          <ChevronsUpDownIcon
            aria-hidden
            className="ml-auto size-3.5 text-faint"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{name}</DropdownMenuLabel>
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

/** Projects, each with the tasks still open; a new one starts here. */
function Projects({
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
    <Section
      title="Projects"
      action={
        <button
          type="button"
          aria-label="New project"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
          className="grid size-6 place-items-center rounded-sm text-faint transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent"
        >
          <PlusIcon className="size-3.5" />
        </button>
      }
    >
      {workspace.projects.map((p) => (
        <NavLink key={p.id} to={`/projects/${p.id}`} className={item}>
          <span
            aria-hidden
            className="grid size-4 place-items-center rounded-xs border border-input"
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
    </Section>
  );
}

const light: Record<Tone, string> = {
  working: "bg-success shadow-[0_0_6px_var(--color-success)]",
  connected: "bg-success shadow-[0_0_6px_var(--color-success)]",
  connecting: "animate-pulse bg-faint",
  attention: "bg-destructive",
  stopped: "bg-faint",
};

/** Which kernel this is, whether it answers, and its version. */
function KernelStatus({ kernel }: { kernel: Kernel }) {
  return (
    <div
      role="status"
      data-tone={kernel.tone}
      className="flex flex-col gap-1 rounded-sm border bg-background px-2.5 py-2 font-mono text-[11px]"
    >
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", light[kernel.tone])}
        />
        {kernel.label}
      </span>
      <span className="text-faint">
        {[kernel.host, kernel.version && `v${kernel.version}`]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}

/** You, the theme, and the settings. */
function UserBar({ owner }: { owner: Actor }) {
  const { theme, resolved, choose } = useTheme();
  const other = resolved === "dark" ? "light" : "dark";
  return (
    <div className="flex items-center gap-1 border-t px-1 pt-2.5">
      <ActorMark kind="human" name={owner.name} className="size-7" />
      <span className="ml-1 flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium">{owner.name}</span>
        <span className="text-[11.5px] text-faint">Owner</span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={other === "light" ? "Daylight theme" : "Night theme"}
        title={other === "light" ? "Daylight theme" : "Night theme"}
        onClick={() => choose(other)}
      >
        {other === "light" ? <SunIcon /> : <MoonIcon />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Settings" />
          }
        >
          <SettingsIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-48">
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
    </div>
  );
}
