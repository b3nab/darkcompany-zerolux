import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EllipsisIcon, MonitorSmartphoneIcon, PlusIcon } from "lucide-react";
import { Button } from "../web/src/components/ui/button";
import { Input } from "../web/src/components/ui/input";
import { Label } from "../web/src/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../web/src/components/ui/dropdown-menu";
import { Kbd } from "../web/src/components/ui/kbd";
import { keyLabel } from "../web/src/app-menu";
import { Mark } from "../web/src/components/brand";
import { startTheme } from "../web/src/theme";
import {
  AdoptionForm,
  NetworkForm,
  networkAddress,
} from "./workspace-settings";
import type { Network } from "./workspace-settings";

/** A ZeroLux the app reaches: this computer's own, or another computer's. */
export type Profile = {
  id: string;
  instance_id: string | null;
  name: string;
  source: { kind: "local" } | { kind: "existing"; url: string };
  running: boolean;
  start_on_launch: boolean;
  dataDirectory: string | null;
  database: string | null;
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
  /** This computer's own ZeroLux. */
  kernel: { network: Network | null; running: boolean };
  computers: JoinedWorkspace[];
  ready: boolean;
  busy: boolean;
  error: string | null;
};
type Action =
  | { action: "list" }
  | { action: "open" | "forget"; id: string }
  | { action: "add"; url: string }
  | { action: "new_workspace" }
  | { action: "edit"; id: string; url: string }
  | { action: "adopt"; id: string; directory: string }
  | { action: "network"; network: Network }
  | { action: "startup"; id: string; enabled: boolean }
  | { action: "join"; url: string; code: string; name: string }
  | { action: "leave"; id: string };
const initial: DesktopState = {
  revision: 0,
  profiles: [],
  active: null,
  kernel: { network: null, running: false },
  computers: [],
  ready: false,
  busy: false,
  error: null,
};

/** What the right side shows instead of the recent workspaces. */
type Panel =
  | { kind: "connect" }
  | { kind: "edit" | "adopt" | "remove"; id: string }
  | { kind: "network" }
  | { kind: "join" };

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

/** The folder a kernel's data is kept in: the project, for its `.zerolux`. */
export function projectFolder(directory: string) {
  return directory.replace(/[\\/]\.zerolux[\\/]?$/, "");
}

/** Where a ZeroLux is: this computer's data folder, or the other computer's address. */
function whereIs(profile: Profile) {
  if (profile.source.kind === "existing")
    return new URL(profile.source.url).host;
  return profile.dataDirectory ? projectFolder(profile.dataDirectory) : "";
}

function Choice({
  icon,
  label,
  keys,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  keys?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:text-primary"
    >
      {icon}
      <span className="flex-1 font-medium">{label}</span>
      {keys && <Kbd>{keys}</Kbd>}
    </button>
  );
}

function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-md border border-input bg-secondary text-sm font-semibold"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Another computer's ZeroLux, at its kernel's address. */
function Connect({
  disabled,
  connect,
  cancel,
}: {
  disabled: boolean;
  connect: (url: string) => Promise<boolean>;
  cancel: () => void;
}) {
  const [address, setAddress] = useState("");
  return (
    <form
      aria-label="Connect to another computer"
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!disabled) await connect(address);
      }}
    >
      <h2 className="text-base font-semibold">Connect to another computer</h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="address">Address</Label>
        <Input
          id="address"
          type="url"
          required
          placeholder="http://192.0.2.10:4310"
          disabled={disabled}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled || !address.trim()}>
          Connect
        </Button>
        <Button type="button" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The workspaces this computer joined, to run their person's sessions here. */
