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
  activeActors,
  ApiError,
  AuthConnection,
  errorMessage,
  requiresSignIn,
  whoAmI,
  type Actor,
  type AuthHealth,
  type AuthIdentity,
  type Invitation,
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
  /** The signed-in connection, for the account's own pages: password and devices. */
  account: AuthConnection;
  busy: boolean;
  error: string;
  signOut(): Promise<void>;
  guard(canLeave: () => boolean): () => void;
}
const AuthenticationContext = createContext<Authentication | null>(null);
export const useAuthentication = () => useContext(AuthenticationContext);

/**
 * Who is using the app: the person signed in (`me`), and whether they own the workspace. A
 * kernel without sign-in has only its owner.
 */
export function useMe(actors: Actor[]) {
  const authentication = useAuthentication();
  return whoAmI(
    authentication?.identity,
    activeActors(actors),
    authentication !== null,
  );
}

/** The invitation a join link carries: `/join?invite=…`. */
const invited = () =>
  globalThis.location?.pathname === "/join"
    ? new URLSearchParams(location.search).get("invite")
    : null;

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
  const [confirmation, setConfirmation] = useState("");
  // Joining by invitation: what it says, or why it can no longer be used.
  const [invite] = useState(invited);
  const [invitation, setInvitation] = useState<Invitation>();
  const [invitationError, setInvitationError] = useState("");
  useEffect(() => {
    if (!invite || !health) return;
    client
      .invitation(invite)
      .then(setInvitation, (failed: unknown) =>
        setInvitationError(
          failed instanceof ApiError && failed.status === 410
            ? "This invitation can no longer be used."
            : errorMessage(failed),
        ),
      );
  }, [client, invite, health]);

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
      // With an invitation, the account joins as a new person; without, it is the owner's.
      const joining = invitation && invite ? invite : undefined;
      if (identity) next = await client.claim(joining);
      else if (creating)
        next = await client.signUp(name, email, password, joining);
      else {
        next = await client.signIn(email, password);
        if (!next.actor_id && (next.setup_required || joining))
          next = await client.claim(joining);
      }
      // In, the join link has done its work.
      if (joining && next.actor_id) history.replaceState(null, "", "/");
      if (live.current) {
        setIdentity(next);
        setPassword("");
        setConfirmation("");
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
      <AuthenticationContext
        value={{ identity, account: client, busy, error, signOut, guard }}
      >
        {children}
      </AuthenticationContext>
    );
  // A kernel without sign-in: the workspace as it always was.
  if (health && !requiresSignIn(health)) return children;

  const enrolling =
    !!invitation ||
    (identity?.setup_required ?? health?.auth.setup_required === true);
  const creating = enrolling && !existing && !identity;
  const blocked =
    busy ||
    (creating &&
      (Boolean(ownerNameError(name)) ||
        !password ||
        confirmation !== password));
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
            : invitation
              ? `Join ${invitation.workspace}`
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
        {invitationError && (
          <p role="alert" className="text-sm text-destructive">
            {invitationError}
          </p>
        )}
        {loading ? null : !health ? (
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
              This account is not a member of this workspace.
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
            {invitation && (
              <p className="text-sm text-muted-foreground">
                Invited by {invitation.invited_by}
              </p>
            )}
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
                    maxLength={128}
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {creating && (
                    <>
                      <Label htmlFor="auth-confirmation">
                        Confirm password
                      </Label>
                      <Input
                        id="auth-confirmation"
                        type="password"
                        autoComplete="new-password"
                        required
                        maxLength={128}
                        value={confirmation}
                        disabled={busy}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                      />
                      {confirmation && confirmation !== password && (
                        <p className="text-xs text-destructive">
                          The passwords do not match.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
              <Button type="submit" className="self-start" disabled={blocked}>
                {busy
                  ? "Please wait…"
                  : invitation
                    ? identity
                      ? "Join"
                      : creating
                        ? "Create account and join"
                        : "Sign in and join"
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
                {existing ? "Create an account" : "Sign in instead"}
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
