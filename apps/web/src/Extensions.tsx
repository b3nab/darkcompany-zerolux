import { useState } from "react";
import {
  disableExtension,
  enableExtension,
  errorMessage,
  loadExtensionFolder,
  removeExtension,
  runAction,
  setExtensionSettings,
  useExtensions,
} from "@zerolux/chat";
import type {
  Extension,
  ExtensionAction,
  ExtensionSetting,
  JsonSchema,
  Perform,
} from "@zerolux/chat";
import { Section, Settings } from "./Account";
import { ActionForm } from "./ActionForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const parts: Record<string, string> = {
  kernel: "Kernel module",
  process: "Process",
  remote: "Remote",
};

/** Whether it runs, and if not, why. */
function State({ extension }: { extension: Extension }) {
  if (extension.error) return <Badge variant="destructive">Error</Badge>;
  if (!extension.enabled) return <Badge variant="secondary">Disabled</Badge>;
  return extension.running ? (
    <Badge className="bg-human/10 text-human-foreground">Running</Badge>
  ) : (
    <Badge variant="outline">Starting again</Badge>
  );
}

/** Its settings as an action's input: a secret is never shown, only replaced or forgotten. */
const settingsSchema = (settings: ExtensionSetting[]): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(
    settings.map((setting) => [
      setting.key,
      {
        type:
          setting.type === "number" || setting.type === "boolean"
            ? setting.type
            : "string",
        format: setting.type === "secret" ? "password" : undefined,
        title: setting.label,
        description:
          [
            setting.description,
            setting.type === "secret" && setting.set
              ? "Saved: type a new one to replace it."
              : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined,
      },
    ]),
  ),
});

/** What the form gives, as changes: an emptied setting is cleared, an empty secret kept. */
export const settingChanges = (
  settings: ExtensionSetting[],
  input: Record<string, unknown>,
) =>
  Object.fromEntries(
    settings.flatMap((setting) =>
      setting.type === "secret"
        ? setting.key in input
          ? [[setting.key, input[setting.key]]]
          : []
        : [[setting.key, input[setting.key] ?? null]],
    ),
  );

function SettingsDialog({
  extension,
  close,
  busy,
  perform,
}: {
  extension: Extension;
  close: () => void;
  busy: boolean;
  perform: Perform;
}) {
  const settings = extension.settings;
  const saved = settings.filter((s) => s.type === "secret" && s.set);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{extension.name} settings</DialogTitle>
          <DialogDescription>
            Secrets stay in the kernel: the extension uses them, and nobody sees
            them again.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          schema={settingsSchema(settings)}
          value={Object.fromEntries(
            settings.flatMap((s) =>
              s.type !== "secret" && s.value != null ? [[s.key, s.value]] : [],
            ),
          )}
          submit="Save"
          busy={busy}
          run={(input) =>
            void perform(async () => {
              await setExtensionSettings(
                extension.id,
                settingChanges(settings, input),
              );
            }).then((done) => done && close())
          }
        />
        {saved.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t pt-3">
            {saved.map((secret) => (
              <Button
                key={secret.key}
                variant="link"
                size="sm"
                className="h-auto p-0 text-destructive"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await setExtensionSettings(extension.id, {
                      [secret.key]: null,
                    });
                  })
                }
              >
                Forget {secret.label}
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** An action run by hand: its input as a form, and what it gave back. */
export function ActionDialog({
  action,
  close,
}: {
  action: ExtensionAction;
  close: () => void;
}) {
  const [run, setRun] = useState<{
    busy?: boolean;
    result?: unknown;
    error?: string;
  }>({});
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          <DialogDescription>
            {action.description}
            {action.effects === "destructive" &&
              " It deletes or overwrites data."}
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          schema={action.input as JsonSchema}
          submit={action.title}
          busy={run.busy === true}
          run={(input) => {
            setRun({ busy: true });
            runAction(action.extension, action.name, input).then(
              (result) => setRun({ result }),
              (failed: unknown) => setRun({ error: errorMessage(failed) }),
            );
          }}
        />
        {run.error && (
          <p role="alert" className="text-sm text-destructive">
            {run.error}
          </p>
        )}
        {"result" in run && (
          <pre className="max-h-64 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[12px]">
            {JSON.stringify(run.result, null, 2) ?? "Done"}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  extension,
  close,
  busy,
  perform,
}: {
  extension: Extension;
  close: () => void;
  busy: boolean;
  perform: Perform;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {extension.name}?</DialogTitle>
          <DialogDescription>
            Its settings, secrets and stored values go with it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await removeExtension(extension.id);
              }).then((done) => done && close())
            }
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A dialog open on an extension, which follows the list as it is read again. */
type Open =
  | { kind: "settings" | "remove"; id: string }
  | { kind: "action"; action: ExtensionAction };

function ExtensionItem({
  extension,
  owns,
  busy,
  perform,
  open,
}: {
  extension: Extension;
  owns: boolean;
  busy: boolean;
  perform: Perform;
  open: (open: Open) => void;
}) {
  const actions = extension.contributes?.actions ?? [];
  const needs = Object.entries(extension.dependencies);
  const act = (operation: () => Promise<unknown>) =>
    void perform(async () => {
      await operation();
    });
  return (
    <li
      aria-label={extension.name}
      className="flex flex-col gap-3 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{extension.name}</h2>
        <span className="font-mono text-[11px] text-faint">
          {extension.version} · {extension.publisher}
        </span>
        <State extension={extension} />
        {extension.dev && <Badge variant="outline">Development</Badge>}
      </div>
      {extension.description && (
        <p className="text-sm text-muted-foreground">{extension.description}</p>
      )}
      {extension.error && (
        <p role="alert" className="text-sm text-destructive">
          {extension.error}
        </p>
      )}
      <p className="font-mono text-[11px] text-faint">
        {[
          extension.parts.map((part) => parts[part] ?? part).join(" · "),
          needs.length
            ? `Needs ${needs.map(([id, version]) => `${id} ${version}`).join(", ")}`
            : "",
          extension.dev ? extension.source : "",
        ]
          .filter(Boolean)
          .join(" — ")}
      </p>
      {actions.length > 0 && (
        <ul aria-label="Actions" className="flex flex-col divide-y border-t">
          {actions.map((action) => (
            <li key={action.name} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{action.title}</p>
                <p className="text-xs text-muted-foreground">
                  {action.description}
                </p>
              </div>
              {action.effects !== "read" && (
                <span
                  className={
                    action.effects === "destructive"
                      ? "font-mono text-[11px] text-destructive"
                      : "font-mono text-[11px] text-faint"
                  }
                >
                  {action.effects === "destructive" ? "Destructive" : "Writes"}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!extension.enabled}
                onClick={() =>
                  open({
                    kind: "action",
                    action: { ...action, extension: extension.id },
                  })
                }
              >
                Run
              </Button>
            </li>
          ))}
        </ul>
      )}
      {owns && (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          {extension.enabled ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => disableExtension(extension.id))}
            >
              Disable
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => act(() => enableExtension(extension.id))}
            >
              Enable
            </Button>
          )}
          {extension.settings.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => open({ kind: "settings", id: extension.id })}
            >
              Settings
            </Button>
          )}
          {extension.dev && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => loadExtensionFolder(extension.source))}
            >
              Load again
            </Button>
          )}
          {!extension.enabled && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => open({ kind: "remove", id: extension.id })}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** An extension being written, from a folder on the kernel's computer. */
