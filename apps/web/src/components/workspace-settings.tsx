import { useState } from "react";
import { creationDateLabel } from "@zerolux/chat";
import type { WorkspaceInfo } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspaceSettings({
  workspace,
  busy,
  error,
  save,
}: {
  workspace: WorkspaceInfo;
  busy: boolean;
  error: string;
  save: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  return (
    <form
      aria-label="Workspace settings"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && name.trim()) void save(name.trim());
      }}
    >
      <p className="text-sm text-muted-foreground">
        {creationDateLabel(workspace)}
      </p>
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
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? "Saving…" : "Save name"}
      </Button>
    </form>
  );
}
