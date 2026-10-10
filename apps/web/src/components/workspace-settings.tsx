import { useState } from "react";
import { GlobeIcon } from "lucide-react";
import { creationDateLabel } from "@zerolux/chat";
import type { WorkspaceInfo } from "@zerolux/chat";
import { desktopConnection, WORKSPACES_LINK } from "@/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Address locality is not server ownership, nor an online/offline assertion. */
export function connectionKind(address: string, managed = false) {
  if (managed) return "Managed on this device";
  try {
    const host = new URL(address).hostname;
    return host === "localhost" || host === "[::1]" || /^127\./.test(host)
      ? "Local address · existing kernel"
      : "Network address · existing kernel";
  } catch {
    return "Existing kernel";
  }
}

export function WorkspaceSettings({
  workspace,
  busy,
  error,
  save,
  connection = {
    address: globalThis.location?.origin ?? "",
    desktop: Boolean(desktopConnection()),
    managed: desktopConnection()?.managed,
  },
}: {
  workspace: WorkspaceInfo;
  busy: boolean;
  error: string;
  save: (name: string) => Promise<void>;
  connection?: { address: string; desktop: boolean; managed?: boolean };
}) {
  const [name, setName] = useState(workspace.name);
  const changed = name.trim() !== workspace.name;
  return (
    <section aria-label="Workspace settings" className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && changed && name.trim()) void save(name.trim());
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="workspace-name">Workspace name</Label>
          <Input
            id="workspace-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            disabled={busy}
            required
            aria-describedby="workspace-name-help"
          />
          <p id="workspace-name-help" className="text-sm text-muted-foreground">
            Shared with everyone in this workspace. Renaming keeps its history
            and identity.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="self-start"
          disabled={busy || !changed || !name.trim()}
        >
          {busy ? "Saving…" : "Save name"}
        </Button>
      </form>
      {connection.address && (
        <div className="flex flex-col gap-3 border-t pt-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <GlobeIcon className="size-4 text-muted-foreground" aria-hidden />
            Connection
          </div>
          <p className="text-sm text-muted-foreground">
            {connectionKind(connection.address, connection.managed)}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-address">Kernel address</Label>
            <Input
              id="workspace-address"
              value={connection.address}
              readOnly
              className="font-mono text-xs"
              aria-describedby="workspace-address-help"
            />
            <p
              id="workspace-address-help"
              className="text-sm text-muted-foreground"
            >
              {connection.desktop
                ? "This device's connection, not the workspace's name. Manage connections to change the address or open another workspace."
                : "This browser connects to the server at this address. Open another server's address to use a different workspace."}
            </p>
          </div>
          {connection.desktop && (
            <Button
              variant="outline"
              className="self-start"
              render={<a href={WORKSPACES_LINK} />}
            >
              Manage connections
            </Button>
          )}
        </div>
      )}
      <p className="border-t pt-4 text-xs text-muted-foreground">
        {creationDateLabel(workspace)}
      </p>
    </section>
  );
}
