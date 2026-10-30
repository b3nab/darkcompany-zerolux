import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";
import { cn } from "cn";
import {
  AuthConnection,
  errorMessage,
  multiWorkspace,
  pickWorkspace,
  rememberedWorkspace,
  rememberWorkspace,
  requiresSignIn,
  setKernelUrl,
  workspaceBase,
  workspaceSummary,
} from "@zerolux/chat";
import type {
  AccountIdentity,
  AuthHealth,
  AuthIdentity,
  Invitation,
  ServedWorkspace,
} from "@zerolux/chat";
import {
  chooseFolder,
  desktopConnection,
  desktopNewWindow,
  desktopSignIn,
  kernelAddress,
  kernelHere,
  macKeys,
  useDesktopEvent,
  WORKSPACES_LINK,
} from "./desktop";
import { AuthenticationContext, Frame, SignIn } from "./AuthGate";
import type { Credentials } from "./AuthGate";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

/** This page's workspace, the kernel's sign-in, and the account's other workspaces there. */
export interface Here {
  connection: AuthConnection;
  health: AuthHealth;
  /** The account's workspaces on this kernel, the oldest first. */
  workspaces: ServedWorkspace[];
  workspace: ServedWorkspace;
  /** Another workspace, here or in a new window or tab. */
  open(workspace: ServedWorkspace, newWindow?: boolean): void;
  /** The list of workspaces, to make a new one. */
  create(): void;
}
const HereContext = createContext<Here | null>(null);
export const useHere = () => useContext(HereContext);

/** The page at a kernel's root that lists the account's workspaces there. */
export const WORKSPACES_PAGE = "/workspaces";

export const pageOf = (workspace: { id: string }) =>
  `/w/${encodeURIComponent(workspace.id)}`;

/** Where a page is among the account's workspaces: in one, or choosing one. */
export type Placed =
  | {
      workspace: ServedWorkspace;
      basename: string;
      /** The page's address, when it changes to name the workspace. */
      address?: string;
    }
  | { choose: { creating: boolean } };

/**
 * A kernel of several workspaces has each at `/w/<id>/…`: the one the address names, else the
 * one chosen last, else the account's only one. An older kernel has its one at its root.
 */
export function place(
  path: string,
  search: string,
  workspaces: ServedWorkspace[],
  multi: boolean,
  remembered?: string,
): Placed {
  const named = /^\/w\/([^/]+)/.exec(path);
  if (!multi)
    return {
      workspace: workspaces[0]!,
      basename: "",
      address: named ? path.slice(named[0].length) || "/" : undefined,
    };
  if (path === WORKSPACES_PAGE)
    return { choose: { creating: new URLSearchParams(search).has("new") } };
  const id = named ? decodeURIComponent(named[1]!) : undefined;
  const workspace =
    id !== undefined
      ? workspaces.find((w) => w.id === id)
      : pickWorkspace(workspaces, remembered);
  if (!workspace) return { choose: { creating: workspaces.length === 0 } };
  const basename = pageOf(workspace);
  return {
    workspace,
    basename,
    address: named ? undefined : `${basename}${path}`,
  };
}

/** The invitation a join link carries: `/join?invite=…`, under its workspace's `/w/<id>`. */
export function invitedTo(path: string, search: string) {
  const match = /^(?:\/w\/([^/]+))?\/join$/.exec(path);
  const token = new URLSearchParams(search).get("invite");
  if (!match || !token) return undefined;
  return {
    workspace: match[1] ? decodeURIComponent(match[1]) : undefined,
    token,
  };
}

