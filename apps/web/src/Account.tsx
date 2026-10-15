import { useCallback, useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { Link } from "react-router";
import {
  ago,
  ApiError,
  capabilityStatus,
  deviceName,
  errorMessage,
  renameWorkspace,
} from "@zerolux/chat";
import type { AuthConnection, AuthDevice, Perform } from "@zerolux/chat";
import { themes } from "@zerolux/theme/themes";
import type { Actor, Workspace } from "./api";
import { useAuthentication } from "./AuthGate";
import { useTheme } from "./theme";
import type { Light } from "./theme";
import { Eyebrow } from "@/components/presence";
import { ProfileHead } from "@/components/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Connection, WorkspaceSettings } from "@/components/workspace-settings";

/** A page of settings: what it is about, and its sections. */
function Settings({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A section the kernel cannot back yet: what it will hold, said plainly. */
function NotYet({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm text-muted-foreground">
      {children} Not available yet.
    </p>
  );
}

/** You, as the workspace sees you, and your password. */
export function ProfilePage({ owner }: { owner: Actor }) {
  const authentication = useAuthentication();
  return (
    <Settings eyebrow="Profile" title="Your profile">
      <div className="overflow-hidden rounded-xl border bg-card">
        {/* TODO: kernel: people rename themselves and add a photo; agents already can be renamed. */}
        <ProfileHead
          actor={owner}
          state="on"
          role="Owner"
          status={
            authentication
              ? `Signed in as ${authentication.identity.user.email}`
              : "This workspace has no sign-in"
          }
        />
      </div>
      {authentication && <Password account={authentication.account} />}
    </Settings>
  );
}

const MIN_PASSWORD = 8;

function Password({ account }: { account: AuthConnection }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [others, setOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const mismatch = again !== "" && again !== next;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mismatch || next.length < MIN_PASSWORD) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      await account.changePassword(current, next, others);
      setCurrent("");
      setNext("");
      setAgain("");
      setNote(
        others
          ? "Password changed. Your other devices have to sign in again."
          : "Password changed.",
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Password">
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-current">Current password</Label>
          <Input
            id="password-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            disabled={busy}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-new">New password</Label>
          <Input
            id="password-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            minLength={MIN_PASSWORD}
            disabled={busy}
            required
            aria-describedby="password-new-help"
          />
          <p id="password-new-help" className="text-sm text-muted-foreground">
            At least {MIN_PASSWORD} characters.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password-again">Confirm the new password</Label>
          <Input
            id="password-again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            disabled={busy}
            required
            aria-invalid={mismatch || undefined}
          />
          {mismatch && (
            <p className="text-sm text-destructive">
              The two passwords differ.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={others}
            onChange={(event) => setOthers(event.target.checked)}
            disabled={busy}
          />
          Sign out my other devices
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="text-sm text-muted-foreground">
            {note}
          </p>
        )}
        <Button
          type="submit"
          className="self-start"
          disabled={busy || mismatch || next.length < MIN_PASSWORD}
        >
          {busy ? "Changing…" : "Change password"}
        </Button>
      </form>
    </Section>
  );
}

/** Your own settings, and this device's: nothing here changes the workspace for anyone else. */
export function MySettingsPage() {
  const authentication = useAuthentication();
  return (
    <Settings eyebrow="Settings" title="My settings">
      <Section title="Notifications">
        {/* TODO: kernel: notifications per channel (in app, push, email) with presets such as approvals only, exceptions per chat and quiet hours. */}
        <NotYet>
          What reaches you, in the app, on the phone and by email, with quiet
          hours.
        </NotYet>
      </Section>
      {authentication && (
        <Devices
          account={authentication.account}
          email={authentication.identity.user.email}
        />
      )}
      <Section title="This device">
        <Appearance />
        <Connection />
      </Section>
    </Settings>
  );
}

function Devices({
  account,
  email,
}: {
  account: AuthConnection;
  email: string;
}) {
  const [list, setList] = useState<{
    devices: AuthDevice[];
    current: string | null;
  }>();
  const [stale, setStale] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setList(await account.devices());
      setStale(false);
    } catch (error) {
      // Better Auth shows your devices only to a sign-in from the last day.
      if (error instanceof ApiError && error.status === 403) setStale(true);
      else setError(errorMessage(error));
    }
  }, [account]);
  useEffect(() => void load(), [load]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Devices">
      {stale ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await account.signIn(email, password);
              setPassword("");
            });
          }}
        >
          <Label htmlFor="devices-password">
            Confirm your password to see where you are signed in
          </Label>
          <div className="flex gap-2">
            <Input
              id="devices-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
            <Button type="submit" disabled={busy || !password}>
              Confirm
            </Button>
          </div>
        </form>
      ) : list ? (
        <ul className="divide-y rounded-lg border">
          {[...list.devices]
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .map((device) => {
              const here = device.id === list.current;
              return (
                <li
                  key={device.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">
                      {deviceName(device.userAgent)}
                    </span>
                    <span className="truncate text-xs text-faint">
                      {here
                        ? "This device"
                        : `Active ${ago(Date.parse(device.updatedAt))}`}
                      {device.ipAddress && ` · ${device.ipAddress}`}
                    </span>
                  </span>
                  {!here && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(() => account.signOutDevice(device.token))
                      }
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
        </ul>
      ) : (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
  );
}

const lights: [Light, string][] = [
  ["system", "System"],
  ["light", "Daylight"],
  ["dark", "Night"],
];

/** The theme and its light on this device. */
function Appearance() {
  const { theme, light, chooseTheme, chooseLight } = useTheme();
  const choice = (selected: boolean) =>
    selected ? ("default" as const) : ("outline" as const);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span id="theme-label" className="text-sm font-medium">
          Theme
        </span>
        <div
          role="radiogroup"
          aria-labelledby="theme-label"
          className="flex flex-wrap gap-2"
        >
          {themes.map((t) => (
            <Button
              key={t.id}
              role="radio"
              aria-checked={theme === t.id}
              title={t.description}
              variant={choice(theme === t.id)}
              size="sm"
              onClick={() => chooseTheme(t.id)}
            >
              {t.name}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span id="light-label" className="text-sm font-medium">
          Light
        </span>
        <div
          role="radiogroup"
          aria-labelledby="light-label"
          className="flex flex-wrap gap-2"
        >
          {lights.map(([value, label]) => (
            <Button
              key={value}
              role="radio"
              aria-checked={light === value}
              variant={choice(light === value)}
              size="sm"
              onClick={() => chooseLight(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The workspace for everyone in it: only its owner sees and changes this. */
export function AdministrationPage({
  workspace,
  busy,
  perform,
  kernel,
}: {
  workspace: Workspace;
  busy: boolean;
  perform: Perform;
  kernel: { version?: string; capabilities: string[] };
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Settings eyebrow="Administration" title={workspace.workspace.name}>
      <Section title="Workspace">
        <WorkspaceSettings
          workspace={workspace.workspace}
          busy={busy || saving}
          error={error}
          save={async (name) => {
            setSaving(true);
            setError("");
            try {
              await renameWorkspace(name);
              await perform(async () => {});
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setSaving(false);
            }
          }}
        />
      </Section>
      <Section title="Features">
        <p className="text-sm text-muted-foreground">
          What this workspace's kernel
          {kernel.version && (
            <span className="font-mono"> {kernel.version}</span>
          )}{" "}
          can do today.
        </p>
        <ul className="divide-y rounded-lg border">
          {capabilityStatus(kernel.capabilities).map((feature) => (
            <li
              key={feature.id}
              data-available={feature.available || undefined}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{feature.name}</span>
                {feature.description && (
                  <span className="text-xs text-muted-foreground">
                    {feature.description}
                  </span>
                )}
              </span>
              <span
                className={
                  feature.available
                    ? "shrink-0 font-mono text-[11px] text-success"
                    : "shrink-0 font-mono text-[11px] text-faint"
                }
              >
                {feature.available ? "Available" : "Not yet"}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="People">
        {/* TODO: kernel: invite people, give them roles and say who reports to whom. */}
        <NotYet>Inviting people, their roles and who reports to whom.</NotYet>
      </Section>
      <Section title="Agents">
        {/* TODO: kernel: instructions for every agent, and the model and effort new agents start with. */}
        <NotYet>
          Instructions for every agent, and the model and effort new agents
          start with.
        </NotYet>
        <p className="text-sm text-muted-foreground">
          Each agent's own model and effort are on its profile in{" "}
          <Link to="/team" className="underline underline-offset-4">
            Team
          </Link>
          .
        </p>
      </Section>
      <Section title="Modules">
        {/* TODO: kernel: modules the workspace turns on, and themes beyond the four built in. */}
        <NotYet>The modules this workspace uses, and community themes.</NotYet>
      </Section>
      <Section title="Storage and updates">
        {/* TODO: kernel: where files are kept, signed updates and the backup taken before each. */}
        <NotYet>
          Where files are kept, signed updates and the backup before each one.
        </NotYet>
      </Section>
    </Settings>
  );
}
