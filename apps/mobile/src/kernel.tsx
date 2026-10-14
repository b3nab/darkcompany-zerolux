import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  probeKernel,
  renameWorkspace as rename,
  setAgentSettings as saveAgentSettings,
  secureKernelOrigin,
  setKernelFetch,
  setKernelUrl,
  useChat,
  useStorage,
} from "@zerolux/chat";
import type {
  Actor,
  AgentSettings,
  Chat,
  Storage,
  Workspace,
} from "@zerolux/chat";
import { AuthenticationProvider, useAuthentication } from "./auth";

// Pin Expo SDK 57's compliant transport even if the RN-fetch compatibility flag is set.
setKernelFetch(expoFetch);

const KEY = "kernel-connection";
const LEGACY_KEY = "kernel-url";
interface Connection {
  url: string;
  workspaceId?: string;
}
interface Kernel {
  /** `undefined` until the saved connection is read, `null` when there is none. */
  url: string | null | undefined;
  error: string;
  connect(url: string): Promise<void>;
  forget(): Promise<void>;
}
interface Session {
  url: string;
  actors: Actor[];
  name(actorId: string): string;
  chat: Chat;
  workspace: Workspace | undefined;
  renameWorkspace(name: string): Promise<void>;
  setAgentSettings(id: string, settings: AgentSettings): Promise<Actor>;
  capabilities: string[];
  version: string | undefined;
  storage: Storage;
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
  const [health, setHealth] = useState<{
    version: string;
    capabilities: string[];
  }>();
  const capabilities = enabled ? (health?.capabilities ?? []) : [];
  const chat = useChat(enabled);
  const storage = useStorage(enabled && capabilities.includes("storage-v1"));
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
      setWorkspace(undefined);
      return;
    }
    let current = true;
    const read = () => {
      const version = workspaceVersion.current;
      return api<Workspace>("/workspace").then(
        (next) =>
          current && version === workspaceVersion.current && setWorkspace(next),
        () => undefined,
      );
    };
    void read();
    const timer = setInterval(read, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled, chat.conversations, chat.sessions]);
  const actors = enabled ? (workspace?.actors ?? []) : [];
  return (
    <SessionContext
      value={{
        url,
        actors,
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
        storage,
      }}
    >
      {children}
    </SessionContext>
  );
}

export function KernelProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>();
  const [error, setError] = useState("");
  const version = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    const current = version.current;
    let live = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(KEY);
        let next: Connection | null = null;
        if (saved) {
          next = JSON.parse(saved) as Connection;
          if (
            !next ||
            typeof next.url !== "string" ||
            typeof next.workspaceId !== "string" ||
            !next.workspaceId
          )
            throw new Error("Invalid connection");
        } else {
          const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
          // No bearer existed in the old app. Pin its public identity before the first
          // authenticated use; the workspace must match before any credentials are loaded.
          if (legacy) {
            const url = secureKernelOrigin(legacy);
            const health = await probeKernel(url);
            if (live && current === version.current)
              await persist({ url, workspaceId: health.workspace.id }, current);
            return;
          }
        }
        if (live && current === version.current) setConnection(next);
      } catch {
        if (live && current === version.current) {
          setError(
            "The saved connection could not be read. Reconnect to continue.",
          );
          setConnection(null);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function persist(next: Connection | null, current: number) {
    const write = writes.current
      .catch(() => {})
      .then(async () => {
        if (current !== version.current)
          throw new Error("The connection changed");
        if (next) await SecureStore.setItemAsync(KEY, JSON.stringify(next));
        else await SecureStore.deleteItemAsync(KEY);
        await SecureStore.deleteItemAsync(LEGACY_KEY);
      });
    writes.current = write;
    await write;
    if (current !== version.current) throw new Error("The connection changed");
    setError("");
    setConnection(next);
  }
  const kernel: Kernel = {
    url: connection === undefined ? undefined : (connection?.url ?? null),
    error,
    async connect(input) {
      const current = ++version.current;
      const address = input.trim().replace(/\/+$/, "");
      const url = secureKernelOrigin(
        /^https?:\/\//i.test(address) ? address : `http://${address}`,
      );
      const health = await probeKernel(url);
      await persist({ url, workspaceId: health.workspace.id }, current);
    },
    async forget() {
      await persist(null, ++version.current);
    },
  };
  return (
    <KernelContext value={kernel}>
      {connection ? (
        <AuthenticationProvider
          key={`${connection.url}:${connection.workspaceId}`}
          kernel={connection.url}
          workspaceId={connection.workspaceId}
        >
          <Connected url={connection.url}>{children}</Connected>
        </AuthenticationProvider>
      ) : (
        children
      )}
    </KernelContext>
  );
}