function LoadFolder({ busy, perform }: { busy: boolean; perform: Perform }) {
  const [folder, setFolder] = useState("");
  return (
    <Section title="Load from a folder">
      <p className="text-sm text-muted-foreground">
        For an extension you are writing: the folder with its
        zerolux-extension.toml, on the computer the kernel runs on. Load it
        again after each change.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const path = folder.trim();
          if (path)
            void perform(async () => {
              await loadExtensionFolder(path);
            }).then((done) => done && setFolder(""));
        }}
      >
        <Input
          aria-label="Folder"
          placeholder="/path/to/extension"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          className="font-mono text-[12.5px]"
        />
        <Button type="submit" disabled={busy || !folder.trim()}>
          Load
        </Button>
      </form>
    </Section>
  );
}

/** The workspace's extensions: what each brings and whether it runs, its actions to run by hand, and for the owner enabling, settings and loading one being written. */
export function ExtensionList({
  extensions,
  error,
  owns,
  busy,
  perform,
}: {
  extensions: Extension[] | undefined;
  error: string;
  owns: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const [shown, setShown] = useState<Open>();
  const close = () => setShown(undefined);
  const opened =
    shown && "id" in shown
      ? extensions?.find((extension) => extension.id === shown.id)
      : undefined;
  return (
    <Settings eyebrow="Workspace" title="Extensions">
      <p className="-mt-3 text-sm text-muted-foreground">
        Extensions add actions, data and pages to ZeroLux. Each action is the
        same for people and agents.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {extensions?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No extensions in this workspace yet.
        </p>
      )}
      {!!extensions?.length && (
        <ul className="flex flex-col gap-4">
          {extensions.map((extension) => (
            <ExtensionItem
              key={extension.id}
              extension={extension}
              owns={owns}
              busy={busy}
              perform={perform}
              open={setShown}
            />
          ))}
        </ul>
      )}
      {owns && <LoadFolder busy={busy} perform={perform} />}
      {shown?.kind === "action" && (
        <ActionDialog action={shown.action} close={close} />
      )}
      {shown?.kind === "settings" && opened && (
        <SettingsDialog
          extension={opened}
          close={close}
          busy={busy}
          perform={perform}
        />
      )}
      {shown?.kind === "remove" && opened && (
        <RemoveDialog
          extension={opened}
          close={close}
          busy={busy}
          perform={perform}
        />
      )}
    </Settings>
  );
}

export function ExtensionsPage({
  owns,
  busy,
  perform,
}: {
  owns: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const { extensions, error, reload } = useExtensions();
  // The list is read again after each change made here, done or refused, besides the
  // kernel's notices of changes made anywhere.
  const act: Perform = (operation) =>
    perform(operation).finally(() => void reload());
  return (
    <ExtensionList
      extensions={extensions}
      error={error}
      owns={owns}
      busy={busy}
      perform={act}
    />
  );
}
