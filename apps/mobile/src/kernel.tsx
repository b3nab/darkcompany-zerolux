import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { router } from "expo-router";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  ApiError,
  api,
  AuthConnection,
  kernelId,
  multiWorkspace,
  probeKernel,
  renameWorkspace as rename,
  requiresSignIn,
  setAgentSettings as saveAgentSettings,
  secureKernelAddress,
  setKernelFetch,
  setKernelUrl,
  useChat,
  useHosts,
  workspaceAddress,
  workspaceSummary,
} from "@zerolux/chat";
import type {
  Actor,
  AgentSettings,
  AuthHealth,
  Chat,
  ServedWorkspace,
  Workspace,
} from "@zerolux/chat";
import {
  adoptSignIn,
  AuthenticationProvider,
  storage,
  useAuthentication,
} from "./auth";

/** A workspace opens at its start, whatever screens the one before had open. */
function fromTheStart() {
  if (router.canDismiss()) router.dismissAll();
}

// Pin Expo SDK 57's compliant transport even if the RN-fetch compatibility flag is set.
setKernelFetch(expoFetch);

const KEY = "kernels";
/** The workspaces the app kept before one sign-in served all of a kernel's workspaces. */
const WORKSPACES_KEY = "kernel-workspaces";
/** One kernel and its workspace, as the app kept them before it kept several. */
const CONNECTION_KEY = "kernel-connection";
const LEGACY_KEY = "kernel-url";

/** One of the account's workspaces on a kernel kept on this phone, as last read. */
export interface KeptWorkspace extends ServedWorkspace {
  /** The kernel's origin. */
  kernel: string;
  /** A name given on this phone only. */
  alias?: string;
}
/** A kernel kept on this phone, signed in to once for all its workspaces. */
export interface KeptKernel {
  /** Its origin. */
  kernel: string;
  /** The id its sign-in is sent to (`kernelId`): empty until the kernel is first read. */
  id: string;
  /** It serves several workspaces and creates them. */
  multi: boolean;
}
interface Kept {
  kernels: KeptKernel[];
  workspaces: KeptWorkspace[];
  /** The kernel open, and its workspace once one is chosen. */
  current: { kernel: string; id?: string } | null;
}
/** How a workspace kept on the phone is known among the others. */
export const keptKey = (w: { kernel: string; id: string }) =>
  `${w.kernel} ${w.id}`;
/** The name a kept workspace shows: the one given on this phone, else its own. */
export const keptName = (w: KeptWorkspace) =>
  w.alias || w.name || new URL(w.kernel).host;

/** What waits in a workspace other than the one open, or why it cannot be read. */
export type ElsewhereState =
  | { state: "ready"; requests: number; unread: number }
  | { state: "signed-out" }
  | { state: "offline" };

/** A kernel not open: signed in, signed out, or out of reach. */
export type KernelState = "ready" | "signed-out" | "offline";

interface Kernel {
  /** The open workspace's base: `undefined` until the phone's kernels are read, `null` when none is open. */
  url: string | null | undefined;
  /** The open kernel's origin: signing in, choosing a workspace, or in one. */
  here: string | undefined;
  /** The workspace to open on it once signed in, when one was named. */
  wanted: string | undefined;
  current: KeptWorkspace | undefined;
  kernels: KeptKernel[];
  /** The account's workspaces on every kernel kept, by kernel. */
  workspaces: KeptWorkspace[];
  /** The other workspaces' state, by `keptKey`. */
  elsewhere: Record<string, ElsewhereState>;
  /** The kernels not open, as last read, by origin. */
  states: Record<string, KernelState>;
  /** Reads the kernels again: their workspaces and what waits in them. */
  look(): void;
  error: string;
  /** The one connection to a kept kernel. */
  connection(kernel: string): AuthConnection;
  /** Keeps a kernel, checked at its address first, and opens it: at a workspace if the address names one. */
  connect(address: string): Promise<void>;
  /** The account's workspaces on a kernel, read again and kept. */
  list(kernel: string): Promise<ServedWorkspace[]>;
  /** Opens one of the account's workspaces on a kept kernel. */
  open(kernel: string, workspace: ServedWorkspace): Promise<void>;
  /** Opens a kept kernel to sign in to it or choose among its workspaces. */
  openKernel(kernel: string): Promise<void>;
  /** Signs this phone out of a kernel that is not open; it stays on the phone. */
  signOut(kernel: string): Promise<void>;
  /** Takes a kernel off this phone, with its workspaces and sign-in; another opens in its place. */
  forget(kernel: string): Promise<void>;
  /** Gives a workspace a name on this phone; an empty one gives its own back. */
  rename(workspace: KeptWorkspace, alias: string): Promise<void>;
}
interface Session {
  url: string;
  actors: Actor[];
  /** The workspace's computers, read with the workspace: whose, open, online. */
  hosts: ReturnType<typeof useHosts>;
  name(actorId: string | null): string;
  chat: Chat;
  workspace: Workspace | undefined;
  renameWorkspace(name: string): Promise<void>;
  setAgentSettings(id: string, settings: AgentSettings): Promise<Actor>;
  capabilities: string[];
  version: string | undefined;
}
const KernelContext = createContext<Kernel | undefined>(undefined);
const SessionContext = createContext<Session | undefined>(undefined);
function required<T>(value: T | undefined, what: string) {
  if (!value) throw new Error(`No ${what}`);
  return value;
}
export const useKernel = () => required(use(KernelContext), "kernel");
export const useSession = () => required(use(SessionContext), "session");
/** The open workspace's session, on screens that also show before one is open. */
export const useOpenSession = () => use(SessionContext);

