import {
  ArrowDownToLineIcon,
  LoaderCircleIcon,
  RotateCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useUpdates, updateOffered, updating } from "./update-state";
import type { BuildInfo, UpdateChannel } from "./update-state";

type Updates = ReturnType<typeof useUpdates>;
const channels: [UpdateChannel, string][] = [
  ["nightly", "Nightly"],
  ["beta", "Beta / RC"],
  ["stable", "Stable"],
];

/** The desktop app's update, regardless of which kernel its window is connected to. */
export function UpdateButton() {
  const update = useUpdates();
  return <UpdateControl update={update} />;
}

export function UpdateControl({ update }: { update: Updates }) {
  if (!update.desktop || !updateOffered(update.state)) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="mr-1 border-human/30 text-human-foreground"
          />
        }
      >
        {updating(update.state) ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <ArrowDownToLineIcon />
        )}
        Update
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 max-w-[calc(100vw-2rem)]">
        <h2 className="font-semibold">ZeroLux desktop</h2>
        <UpdateDetails update={update} />
      </PopoverContent>
    </Popover>
  );
}

/** The tray consumes the same host state and offers the same installation action. */
export function TrayUpdate() {
  const update = useUpdates();
  if (!updateOffered(update.state)) return null;
  return (
    <div className="mx-2 mb-1.5 rounded-lg border bg-card px-3 py-2.5">
      <UpdateDetails update={update} compact />
    </div>
  );
}

/** Always reachable, including before an update is available or after a failed check. */
export function UpdateSettings() {
  const update = useUpdates();
  if (!update.desktop) return null;
  return (
    <section
      aria-label="Desktop updates"
      className="flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <h2 className="text-base font-semibold">Desktop updates</h2>
      <UpdateDetails update={update} />
    </section>
  );
}

function Build({ build }: { build: BuildInfo }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
      {build.commit && (
        <span className="font-mono" title={build.commit}>
          {build.commit.slice(0, 8)}
        </span>
      )}
      {build.built_at && (
        <time dateTime={build.built_at}>
          {new Date(build.built_at).toLocaleString()}
        </time>
      )}
      {build.dirty && <span>Local changes</span>}
    </div>
  );
}

export function UpdateDetails({
  update,
  compact = false,
}: {
  update: Updates;
  compact?: boolean;
}) {
  const { state, error, pending, act } = update;
  const busy = pending || updating(state);
  if (!state)
    return (
      <div className="flex flex-col gap-2">
        <p
          role={error ? "alert" : "status"}
          className={
            error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {error || "Loading…"}
        </p>
        {error && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void act("update_check")}
          >
            Try again
          </Button>
        )}
      </div>
    );
  const action =
    state.phase === "ready"
      ? "update_install"
      : state.available
        ? "update_download"
        : "update_check";
  const label =
    state.phase === "installing"
      ? "Restarting…"
      : state.phase === "downloading"
        ? "Downloading…"
        : state.phase === "checking"
          ? "Checking…"
          : state.phase === "ready"
            ? "Restart and update"
            : state.available
              ? "Download update"
              : "Check for updates";
  const failure = error || state.error;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Installed{" "}
          <span className="font-mono break-all text-foreground">
            {state.current.version}
          </span>
        </span>
        {!compact && <Build build={state.current} />}
        {state.available && (
          <span className="text-xs text-muted-foreground">
            Available{" "}
            <span className="font-mono break-all text-foreground">
              {state.available.version}
            </span>
          </span>
        )}
      </div>
      {!compact && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Update channel
          </span>
          <div
            role="radiogroup"
            aria-label="Update channel"
            className="flex flex-wrap gap-1.5"
          >
            {channels.map(([channel, name]) => (
              <Button
                key={channel}
                role="radio"
                aria-checked={state.channel === channel}
                variant={state.channel === channel ? "default" : "outline"}
                size="sm"
                disabled={busy}
                onClick={() => void act("update_channel", channel)}
              >
                {name}
              </Button>
            ))}
          </div>
        </div>
      )}
      {state.phase === "downloading" && (
        <progress
          aria-label="Update download"
          className="h-1.5 w-full accent-primary"
          {...(state.total && state.downloaded !== undefined
            ? { value: state.downloaded, max: state.total }
            : {})}
        />
      )}
      {state.phase === "idle" && state.checkedAt && !failure && (
        <p role="status" className="text-xs text-muted-foreground">
          Up to date
        </p>
      )}
      {!compact && state.available?.notes && (
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {state.available.notes}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act(action)}>
          {busy ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : state.phase === "ready" ? (
            <RotateCwIcon />
          ) : state.available ? (
            <ArrowDownToLineIcon />
          ) : null}
          {label}
        </Button>
        {!compact && state.available && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act("update_check")}
          >
            Check again
          </Button>
        )}
      </div>
    </div>
  );
}
