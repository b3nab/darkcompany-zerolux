import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import {
  activeActors,
  whoAmI,
  type Actor,
  type AuthConnection,
  type AuthHealth,
  type AuthIdentity,
  type Invitation,
} from "@zerolux/chat";
import { windowDragProps } from "./desktop";
import { ownerNameError } from "./OwnerOnboarding";
import { WindowControls } from "./components/window-controls";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";

interface Authentication {
  /** The signed-in account in this workspace. */
  identity: AuthIdentity;
  /** The kernel's sign-in, for the account's own pages: password and devices. */
  account: AuthConnection;
  busy: boolean;
  error: string;
  signOut(): Promise<void>;
  guard(canLeave: () => boolean): () => void;
}
export const AuthenticationContext = createContext<Authentication | null>(null);
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

/** A page before any workspace's own: the window's controls, and what it says. */
export function Frame({ children }: { children: ReactNode }) {
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

/** What signing in submits: a new account, with its name, or an existing one. */
export interface Credentials {
  name?: string;
  email: string;
  password: string;
}

/**
 * Signing in to a kernel, once for all its workspaces: its first account while it has none,
 * an account of one's own with an invitation, or the account one has.
 */
export function SignIn({
  health,
  invitation,
  invitationError,
  place,
  busy,
  error,
  submit,
}: {
  health: AuthHealth;
  invitation?: Invitation;
  invitationError?: string;
  /** What the kernel is called here: its host, or an older kernel's workspace. */
  place: string;
  busy: boolean;
  error: string;
  submit: (credentials: Credentials) => void;
}) {
  const [existing, setExisting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  // A new account: the kernel's first, or one with an invitation.
  const open = !!invitation || health.auth.setup_required;
  const creating = open && !existing;
  const blocked =
    busy ||
    (creating &&
      (Boolean(ownerNameError(name)) ||
        !password ||
        confirmation !== password));
  return (
    <>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        ZeroLux · {place}
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {invitation
          ? `Join ${invitation.workspace}`
          : creating
            ? "Create account"
            : "Sign in"}
      </h1>
      {invitation && (
        <p className="text-sm text-muted-foreground">
          Invited by {invitation.invited_by}
        </p>
      )}
      {(error || invitationError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || invitationError}
        </p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked)
            submit({ name: creating ? name : undefined, email, password });
        }}
      >
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
              <p className="text-sm text-destructive">{ownerNameError(name)}</p>
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
          autoComplete={creating ? "new-password" : "current-password"}
          required
          maxLength={128}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        {creating && (
          <>
            <Label htmlFor="auth-confirmation">Confirm password</Label>
            <Input
              id="auth-confirmation"
              type="password"
              autoComplete="new-password"
              required
              maxLength={128}
              value={confirmation}
              disabled={busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {confirmation && confirmation !== password && (
              <p className="text-xs text-destructive">
                The passwords do not match.
              </p>
            )}
          </>
        )}
        <Button type="submit" className="self-start" disabled={blocked}>
          {busy
            ? "Please wait…"
            : invitation
              ? creating
                ? "Create account and join"
                : "Sign in and join"
              : creating
                ? "Create account"
                : "Sign in"}
        </Button>
      </form>
      {open && (
        <Button
          variant="ghost"
          className="self-start"
          disabled={busy}
          onClick={() => {
            setExisting((value) => !value);
            setPassword("");
          }}
        >
          {existing ? "Create an account" : "Sign in instead"}
        </Button>
      )}
    </>
  );
}
