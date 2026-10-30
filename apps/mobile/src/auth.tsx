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
  requiresSignIn,
  type AccountIdentity,
  type AuthHealth,
  type AuthDevice,
  type AuthIdentity,
  type AuthStorage,
  type Invitation,
} from "@zerolux/chat";

// Expo SDK 57: this device's keychain/Keystore, never AsyncStorage or a cookie jar.
export const storage: AuthStorage = {
  read: (kernel) => SecureStore.getItemAsync(credentialStorageKey(kernel)),
  async write(kernel, token) {
    const key = credentialStorageKey(kernel);
    if (token === null) await SecureStore.deleteItemAsync(key);
    else
      await SecureStore.setItemAsync(key, token, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
  },
};

/**
 * Keeps a sign-in this phone had for a workspace of `kernel`, from before one sign-in served
 * all of a kernel's workspaces: the first found becomes the kernel's, the others go. Answers
 * whose it was.
 */
export async function adoptSignIn(kernel: string, workspaceIds: string[]) {
  let adopted: string | undefined;
  for (const id of workspaceIds) {
    const key = credentialStorageKey(kernel, id);
    const token = await SecureStore.getItemAsync(key);
    if (!token) continue;
    if (!adopted) {
      await storage.write(kernel, token);
      adopted = id;
    }
    await SecureStore.deleteItemAsync(key);
  }
  return adopted;
}

interface Authentication {
  health?: AuthHealth;
  /** The account signed in on this kernel. */
  identity: AccountIdentity | null;
  /** That account in the open workspace, the person it is there: `undefined` while it is read. */
  member: AuthIdentity | null | undefined;
  loading: boolean;
  busy: boolean;
  error: string;
  refresh(): Promise<void>;
  signIn(email: string, password: string): Promise<boolean>;
  /** A new account: the kernel's first, or a person's who joins with an invitation. */
  signUp(
    name: string,
    email: string,
    password: string,
    invite?: string,
  ): Promise<boolean>;
  /** The account joins a workspace: with an invitation, or as an older kernel's owner. */
  join(base: string, invite?: string): Promise<boolean>;
  /** What an invitation says, before any account: refused once it cannot be used. */
  invitation(base: string, token: string): Promise<Invitation>;
  signOut(): Promise<boolean>;
  guard(canLeave: () => boolean): () => void;
  /** Your account, straight from the kernel: callers show their own errors. */
  changePassword(
    currentPassword: string,
    newPassword: string,
    signOutOthers: boolean,
  ): Promise<void>;
  devices(): Promise<{ devices: AuthDevice[]; current: string | null }>;
  signOutDevice(token: string): Promise<void>;
}
const Context = createContext<Authentication | null>(null);
export const useAuthentication = () => use(Context);

/**
 * One kernel's sign-in, with the connection the phone keeps for it, and the account's person
 * in the open workspace. Keeps the root navigator mounted; Stack.Protected gates every private
 * screen.
 */
export function AuthenticationProvider({
  client,
  base,
  onVerified,
  children,
}: {
  client: AuthConnection;
  /** The open workspace's base, once one is open. */
  base?: string;
  onVerified(health: AuthHealth): void;
  children: ReactNode;
}) {
  const [health, setHealth] = useState<AuthHealth>();
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [member, setMember] = useState<AuthIdentity | null>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true);
  const working = useRef(false);
  const version = useRef(0);
  const canLeave = useRef<() => boolean>(() => true);
  const verified = useRef(onVerified);
  verified.current = onVerified;

  const refresh = useCallback(async () => {
    if (working.current) return;
    const current = ++version.current;
    try {
      const result = await client.restore();
      if (!live.current || current !== version.current) return;
      verified.current(result.health);
      setHealth(result.health);
      setIdentity(result.identity);
      setError("");
    } catch (error) {
      if (!live.current || current !== version.current) return;
      // Another read of the same kernel took over: this one is read again.
      if (error instanceof Error && error.name === "AbortError")
        setTimeout(() => void refresh(), 0);
      else setError(errorMessage(error));
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
    };
  }, [client, refresh]);

  // The account's person in the open workspace, read again with every sign-in.
  const signedIn = health && requiresSignIn(health) ? identity : undefined;
  useEffect(() => {
    if (!base || !signedIn) return setMember(null);
    let current = true;
    setMember(undefined);
    client.identity(base).then(
      (next) => current && setMember(next),
      () => current && setMember(null),
    );
    return () => {
      current = false;
    };
  }, [client, base, signedIn]);

  const guard = useCallback((check: () => boolean) => {
    canLeave.current = check;
    return () => {
      if (canLeave.current === check) canLeave.current = () => true;
    };
  }, []);

  async function perform(action: () => Promise<void>, leaving = false) {
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
      await action();
      return live.current;
    } catch (error) {
      if (live.current) setError(errorMessage(error));
      return false;
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  const account = (next: AccountIdentity) => {
    if (!live.current) return;
    setIdentity(next);
    setHealth(
      (previous) =>
        previous && {
          ...previous,
          auth: { setup_required: next.setup_required },
        },
    );
  };

  return (
    <Context
      value={{
        health,
        identity,
        member,
        loading,
        busy,
        error,
        refresh,
        guard,
        signIn: (email, password) =>
          perform(async () => account(await client.signIn(email, password))),
        signUp: (name, email, password, invite) =>
          perform(async () =>
            account(await client.signUp(name, email, password, invite)),
          ),
        join: (where, invite) =>
          perform(async () => {
            const next = await client.claim(where, invite);
            if (live.current && where === base) setMember(next);
          }),
        invitation: (where, token) => client.invitation(where, token),
        signOut: () =>
          perform(async () => {
            await client.signOut();
            if (live.current) setIdentity(null);
          }, true),
        changePassword: (current, next, others) =>
          client.changePassword(current, next, others),
        devices: () => client.devices(),
        signOutDevice: (token) => client.signOutDevice(token),
      }}
    >
      {children}
    </Context>
  );
}
