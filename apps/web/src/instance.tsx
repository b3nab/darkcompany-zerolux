import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";
import { cn } from "cn";
import {
  ApiError,
  AuthConnection,
  errorMessage,
  pickWorkspace,
  readInstance,
  rememberedWorkspace,
  rememberWorkspace,
  requiresSignIn,
  setKernelUrl,
  workspaceAddress,
  workspaceSummary,
} from "@zerolux/chat";
import type { KernelInstance, ServedWorkspace } from "@zerolux/chat";
import {
  desktopConnection,
  kernelAddress,
  macKeys,
  windowDragProps,
  WORKSPACES_LINK,
} from "./desktop";
import { WindowControls } from "./components/window-controls";
import { Button } from "./components/ui/button";

/** This page's workspace, and every workspace its kernel serves. */
export interface Here {
  instance: KernelInstance;
  workspace: ServedWorkspace;
}
const HereContext = createContext<Here | null>(null);
export const useHere = () => useContext(HereContext);

/** In a browser, the page at a kernel's root that lists its workspaces. */
export const WORKSPACES_PAGE = "/workspaces";

const pageOf = (workspace: ServedWorkspace) =>
  `/w/${encodeURIComponent(workspace.id)}`;

/** Where a page is on its kernel: in a workspace, its pages under `basename`, or choosing one. */
export type Placed =
  | {
      here: Here;
      basename: string;
      /** The page's address, when it changes to name the workspace. */
      address?: string;
    }
  | { choose: KernelInstance };

/**
 * A desktop window is in the workspace it was opened for. A browser is in the one its address
 * names (`/w/<id>/…`), else the one chosen last on this kernel, else the kernel's only one.
 */
