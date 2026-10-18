import { useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { Link } from "react-router";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { activeActors, errorMessage, harnessLabels } from "./api";
import type { Actor, Workspace } from "./api";
import {
  agentWork,
  agentLaunchSettings,
  agentSettingFields,
  canApplyAgentSettings,
  agentModelOption,
  useAgentSettings,
  useSessionCatalog,
  setAgentSettings,
  ago,
  byProject,
  claudeModes,
  codexApprovalPolicies,
  codexSandboxes,
  folderName,
  recentFolders,
  sessionState,
  contextShare,
  percent,
  tokenCount,
  usdCost,
} from "@zerolux/chat";
import type {
  AgentSettings,
  ChatSession,
  ClaudeMode,
  CodexApprovalPolicy,
  CodexSandbox,
  DiscoveredSession,
  Discovery,
  NewSession,
  SessionUsage,
  Tone,
} from "@zerolux/chat";
import type { Chat, Perform } from "@zerolux/chat";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ActorMark, Eyebrow, Presence } from "@/components/presence";
import {
  Fact,
  Facts,
  Mark,
  memberRole,
  ProfileHead,
} from "@/components/profile";
import { agentPresence, sessionTone } from "./presence";

/** Finds the owner's harness sessions and hires them. */
export function Hire({
  chat,
  actors,
  busy,
  perform,
  initialDiscovery,
}: {
  chat: Chat;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
  initialDiscovery?: Discovery;
}) {
  const [discovery, setDiscovery] = useState(initialDiscovery);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [hiring, setHiring] = useState<string>();
  const name = (id: string | null) => actors.find((a) => a.id === id)?.name;
  async function search() {
    setSearching(true);
    try {
      setDiscovery(await chat.discover());
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }
  useEffect(() => {
    if (!initialDiscovery) void search();
    // Discovery runs on open and on request, never on a timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const linked = (d: DiscoveredSession, stopped: boolean) =>
    chat.sessions.find(
      (s) =>
        (s.status === "stopped") === stopped &&
        s.harness === d.harness &&
        s.native_session_id === d.native_session_id,
    );
  const found = [...(discovery?.sessions ?? [])].sort(
    (a, b) =>
      Number(b.availability === "attachable") -
        Number(a.availability === "attachable") ||
      (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
  );
  // Hireable sessions first; the rest stay out of the way, with their reason.
  const ready = found.filter(
    (d) => d.availability === "attachable" || linked(d, false),
  );
  const unavailable = found.filter((d) => !ready.includes(d));
  const row = (d: DiscoveredSession) => {
    const session = linked(d, false);
    return (
      <li key={d.id} className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <strong className="truncate text-sm font-medium">
              {d.title || "Untitled session"}
            </strong>
            <span className="text-xs text-muted-foreground">
              {harnessLabels[d.harness] ?? d.harness}
              {d.last_activity_at !== null && ` · ${ago(d.last_activity_at)}`}
            </span>
          </div>
          {session ? (
            <Presence tone="connected">
              {session.actor_id
                ? `Hired as ${name(session.actor_id)}`
                : "Open in the Console"}
            </Presence>
          ) : d.availability === "attention" ? (
            <Presence tone="attention" className="max-w-sm">
              {d.reason ?? "Cannot be connected right now"}
            </Presence>
          ) : hiring !== d.id ? (
            <Button disabled={busy} onClick={() => setHiring(d.id)}>
              Hire…
            </Button>
          ) : null}
        </div>
        {hiring === d.id && !session && (
          <HireForm
            session={d}
            previous={linked(d, true)?.actor_id ?? undefined}
            agents={actors.filter(
              (a) =>
                a.kind === "agent" && !a.archived && a.harness === d.harness,
            )}
            busy={busy}
            cancel={() => setHiring(undefined)}
            hire={(agent) =>
              perform(async () => {
                await chat.attach(d.id, agent);
                setHiring(undefined);
              })
            }
          />
        )}
      </li>
    );
  };
  const projects = (list: DiscoveredSession[]) =>
    byProject(list).map((p) => (
      <div key={p.workspace} className="flex flex-col gap-2">
        <h4 className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
          {p.name}{" "}
          <small className="font-mono text-xs font-normal text-muted-foreground">
            {p.workspace}
          </small>
        </h4>
        <ul className="divide-y rounded-xl border bg-card">
          {p.sessions.map(row)}
        </ul>
      </div>
    ));

  return (
    <section
      aria-label="Hire an agent"
      className="flex max-w-3xl flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <Eyebrow>Team / Hire</Eyebrow>
          <Button
            variant="outline"
            disabled={searching}
            onClick={() => void search()}
          >
            {searching ? "Looking…" : "Look again"}
          </Button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Hire an agent.
        </h1>
      </div>
      <StartSession
        chat={chat}
        actors={actors}
        folders={[
          ...recentFolders(chat.sessions),
          ...found.map((d) => d.workspace),
        ]}
        busy={busy}
        perform={perform}
        heading="Start a new agent"
        intro="ZeroLux runs it in the folder you choose. What you write in your chats reaches it as yours."
      />
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">
          Or hire a session you already have
        </h2>
        <p className="text-sm text-muted-foreground">
          ZeroLux looks for your pi, Claude Code and Codex sessions. Pick one:
          that agent joins your chats with everything it already knows. It can
          reply and resume this session until you press Stop.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {discovery?.errors.map((e) => (
        <p key={e.harness} className="text-sm text-attention">
          {harnessLabels[e.harness] ?? e.harness}: {e.message}
        </p>
      ))}
      {discovery && found.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No sessions found. Start pi, Claude Code or Codex in a project folder,
          then look again.
        </p>
      )}
      {projects(ready)}
      {discovery && ready.length === 0 && unavailable.length > 0 && (
        <p className="text-sm text-muted-foreground">
          None of your sessions can be hired right now.
        </p>
      )}
      {unavailable.length > 0 && (
        <details className="group flex flex-col gap-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {unavailable.length} other session
            {unavailable.length === 1 ? "" : "s"} can't be hired right now
          </summary>
          <div className="mt-3 flex flex-col gap-6">
            {projects(unavailable)}
          </div>
        </details>
      )}
    </section>
  );
}

/** A new native identity; recovery continues existing sessions instead. */
const startable = ["claude-code", "codex", "pi"] as const;
type Startable = (typeof startable)[number];
const NO_AGENT = "none";

/**
 * Starts a session ZeroLux runs in a folder: the owner's own, or for an agent, new or
 * existing. What is left blank, the harness decides with its own settings.
 */
export function StartSession({
  chat,
  actors,
  folders,
  busy,
  perform,
  agent: initial = "new",
  heading,
  intro,
  created,
  className,
}: {
  chat: Chat;
  actors: Actor[];
  /** Folders ZeroLux has seen sessions in, offered as suggestions. */
  folders: string[];
  busy: boolean;
  perform: Perform;
  /** Who it works for at first: no agent, or a new one. */
  agent?: "none" | "new";
  heading: string;
  intro: string;
  /** The session just started, e.g. to open it. */
  created?: (session: ChatSession) => void;
  className?: string;
}) {
  const [harness, setHarness] = useState<Startable>("claude-code");
  const agents = actors.filter(
    (a) => a.kind === "agent" && !a.archived && a.harness === harness,
  );
  // NO_AGENT, "" for a new agent, or an agent by its place in the list: no IDs in the page.
  const [pick, setPick] = useState(initial === "none" ? NO_AGENT : "");
  const actorId =
    pick && pick !== NO_AGENT ? agents[Number(pick)]?.id : undefined;
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState<ClaudeMode>("default");
  // Codex: unset means Codex's own settings, never a choice made for the owner.
  const [policy, setPolicy] = useState<CodexApprovalPolicy | "">("");
  const [sandbox, setSandbox] = useState<CodexSandbox | "">("");
  const catalog = useSessionCatalog(harness);
  const launchFields = agentSettingFields(
    harness,
    catalog.data?.models ?? [],
    model || agents.find((agent) => agent.id === actorId)?.model,
  ).slice(0, 2);
  const label = harnessLabels[harness];
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const common = {
      workspace: workspace.trim(),
      ...(worktree ? { worktree: branch.trim() } : {}),
      ...agentLaunchSettings(model, effort),
      ...(pick === NO_AGENT
        ? {}
        : actorId
          ? { actor_id: actorId }
          : { name: name.trim() || label }),
    };
    const input: NewSession =
      harness === "claude-code"
        ? { harness, ...common, permission_mode: mode }
        : harness === "pi"
          ? { harness, ...common }
          : {
              harness,
              ...common,
              ...(policy ? { approval_policy: policy } : {}),
              ...(sandbox ? { sandbox } : {}),
            };
    let session: ChatSession | undefined;
    const started = await perform(async () => {
      session = (await chat.createSession(input)).session;
    });
    if (started && session) {
      setName("");
      setWorkspace("");
      setWorktree(false);
      setBranch("");
      setModel("");
      setEffort("");
      created?.(session);
    }
  }
  return (
    <form
      aria-label={heading}
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card p-4",
        className,
      )}
      onSubmit={(e) => void submit(e)}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{heading}</h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="start-harness">Harness</Label>
        <NativeSelect
          id="start-harness"
          className="w-full"
          value={harness}
          onChange={(e) => {
            setHarness(e.target.value as Startable);
            if (pick !== NO_AGENT) setPick("");
            setModel("");
            setEffort("");
            setMode("default");
            setPolicy("");
            setSandbox("");
          }}
        >
          {startable.map((h) => (
            <NativeSelectOption key={h} value={h}>
              {harnessLabels[h]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="start-agent">Agent</Label>
        <NativeSelect
          id="start-agent"
          className="w-full"
          value={pick}
          onChange={(e) => {
            const pick = e.target.value;
            const agent =
              pick && pick !== NO_AGENT ? agents[Number(pick)] : undefined;
            setPick(pick);
            setMode((agent?.permission_mode as ClaudeMode) || "default");
            setPolicy((agent?.approval_policy as CodexApprovalPolicy) || "");
            setSandbox((agent?.sandbox as CodexSandbox) || "");
          }}
        >
          <NativeSelectOption value={NO_AGENT}>
            No agent: only in the Console
          </NativeSelectOption>
          <NativeSelectOption value="">A new agent</NativeSelectOption>
          {agents.map((a, i) => (
            <NativeSelectOption key={a.id} value={String(i)}>
              Another session of {a.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {pick === "" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="start-name">Agent name</Label>
          <Input
            id="start-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={label}
            maxLength={200}
          />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="start-folder">Folder</Label>
        <Input
          id="start-folder"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="/Users/you/projects/app"
          list="start-folders"
          required
          className="font-mono"
        />
        <datalist id="start-folders">
          {[...new Set(folders)].map((folder) => (
            <option key={folder} value={folder} />
          ))}
        </datalist>
      </div>
      <div className="flex flex-col gap-2">
        <Label className="font-normal">
          <Checkbox
            checked={worktree}
            onCheckedChange={(checked) => setWorktree(checked)}
          />
          In a new git worktree of the folder
        </Label>
        {worktree && (
          <Input
            aria-label="Branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="Branch: ZeroLux names one if empty"
            maxLength={200}
            className="font-mono"
          />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {launchFields.map(({ key, label, options }) => (
          <div key={key} className="flex flex-col gap-2">
            <Label htmlFor={`start-${key}`}>{label} · optional</Label>
            <NativeSelect
              id={`start-${key}`}
              value={key === "model" ? model : effort}
              disabled={
                busy || catalog.loading || Object.keys(options).length === 0
              }
              onChange={(event) => {
                if (key === "model") {
                  setModel(event.target.value);
                  setEffort("");
                } else setEffort(event.target.value);
              }}
            >
              <NativeSelectOption value="">
                {pick === NO_AGENT
                  ? "Harness choice"
                  : "Agent or harness choice"}
              </NativeSelectOption>
              {Object.entries(options).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ))}
      </div>
      {!catalog.loading && catalog.data?.models.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Connect this harness to load its model choices. You can start with its
          own settings.
        </p>
      )}
      {catalog.error && (
        <p className="text-xs text-attention">{catalog.error}</p>
      )}
      {harness === "claude-code" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="start-mode">Permissions</Label>
          <NativeSelect
            id="start-mode"
            className="w-full"
            value={mode}
            onChange={(e) => setMode(e.target.value as ClaudeMode)}
          >
            {(Object.keys(claudeModes) as ClaudeMode[]).map((m) => (
              <NativeSelectOption key={m} value={m}>
                {claudeModes[m]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : harness === "codex" ? (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="start-policy">Approvals</Label>
            <NativeSelect
              id="start-policy"
              className="w-full"
              value={policy}
              onChange={(e) =>
                setPolicy(e.target.value as CodexApprovalPolicy | "")
              }
            >
              <NativeSelectOption value="">Codex settings</NativeSelectOption>
              {(
                Object.keys(codexApprovalPolicies) as CodexApprovalPolicy[]
              ).map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {codexApprovalPolicies[p]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="start-sandbox">Sandbox</Label>
            <NativeSelect
              id="start-sandbox"
              className="w-full"
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value as CodexSandbox | "")}
            >
              <NativeSelectOption value="">Codex settings</NativeSelectOption>
              {(Object.keys(codexSandboxes) as CodexSandbox[]).map((m) => (
                <NativeSelectOption key={m} value={m}>
                  {codexSandboxes[m]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Uses pi's own tools and project settings.
        </p>
      )}
      <Button
        type="submit"
        className="self-start"
        disabled={busy || !workspace.trim()}
      >
        Start
      </Button>
    </form>
  );
}

/** The team: each of your agents once, with what it is doing; each opens its profile. */
export function Team({
  workspace,
  chat,
  owner,
  hire,
}: {
  workspace: Workspace;
  chat: Chat;
  owner: Actor;
  hire: () => void;
}) {
  const rows = activeActors(workspace.actors)
    .filter((a) => a.kind === "agent" && a.owner_id === owner.id)
    .map((agent) => {
      const { sessions, earlier } = agentWork(agent, chat);
      return {
        agent,
        presence: agentPresence(agent.id, chat.sessions),
        // Where it works, or last worked.
        folder: (sessions[0] ?? earlier[0])?.workspace,
      };
    });
  const count = (tone: Tone) =>
    rows.filter((r) => r.presence.tone === tone).length;
  const summary = [
    `${rows.length} agent${rows.length === 1 ? "" : "s"}`,
    count("working") > 0 && `${count("working")} working`,
    count("attention") > 0 &&
      `${count("attention")} need${count("attention") === 1 ? "s" : ""} your attention`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-label="Your agents" className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <Eyebrow>Team</Eyebrow>
          <Button onClick={hire}>Hire an agent</Button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Your agents.</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length ? summary : "No agents yet."}
        </p>
      </div>
      {rows.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {rows.map(({ agent, presence, folder }) => (
            <li key={agent.id}>
              <Link
                to={`/team/${agent.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
              >
                <Mark actor={agent} state={presence.tone} className="size-9" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-sm text-agent-foreground">
                    {agent.name}
                  </span>
                  <span className="truncate text-xs text-faint">
                    {memberRole(agent)}
                    {folder && (
                      <>
                        {" · "}
                        <span title={folder} className="font-mono">
                          {folderName(folder)}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <Presence tone={presence.tone} className="max-sm:hidden">
                  {presence.label}
                </Presence>
                <ChevronRightIcon
                  aria-hidden
                  className="size-4 shrink-0 text-faint"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** An agent on its own page, below the way back to the team. */
export function AgentPage({
  agent,
  workspace,
  chat,
  busy,
  perform,
}: {
  agent: Actor;
  workspace: Workspace;
  chat: Chat;
  busy: boolean;
  perform: Perform;
}) {
  return (
    <section
      aria-label={`${agent.name}'s profile`}
      className="flex max-w-2xl flex-col gap-4"
    >
      <Eyebrow>
        <Link to="/team" className="transition-colors hover:text-foreground">
          Team
        </Link>{" "}
        / {agent.name}
      </Eyebrow>
      <div className="overflow-hidden rounded-xl border bg-card">
        <AgentProfile
          agent={agent}
          workspace={workspace}
          chat={chat}
          busy={busy}
          perform={perform}
        />
      </div>
    </section>
  );
}

/** Sessions ZeroLux runs, and pi ones it can continue from their saved file. */
export const resumable = (s: ChatSession) =>
  (s.harness === "pi" || s.origin === "owned") &&
  (s.status === "stopped" || s.status === "attention");
/** A pi hired from a terminal: ZeroLux can take it over while it is idle there. */
export const takeable = (s: ChatSession) =>
  s.harness === "pi" && s.origin === "attached" && s.status === "connected";

/** An agent's profile: who it is, what it does now, where it runs, and its chats. */
export function AgentProfile({
  agent,
  workspace,
  chat,
  busy,
  perform,
}: {
  agent: Actor;
  workspace: Workspace;
  chat: Chat;
  busy: boolean;
  perform: Perform;
}) {
  const owner = workspace.actors.find((a) => a.id === agent.owner_id);
  const { label, tone } = agentPresence(agent.id, chat.sessions);
  const { sessions, earlier, chats, answering, dm, waiting } = agentWork(
    agent,
    chat,
  );
  // With nothing live, its last session stands where the live one would be.
  const current = sessions.length ? sessions : earlier.slice(0, 1);
  const older = earlier.slice(sessions.length ? 0 : 1);
  // The new name while renaming; chats, sessions and history keep the same agent.
  const [draft, setDraft] = useState<string>();
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const name = draft?.trim();
    if (name && (await perform(() => chat.rename(agent.id, name))))
      setDraft(undefined);
  }
  const card = (session: ChatSession, facts: boolean) => (
    <SessionCard
      key={session.id}
      session={session}
      name={agent.name}
      facts={facts}
      busy={busy}
      stop={() => perform(() => chat.stop(session.id))}
      interrupt={() =>
        perform(async () => void (await chat.interrupt(session.id)))
      }
      resume={
        resumable(session)
          ? () => perform(() => chat.resume(session.id))
          : undefined
      }
      takeover={
        takeable(session)
          ? () => perform(() => chat.takeoverPi(session.id))
          : undefined
      }
    />
  );
  return (
    <>
      <ProfileHead
        actor={agent}
        state={tone}
        role={memberRole(agent)}
        status={label}
      >
        {dm && (
          <Link
            to={`/chats/${dm.id}`}
            className={cn(
              buttonVariants({ size: "sm" }),
              "bg-agent text-background hover:bg-agent/80",
            )}
          >
            Message {agent.name}
          </Link>
        )}
        {draft === undefined && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(agent.name)}
          >
            Rename
          </Button>
        )}
      </ProfileHead>
      {draft !== undefined && (
        <form
          className="flex gap-2 border-b px-5 py-3"
          onSubmit={(e) => void save(e)}
        >
          <Input
            aria-label={`New name for ${agent.name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
            autoFocus
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(undefined)}
          >
            Cancel
          </Button>
        </form>
      )}
      <section className="border-b px-5 py-4">
        <Facts>
          <Fact label="Owned by">
            {owner ? (
              <Link
                to={`/org?actor=${owner.id}`}
                className="inline-flex items-center gap-1.5 font-medium text-human-foreground hover:underline"
              >
                <ActorMark
                  kind="human"
                  name={owner.name}
                  className="size-5 text-[9px]"
                />
                {owner.name}
              </Link>
            ) : (
              <span className="text-faint">No one</span>
            )}
          </Fact>
          <Fact label="Working on" className="truncate">
            {answering ? (
              <Link to={`/chats/${answering.id}`} className="hover:underline">
                Answering in {answering.title}
              </Link>
            ) : (
              <span className="text-faint">Nothing right now</span>
            )}
          </Fact>
          <Fact label="Waiting" className="font-mono text-xs">
            {waiting} message{waiting === 1 ? "" : "s"}
          </Fact>
        </Facts>
      </section>
      <AgentSettingsForm
        key={agent.id}
        agent={agent}
        busy={busy}
        save={async (settings) => {
          let actor: Actor | undefined;
          const ok = await perform(async () => {
            actor = await setAgentSettings(agent.id, settings);
          });
          return ok ? actor : undefined;
        }}
      />
      {current.length > 0 && (
        <section className="flex flex-col gap-3 border-b px-5 py-4">
          <Eyebrow>
            {sessions.length === 0
              ? "Last session"
              : sessions.length === 1
                ? "Session"
                : `Sessions · ${sessions.length}`}
          </Eyebrow>
          {current.map((s) => card(s, true))}
        </section>
      )}
      <section className="flex flex-col gap-1 border-b px-5 py-4">
        <Eyebrow className="mb-1.5">Chats · {chats.length}</Eyebrow>
        {chats.map((c) => (
          <Link
            key={c.id}
            to={`/chats/${c.id}`}
            className="-mx-2 flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <span className="truncate">
              {c.kind === "dm" ? "Direct chat" : c.title}
            </span>
            <span className="ml-auto shrink-0 text-xs text-faint">
              {c.members.length} members
            </span>
          </Link>
        ))}
        {chats.length === 0 && (
          <p className="text-sm text-muted-foreground">Not in a chat yet.</p>
        )}
      </section>
      {older.length > 0 && (
        <details className="border-b px-5 py-4">
          <summary className="cursor-pointer">
            <Eyebrow>Earlier sessions · {older.length}</Eyebrow>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {older.map((s) => card(s, false))}
          </div>
        </details>
      )}
      <section className="flex flex-col gap-2 px-5 py-4">
        <Eyebrow>Budget</Eyebrow>
        {/* TODO: kernel: the agent's monthly spend and budget, from its harness usage. */}
        <p className="text-sm text-muted-foreground">Not tracked yet.</p>
      </section>
    </>
  );
}

/** The agent's defaults for its new sessions, among its harness's native choices. */
export function AgentSettingsForm({
  agent,
  busy,
  save,
  revision = "",
}: {
  agent: Actor;
  busy: boolean;
  save: (settings: AgentSettings) => Promise<Actor | undefined>;
  revision?: string;
}) {
  const native = useAgentSettings(agent, revision);
  const current = native.data?.actor ?? agent;
  const models = native.data?.models ?? [];
  const [changes, setChanges] = useState<AgentSettings>({});
  const model = changes.model ?? current.model;
  const locked = busy || native.loading || Boolean(native.error);
  const fields = agentSettingFields(agent.harness, models, model);
  const applicable = canApplyAgentSettings(
    changes,
    fields,
    native.data?.editable ?? [],
  );
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (locked || !applicable) return;
    const actor = await save(changes);
    if (actor) {
      native.accept(actor);
      setChanges({});
    }
    native.refresh(); // A failed response may still have followed a native change.
  }
  return (
    <form
      aria-label="Agent settings"
      className="flex flex-col gap-3 border-b px-5 py-4"
      onSubmit={(event) => void submit(event)}
    >
      <Eyebrow>Agent settings</Eyebrow>
      {native.loading && (
        <p className="text-xs text-muted-foreground">
          Reading native settings…
        </p>
      )}
      {fields.map(({ key, label, options }) => {
        let value = changes[key] ?? current[key] ?? "";
        if (
          key === "effort" &&
          changes.model !== undefined &&
          !Object.hasOwn(options, value)
        )
          value = "";
        return (
          <div key={key} className="flex flex-col gap-2">
            <Label htmlFor={`agent-setting-${key}`}>{label}</Label>
            <NativeSelect
              id={`agent-setting-${key}`}
              className="w-full"
              value={value}
              disabled={
                locked ||
                !native.data?.editable.includes(key) ||
                Object.keys(options).length === 0
              }
              onChange={(event) => {
                const value = event.target.value;
                setChanges((previous) => {
                  const next = { ...previous, [key]: value };
                  if (
                    key === "model" &&
                    next.effort &&
                    !agentModelOption(models, value)?.efforts.includes(
                      next.effort,
                    )
                  )
                    delete next.effort;
                  return next;
                });
              }}
            >
              <NativeSelectOption value="" disabled>
                {changes.model && key === "effort"
                  ? "Native choice"
                  : "The harness's own default"}
              </NativeSelectOption>
              {value && !Object.hasOwn(options, value) && (
                <NativeSelectOption value={value} disabled>
                  {value}
                </NativeSelectOption>
              )}
              {Object.entries(options).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        For its new sessions; each session changes its own in the Console.
      </p>
      {native.error && (
        <p role="alert" className="text-sm text-destructive">
          {native.error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={locked || !applicable}>
          Apply
        </Button>
        {!!Object.keys(changes).length && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setChanges({})}
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy || native.loading}
          onClick={native.refresh}
        >
          Refresh
        </Button>
      </div>
    </form>
  );
}

export function HireForm({
  session,
  previous,
  agents,
  busy,
  hire,
  cancel,
}: {
  session: DiscoveredSession;
  /** The agent this session had before Stop: hiring it again keeps its chats. */
  previous?: string;
  agents: Actor[];
  busy: boolean;
  /** For an agent (an existing one, or a new one by name), or as the owner's own session. */
  hire: (agent: { name?: string; actor_id?: string }) => Promise<boolean>;
  cancel: () => void;
}) {
  const [name, setName] = useState("");
  // "" is a new agent, NO_AGENT the owner's own session, else an agent's ID.
  const [actorId, setActorId] = useState(
    agents.some((a) => a.id === previous) ? previous! : "",
  );
  const label = harnessLabels[session.harness] ?? session.harness;
  function submit(event: SubmitEvent) {
    event.preventDefault();
    void hire(
      actorId === NO_AGENT
        ? {}
        : actorId
          ? { actor_id: actorId }
          : { name: name.trim() || label },
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3"
      onSubmit={submit}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`hire-as-${session.id}`}>Hire as</Label>
        <NativeSelect
          id={`hire-as-${session.id}`}
          className="w-full"
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
        >
          <NativeSelectOption value="">A new agent</NativeSelectOption>
          {agents.map((a) => (
            <NativeSelectOption key={a.id} value={a.id}>
              {a.id === previous
                ? `${a.name} again, back in their chats`
                : `Another session of ${a.name}`}
            </NativeSelectOption>
          ))}
          <NativeSelectOption value={NO_AGENT}>
            No agent: only in the Console
          </NativeSelectOption>
        </NativeSelect>
      </div>
      {!actorId && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`agent-name-${session.id}`}>Agent name</Label>
          <Input
            id={`agent-name-${session.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={label}
            maxLength={200}
            autoFocus
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Hire
        </Button>
        <Button type="button" variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {actorId === NO_AGENT
          ? "It opens in the Console: you follow and steer it there, no agent joins your chats."
          : `${
              actorId
                ? agents.find((a) => a.id === actorId)?.name
                : name.trim() || label
            } will be able to reply and resume this session until you press Stop.`}
      </p>
    </form>
  );
}

/** One session of an agent: where it runs, its state, and what can be done with it. */
export function SessionCard({
  session,
  name,
  facts,
  busy,
  stop,
  interrupt,
  resume,
  takeover,
  usage,
}: {
  session: ChatSession;
  name: string;
  /** Where and how it runs, in full; an earlier session names only its harness and folder. */
  facts: boolean;
  /** How full its context is and what it has used, where its harness says. */
  usage?: SessionUsage | null;
  busy: boolean;
  stop: () => Promise<boolean>;
  /** Stops the turn it is working on; the session stays. */
  interrupt?: () => Promise<boolean>;
  /** A session ZeroLux runs, stopped or needing attention: start it again. */
  resume?: () => Promise<boolean>;
  takeover?: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<"stop" | "takeover">();
  const confirmedAction = confirming === "takeover" ? takeover : stop;
  async function confirm() {
    if (confirmedAction && (await confirmedAction())) setConfirming(undefined);
  }
  const harness = harnessLabels[session.harness] ?? session.harness;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="truncate text-sm font-medium">
            {session.title || "Untitled session"}
          </strong>
          {!facts && (
            <span className="truncate text-xs text-faint">
              {harness} ·{" "}
              <span title={session.workspace} className="font-mono">
                {folderName(session.workspace)}
              </span>
            </span>
          )}
        </div>
        <Presence tone={sessionTone(session)}>{sessionState(session)}</Presence>
      </div>
      {facts && (
        <Facts>
          <Fact label="Harness">{harness}</Fact>
          <Fact label="Folder" className="font-mono text-xs break-all">
            {session.workspace}
          </Fact>
          <Fact label="Started by">
            {session.origin === "owned" ? "ZeroLux" : "You, then hired"}
          </Fact>
          {usage?.context_tokens != null && (
            <Fact label="Context">
              {tokenCount(usage.context_tokens)}
              {usage.context_window
                ? ` of ${tokenCount(usage.context_window)} · ${percent(contextShare(usage) ?? 0)}`
                : ""}
            </Fact>
          )}
          {usage?.total_tokens != null && (
            <Fact label="Tokens used">{tokenCount(usage.total_tokens)}</Fact>
          )}
          {usage?.cost_usd != null && (
            <Fact label="Cost">{usdCost(usage.cost_usd)}</Fact>
          )}
        </Facts>
      )}
      {session.attention_reason && (
        <p className="text-xs text-attention">{session.attention_reason}</p>
      )}
      {!confirming && (takeover || resume || session.status !== "stopped") && (
        <div className="flex flex-wrap gap-2">
          {interrupt &&
            session.status === "connected" &&
            session.activity === "working" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void interrupt()}
              >
                Interrupt
              </Button>
            )}
          {takeover && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming("takeover")}
            >
              Take over
            </Button>
          )}
          {resume && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void resume()}
            >
              Resume
            </Button>
          )}
          {session.status !== "stopped" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirming("stop")}
            >
              Stop
            </Button>
          )}
        </div>
      )}
      {confirming && (
        <div className="flex flex-col gap-3 rounded-lg bg-attention/10 p-3">
          <p className="text-sm">
            {confirming === "takeover"
              ? `Close ${name}'s idle pi terminal and continue the same session under ZeroLux? Work and queued messages must finish first; clear terminal drafts and dialogs. Its saved history and launch profile must be verified. No process is force-killed.`
              : `Stop ${name}? It will no longer reply in ZeroLux or resume this session. Your chats and their history stay.`}
          </p>
          <div className="flex gap-2">
            <Button
              variant={confirming === "stop" ? "destructive" : "default"}
              disabled={busy || !confirmedAction}
              onClick={() => void confirm()}
            >
              {confirming === "stop" ? "Stop" : "Take over"} {name}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(undefined)}>
              Keep working
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
