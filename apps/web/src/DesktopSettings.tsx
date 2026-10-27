import { useEffect, useSyncExternalStore } from "react";
import { errorMessage } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { desktopConnection } from "./desktop";

export type AutostartStatus = { enabled: boolean; supported: boolean };
type Snapshot = {
  state?: AutostartStatus;
  pending: boolean;
  error?: string;
};
const empty: Snapshot = { pending: false };

/** The operating system confirms the setting; a failed change keeps its previous value. */
export function autostartSettings(
  invoke: (
    command: "autostart_status" | "autostart_set",
    args?: { enabled: boolean },
  ) => Promise<AutostartStatus>,
) {
  let value = empty;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async change(enabled?: boolean) {
      if (value.pending || (enabled !== undefined && !value.state?.supported))
        return;
      publish({ state: value.state, pending: true });
      try {
        const state = await invoke(
          enabled === undefined ? "autostart_status" : "autostart_set",
          enabled === undefined ? undefined : { enabled },
        );
        publish({ state, pending: false });
      } catch (error) {
        publish({ ...value, pending: false, error: errorMessage(error) });
      }
    },
  };
}

const native = autostartSettings(async (command, args) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AutostartStatus>(command, args);
});
const nothing = () => () => {};

export function DesktopSettings() {
  const desktop = !!desktopConnection();
  const snapshot = useSyncExternalStore(
    desktop ? native.subscribe : nothing,
    native.snapshot,
    () => empty,
  );
  useEffect(() => {
    if (!desktop) return;
    const refresh = () => void native.change();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [desktop]);
  if (!desktop) return null;
  return <AutostartControl {...snapshot} change={native.change} />;
}

export function AutostartControl({
  state,
  pending,
  error,
  change,
}: Snapshot & { change: (enabled?: boolean) => Promise<void> }) {
  return (
    <section
      aria-label="Desktop"
      className="flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <h2 className="text-base font-semibold">Desktop</h2>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="desktop-autostart">Open at login</Label>
        <Switch
          id="desktop-autostart"
          checked={state?.enabled ?? false}
          disabled={pending || !state?.supported}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </div>
      {state && !state.supported && (
        <p className="text-sm text-muted-foreground">
          Not available on this computer.
        </p>
      )}
      {!state && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void change()}
          >
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
