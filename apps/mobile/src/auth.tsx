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
import * as SecureStore from "expo-secure-store";
import {
  AuthConnection,
  credentialStorageKey,
  errorMessage,
  type AuthHealth,
  type AuthIdentity,
  type AuthStorage,
} from "@zerolux/chat";

// Expo SDK 57: this device's keychain/Keystore, never AsyncStorage or a cookie jar.
const storage: AuthStorage = {
  read: (kernel, workspace) =>
    SecureStore.getItemAsync(credentialStorageKey(kernel, workspace)),
  async write(kernel, workspace, token) {
    const key = credentialStorageKey(kernel, workspace);
    if (token === null) await SecureStore.deleteItemAsync(key);
    else
      await SecureStore.setItemAsync(key, token, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
  },
};

interface Authentication {
  health?: AuthHealth;
  identity: AuthIdentity | null;
  loading: boolean;
  busy: boolean;
  error: string;
  refresh(): Promise<void>;
  signIn(email: string, password: string, setup?: string): Promise<boolean>;
  signUp(
    name: string,
    email: string,
    password: string,
    setup: string,
  ): Promise<boolean>;
  claim(setup: string): Promise<boolean>;
  signOut(): Promise<boolean>;
  guard(canLeave: () => boolean): () => void;
}
const Context = createContext<Authentication | null>(null);
export const useAuthentication = () => use(Context);

/** Keeps the root navigator mounted; Stack.Protected gates every private screen. */
export function AuthenticationProvider({
  kernel,
  workspaceId,
  children,
}: {
  kernel: string;
  workspaceId?: string;
  children: ReactNode;
}) {
  const [client] = useState(
    () => new AuthConnection(kernel, workspaceId, storage),
  );
  const [health, setHealth] = useState<AuthHealth>();
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true);
  const working = useRef(false);
  const version = useRef(0);
  const canLeave = useRef<() => boolean>(() => true);

  const refresh = useCallback(async () => {
    if (working.current) return;
    const current = ++version.current;
    try {
      const result = await client.restore();
      if (!live.current || current !== version.current) return;
      setHealth(result.health);
      setIdentity(result.identity);
      setError("");
    } catch (error) {
      if (
        live.current &&
        current === version.current &&
        !(error instanceof Error && error.name === "AbortError")
      )
        setError(errorMessage(error));
    } finally {
      if (live.current && current === version.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    live.current = true;
    void refresh();
    const stop = client.onRequired(() => {
      if (!live.current) return;
      setIdentity(null);
      void refresh();
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    const timer = setInterval(
      () => {
        if (AppState.currentState === "active") void refresh();
      },
      60 * 60 * 1000,
    );
    return () => {
      live.current = false;
      ++version.current;
      stop();
      subscription.remove();
      clearInterval(timer);
      client.dispose();
    };
  }, [client, refresh]);

  const guard = useCallback((check: () => boolean) => {
    canLeave.current = check;
    return () => {
      if (canLeave.current === check) canLeave.current = () => true;
    };
  }, []);

  async function perform(
    action: () => Promise<AuthIdentity | null>,
    leaving = false,
  ) {
    if (working.current) return false;
    if (leaving && !canLeave.current()) {
      setError("Wait for pending chat messages before signing out.");
      return false;
    }
    working.current = true;
    ++version.current;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (!live.current) return false;
      setIdentity(next);
      if (next)
        setHealth(
          (previous) =>
            previous && {
              ...previous,
              auth: { setup_required: next.setup_required },
            },
        );
      return true;
    } catch (error) {
      if (live.current) setError(errorMessage(error));
      return false;
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  return (
    <Context
      value={{
        health,
        identity,
        loading,
        busy,
        error,
        refresh,
        guard,
        signIn: (email, password, setup) =>
          perform(async () => {
            const next = await client.signIn(email, password);
            return !next.actor_id && next.setup_required && setup?.trim()
              ? client.claim(setup)
              : next;
          }),
        signUp: (name, email, password, setup) =>
          perform(() => client.signUp(name, email, password, setup)),
        claim: (setup) => perform(() => client.claim(setup)),
        signOut: () =>
          perform(async () => {
            await client.signOut();
            return null;
          }, true),
      }}
    >
      {children}
    </Context>
  );
}
