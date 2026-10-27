import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../web/src/components/ui/button";
import { Input } from "../web/src/components/ui/input";
import { Label } from "../web/src/components/ui/label";
import { Checkbox } from "../web/src/components/ui/checkbox";
import { startTheme } from "../web/src/theme";
import {
  AdoptionForm,
  NetworkForm,
  networkAddress,
} from "./workspace-settings";
import type { Network } from "./workspace-settings";

export type Profile = {
  id: string;
  workspace_id: string | null;
  name: string;
  source:
    | { kind: "local"; legacy: boolean }
    | { kind: "existing"; url: string };
  running: boolean;
  start_on_launch: boolean;
  dataDirectory: string | null;
  database: string | null;
  network: Network | null;
  localUrl: string | null;
};
/** A workspace this computer joined, to run its person's sessions here. */
export type JoinedWorkspace = {
  id: string;
  url: string;
  /** Where its connection is; none once it stopped. */
  link:
    | { state: "connecting" | "connected" }
    | { state: "reconnecting"; error: string }
    | null;
  /** Why it stopped, as when the workspace removed this computer. */
  error: string | null;
};
export type DesktopState = {
  revision: number;
  profiles: Profile[];
  active: string | null;
  computers: JoinedWorkspace[];
  ready: boolean;
  busy: boolean;
  error: string | null;
};
type Action =
  | { action: "list" }
  | { action: "open" | "forget"; id: string }
  | { action: "add"; url: string }
  | { action: "create"; name: string }
  | { action: "edit"; id: string; url: string }
  | { action: "adopt"; id: string; directory: string }
  | { action: "network"; id: string; network: Network }
  | { action: "startup"; id: string; enabled: boolean }
  | { action: "join"; url: string; code: string; name: string }
  | { action: "leave"; id: string };
const initial: DesktopState = {
  revision: 0,
  profiles: [],
  active: null,
  computers: [],
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

/** Where a joined workspace's connection is, in words. */
export function linkState(link: JoinedWorkspace["link"]) {
  if (!link) return "Not connected";
  if (link.state === "reconnecting") return `Reconnecting: ${link.error}`;
  return link.state === "connected" ? "Connected" : "Connecting…";
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
  const [joining, setJoining] = useState({ url: "", code: "", name: "" });
  const [leaving, setLeaving] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [networking, setNetworking] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const disabled = !state.ready || state.busy || pending || previewing;
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
    setAdopting(null);
    setNetworking(null);
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
      if (adopting || networking || previewing) return;
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
  }, [state.profiles, address, edited, adopting, networking, previewing]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-7 p-8">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          ZeroLux
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
      </header>
      <div aria-live="polite">
        {(state.busy || pending || previewing) && (
          <p role="status" className="text-sm text-muted-foreground">
            Working…
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
                  {profile.dataDirectory && (
                    <p className="break-all text-xs text-muted-foreground">
                      {profile.dataDirectory}
                    </p>
                  )}
                  {profile.network && profile.network.port > 0 && (
                    <p className="break-all text-xs text-muted-foreground">
                      {networkAddress(profile.network)}
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
              <div className="flex flex-wrap items-center gap-2">
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
                {profile.source.kind === "existing" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      cancelEdit();
                      setForgetting(null);
                      setNetworking(null);
                      setAdopting(profile.id);
                    }}
                  >
                    Run with this app
                  </Button>
                )}
                {profile.source.kind === "local" && profile.network && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      cancelEdit();
                      setForgetting(null);
                      setAdopting(null);
                      setNetworking(profile.id);
                    }}
                  >
                    Network settings
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || profile.running}
                  onClick={() => {
                    setForgetting(profile.id);
                    cancelEdit();
                    setAdopting(null);
                    setNetworking(null);
                  }}
                >
                  Forget connection
                </Button>
              </div>
              {profile.source.kind === "local" && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`startup-${profile.id}`}
                    checked={profile.start_on_launch}
                    disabled={disabled}
                    onCheckedChange={(enabled) =>
                      void act({
                        action: "startup",
                        id: profile.id,
                        enabled: !!enabled,
                      })
                    }
                  />
                  <Label htmlFor={`startup-${profile.id}`}>
                    Start when ZeroLux opens
                  </Label>
                </div>
              )}
              {adopting === profile.id &&
                profile.source.kind === "existing" && (
                  <AdoptionForm
                    id={profile.id}
                    disabled={disabled}
                    busy={setPreviewing}
                    cancel={() => setAdopting(null)}
                    adopt={async (directory) => {
                      if (
                        await act({
                          action: "adopt",
                          id: profile.id,
                          directory,
                        })
                      )
                        setAdopting(null);
                    }}
                  />
                )}
              {networking === profile.id && profile.network && (
                <NetworkForm
                  id={profile.id}
                  network={profile.network}
                  disabled={disabled}
                  cancel={() => setNetworking(null)}
                  save={async (network) => {
                    if (
                      await act({ action: "network", id: profile.id, network })
                    )
                      setNetworking(null);
                  }}
                />
              )}
              {forgetting === profile.id && (
                <div className="space-y-3 border-t pt-3">
                  <p className="text-sm text-muted-foreground">
                    Forget this connection?
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
      <section
        className="space-y-4 border-t pt-6"
        aria-labelledby="computer-heading"
      >
        <h2 id="computer-heading" className="text-sm font-semibold">
          This computer in a workspace
        </h2>
        {state.computers.length > 0 && (
          <ul aria-label="Joined workspaces" className="space-y-2">
            {state.computers.map((joined) => (
              <li
                key={joined.id}
                className="space-y-2 rounded-xl border bg-card p-3 text-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="break-all font-medium">{joined.url}</p>
                    <p
                      className={
                        joined.error
                          ? "text-xs text-destructive"
                          : joined.link?.state === "connected"
                            ? "text-xs text-success"
                            : "text-xs text-muted-foreground"
                      }
                    >
                      {joined.error ?? linkState(joined.link)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setLeaving(joined.id)}
                  >
                    Leave
                  </Button>
                </div>
                {leaving === joined.id && (
                  <div className="space-y-3 border-t pt-3">
                    <p className="text-sm text-muted-foreground">
                      Leave this workspace? Its sessions here stop being
                      reachable from the workspace.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={async () => {
                          if (await act({ action: "leave", id: joined.id }))
                            setLeaving(null);
                        }}
                      >
                        Leave
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setLeaving(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3"
          aria-label="Join a workspace"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!disabled && (await act({ action: "join", ...joining })))
              setJoining({ url: "", code: "", name: "" });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="join-address">Workspace address</Label>
            <Input
              id="join-address"
              type="url"
              required
              placeholder="http://192.0.2.10:4310"
              disabled={disabled}
              value={joining.url}
              onChange={(event) =>
                setJoining({ ...joining, url: event.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="join-code">Code</Label>
            <Input
              id="join-code"
              required
              autoComplete="off"
              disabled={disabled}
              value={joining.code}
              onChange={(event) =>
                setJoining({ ...joining, code: event.target.value })
              }
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              From the workspace: My settings › Computers › Add a computer.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="join-name">Computer name · optional</Label>
            <Input
              id="join-name"
              maxLength={200}
              disabled={disabled}
              value={joining.name}
              onChange={(event) =>
                setJoining({ ...joining, name: event.target.value })
              }
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !joining.url.trim() || !joining.code.trim()}
          >
            Join workspace
          </Button>
        </form>
      </section>
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