function Joined({
  state,
  disabled,
  act,
  cancel,
}: {
  state: DesktopState;
  disabled: boolean;
  act: (action: Action) => Promise<boolean>;
  cancel: () => void;
}) {
  const [joining, setJoining] = useState({ url: "", code: "", name: "" });
  const [leaving, setLeaving] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">This computer in a workspace</h2>
      {state.computers.length > 0 && (
        <ul aria-label="Joined workspaces" className="flex flex-col gap-2">
          {state.computers.map((joined) => (
            <li key={joined.id} className="rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
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
                {leaving === joined.id ? (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
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
                      size="sm"
                      variant="ghost"
                      onClick={() => setLeaving(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setLeaving(joined.id)}
                  >
                    Leave…
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3"
        aria-label="Join a workspace"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!disabled && (await act({ action: "join", ...joining })))
            setJoining({ url: "", code: "", name: "" });
        }}
      >
        <div className="flex flex-col gap-2">
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
        <div className="flex flex-col gap-2">
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
        <div className="flex flex-col gap-2">
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
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !joining.url.trim() || !joining.code.trim()}
          >
            Join workspace
          </Button>
          <Button type="button" variant="ghost" onClick={cancel}>
            Done
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A ZeroLux the app reaches, opened by a click. */
function Recent({
  profile,
  active,
  disabled,
  canAdopt,
  act,
  show,
}: {
  profile: Profile;
  active: boolean;
  disabled: boolean;
  /** This computer has no ZeroLux of its own yet: another's can become it. */
  canAdopt: boolean;
  act: (action: Action) => Promise<boolean>;
  show: (panel: Panel) => void;
}) {
  const local = profile.source.kind === "local";
  return (
    <li className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent">
      <button
        type="button"
        disabled={disabled}
        onClick={() => void act({ action: "open", id: profile.id })}
        className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left"
      >
        <Initial name={profile.name} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{profile.name}</span>
          <span
            title={whereIs(profile)}
            className="truncate font-mono text-[11px] text-muted-foreground"
          >
            {whereIs(profile)}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {active && <span className="sr-only">Open</span>}
          {(profile.running || active) && (
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]"
            />
          )}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`${profile.name}, more`}
              disabled={disabled}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {local ? (
            <DropdownMenuCheckboxItem
              checked={profile.start_on_launch}
              onCheckedChange={(enabled) =>
                void act({ action: "startup", id: profile.id, enabled })
              }
            >
              Start when ZeroLux opens
            </DropdownMenuCheckboxItem>
          ) : (
            <>
              <DropdownMenuItem
                onClick={() => show({ kind: "edit", id: profile.id })}
              >
                Change address…
              </DropdownMenuItem>
              {canAdopt && (
                <DropdownMenuItem
                  onClick={() => show({ kind: "adopt", id: profile.id })}
                >
                  Run with this app…
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => show({ kind: "remove", id: profile.id })}
          >
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * The app's workspaces, as VS Code, JetBrains and Obsidian welcome theirs: on the left a new
 * one, a folder's, or another computer's; on the right the saved ones, each opened by a click.
 */
export function WorkspaceManager({
  initialState = initial,
}: {
  initialState?: DesktopState;
}) {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [address, setAddress] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const apply = (next: DesktopState) =>
    setState((current) => newerDesktopState(current, next));
  const disabled = !state.ready || state.busy || pending || previewing;
  const shown =
    panel && "id" in panel
      ? state.profiles.find((profile) => profile.id === panel.id)
      : undefined;

  async function act(action: Action) {
    setPending(true);
    setState((current) => ({ ...current, error: null }));
    try {
      apply(await invoke<DesktopState>("workspace_action", { action }));
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
  /** An action that, done, leaves the panel for the recent workspaces. */
  const done = async (action: Action) => {
    const ok = await act(action);
    if (ok) setPanel(null);
    return ok;
  };
  function show(next: Panel) {
    setState((current) => ({ ...current, error: null }));
    if (next.kind === "edit") {
      const profile = state.profiles.find((one) => one.id === next.id);
      if (profile?.source.kind === "existing") setAddress(profile.source.url);
    }
    setPanel(next);
  }

  useEffect(() => {
    window.zeroluxDesktopState = apply;
    void act({ action: "list" });
    return () => {
      delete window.zeroluxDesktopState;
    };
  }, []);
  useEffect(() => {
    // A window asks to change its connection; an address being edited or a choice in
    // progress stays.
    const busy = panel && panel.kind !== "edit";
    window.zeroluxDesktopFocus = (id) => {
      const profile = state.profiles.find((one) => one.id === id);
      if (!busy && profile?.source.kind === "existing")
        show({ kind: "edit", id });
    };
    return () => {
      delete window.zeroluxDesktopFocus;
    };
  }, [state.profiles, panel]);

  const cancel = () => setPanel(null);
  return (
    <main className="grid min-h-dvh grid-cols-[19rem_minmax(0,1fr)] max-sm:grid-cols-1">
      <aside className="flex flex-col gap-6 border-r bg-sidebar p-6 max-sm:border-r-0 max-sm:border-b">
        <div className="flex flex-col gap-3">
          <Mark className="size-8" />
          <h1 className="text-lg font-semibold tracking-tight">
            Welcome to ZeroLux
          </h1>
        </div>
        <nav aria-label="Add a workspace" className="-mx-3 flex flex-col">
          <Choice
            icon={<PlusIcon />}
            label="New Workspace…"
            keys={keyLabel("CmdOrCtrl+Shift+N")}
            disabled={disabled}
            onClick={() => void done({ action: "new_workspace" })}
          />
          <Choice
            icon={<MonitorSmartphoneIcon />}
            label="Connect to Another Computer…"
            disabled={disabled}
            onClick={() => show({ kind: "connect" })}
          />
        </nav>
        <div className="mt-auto flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="font-mono text-[10.5px] tracking-widest uppercase">
            This computer
          </span>
          {state.kernel.network && (
            <span className="font-mono break-all text-foreground">
              {networkAddress(state.kernel.network)}
            </span>
          )}
          <span className="flex gap-3">
            {state.kernel.network && (
              <button
                type="button"
                disabled={disabled}
                className="underline-offset-2 hover:underline"
                onClick={() => show({ kind: "network" })}
              >
                Network…
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              className="underline-offset-2 hover:underline"
              onClick={() => show({ kind: "join" })}
            >
              Join a workspace…
            </button>
          </span>
        </div>
      </aside>
      <section className="flex min-w-0 flex-col gap-4 overflow-y-auto p-6">
        <div aria-live="polite">
          {!state.ready && !state.error && (
            <p role="status" className="text-sm text-muted-foreground">
              Opening workspaces…
            </p>
          )}
          {state.error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm break-words whitespace-pre-wrap text-destructive"
            >
              {state.error}
            </p>
          )}
        </div>
        {panel?.kind === "connect" ? (
          <Connect
            disabled={disabled}
            cancel={cancel}
            connect={(url) => done({ action: "add", url })}
          />
        ) : panel?.kind === "join" ? (
          <Joined state={state} disabled={disabled} act={act} cancel={cancel} />
        ) : panel?.kind === "network" && state.kernel.network ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Network</h2>
            <NetworkForm
              id="kernel"
              network={state.kernel.network}
              disabled={disabled}
              cancel={cancel}
              save={async (network) => {
                await done({ action: "network", network });
              }}
            />
          </div>
        ) : panel?.kind === "edit" && shown ? (
          <form
            aria-label={`Address of ${shown.name}`}
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!disabled)
                await done({ action: "edit", id: shown.id, url: address });
            }}
          >
            <h2 className="text-base font-semibold">{shown.name}</h2>
            <Label htmlFor="edit-address">Address</Label>
            <Input
              id="edit-address"
              type="url"
              required
              disabled={disabled}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={disabled || !address.trim()}>
                Save address
              </Button>
              <Button type="button" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </form>
        ) : panel?.kind === "adopt" && shown ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">{shown.name}</h2>
            <AdoptionForm
              id={shown.id}
              disabled={disabled}
              busy={setPreviewing}
              cancel={cancel}
              adopt={async (directory) => {
                await done({ action: "adopt", id: shown.id, directory });
              }}
            />
          </div>
        ) : panel?.kind === "remove" && shown ? (
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Remove {shown.name}?</h2>
            <p className="text-sm text-muted-foreground">
              {shown.source.kind === "local"
                ? "Its workspaces and files stay where they are."
                : "Its workspaces stay on their computer."}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => void done({ action: "forget", id: shown.id })}
              >
                Remove
              </Button>
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <section
            aria-label="Recent workspaces"
            className="flex flex-col gap-2"
          >
            <h2 className="px-2 font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">
              Recent
            </h2>
            {state.ready && state.profiles.length === 0 && (
              <p className="px-2 text-sm text-muted-foreground">
                No workspaces yet.
              </p>
            )}
            <ul className="flex flex-col">
              {state.profiles.map((profile) => (
                <Recent
                  key={profile.id}
                  profile={profile}
                  active={state.active === profile.id}
                  disabled={disabled}
                  canAdopt={
                    !state.profiles.some((one) => one.source.kind === "local")
                  }
                  act={act}
                  show={show}
                />
              ))}
            </ul>
          </section>
        )}
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
