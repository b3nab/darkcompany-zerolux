import * as SecureStore from "expo-secure-store";
import { createContext, use, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  api,
  errorMessage,
  renameWorkspace as rename,
  setKernelUrl,
  useChat,
  useStorage,
} from "@zerolux/chat";
import type { Actor, Chat, Storage, Workspace } from "@zerolux/chat";

const KEY = "kernel-url";

interface Kernel {
  /** `undefined` until the saved address is read, `null` when there is none. */
  url: string | null | undefined;
  connect(url: string): Promise<void>;
  forget(): Promise<void>;
}
interface Session {
  actors: Actor[];
  name(actorId: string): string;
  chat: Chat;
  /** The whole company: projects, tasks, workers; undefined until the kernel answers. */
  workspace: Workspace | undefined;
  renameWorkspace(name: string): Promise<void>;
  /** What this kernel can do, e.g. "storage-v1". */
  capabilities: string[];
  /** The kernel's version; undefined until it answers. */
  version: string | undefined;
  /** The company's files, one list for every screen. */
  storage: Storage;
}
const KernelContext = createContext<Kernel | undefined>(undefined);
const SessionContext = createContext<Session | undefined>(undefined);

function required<T>(value: T | undefined, what: string) {
  if (!value) throw new Error(`No ${what}`);
  return value;
}
export const useKernel = () => required(use(KernelContext), "kernel");
/** Only on screens that the owner reaches after connecting to a kernel. */
export const useSession = () => required(use(SessionContext), "session");

/** A bare address such as `192.168.1.10:4310` is enough: `http://` goes in front of it. */
const normalize = (input: string) =>
  (/^https?:\/\//i.test(input.trim()) ? "" : "http://") +
  input.trim().replace(/\/+$/, "");

/** Asks the candidate itself: the address in use changes only once it is verified. */
async function verify(url: string) {
  try {
    const response = await fetch(`${url}/api/health`);
    const health = (await response.json()) as { capabilities?: string[] };
    if (!response.ok || !health.capabilities?.includes("chat-v1"))
      throw new Error("it has no chat");
  } catch (error) {
    throw new Error(`No ZeroLux kernel at ${url}: ${errorMessage(error)}`);
  }
}

/**
 * The chat of one kernel. It is mounted again for another address, so messages that wait
 * for one kernel never go to another, and nothing is retried while disconnected.
 */
function Connected({ url, children }: { url: string; children: ReactNode }) {
  useState(() => setKernelUrl(url));
  const [workspace, setWorkspace] = useState<Workspace>();
  const workspaceVersion = useRef(0);
  const [health, setHealth] = useState<{
    version: string;
    capabilities: string[];
  }>();
  const capabilities = health?.capabilities ?? [];
  const chat = useChat(true);
  const storage = useStorage(capabilities.includes("storage-v1"));
  useEffect(() => {
    void api<{ version: string; capabilities: string[] }>("/health").then(
      setHealth,
      () => undefined,
    );
  }, []);
  // Names change with every chat update (the owner renames an agent), and tasks move without
  // one (a worker finishes): read the workspace on both, as the web app does.
  useEffect(() => {
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
  }, [chat.conversations, chat.sessions]);
  const actors = workspace?.actors ?? [];
  return (
    <SessionContext
      value={{
        actors,
        name: (id) => actors.find((actor) => actor.id === id)?.name ?? "…",
        chat,
        workspace,
        async renameWorkspace(name) {
          const info = await rename(name, url);
          // A snapshot requested before the rename must not restore the old name.
          workspaceVersion.current++;
          setWorkspace(
            (previous) => previous && { ...previous, workspace: info },
          );
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
  const [url, setUrl] = useState<string | null>();
  useEffect(() => {
    void SecureStore.getItemAsync(KEY).then(setUrl);
  }, []);
  const kernel: Kernel = {
    url,
    async connect(input) {
      const next = normalize(input);
      await verify(next);
      await SecureStore.setItemAsync(KEY, next);
      setUrl(next);
    },
    async forget() {
      await SecureStore.deleteItemAsync(KEY);
      setUrl(null);
    },
  };
  return (
    <KernelContext value={kernel}>
      {url ? (
        <Connected key={url} url={url}>
          {children}
        </Connected>
      ) : (
        children
      )}
    </KernelContext>
  );
}
