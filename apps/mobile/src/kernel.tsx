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
  api,
  probeKernel,
  readInstance,
  renameWorkspace as rename,
  setAgentSettings as saveAgentSettings,
  secureKernelAddress,
  setKernelFetch,
  setKernelUrl,
  useChat,
  useHosts,
} from "@zerolux/chat";
import type {
  Actor,
  AgentSettings,
  Chat,
  ServedWorkspace,
  Workspace,
} from "@zerolux/chat";
import {
  AuthenticationProvider,
  readElsewhere,
  signOutElsewhere,
  useAuthentication,
} from "./auth";

/** A workspace opens at its start, whatever screens the one before had open. */
function fromTheStart() {
  if (router.canDismiss()) router.dismissAll();
}

// Pin Expo SDK 57's compliant transport even if the RN-fetch compatibility flag is set.
setKernelFetch(expoFetch);

const KEY = "kernel-workspaces";
/** One kernel and its workspace, as the app kept them before it kept several. */
const CONNECTION_KEY = "kernel-connection";
const LEGACY_KEY = "kernel-url";

/** A workspace kept on this phone: on which kernel, which one, and its name and base as last read. */
export interface KeptWorkspace {
  /** The kernel's origin. */
  kernel: string;
  id: string;
  name: string;
  /** Where its API is: the kernel's origin, or `<kernel>/w/<id>` on a kernel that serves several. */
  base: string;
  /** A name given on this phone only. */
  alias?: string;
}
interface Kept {
  workspaces: KeptWorkspace[];
  current: string | null;
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

interface Kernel {
  /** The open workspace's base: `undefined` until the phone's workspaces are read, `null` when none is open. */
  url: string | null | undefined;
  current: KeptWorkspace | undefined;
  /** Every workspace kept on this phone, in the order they were added. */
  workspaces: KeptWorkspace[];
  /** The other workspaces' state, by `keptKey`. */
  elsewhere: Record<string, ElsewhereState>;
  /** What each kernel serves that the phone does not keep, by kernel. */
  available: Record<string, ServedWorkspace[]>;
  /** Reads the other workspaces again. */
  look(): void;
  error: string;
  /** Opens a workspace of a kernel, keeping it on the phone. */
  open(kernel: string, workspace: ServedWorkspace): Promise<void>;
  /** Takes a workspace off this phone with its sign-in; another opens in its place. */
  forget(workspace: KeptWorkspace): Promise<void>;
  /** Signs this phone out of a workspace that is not open; it stays on the phone. */
  signOut(workspace: KeptWorkspace): Promise<void>;
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

/** One kernel's data model. It stays idle until a human is authenticated AND bound. */
function Connected({ url, children }: { url: string; children: ReactNode }) {
  useState(() => setKernelUrl(url));
  const auth = useAuthentication();
  const enabled = Boolean(auth?.identity?.actor_id);
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

/** The workspaces kept before this version: one connection, or only a kernel's address. */
async function migrate(): Promise<Kept | null> {
  const saved = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (saved) {
    const old = JSON.parse(saved) as { url?: unknown; workspaceId?: unknown };
    if (typeof old.url !== "string" || typeof old.workspaceId !== "string")
      throw new Error("Invalid connection");
    const base = secureKernelAddress(old.url);
    const kept = {
      kernel: new URL(base).origin,
      id: old.workspaceId,
      name: "",
      base,
    };
    return { workspaces: [kept], current: keptKey(kept) };
  }
  const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
  if (!legacy) return null;
  // No bearer existed in the old app. Pin its public identity before the first authenticated
  // use; the workspace must match before any credentials are loaded.
  const base = secureKernelAddress(legacy);
  const health = await probeKernel(base);
  const kept = {
    kernel: new URL(base).origin,
    id: health.workspace.id,
    name: health.workspace.name,
    base,
  };
  return { workspaces: [kept], current: keptKey(kept) };
}

function validKept(value: unknown): value is Kept {
  const kept = value as Kept | null;
  return Boolean(
    kept &&
    Array.isArray(kept.workspaces) &&
    kept.workspaces.every(
      (w) =>
        typeof w.kernel === "string" &&
        typeof w.id === "string" &&
        w.id &&
        typeof w.base === "string" &&
        typeof w.name === "string",
    ) &&
    (kept.current === null || typeof kept.current === "string"),
  );
}

/**
 * The workspaces kept on this phone, one open at a time: its sign-in and data model are
 * mounted, the others are read for what waits in them.
 */
export function KernelProvider({ children }: { children: ReactNode }) {
  const [kept, setKept] = useState<Kept | null>();
  const [error, setError] = useState("");
  const [elsewhere, setElsewhere] = useState<Record<string, ElsewhereState>>(
    {},
  );
  const [available, setAvailable] = useState<Record<string, ServedWorkspace[]>>(
    {},
  );
  const writes = useRef(Promise.resolve());
  const latest = useRef<Kept | null | undefined>(undefined);
  latest.current = kept;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(KEY);
        const next = saved ? (JSON.parse(saved) as unknown) : await migrate();
        if (next !== null && !validKept(next))
          throw new Error("Invalid workspaces");
        if (!live) return;
        if (!saved && next) await persist(next);
        else setKept(next);
        await SecureStore.deleteItemAsync(CONNECTION_KEY);
        await SecureStore.deleteItemAsync(LEGACY_KEY);
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

  /** Saves the kept workspaces, one write after the other, from what is kept now. */
  function persist(next: Kept | ((now: Kept) => Kept)) {
    const write = writes.current
      .catch(() => {})
      .then(async () => {
        const value =
          typeof next === "function"
            ? next(latest.current ?? { workspaces: [], current: null })
            : next;
        await SecureStore.setItemAsync(KEY, JSON.stringify(value));
        latest.current = value;
        setError("");
        setKept(value);
      });
    writes.current = write;
    return write;
  }

  const current = kept?.workspaces.find((w) => keptKey(w) === kept.current);

  /**
   * Each kernel read again: the bases and names of the workspaces kept on it (a workspace
   * moves to `/w/<id>` when its kernel serves several), what it serves besides, and what
   * waits in the workspaces that are not open.
   */
  const look = useCallback(() => {
    const now = latest.current;
    if (!now?.workspaces.length) return;
    const open = now.current;
    for (const kernel of new Set(now.workspaces.map((w) => w.kernel))) {
      const mine = now.workspaces.filter((w) => w.kernel === kernel);
      readInstance(kernel).then(
        (instance) => {
          const served = new Map(instance.workspaces.map((w) => [w.id, w]));
          if (
            mine.some(
              (w) =>
                served.has(w.id) &&
                (served.get(w.id)!.base !== w.base ||
                  served.get(w.id)!.name !== w.name),
            )
          )
            void persist((all) => ({
              ...all,
              workspaces: all.workspaces.map((w) => {
                const s = w.kernel === kernel ? served.get(w.id) : undefined;
                return s ? { ...w, base: s.base, name: s.name } : w;
              }),
            }));
          setAvailable((all) => ({
            ...all,
            [kernel]: instance.workspaces.filter(
              (w) => !mine.some((m) => m.id === w.id),
            ),
          }));
          for (const w of mine) {
            const key = keptKey(w);
            const base = served.get(w.id)?.base;
            if (key === open || !base) continue;
            void readElsewhere(base, w.id)
              .catch(() => ({ state: "offline" }) as const)
              .then((state) =>
                setElsewhere((all) => ({ ...all, [key]: state })),
              );
          }
        },
        () =>
          setElsewhere((all) => ({
            ...all,
            ...Object.fromEntries(
              mine
                .filter((w) => keptKey(w) !== open)
                .map((w) => [keptKey(w), { state: "offline" } as const]),
            ),
          })),
      );
    }
    // `persist` reads what is kept when it writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read as a workspace opens, when the app comes back, and every minute while it is in front.
  const open = kept?.current;
  useEffect(() => {
    if (!open) return;
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
  }, [open, look]);

  const kernel: Kernel = {
    url: kept === undefined ? undefined : (current?.base ?? null),
    current,
    workspaces: kept?.workspaces ?? [],
    elsewhere,
    available,
    look,
    error,
    async open(origin, workspace) {
      const next = {
        kernel: origin,
        id: workspace.id,
        name: workspace.name,
        base: workspace.base,
      };
      await persist((all) => ({
        workspaces: all.workspaces.some((w) => keptKey(w) === keptKey(next))
          ? all.workspaces.map((w) =>
              keptKey(w) === keptKey(next) ? { ...w, ...next } : w,
            )
          : [...all.workspaces, next],
        current: keptKey(next),
      }));
      fromTheStart();
    },
    async forget(workspace) {
      await signOutElsewhere(workspace.base, workspace.id);
      const open = latest.current?.current === keptKey(workspace);
      await persist((all) => {
        const workspaces = all.workspaces.filter(
          (w) => keptKey(w) !== keptKey(workspace),
        );
        return {
          workspaces,
          current:
            all.current === keptKey(workspace)
              ? workspaces[0]
                ? keptKey(workspaces[0])
                : null
              : all.current,
        };
      });
      if (open) fromTheStart();
    },
    async signOut(workspace) {
      await signOutElsewhere(workspace.base, workspace.id);
      setElsewhere((all) => ({
        ...all,
        [keptKey(workspace)]: { state: "signed-out" },
      }));
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
    <KernelContext value={kernel}>
      {current ? (
        <AuthenticationProvider
          key={`${current.base}:${current.id}`}
          kernel={current.base}
          workspaceId={current.id}
        >
          <Connected url={current.base}>{children}</Connected>
        </AuthenticationProvider>
      ) : (
        children
      )}
    </KernelContext>
  );
}