export function place(
  instance: KernelInstance,
  path: string,
  desktop?: string,
): Placed {
  const named = /^\/w\/([^/]+)/.exec(path);
  if (!instance.multi)
    return {
      here: { instance, workspace: instance.workspaces[0]! },
      basename: "",
      address: named ? path.slice(named[0].length) || "/" : undefined,
    };
  const id = desktop ?? (named ? decodeURIComponent(named[1]!) : undefined);
  const workspace =
    id !== undefined
      ? instance.workspaces.find((w) => w.id === id)
      : path === WORKSPACES_PAGE
        ? undefined
        : pickWorkspace(instance, rememberedWorkspace(instance.kernel));
  if (!workspace) return { choose: instance };
  if (desktop !== undefined)
    return { here: { instance, workspace }, basename: "" };
  const basename = pageOf(workspace);
  return {
    here: { instance, workspace },
    basename,
    address: named ? undefined : `${basename}${path}`,
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

/** Where to go back to the workspaces: the desktop's own window, or a kernel's list of them. */
export function useWorkspacesLink() {
  const here = useHere();
  if (desktopConnection()) return WORKSPACES_LINK;
  return here && here.instance.workspaces.length > 1
    ? WORKSPACES_PAGE
    : undefined;
}

/** A page before the workspace's own: the window's controls, and what it says. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div
        className="flex h-10 items-center justify-end"
        {...windowDragProps()}
      >
        <WindowControls />
      </div>
      <main className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-12">
        {children}
      </main>
    </div>
  );
}

const RETRY = 5_000;

/**
 * The page's workspace, found on its kernel before anything of it shows: every call, sign-in
 * and file goes to its base, and in a browser its pages are under `/w/<id>`.
 */
export function WorkspaceRoot({ children }: { children: ReactNode }) {
  const [placed, setPlaced] = useState<Placed>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const desktop = desktopConnection();
    const address = kernelAddress() || location.origin;
    readInstance(address).then(
      (instance) => {
        if (!live) return;
        const there = place(
          instance,
          location.pathname,
          desktop &&
            (workspaceAddress(address).workspaceId ?? desktop.workspaceId),
        );
        if ("here" in there) {
          const { workspace } = there.here;
          setKernelUrl(workspace.base);
          if (instance.multi && !desktop)
            rememberWorkspace(instance.kernel, workspace.id);
          if (there.address)
            history.replaceState(
              history.state,
              "",
              `${there.address}${location.search}${location.hash}`,
            );
        }
        setError("");
        setPlaced(there);
      },
      (failed: unknown) => {
        if (live) setError(errorMessage(failed));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  // An unreachable kernel, often one restarting, is asked again until it answers.
  useEffect(() => {
    if (!error) return;
    const again = setTimeout(() => setAttempt((n) => n + 1), RETRY);
    return () => clearTimeout(again);
  }, [error, attempt]);
  useWorkspaceKeys(placed && "here" in placed ? placed.here : undefined);

  if (placed && "here" in placed)
    return (
      <HereContext value={placed.here}>
        <BrowserRouter basename={placed.basename}>{children}</BrowserRouter>
      </HereContext>
    );
  const back = desktopConnection() && (
    <Button
      variant="outline"
      className="self-start"
      render={<a href={WORKSPACES_LINK} />}
    >
      Back to workspaces
    </Button>
  );
  if (error)
    return (
      <Frame>
        {back}
        <h1 className="text-3xl font-semibold tracking-tight">
          Can't reach ZeroLux
        </h1>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button className="self-start" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </Frame>
    );
  if (!placed) return <Frame>{null}</Frame>;
  const { workspaces } = placed.choose;
  return (
    <Frame>
      {back}
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        ZeroLux · {location.host}
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {desktopConnection()
          ? "This workspace is not served here"
          : "Workspaces"}
      </h1>
      {!desktopConnection() &&
        (workspaces.length ? (
          <nav aria-label="Workspaces" className="flex flex-col gap-1">
            {workspaces.map((workspace) => (
              <a
                key={workspace.id}
                href={`${pageOf(workspace)}/`}
                className="flex h-11 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-accent"
              >
                <WorkspaceMark name={workspace.name} className="size-7" />
                <span className="truncate font-medium">{workspace.name}</span>
              </a>
            ))}
          </nav>
        ) : (
          <p className="text-sm text-muted-foreground">No workspaces yet.</p>
        ))}
    </Frame>
  );
}

/** ⌃1…9 on a Mac, Alt+1…9 elsewhere: the kernel's workspaces by position, in a browser. */
function useWorkspaceKeys(here?: Here) {
  useEffect(() => {
    if (!here?.instance.multi || desktopConnection()) return;
    const mac = macKeys();
    const keys = (event: KeyboardEvent) => {
      const at = /^Digit([1-9])$/.exec(event.code)?.[1];
      const held = mac
        ? event.ctrlKey && !event.altKey
        : event.altKey && !event.ctrlKey;
      if (!at || !held || event.metaKey || event.shiftKey) return;
      const workspace = here.instance.workspaces[Number(at) - 1];
      if (!workspace) return;
      event.preventDefault();
      if (workspace.id !== here.workspace.id)
        location.assign(`${pageOf(workspace)}/`);
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [here]);
}

export type Waits = Awaited<ReturnType<typeof workspaceSummary>>;

const ELSEWHERE_EVERY = 60_000;

/**
 * What waits in the kernel's other workspaces this browser is signed in to, read again every
 * minute while the page is in view. The desktop keeps each workspace's sign-in to its window.
 */
export function useElsewhere(here: Here | null) {
  const [waits, setWaits] = useState<Record<string, Waits>>({});
  const others =
    here && !desktopConnection()
      ? here.instance.workspaces.filter((w) => w.id !== here.workspace.id)
      : [];
  const key = others.map((w) => w.base).join(" ");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const signedIn = new Set<string>();
    const connections = others.map(
      (workspace) =>
        [workspace, new AuthConnection(workspace.base, workspace.id)] as const,
    );
    async function readOne(
      workspace: ServedWorkspace,
      connection: AuthConnection,
    ) {
      try {
        if (!signedIn.has(workspace.id)) {
          const { health, identity } = await connection.restore();
          if (requiresSignIn(health) && !identity?.actor_id) return undefined;
          signedIn.add(workspace.id);
        }
        return await workspaceSummary(workspace.base);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          signedIn.delete(workspace.id);
        return undefined;
      }
    }
    async function read() {
      if (document.visibilityState !== "visible") return;
      const all = await Promise.all(
        connections.map(
          async ([workspace, connection]) =>
            [workspace.id, await readOne(workspace, connection)] as const,
        ),
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
      for (const [, connection] of connections) connection.dispose();
    };
    // The workspaces' addresses decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return waits;
}
