import { useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { errorMessage, harnessLabels } from "./api";
import type { Actor } from "./api";
import {
  ago,
  byProject,
  claudeModes,
  codexApprovalPolicies,
  codexSandboxes,
  listedSessions,
  sessionState,
} from "@zerolux/chat";
import type {
  ChatSession,
  ClaudeMode,
  CodexApprovalPolicy,
  CodexSandbox,
  DiscoveredSession,
  Discovery,
} from "@zerolux/chat";
import type { Chat, Perform } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Eyebrow, Presence } from "@/components/presence";
import { sessionTone } from "./presence";

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
  const name = (id: string) => actors.find((a) => a.id === id)?.name;
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
              Hired as {name(session.actor_id)}
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
            previous={linked(d, true)?.actor_id}
            agents={actors.filter(
              (a) =>
                a.kind === "agent" && !a.archived && a.harness === d.harness,
            )}
            busy={busy}
            cancel={() => setHiring(undefined)}
            hire={(label, actorId) =>
              perform(async () => {
                await chat.hire(d.id, label, actorId);
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
      <StartAgent
        chat={chat}
        actors={actors}
        folders={[
          ...chat.sessions.map((s) => s.workspace),
          ...found.map((d) => d.workspace),
        ]}
        busy={busy}
        perform={perform}
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

/** Starts a new Claude Code session ZeroLux runs in a folder. */
/** A new native identity; recovery continues existing sessions instead. */
const startable = ["claude-code", "codex", "pi"] as const;
type Startable = (typeof startable)[number];

export function StartAgent({
  chat,
  actors,
  folders,
  busy,
  perform,
}: {
  chat: Chat;
  actors: Actor[];
  /** Folders ZeroLux has seen sessions in, offered as suggestions. */
  folders: string[];
  busy: boolean;
  perform: Perform;
}) {
  const [harness, setHarness] = useState<Startable>("claude-code");
  const agents = actors.filter(
    (a) => a.kind === "agent" && !a.archived && a.harness === harness,
  );
  // The chosen agent by its place in the list: no IDs in the page.
  const [pick, setPick] = useState("");
  const actorId = pick ? agents[Number(pick)]?.id : undefined;
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [mode, setMode] = useState<ClaudeMode>("default");
  // Codex: unset means Codex's own settings, never a choice made for the owner.
  const [policy, setPolicy] = useState<CodexApprovalPolicy | "">("");
  const [sandbox, setSandbox] = useState<CodexSandbox | "">("");
  const label = harnessLabels[harness];
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const common = {
      name: name.trim() || label,
      workspace: workspace.trim(),
      ...(actorId ? { actor_id: actorId } : {}),
    };
    const started = await perform(() =>
      harness === "claude-code"
        ? chat.startClaude({ ...common, permission_mode: mode })
        : harness === "pi"
          ? chat.startPi(common)
          : chat.startCodex({
              ...common,
              ...(policy ? { approval_policy: policy } : {}),
              ...(sandbox ? { sandbox } : {}),
            }),
    );
    if (started) {
      setName("");
      setWorkspace("");
    }
  }
  return (
    <form
      aria-label="Start an agent"
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
      onSubmit={(e) => void submit(e)}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Start a new agent</h2>
        <p className="text-sm text-muted-foreground">
          ZeroLux runs it in the folder you choose. What you write in your chats
          reaches it as yours.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="start-harness">Harness</Label>
        <NativeSelect
          id="start-harness"
          className="w-full"
          value={harness}
          onChange={(e) => {
            setHarness(e.target.value as Startable);
            setPick("");
          }}
        >
          {startable.map((h) => (
            <NativeSelectOption key={h} value={h}>
              {harnessLabels[h]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {agents.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="start-agent">Agent</Label>
          <NativeSelect
            id="start-agent"
            className="w-full"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <NativeSelectOption value="">A new agent</NativeSelectOption>
            {agents.map((a, i) => (
              <NativeSelectOption key={a.id} value={String(i)}>
                Another session of {a.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      {!actorId && (
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
          Uses pi's own model, tools and project settings.
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

/** The hired agents: their state, rename and stop. */
export function Team({
  chat,
  actors,
  busy,
  perform,
  hire,
}: {
  chat: Chat;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
  hire: () => void;
}) {
  const name = (id: string) => actors.find((a) => a.id === id)?.name;
  const hired = chat.sessions.filter((s) => s.status !== "stopped");
  // A stop the harness could not confirm keeps its reason visible.
  const shown = listedSessions(chat.sessions);
  return (
    <section aria-label="Your agents" className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Eyebrow>Team / Your agents · {hired.length}</Eyebrow>
        <Button onClick={hire}>Hire an agent</Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {shown.map((s) => (
            <HiredSession
              key={s.id}
              session={s}
              name={name(s.actor_id) ?? "Agent"}
              busy={busy}
              stop={() => perform(() => chat.stop(s.id))}
              resume={
                (s.harness === "pi" || s.origin === "owned") &&
                (s.status === "stopped" || s.status === "attention")
                  ? () => perform(() => chat.resume(s.id))
                  : undefined
              }
              takeover={
                s.harness === "pi" &&
                s.origin === "attached" &&
                s.status === "connected"
                  ? () => perform(() => chat.takeoverPi(s.id))
                  : undefined
              }
              rename={(next) => perform(() => chat.rename(s.actor_id, next))}
            />
          ))}
        </ul>
      )}
    </section>
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
  hire: (name: string, actorId?: string) => Promise<boolean>;
  cancel: () => void;
}) {
  const [name, setName] = useState("");
  const [actorId, setActorId] = useState(
    agents.some((a) => a.id === previous) ? previous! : "",
  );
  const label = harnessLabels[session.harness] ?? session.harness;
  function submit(event: SubmitEvent) {
    event.preventDefault();
    void hire(name.trim() || label, actorId || undefined);
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3"
      onSubmit={submit}
    >
      {agents.length > 0 && (
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
          </NativeSelect>
        </div>
      )}
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
        {actorId
          ? agents.find((a) => a.id === actorId)?.name
          : name.trim() || label}{" "}
        will be able to reply and resume this session until you press Stop.
      </p>
    </form>
  );
}

export function HiredSession({
  session,
  name,
  busy,
  stop,
  rename,
  resume,
  takeover,
}: {
  session: ChatSession;
  name: string;
  busy: boolean;
  stop: () => Promise<boolean>;
  rename: (name: string) => Promise<boolean>;
  /** A session ZeroLux runs, stopped or needing attention: start it again. */
  resume?: () => Promise<boolean>;
  takeover?: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<"stop" | "takeover">();
  const confirmedAction = confirming === "takeover" ? takeover : stop;
  async function confirm() {
    if (confirmedAction && (await confirmedAction())) setConfirming(undefined);
  }
  // The new name while renaming; chats, sessions and history keep the same agent.
  const [draft, setDraft] = useState<string>();
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (draft?.trim() && (await rename(draft.trim()))) setDraft(undefined);
  }
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {draft === undefined ? (
            <strong className="text-sm font-medium">{name}</strong>
          ) : (
            <form className="flex gap-2" onSubmit={(e) => void save(e)}>
              <Input
                aria-label={`New name for ${name}`}
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
          <span className="text-xs text-muted-foreground">
            {harnessLabels[session.harness] ?? session.harness} ·{" "}
            {session.title || "Untitled session"}
          </span>
          <small
            title={session.workspace}
            className="truncate font-mono text-xs text-muted-foreground"
          >
            {session.workspace}
          </small>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Presence tone={sessionTone(session)}>
            {sessionState(session)}
          </Presence>
          {session.attention_reason && (
            <small className="max-w-xs text-right text-xs text-attention">
              {session.attention_reason}
            </small>
          )}
          {takeover && !confirming && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming("takeover")}
            >
              Take over
            </Button>
          )}
          {resume && !confirming && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void resume()}
            >
              Resume
            </Button>
          )}
          {session.status !== "stopped" && !confirming && (
            <div className="flex gap-2">
              {draft === undefined && (
                <Button variant="outline" onClick={() => setDraft(name)}>
                  Rename
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConfirming("stop")}
              >
                Stop
              </Button>
            </div>
          )}
        </div>
      </div>
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
    </li>
  );
}
