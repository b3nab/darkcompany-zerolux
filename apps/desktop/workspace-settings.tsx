import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Button } from "../web/src/components/ui/button";
import { Input } from "../web/src/components/ui/input";
import { Label } from "../web/src/components/ui/label";

export type Network = {
  listen: string;
  port: number;
  expose: string | null;
  publicOrigin: string | null;
  publicLivekitUrl: string | null;
};
export type AdoptionPreview = {
  id: string;
  directory: string;
  database: string;
  workspaceId: string;
  workspaceName: string;
  hostId: string;
  version: string;
  schema: string;
  network: Network;
  externalLivekit: boolean;
};

export function networkAddress(network: Network) {
  if (network.publicOrigin) return network.publicOrigin;
  const host = network.expose ?? network.listen;
  return `http://${host.includes(":") ? `[${host}]` : host}:${network.port}`;
}

export function AdoptionForm({
  id,
  disabled,
  busy,
  adopt,
  cancel,
}: {
  id: string;
  disabled: boolean;
  busy: (value: boolean) => void;
  adopt: (directory: string) => Promise<void>;
  cancel: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [preview, setPreview] = useState<AdoptionPreview | null>(null);
  const [error, setError] = useState("");
  async function choose() {
    if (disabled) return;
    busy(true);
    setError("");
    try {
      const selected = await invoke<string | null>("choose_folder", {
        start: directory || null,
      });
      if (!selected) return;
      setDirectory(selected);
      setPreview(null);
      setPreview(
        await invoke<AdoptionPreview>("workspace_adoption_preview", {
          id,
          directory: selected,
        }),
      );
    } catch (error) {
      setError(String(error));
    } finally {
      busy(false);
    }
  }
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm text-muted-foreground">
        Choose this workspace’s folder on this computer. Its files stay in
        place.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`adopt-${id}`}>Workspace folder</Label>
        <div className="flex gap-2">
          <Input id={`adopt-${id}`} value={directory} readOnly />
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void choose()}
          >
            Browse…
          </Button>
        </div>
      </div>
      {preview && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{preview.workspaceName}</p>
          <p className="break-all text-xs text-muted-foreground">
            {preview.workspaceId}
          </p>
          <p className="break-all text-muted-foreground">
            {networkAddress(preview.network)}
          </p>
          {preview.externalLivekit && (
            <p className="text-muted-foreground">
              Uses your existing call server.
            </p>
          )}
          <p className="text-muted-foreground">
            The workspace will restart. Keep ZeroLux open to use it from your
            other devices.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={disabled || !preview}
          onClick={() => preview && void adopt(preview.directory)}
        >
          Run with this app
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type NetworkFields = {
  port: string;
  expose: string;
  publicOrigin: string;
  publicLivekitUrl: string;
};

/** Keep the kernel's listen address; optional empty fields explicitly remove their setting. */
export function networkSettings(
  listen: string,
  fields: NetworkFields,
): Network {
  const port = fields.port.trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Choose a port between 1 and 65535.");
  return {
    listen,
    port: Number(port),
    expose: fields.expose.trim() || null,
    publicOrigin: fields.publicOrigin.trim() || null,
    publicLivekitUrl: fields.publicLivekitUrl.trim() || null,
  };
}

export function NetworkForm({
  id,
  network,
  disabled,
  save,
  cancel,
}: {
  id: string;
  network: Network;
  disabled: boolean;
  save: (network: Network) => Promise<void>;
  cancel: () => void;
}) {
  const [fields, setFields] = useState<NetworkFields>({
    port: network.port ? String(network.port) : "",
    expose: network.expose ?? "",
    publicOrigin: network.publicOrigin ?? "",
    publicLivekitUrl: network.publicLivekitUrl ?? "",
  });
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-3 border-t pt-3"
      aria-label="Workspace network"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled) return;
        setError("");
        try {
          await save(networkSettings(network.listen, fields));
        } catch (error) {
          setError(String(error));
        }
      }}
    >
      <p className="text-xs text-muted-foreground">
        Local address: {network.listen}
      </p>
      {(
        [
          ["port", "Port", "number", "4310"],
          ["expose", "Private network IP · optional", "text", "192.0.2.10"],
          [
            "publicOrigin",
            "Public web address · optional",
            "url",
            "https://workspace.example",
          ],
          [
            "publicLivekitUrl",
            "Public call address · optional",
            "url",
            "wss://calls.example",
          ],
        ] as const
      ).map(([field, label, type, placeholder]) => (
        <div key={field} className="space-y-2">
          <Label htmlFor={`${id}-${field}`}>{label}</Label>
          <Input
            id={`${id}-${field}`}
            type={type}
            value={fields[field]}
            disabled={disabled}
            placeholder={placeholder}
            required={field === "port"}
            {...(field === "port" ? { min: 1, max: 65535, step: 1 } : {})}
            onChange={(event) =>
              setFields({ ...fields, [field]: event.target.value })
            }
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Other devices use the private network IP. Leave it empty for access only
        on this computer.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={disabled}>
          Apply and restart
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={cancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
