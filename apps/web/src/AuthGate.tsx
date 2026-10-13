import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AuthConnection,
  errorMessage,
  type AuthHealth,
  type AuthIdentity,
} from "@zerolux/chat";
import {
  desktopConnection,
  kernelAddress,
  windowDragProps,
  WORKSPACES_LINK,
} from "./desktop";
import { ownerNameError } from "./OwnerOnboarding";
import { WindowControls } from "./components/window-controls";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

interface Authentication {
  identity: AuthIdentity;
  busy: boolean;
  error: string;
  signOut(): Promise<void>;
  guard(canLeave: () => boolean): () => void;
}
const AuthenticationContext = createContext<Authentication | null>(null);
export const useAuthentication = () => useContext(AuthenticationContext);

/** Domain UI is mounted only for a verified, bound human identity. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const desktop = desktopConnection();
    // Packaged desktop pages are cross-origin: keep their bearer only in this
    // connection's memory. A new window requires login; there is no native storage IPC.
    let token: string | null = null;
    return new AuthConnection(
      kernelAddress(),
      desktop?.workspaceId,
      desktop
        ? {
            async read() {
              return token;
            },
            async write(_kernel, _workspaceId, value) {
              token = value;
            },
          }
        : undefined,
    );
  });
  const [health, setHealth] = useState<AuthHealth>();
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const live = useRef(true);
  const loadVersion = useRef(0);
  const canLeave = useRef<() => boolean>(() => true);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => live.current && loadVersion.current === version;
    try {
      const result = await client.restore();
      if (!current()) return;
      setHealth(result.health);
      setIdentity(result.identity);
      setError("");
    } catch (error) {
      if (current() && !(error instanceof Error && error.name === "AbortError"))
        setError(errorMessage(error));
    } finally {
      if (current()) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    live.current = true;
    void load();
    const stop = client.onRequired(() => {
      if (!live.current) return;
      setIdentity(null);
      if (!working.current) void load();
    });
    const focus = () => {
      if (!working.current) void load();
    };
    window.addEventListener("focus", focus);
    const refresh = setInterval(
      () => {
        if (document.visibilityState === "visible") focus();
      },
      60 * 60 * 1000,
    );
    return () => {
      live.current = false;
      ++loadVersion.current;
      stop();
      window.removeEventListener("focus", focus);
      clearInterval(refresh);
      client.dispose();
    };
  }, [client, load]);

  const guard = useCallback((check: () => boolean) => {
    canLeave.current = check;
    return () => {
      if (canLeave.current === check) canLeave.current = () => true;
    };
  }, []);

  async function signOut() {
    if (working.current) return;
    if (!canLeave.current()) {
      setError("Wait for pending chat messages before signing out.");
      return;
    }
    working.current = true;
    ++loadVersion.current;
    setBusy(true);
    setError("");
    try {
      await client.signOut();
      if (live.current) {
        setIdentity(null);
        setPassword("");
      }
      await load();
    } catch (error) {
      if (live.current) setError(errorMessage(error));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function submit() {
    if (working.current) return;
    working.current = true;
    ++loadVersion.current;
    setBusy(true);
    setError("");
    try {
      let next: AuthIdentity;
      if (identity) next = await client.claim();
      else if (health?.auth.setup_required && !existing)
        next = await client.signUp(name, email, password);
      else {
        next = await client.signIn(email, password);
        if (!next.actor_id && next.setup_required) next = await client.claim();
      }
      if (live.current) {
        setIdentity(next);
        setPassword("");
      }
    } catch (error) {
      if (live.current) setError(errorMessage(error));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  if (identity?.actor_id)
    return (
      <AuthenticationContext value={{ identity, busy, error, signOut, guard }}>
        {children}
      </AuthenticationContext>
    );

  const enrolling =
    identity?.setup_required ?? health?.auth.setup_required === true;
  const creating = enrolling && !existing && !identity;
  const blocked =
    busy ||
    (creating && (Boolean(ownerNameError(name)) || password.length < 12));
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div
        className="flex h-10 items-center justify-end"
        {...windowDragProps()}
      >
        <WindowControls />
      </div>
      <main className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-12">
        {desktopConnection() && (
          <Button
            variant="outline"
            className="self-start"
            render={<a href={WORKSPACES_LINK} />}
          >
            Back to workspaces
          </Button>
        )}
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          ZeroLux · {health?.workspace.name ?? "your workspace"}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {loading
            ? "Checking your workspace…"
            : creating
              ? "Create account"
              : identity && enrolling
                ? "Connect account"
                : "Sign in"}
        </h1>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">
            No workspace data is loaded before you sign in.
          </p>
        ) : !health ? (
          <Button
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Try again
          </Button>
        ) : identity && !enrolling ? (
          <>
            <p className="text-sm text-muted-foreground">
              This account is not a member of this workspace. Signing in does
              not grant access.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {creating
                ? "Create your account to become this workspace’s owner. Its people and history stay unchanged."
                : enrolling
                  ? "Connect your account to the workspace’s owner. Its people and history stay unchanged."
                  : "Use your account for this workspace."}
            </p>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!blocked) void submit();
              }}
            >
              {identity && (
                <p className="text-sm text-muted-foreground">
                  {identity.user.email}
                </p>
              )}
              {!identity && (
                <>
                  {creating && (
                    <>
                      <Label htmlFor="auth-name">Your name</Label>
                      <Input
                        id="auth-name"
                        autoComplete="name"
                        required
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                      {name && ownerNameError(name) && (
                        <p className="text-sm text-destructive">
                          {ownerNameError(name)}
                        </p>
                      )}
                    </>
                  )}
                  <Label htmlFor="auth-email">Email</Label>
                  <Input
                    id="auth-email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    disabled={busy}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <Label htmlFor="auth-password">Password</Label>
                  <Input
                    id="auth-password"
                    type="password"
                    autoComplete={
                      creating ? "new-password" : "current-password"
                    }
                    required
                    minLength={creating ? 12 : undefined}
                    maxLength={128}
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {creating && (
                    <p className="text-xs text-muted-foreground">
                      Use at least 12 characters.
                    </p>
                  )}
                </>
              )}
              <Button type="submit" className="self-start" disabled={blocked}>
                {busy
                  ? "Please wait…"
                  : identity
                    ? "Connect account"
                    : creating
                      ? "Create account"
                      : "Sign in"}
              </Button>
            </form>
            {enrolling && !identity && (
              <Button
                variant="ghost"
                className="self-start"
                disabled={busy}
                onClick={() => {
                  setExisting((value) => !value);
                  setPassword("");
                  setError("");
                }}
              >
                {existing
                  ? "Create an account"
                  : "Already have an account? Sign in"}
              </Button>
            )}
            {identity && (
              <Button
                variant="ghost"
                className="self-start"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Use another account
              </Button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
