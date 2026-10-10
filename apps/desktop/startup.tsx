import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../web/src/components/ui/button";
import { Input } from "../web/src/components/ui/input";
import { Label } from "../web/src/components/ui/label";
import { startTheme } from "../web/src/theme";

export type Profile = {
  id: string;
  workspace_id: string | null;
  name: string;
  source:
    | { kind: "local"; legacy: boolean }
    | { kind: "existing"; url: string };
  running: boolean;
};
export type DesktopState = {
  revision: number;
  profiles: Profile[];
  active: string | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
};
type Action =
  | { action: "list" }
  | { action: "open" | "forget"; id: string }
  | { action: "add"; url: string }
  | { action: "create"; name: string }
  | { action: "edit"; id: string; url: string };
const initial: DesktopState = {
  revision: 0,
  profiles: [],
  active: null,
  ready: false,
  busy: false,
  error: null,
};

declare global {
  interface Window {
    zeroluxDesktopState?: (state: DesktopState) => void;
    zeroluxDesktopFocus?: (id: string) => void;
  }
}

export function newerDesktopState(current: DesktopState, next: DesktopState) {
  return next.revision >= current.revision ? next : current;
}

export function WorkspaceManager({
  initialState = initial,
}: {
  initialState?: DesktopState;
}) {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);
  const apply = (next: DesktopState) =>
    setState((current) => newerDesktopState(current, next));
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const disabled = !state.ready || state.busy || pending;
  const edited = state.profiles.find((profile) => profile.id === editing);

  async function act(action: Action) {
    setPending(true);
    setState((current) => ({ ...current, error: null }));
    try {
      const next = await invoke<DesktopState>("workspace_action", { action });
      apply(next);
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        busy: false,
        error: String(error),
      }));
      return false;
    } finally {
      setPending(false);
    }
  }
  function edit(profile: Profile) {
    setForgetting(null);
    if (profile.source.kind === "existing") {
      setEditing(profile.id);
      setAddress(profile.source.url);
    }
  }
  function cancelEdit() {
    setEditing(null);
    setAddress("");
  }

  useEffect(() => {
    window.zeroluxDesktopState = apply;
    void act({ action: "list" });
    return () => {
      delete window.zeroluxDesktopState;
    };
  }, []);
  useEffect(() => {
    window.zeroluxDesktopFocus = (id) => {
      // Opening the manager must not overwrite an address the owner is editing.
      if (
        address &&
        (edited?.source.kind !== "existing" || address !== edited.source.url)
      )
        return;
      const profile = state.profiles.find((profile) => profile.id === id);
      if (profile) edit(profile);
    };
    return () => {
      delete window.zeroluxDesktopFocus;
    };
  }, [state.profiles, address, edited]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-7 p-8">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          ZeroLux
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          Separate organizations, chats and agents. Your saved connections stay
          on this device.
        </p>
      </header>
      <div aria-live="polite">
        {(state.busy || pending) && (
          <p role="status" className="text-sm text-muted-foreground">
            Connecting…
          </p>
        )}
        {!state.ready && !state.error && (
          <p role="status" className="text-sm text-muted-foreground">
            Opening connections…
          </p>
        )}
        {state.error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {state.error}
          </p>
        )}
      </div>
      {state.profiles.length > 0 && (
        <section aria-label="Saved workspaces" className="space-y-3">
          {state.profiles.map((profile) => (
            <article
              key={profile.id}
              className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <h2 className="break-words text-sm font-semibold">
                    {profile.name}
                  </h2>
                  <p className="break-all text-xs text-muted-foreground">
                    {profile.source.kind === "local"
                      ? `Managed on this device${profile.running ? " · running" : ""}`
                      : profile.source.url}
                  </p>
                  {profile.workspace_id && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {profile.workspace_id}
                    </p>
                  )}
                </div>
                <Button
                  disabled={disabled}
                  variant={state.active === profile.id ? "outline" : "default"}
                  onClick={() => void act({ action: "open", id: profile.id })}
                >
                  {state.active === profile.id ? "Return" : "Open"}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                {profile.source.kind === "existing" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => edit(profile)}
                  >
                    Change address
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || profile.running}
                  title={
                    profile.running
                      ? "A running local kernel keeps its connection in this list"
                      : undefined
                  }
                  onClick={() => {
                    setForgetting(profile.id);
                    cancelEdit();
                  }}
                >
                  Forget connection
                </Button>
              </div>
              {forgetting === profile.id && (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-sm text-muted-foreground">
                    Remove this saved connection? Workspace data is not deleted
                    and an external server is not stopped.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={async () => {
                        if (await act({ action: "forget", id: profile.id }))
                          setForgetting(null);
                      }}
                    >
                      Forget connection
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setForgetting(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      <section
        className="space-y-4 border-t pt-6"
        aria-labelledby="connection-heading"
      >
        <h2 id="connection-heading" className="text-sm font-semibold">
          {edited
            ? `Connection for ${edited.name}`
            : "Connect an existing workspace"}
        </h2>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled) return;
            if (
              await act(
                edited
                  ? { action: "edit", id: edited.id, url: address }
                  : { action: "add", url: address },
              )
            )
              cancelEdit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="address">Kernel address</Label>
            <Input
              id="address"
              name="address"
              type="url"
              required
              placeholder="https://server.example"
              disabled={disabled}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {edited
                ? "Only this device's address changes. It must serve the same workspace; pending sends must finish first."
                : "A server on this computer, your network or a trusted remote network. No existing workspace is copied or replaced."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={disabled || !address.trim()}>
              {edited ? "Save address" : "Connect workspace"}
            </Button>
            {edited && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={cancelEdit}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </section>
      <section
        className="space-y-4 border-t pt-6"
        aria-labelledby="local-heading"
      >
        <h2 id="local-heading" className="text-sm font-semibold">
          Create a local workspace
        </h2>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!disabled && (await act({ action: "create", name })))
              setName("");
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="local-name">Workspace name</Label>
            <Input
              id="local-name"
              required
              maxLength={200}
              disabled={disabled}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My workspace"
            />
            <p className="text-xs text-muted-foreground">
              A new, independent kernel and data directory, managed by this app.
              LiveKit and Bun must be installed.
            </p>
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !name.trim()}
          >
            Create workspace
          </Button>
        </form>
      </section>
      <footer className="space-y-2 border-t pt-5 text-xs text-muted-foreground">
        <p>
          Switching keeps open workspaces running. Quitting only shuts down
          local kernels started by this app, not external servers or native
          agents.
        </p>
        <p>
          The kernel does not yet authenticate users. Do not expose it on an
          untrusted public network.
        </p>
      </footer>
    </main>
  );
}

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) {
    startTheme();
    createRoot(root).render(<WorkspaceManager />);
  }
}