/** One kernel's data model. It stays idle until a human is authenticated AND bound. */
function Connected({ url, children }: { url: string; children: ReactNode }) {
  useState(() => setKernelUrl(url));
  const auth = useAuthentication();
  const enabled = Boolean(auth?.member?.actor_id);
  const [workspace, setWorkspace] = useState<Workspace>();
  const workspaceVersion = useRef(0);
  // The last workspace read, as text: a read that finds nothing new changes nothing on screen.
  const workspaceRead = useRef("");
  const [health, setHealth] = useState<{
    version: string;
    capabilities: string[];
  }>();
  const capabilities = enabled ? (health?.capabilities ?? []) : [];
  const chat = useChat(enabled);
  const hosts = useHosts(url, enabled);
  const readHosts = hosts.reload;
  const guard = auth?.guard;
  useEffect(() => guard?.(chat.canLeave), [guard, chat.canLeave]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void api<{ version: string; capabilities: string[] }>("/health").then(
      (next) => {
        if (current) setHealth(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      workspaceRead.current = "";
      setWorkspace(undefined);
      return;
    }
    let current = true;
    const read = () => {
      const version = workspaceVersion.current;
      return api<Workspace>("/workspace").then(
        (next) => {
          if (!current || version !== workspaceVersion.current) return;
          const text = JSON.stringify(next);
          if (text === workspaceRead.current) return;
          workspaceRead.current = text;
          setWorkspace(next);
        },
        () => undefined,
      );
    };
    void read();
    // Nothing tells when a computer connects or leaves: its hosts are read with it.
    const timer = setInterval(() => void read().then(readHosts), 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled, chat.conversations, chat.sessions, readHosts]);
  const actors = enabled ? (workspace?.actors ?? []) : [];
  return (
    <SessionContext
      value={{
        url,
        actors,
        hosts,
        name: (id) => actors.find((actor) => actor.id === id)?.name ?? "…",
        chat,
        workspace: enabled ? workspace : undefined,
        async renameWorkspace(name) {
          if (!enabled)
            throw new Error("Sign in before changing the workspace");
          const info = await rename(name, url);
          workspaceVersion.current++;
          setWorkspace(
            (previous) => previous && { ...previous, workspace: info },
          );
        },
        async setAgentSettings(id, settings) {
          if (!enabled) throw new Error("Sign in before changing an agent");
          const actor = await saveAgentSettings(id, settings, url);
          workspaceVersion.current++;
          setWorkspace(
            (previous) =>
              previous && {
                ...previous,
                actors: previous.actors.map((old) =>
                  old.id === actor.id ? actor : old,
                ),
              },
          );
          return actor;
        },
        capabilities,
        version: health?.version,
      }}
    >
      {children}
    </SessionContext>
  );
}

/**
 * What the app kept before: several workspaces each with its own sign-in, one connection, or
 * only a kernel's address. A kernel keeps the sign-in of the workspace open, or of another.
 */
async function migrate(): Promise<Kept | null> {
  const list = await SecureStore.getItemAsync(WORKSPACES_KEY);
  const connection = await SecureStore.getItemAsync(CONNECTION_KEY);
  const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
  let workspaces: Omit<KeptWorkspace, "owner">[] = [];
  let current: string | null = null;
  if (list) {
    const old = JSON.parse(list) as {
      workspaces?: Omit<KeptWorkspace, "owner">[];
      current?: string | null;
    };
    if (
      !Array.isArray(old.workspaces) ||
      !old.workspaces.every(
        (w) =>
          typeof w.kernel === "string" &&
          typeof w.id === "string" &&
          typeof w.base === "string" &&
          typeof w.name === "string",
      )
    )
      throw new Error("Invalid workspaces");
    workspaces = old.workspaces;
    current = old.current ?? null;
  } else if (connection) {
    const old = JSON.parse(connection) as {
      url?: unknown;
      workspaceId?: unknown;
    };
    if (typeof old.url !== "string" || typeof old.workspaceId !== "string")
      throw new Error("Invalid connection");
    const base = secureKernelAddress(old.url);
    const kernel = new URL(base).origin;
    workspaces = [{ kernel, id: old.workspaceId, name: "", base }];
    current = keptKey(workspaces[0]!);
  } else if (legacy) {
    // No bearer existed in the old app. Pin its public identity before the first authenticated use.
    const base = secureKernelAddress(legacy);
    const kernel = new URL(base).origin;
    const health = await probeKernel(base);
    return {
      kernels: [
        { kernel, id: kernelId(health), multi: multiWorkspace(health) },
      ],
      workspaces: [],
      current: { kernel },
    };
  } else return null;
  const kernels: KeptKernel[] = [];
  for (const kernel of new Set(workspaces.map((w) => w.kernel))) {
    const mine = workspaces
      .filter((w) => w.kernel === kernel)
      .sort((w) => (keptKey(w) === current ? -1 : 0));
    await adoptSignIn(
      kernel,
      mine.map((w) => w.id),
    );
    // One workspace at the origin was the kernel: its id is the kernel's. With several, the
    // kernel's id is read at its first answer.
    const multi = mine.some((w) => w.base !== kernel);
    kernels.push({ kernel, id: multi ? "" : mine[0]!.id, multi });
  }
  const open = workspaces.find((w) => keptKey(w) === current);
  return {
    kernels,
    workspaces: workspaces.map((w) => ({ ...w, owner: false })),
    current: open
      ? { kernel: open.kernel, id: open.id }
      : kernels[0]
        ? { kernel: kernels[0].kernel }
        : null,
  };
}

function validKept(value: unknown): value is Kept {
  const kept = value as Kept | null;
  return Boolean(
    kept &&
    Array.isArray(kept.kernels) &&
    kept.kernels.every(
      (k) =>
        typeof k.kernel === "string" &&
        typeof k.id === "string" &&
        typeof k.multi === "boolean",
    ) &&
    Array.isArray(kept.workspaces) &&
    kept.workspaces.every(
      (w) =>
        typeof w.kernel === "string" &&
        typeof w.id === "string" &&
        w.id &&
        typeof w.base === "string" &&
        typeof w.name === "string",
    ) &&
    (kept.current === null || typeof kept.current?.kernel === "string"),
  );
}

/** What waits in a workspace, unless its kernel does not answer in time. */
async function summary(base: string) {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), 10_000);
  try {
    return await workspaceSummary(base, late.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The kernels kept on this phone, each with one sign-in and one connection, and the account's
 * workspaces on them, one open at a time: its kernel's sign-in and its data model are mounted,
 * the others are read for what waits in them.
 */
export function KernelProvider({ children }: { children: ReactNode }) {
  const [kept, setKept] = useState<Kept | null>();
  const [error, setError] = useState("");
  const [elsewhere, setElsewhere] = useState<Record<string, ElsewhereState>>(
    {},
  );
  const [states, setStates] = useState<Record<string, KernelState>>({});
  const writes = useRef(Promise.resolve());
  const latest = useRef<Kept | null | undefined>(undefined);
  latest.current = kept;
  const connections = useRef(new Map<string, AuthConnection>());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(KEY);
        const next = saved ? (JSON.parse(saved) as unknown) : await migrate();
        if (next !== null && !validKept(next))
          throw new Error("Invalid kernels");
        if (!live) return;
        if (!saved && next) await persist(next);
        else setKept(next);
        for (const old of [WORKSPACES_KEY, CONNECTION_KEY, LEGACY_KEY])
          await SecureStore.deleteItemAsync(old);
      } catch {
        if (!live) return;
        setError(
          "The saved workspaces could not be read. Connect again to continue.",
        );
        setKept(null);
      }
    })();
    return () => {
      live = false;
    };
    // Read once, as the app starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Saves what is kept, one write after the other, from what is kept now. */
  function persist(next: Kept | ((now: Kept) => Kept)) {
    const write = writes.current
      .catch(() => {})
      .then(async () => {
        const value =
          typeof next === "function"
            ? next(
                latest.current ?? {
                  kernels: [],
                  workspaces: [],
                  current: null,
                },
              )
            : next;
        await SecureStore.setItemAsync(KEY, JSON.stringify(value));
        latest.current = value;
        setError("");
        setKept(value);
      });
    writes.current = write;
    return write;
  }

  const connection = useCallback((kernel: string) => {
    let client = connections.current.get(kernel);
    if (!client) {
      const id = latest.current?.kernels.find((k) => k.kernel === kernel)?.id;
      client = new AuthConnection(kernel, id || undefined, storage);
      connections.current.set(kernel, client);
    }
    return client;
  }, []);

  /** A kernel as it answered: its id, once first read, and whether it serves several workspaces. */
  const verified = useCallback((kernel: string, health: AuthHealth) => {
    const was = latest.current?.kernels.find((k) => k.kernel === kernel);
    const multi = multiWorkspace(health);
    if (!was || (was.id && was.multi === multi)) return;
    void persist((all) => ({
      ...all,
      kernels: all.kernels.map((k) =>
        k.kernel === kernel ? { ...k, id: k.id || kernelId(health), multi } : k,
      ),
    }));
    // `persist` reads what is kept when it writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = useCallback(
    async (kernel: string) => {
      const served = await connection(kernel).workspaces();
      await persist((all) => ({
        ...all,
        workspaces: all.kernels.flatMap(({ kernel: k }) =>
          k === kernel
            ? served.map((s) => ({
                ...s,
                kernel,
                alias: all.workspaces.find(
                  (w) => w.kernel === kernel && w.id === s.id,
                )?.alias,
              }))
            : all.workspaces.filter((w) => w.kernel === k),
        ),
      }));
      return served;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection],
  );

  const current = kept?.current?.id
    ? kept.workspaces.find(
        (w) => w.kernel === kept.current!.kernel && w.id === kept.current!.id,
      )
    : undefined;
  const here = kept?.current?.kernel;

  /**
   * Each kernel read again: the account's workspaces on it and what waits in those not open.
   * The open kernel is its sign-in's to verify; the others are verified here.
   */
  const look = useCallback(() => {
    const now = latest.current;
    if (!now) return;
    const open = now.current?.id
      ? keptKey({ kernel: now.current.kernel, id: now.current.id })
      : undefined;
    for (const { kernel } of now.kernels) {
      const mine = (state: Exclude<ElsewhereState, { state: "ready" }>) => {
        setStates((all) => ({ ...all, [kernel]: state.state }));
        setElsewhere((all) => ({
          ...all,
          ...Object.fromEntries(
            (latest.current?.workspaces ?? [])
              .filter((w) => w.kernel === kernel && keptKey(w) !== open)
              .map((w) => [keptKey(w), state]),
          ),
        }));
      };
      const client = connection(kernel);
      void (async () => {
        if (kernel !== now.current?.kernel) {
          const { health, identity } = await client.restore();
          verified(kernel, health);
          if (requiresSignIn(health) && !identity)
            return mine({ state: "signed-out" });
        }
        const served = await list(kernel);
        setStates((all) => ({ ...all, [kernel]: "ready" }));
        for (const w of served) {
          const key = keptKey({ kernel, id: w.id });
          if (key === open) continue;
          void summary(w.base).then(
            (counts) =>
              setElsewhere((all) => ({
                ...all,
                [key]: { state: "ready", ...counts },
              })),
            () =>
              setElsewhere((all) => ({ ...all, [key]: { state: "offline" } })),
          );
        }
      })().catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401)
          mine({ state: "signed-out" });
        // The open kernel not verified yet is its sign-in's to say.
        else if (kernel !== now.current?.kernel) mine({ state: "offline" });
      });
    }
  }, [connection, verified, list]);

  // Read as a workspace opens, when the app comes back, and every minute while it is in front.
  const opened = kept?.current ? JSON.stringify(kept.current) : undefined;
  useEffect(() => {
    if (!opened) return;
    look();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") look();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") look();
    }, 60_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [opened, look]);

  /** Opens a kernel, at a workspace or at its start, and the app from there. */
  async function go(kernel: string, id?: string) {
    await persist((all) => ({
      ...all,
      current: { kernel, ...(id ? { id } : {}) },
    }));
    fromTheStart();
  }

  const value: Kernel = {
    url: kept === undefined ? undefined : (current?.base ?? null),
    here,
    wanted: kept?.current?.id,
    current,
    kernels: kept?.kernels ?? [],
    workspaces: kept?.workspaces ?? [],
    elsewhere,
    states,
    look,
    error,
    connection,
    async connect(address) {
      const { kernel, workspaceId } = workspaceAddress(address);
      const health = await probeKernel(kernel);
      await persist((all) => ({
        ...all,
        kernels: all.kernels.some((k) => k.kernel === kernel)
          ? all.kernels
          : [
              ...all.kernels,
              { kernel, id: kernelId(health), multi: multiWorkspace(health) },
            ],
      }));
      await go(kernel, workspaceId);
    },
    list,
    async open(kernel, workspace) {
      await persist((all) => ({
        ...all,
        workspaces: all.workspaces.some(
          (w) => w.kernel === kernel && w.id === workspace.id,
        )
          ? all.workspaces.map((w) =>
              w.kernel === kernel && w.id === workspace.id
                ? { ...w, ...workspace }
                : w,
            )
          : [...all.workspaces, { ...workspace, kernel }],
      }));
      await go(kernel, workspace.id);
    },
    // The kernel open keeps its workspace, to return to once signed in.
    openKernel: (kernel) =>
      go(
        kernel,
        latest.current?.current?.kernel === kernel
          ? latest.current.current.id
          : undefined,
      ),
    async signOut(kernel) {
      const client = connection(kernel);
      try {
        await client.restore();
        await client.signOut();
      } catch {
        // Unreachable, or signed out already: the phone forgets its sign-in all the same.
        await storage.write(kernel, null);
      }
      setStates((all) => ({ ...all, [kernel]: "signed-out" }));
      setElsewhere((all) => ({
        ...all,
        ...Object.fromEntries(
          (latest.current?.workspaces ?? [])
            .filter((w) => w.kernel === kernel)
            .map((w) => [keptKey(w), { state: "signed-out" } as const]),
        ),
      }));
    },
    async forget(kernel) {
      await value.signOut(kernel);
      connections.current.get(kernel)?.dispose();
      connections.current.delete(kernel);
      const open = latest.current?.current?.kernel === kernel;
      await persist((all) => {
        const kernels = all.kernels.filter((k) => k.kernel !== kernel);
        const workspaces = all.workspaces.filter((w) => w.kernel !== kernel);
        const next = workspaces[0];
        return {
          kernels,
          workspaces,
          current: open
            ? next
              ? { kernel: next.kernel, id: next.id }
              : kernels[0]
                ? { kernel: kernels[0].kernel }
                : null
            : all.current,
        };
      });
      if (open) fromTheStart();
    },
    async rename(workspace, alias) {
      await persist((all) => ({
        ...all,
        workspaces: all.workspaces.map((w) =>
          keptKey(w) === keptKey(workspace)
            ? { ...w, alias: alias.trim() || undefined }
            : w,
        ),
      }));
    },
  };
  return (
    <KernelContext value={value}>
      {here ? (
        <AuthenticationProvider
          key={here}
          client={connection(here)}
          base={current?.base}
          onVerified={(health) => verified(here, health)}
        >
          {current ? (
            <Connected key={current.base} url={current.base}>
              {children}
            </Connected>
          ) : (
            children
          )}
        </AuthenticationProvider>
      ) : (
        children
      )}
    </KernelContext>
  );
}