/** A workspace's initial, as its mark. */
export function WorkspaceMark({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-sm border border-input bg-secondary text-xs font-semibold",
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Where to go back to the workspaces: the desktop's own window, or the kernel's list. */
export function useWorkspacesLink() {
  const here = useHere();
  if (desktopConnection()) return WORKSPACES_LINK;
  return here && multiWorkspace(here.health) ? WORKSPACES_PAGE : undefined;
}

export type Stage =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | {
      kind: "sign-in";
      health: AuthHealth;
      invitation?: Invitation;
      invitationError?: string;
    }
  | {
      kind: "choose";
      health: AuthHealth;
      workspaces: ServedWorkspace[];
      creating: boolean;
      /** A workspace the address named, of which the account is not a member. */
      outside?: ServedWorkspace;
    }
  | {
      kind: "in";
      health: AuthHealth;
      workspaces: ServedWorkspace[];
      workspace: ServedWorkspace;
      basename: string;
      identity: AuthIdentity | null;
    };

const RETRY = 5_000;

/** What a page asks of its kernel's sign-in to arrive in a workspace. */
type Gate = Pick<
  AuthConnection,
  "kernel" | "restore" | "workspaces" | "identity" | "claim" | "invitation"
>;

/** A workspace, entered as the person the account is there. */
export async function enterWorkspace(
  connection: Gate,
  health: AuthHealth,
  workspaces: ServedWorkspace[],
  workspace: ServedWorkspace,
): Promise<Stage> {
  let identity = requiresSignIn(health)
    ? await connection.identity(workspace.base)
    : null;
  // An older kernel's workspace becomes its first account's.
  if (identity && !identity.actor_id && identity.setup_required)
    identity = await connection.claim(workspace.base);
  if (identity && !identity.actor_id)
    return {
      kind: "choose",
      health,
      workspaces,
      creating: false,
      outside: workspace,
    };
  return {
    kind: "in",
    health,
    workspaces,
    workspace,
    basename: multiWorkspace(health) ? pageOf(workspace) : "",
    identity,
  };
}

/**
 * Where a page arrives on its kernel: signing in, choosing a workspace, or in one. A join
 * link's invitation is used once the account is signed in, and the page's address then
 * changes (`address`).
 */
export async function arrive(
  connection: Gate,
  path: string,
  search: string,
  invite: ReturnType<typeof invitedTo>,
  remembered?: string,
): Promise<{ stage: Stage; address?: string }> {
  const { health, identity: account } = await connection.restore();
  const joinBase = invite?.workspace
    ? workspaceBase(connection.kernel, invite.workspace)
    : connection.kernel;
  if (requiresSignIn(health) && !account) {
    if (!invite) return { stage: { kind: "sign-in", health } };
    try {
      const invitation = await connection.invitation(joinBase, invite.token);
      return { stage: { kind: "sign-in", health, invitation } };
    } catch (failed) {
      return {
        stage: {
          kind: "sign-in",
          health,
          invitationError: errorMessage(failed),
        },
      };
    }
  }
  if (invite) {
    // Signed in, the invitation makes the account a person of its workspace.
    await connection.claim(joinBase, invite.token);
    path = invite.workspace ? `${pageOf({ id: invite.workspace })}/` : "/";
    search = "";
  }
  const workspaces = await connection.workspaces();
  const there = place(
    path,
    search,
    workspaces,
    multiWorkspace(health),
    remembered,
  );
  if ("choose" in there)
    return {
      stage: {
        kind: "choose",
        health,
        workspaces,
        creating: there.choose.creating,
      },
      address: invite ? WORKSPACES_PAGE : undefined,
    };
  const stage = await enterWorkspace(
    connection,
    health,
    workspaces,
    there.workspace,
  );
  return {
    stage,
    address:
      stage.kind === "in"
        ? (there.address ?? (invite ? path : undefined))
        : undefined,
  };
}

/**
 * The kernel the page belongs to, signed in to once for all its workspaces, and the
 * workspace it shows: every call, file and invitation goes to that workspace's base, and its
 * pages are under `/w/<id>`.
 */
export function WorkspaceRoot({ children }: { children: ReactNode }) {
  const [connection] = useState(() => {
    const desktop = desktopConnection();
    // Packaged desktop pages are cross-origin to their kernel: no cookie reaches it, so
    // their bearer is kept by the desktop, one for each kernel.
    return new AuthConnection(
      kernelAddress() || location.origin,
      desktop?.instanceId,
      desktop ? desktopSignIn() : undefined,
    );
  });
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // A join link's invitation, until it has been used.
  const invite = useRef(invitedTo(location.pathname, location.search));
  const canLeave = useRef<() => boolean>(() => true);
  const version = useRef(0);

  /** The stage the page is at: in a workspace, its calls go to the workspace's base. */
  const land = useCallback(
    (next: Stage) => {
      if (next.kind === "in") {
        setKernelUrl(next.workspace.base);
        if (multiWorkspace(next.health))
          rememberWorkspace(connection.kernel, next.workspace.id);
      }
      setStage(next);
    },
    [connection],
  );
  const enter = useCallback(
    (
      health: AuthHealth,
      workspaces: ServedWorkspace[],
      workspace: ServedWorkspace,
    ) => enterWorkspace(connection, health, workspaces, workspace),
    [connection],
  );

  const settle = useCallback(async () => {
    const run = ++version.current;
    const live = () => run === version.current;
    try {
      const invited = invite.current;
      const { stage: next, address } = await arrive(
        connection,
        location.pathname,
        location.search,
        invited,
        rememberedWorkspace(connection.kernel),
      );
      if (!live()) return;
      // Used once the account is in: an invitation joins one workspace.
      if (next.kind !== "sign-in") invite.current = undefined;
      if (address)
        history.replaceState(
          history.state,
          "",
          invited ? address : `${address}${location.search}${location.hash}`,
        );
      setError("");
      land(next);
    } catch (failed) {
      if (!live() || (failed instanceof Error && failed.name === "AbortError"))
        return;
      setStage({ kind: "failed", error: errorMessage(failed) });
    }
  }, [connection, land]);

  useEffect(() => {
    void settle();
  }, [settle, attempt]);
  // A sign-in the kernel no longer accepts: sign in again.
  useEffect(
    () => connection.onRequired(() => void settle()),
    [connection, settle],
  );
  useEffect(() => () => connection.dispose(), [connection]);
  // An unreachable kernel, often one restarting, is asked again until it answers.
  useEffect(() => {
    if (stage.kind !== "failed") return;
    const again = setTimeout(() => setAttempt((n) => n + 1), RETRY);
    return () => clearTimeout(again);
  }, [stage]);

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failed) {
      setError(errorMessage(failed));
    } finally {
      setBusy(false);
    }
  }

  const signIn = (credentials: Credentials) =>
    act(async () => {
      if (credentials.name)
        await connection.signUp(
          credentials.name,
          credentials.email,
          credentials.password,
          invite.current?.token,
        );
      else await connection.signIn(credentials.email, credentials.password);
      await settle();
    });

  const signOut = () =>
    act(async () => {
      if (!canLeave.current())
        throw new Error("Wait for pending chat messages before signing out.");
      await connection.signOut();
      history.replaceState(null, "", "/");
      await settle();
    });

  /** Another of the account's workspaces, in place of what the page shows. */
  const show = (
    health: AuthHealth,
    workspaces: ServedWorkspace[],
    workspace: ServedWorkspace,
  ) =>
    act(async () => {
      const next = await enter(health, workspaces, workspace);
      if (next.kind === "in") history.pushState(null, "", `${next.basename}/`);
      land(next);
    });

  /** The account's workspaces, to choose one or to make a new one. */
  const choose = (creating: boolean) =>
    act(async () => {
      const { health } = await connection.restore();
      const workspaces = await connection.workspaces();
      history.pushState(
        null,
        "",
        `${WORKSPACES_PAGE}${creating ? "?new" : ""}`,
      );
      setStage({ kind: "choose", health, workspaces, creating });
    });

  const open = (workspace: ServedWorkspace, newWindow?: boolean) => {
    if (newWindow) openElsewhere(workspace);
    else if ("workspaces" in stage)
      void show(stage.health, stage.workspaces, workspace);
  };

  // The desktop sends a window to a page: the list, to make a new workspace, or another
  // workspace's page, as the tray does; this workspace's own pages are the app's.
  useDesktopEvent("zerolux-open", (path) => {
    if (path.startsWith(WORKSPACES_PAGE)) {
      void choose(path.includes("?new"));
      return;
    }
    const id = /^\/w\/([^/]+)/.exec(path)?.[1];
    if (!id || !("workspaces" in stage)) return;
    const target = stage.workspaces.find(
      (workspace) => workspace.id === decodeURIComponent(id),
    );
    if (!target || (stage.kind === "in" && stage.workspace.id === target.id))
      return;
    void act(async () => {
      const next = await enter(stage.health, stage.workspaces, target);
      if (next.kind === "in") history.pushState(null, "", path);
      land(next);
    });
  });
  // ⌃1…9 on a Mac, Alt+1…9 elsewhere: the account's workspaces here, by place.
  const byPlace = useRef<(at: number) => void>(() => {});
  byPlace.current = (at) => {
    if (stage.kind !== "in" || !multiWorkspace(stage.health)) return;
    const workspace = stage.workspaces[at];
    if (workspace && workspace.id !== stage.workspace.id) open(workspace);
  };
  useEffect(() => {
    const mac = macKeys();
    const keys = (event: KeyboardEvent) => {
      const at = /^Digit([1-9])$/.exec(event.code)?.[1];
      const held = mac
        ? event.ctrlKey && !event.altKey
        : event.altKey && !event.ctrlKey;
      if (!at || !held || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      byPlace.current(Number(at) - 1);
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, []);

  if (stage.kind === "in") {
    const here: Here = {
      connection,
      health: stage.health,
      workspaces: stage.workspaces,
      workspace: stage.workspace,
      open,
      create: () => void choose(true),
    };
    const authentication = stage.identity && {
      identity: stage.identity,
      account: connection,
      busy,
      error,
      signOut,
      guard(check: () => boolean) {
        canLeave.current = check;
        return () => {
          if (canLeave.current === check) canLeave.current = () => true;
        };
      },
    };
    return (
      <HereContext value={here}>
        <AuthenticationContext value={authentication}>
          <BrowserRouter key={stage.workspace.id} basename={stage.basename}>
            {children}
          </BrowserRouter>
        </AuthenticationContext>
      </HereContext>
    );
  }
  const back = desktopConnection() && (
    <Button
      variant="outline"
      className="self-start"
      render={<a href={WORKSPACES_LINK} />}
    >
      Back to workspaces
    </Button>
  );
  const host = new URL(connection.kernel).host;
  if (stage.kind === "loading") return <Frame>{null}</Frame>;
  if (stage.kind === "failed")
    return (
      <Frame>
        {back}
        <h1 className="text-3xl font-semibold tracking-tight">
          Can't reach ZeroLux
        </h1>
        <p role="alert" className="text-sm text-destructive">
          {stage.error}
        </p>
        <Button className="self-start" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </Frame>
    );
  if (stage.kind === "sign-in")
    return (
      <Frame>
        {back}
        <SignIn
          health={stage.health}
          invitation={stage.invitation}
          invitationError={stage.invitationError}
          place={stage.health.workspace?.name ?? host}
          busy={busy}
          error={error}
          submit={(credentials) => void signIn(credentials)}
        />
      </Frame>
    );
  return (
    <Frame>
      {back}
      <Workspaces
        place={host}
        workspaces={stage.workspaces}
        outside={stage.outside}
        creating={stage.creating}
        canCreate={multiWorkspace(stage.health)}
        busy={busy}
        error={error}
        open={(workspace, newWindow) => open(workspace, newWindow)}
        create={(name, folder) =>
          void act(async () => {
            const made = await connection.createWorkspace(name, folder);
            const workspaces = await connection.workspaces();
            const next = await enter(stage.health, workspaces, made);
            if (next.kind === "in")
              history.pushState(null, "", `${next.basename}/`);
            land(next);
          })
        }
        startCreating={() => void choose(true)}
        cancel={
          stage.workspaces.length > 0
            ? () => {
                history.replaceState(null, "", WORKSPACES_PAGE);
                setStage({ ...stage, creating: false });
              }
            : undefined
        }
        signOut={() => void signOut()}
      />
    </Frame>
  );
}

/** Where a workspace keeps its files in a folder chosen: its `.zerolux`. */
export function filesIn(folder: string) {
  if (/[\\/]\.zerolux[\\/]?$/.test(folder)) return folder;
  const separator = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}.zerolux`;
}

/** A workspace in a window or tab of its own. */
function openElsewhere(workspace: ServedWorkspace) {
  if (desktopConnection()) void desktopNewWindow(`${pageOf(workspace)}/`);
  else window.open(`${pageOf(workspace)}/`, "_blank", "noopener");
}

/** The account's workspaces on a kernel: one to open, or a new one to make. */
export function Workspaces({
  place,
  workspaces,
  outside,
  creating,
  canCreate,
  busy,
  error,
  open,
  create,
  startCreating,
  cancel,
  signOut,
}: {
  place: string;
  workspaces: ServedWorkspace[];
  /** A workspace the account is not a member of, which the address named. */
  outside?: ServedWorkspace;
  creating: boolean;
  canCreate: boolean;
  busy: boolean;
  error: string;
  open: (workspace: ServedWorkspace, newWindow: boolean) => void;
  create: (name: string, folder?: string) => void;
  startCreating: () => void;
  /** Back to the list, from making a new one. */
  cancel?: () => void;
  signOut: () => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  // On this computer's own kernel, a workspace keeps its files in a folder chosen here.
  const folders = !!desktopConnection() && kernelHere();
  return (
    <>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        ZeroLux · {place}
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {creating ? "New workspace" : "Workspaces"}
      </h1>
      {outside && (
        <p role="alert" className="text-sm text-muted-foreground">
          You are not a member of {outside.name}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {creating ? (
        <form
          aria-label="New workspace"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && name.trim())
              create(name.trim(), folder ? filesIn(folder) : undefined);
          }}
        >
          {folders && (
            <>
              <Label htmlFor="new-folder">Folder · optional</Label>
              <div className="flex gap-2">
                <Input id="new-folder" value={folder} readOnly />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void chooseFolder(folder || undefined).then(
                      (chosen) => {
                        if (!chosen) return;
                        setFolder(chosen);
                        if (!name)
                          setName(
                            chosen.split(/[\\/]/).filter(Boolean).pop() ?? "",
                          );
                      },
                      () => {},
                    )
                  }
                >
                  Choose…
                </Button>
              </div>
            </>
          )}
          <Label htmlFor="new-name">Name</Label>
          <Input
            id="new-name"
            required
            maxLength={200}
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              Create workspace
            </Button>
            {cancel && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          {workspaces.length > 0 ? (
            <nav aria-label="Workspaces" className="flex flex-col gap-1">
              {workspaces.map((workspace) => (
                <a
                  key={workspace.id}
                  href={`${pageOf(workspace)}/`}
                  onClick={(event) => {
                    event.preventDefault();
                    open(workspace, event.metaKey || event.ctrlKey);
                  }}
                  className="flex h-11 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-accent"
                >
                  <WorkspaceMark name={workspace.name} className="size-7" />
                  <span className="truncate font-medium">{workspace.name}</span>
                </a>
              ))}
            </nav>
          ) : (
            <p className="text-sm text-muted-foreground">No workspaces yet.</p>
          )}
          {canCreate && (
            <Button
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={startCreating}
            >
              New workspace
            </Button>
          )}
        </>
      )}
      <Button
        variant="ghost"
        className="self-start"
        disabled={busy}
        onClick={signOut}
      >
        Sign out
      </Button>
    </>
  );
}

export type Waits = Awaited<ReturnType<typeof workspaceSummary>>;

const ELSEWHERE_EVERY = 60_000;

/**
 * What waits in the account's other workspaces on this kernel, read again every minute while
 * the page is in view; one sign-in reaches them all.
 */
export function useElsewhere(here: Here | null) {
  const [waits, setWaits] = useState<Record<string, Waits>>({});
  const others = here
    ? here.workspaces.filter((w) => w.id !== here.workspace.id)
    : [];
  const key = others.map((w) => w.base).join(" ");
  useEffect(() => {
    if (!key) return;
    let live = true;
    async function read() {
      if (document.visibilityState !== "visible") return;
      const all = await Promise.all(
        others.map(async (workspace) => {
          try {
            return [
              workspace.id,
              await workspaceSummary(workspace.base),
            ] as const;
          } catch {
            return [workspace.id, undefined] as const;
          }
        }),
      );
      if (live)
        setWaits(
          Object.fromEntries(
            all.filter((entry): entry is [string, Waits] => !!entry[1]),
          ),
        );
    }
    void read();
    const every = setInterval(() => void read(), ELSEWHERE_EVERY);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => {
      live = false;
      clearInterval(every);
      document.removeEventListener("visibilitychange", shown);
    };
    // The workspaces' addresses decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return waits;
}
