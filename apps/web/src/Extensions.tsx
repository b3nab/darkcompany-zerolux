import { useState } from "react";
import {
  disableExtension,
  enableExtension,
  errorMessage,
  installExtension,
  installOffer,
  loadExtensionFolder,
  offerAction,
  offerWarning,
  removeExtension,
  runAction,
  setExtensionSettings,
  useExtensions,
  useMarketplace,
  useOfficialExtensions,
} from "@zerolux/chat";
import type {
  Extension,
  ExtensionAction,
  ExtensionSetting,
  JsonSchema,
  Marketplace,
  OfficialExtension,
  Perform,
} from "@zerolux/chat";
import { Section, Settings } from "./Account";
import { ActionForm } from "./ActionForm";
import { ConfirmButton } from "./extension-view";
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
  interface: "Interface",
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
    <Badge variant="outline">Restarting</Badge>
  );
}

/**
 * Its settings as an action's input: a secret is never shown, only replaced or forgotten; a
 * choice offers its values by their labels.
 */
export const settingsSchema = (settings: ExtensionSetting[]): JsonSchema => ({
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
        oneOf:
          setting.type === "choice"
            ? (setting.options ?? []).map((option) => ({
                const: option.value,
                title: option.label,
              }))
            : undefined,
        title: setting.label,
        description:
          [
            setting.description,
            setting.type === "secret" && setting.set ? "Saved" : "",
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
  // A destructive action runs only once its input is confirmed.
  const [confirm, setConfirm] = useState<Record<string, unknown>>();
  const start = (input: Record<string, unknown>) => {
    setConfirm(undefined);
    setRun({ busy: true });
    runAction(action.extension, action.name, input).then(
      (result) => setRun({ result }),
      (failed: unknown) => setRun({ error: errorMessage(failed) }),
    );
  };
  // An action that may run longer than a minute says so, and shows it is still running.
  const minutes = Math.ceil((action.seconds ?? 0) / 60);
  const long = minutes > 1 ? `${minutes} minutes` : "";
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          {action.description && (
            <DialogDescription>{action.description}</DialogDescription>
          )}
        </DialogHeader>
        <ActionForm
          schema={action.input as JsonSchema}
          submit={action.title}
          busy={run.busy === true}
          run={(input) =>
            action.effects === "destructive" ? setConfirm(input) : start(input)
          }
        />
        {confirm && (
          <div
            role="alertdialog"
            aria-label="Confirm"
            className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-3"
          >
            <p className="flex-1 text-sm">
              Run {action.title}? It deletes or overwrites data.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirm(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => start(confirm)}
            >
              {action.title}
            </Button>
          </div>
        )}
        {run.busy && long && (
          <p role="status" className="text-sm text-muted-foreground">
            Running…
          </p>
        )}
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
            Its settings, secrets and stored values are deleted.
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
        {extension.dev && <Badge variant="outline">In development</Badge>}
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

/**
 * The official extensions ZeroLux brings that are not installed yet, installed in one press.
 * The first start of one can take a while: the press waits on its own, the page does not.
 */
function Available({
  official,
  owns,
  installed,
}: {
  official: OfficialExtension[];
  owns: boolean;
  installed: () => void;
}) {
  const [installing, setInstalling] = useState<string>();
  const [error, setError] = useState("");
  const offered = official.filter((extension) => !extension.installed);
  if (!offered.length) return null;
  return (
    <Section title="Available">
      <ul className="flex flex-col divide-y">
        {offered.map((extension) => (
          <li key={extension.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {extension.name}{" "}
                <span className="font-mono text-[11px] font-normal text-faint">
                  {extension.version}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {extension.description}
              </p>
            </div>
            {owns && (
              <Button
                size="sm"
                disabled={installing !== undefined}
                onClick={() => {
                  setInstalling(extension.id);
                  setError("");
                  installExtension(extension.id)
                    .catch((failed: unknown) => setError(errorMessage(failed)))
                    .finally(() => {
                      setInstalling(undefined);
                      installed();
                    });
                }}
              >
                {installing === extension.id ? "Installing…" : "Install"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
  );
}

/**
 * What the indexes offer, installed or updated by the owner in one press, and the indexes that
 * could not be read. Code that runs inside the kernel says so, and who signed it, before it
 * installs.
 */
function MarketplaceSection({
  marketplace,
  error,
  owns,
  installed,
}: {
  marketplace?: Marketplace;
  error: string;
  owns: boolean;
  installed: () => void;
}) {
  const [installing, setInstalling] = useState<string>();
  const [failed, setFailed] = useState("");
  const offers = marketplace?.offers ?? [];
  const errors = marketplace?.errors ?? [];
  if (!offers.length && !errors.length && !error) return null;
  return (
    <Section title="Marketplace">
      {!!offers.length && (
        <ul className="flex flex-col divide-y">
          {offers.map((offer) => {
            const action = offerAction(offer);
            const key = `${offer.index} ${offer.id}`;
            return (
              <li key={key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {offer.name}{" "}
                    <span className="font-mono text-[11px] font-normal text-faint">
                      {action === "update"
                        ? `${offer.installed} → ${offer.version}`
                        : offer.version}{" "}
                      · {offer.publisher}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {offer.description}
                  </p>
                  {offer.parts && (
                    <p className="font-mono text-[11px] text-faint">
                      {offer.parts
                        .map((part) => parts[part] ?? part)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                {action === "installed" ? (
                  <Badge variant="outline">Installed</Badge>
                ) : (
                  owns && (
                    <ConfirmButton
                      title={
                        installing === key
                          ? "Installing…"
                          : action === "update"
                            ? "Update"
                            : "Install"
                      }
                      tone="primary"
                      confirm={offerWarning(offer)}
                      busy={installing !== undefined}
                      go={() => {
                        setInstalling(key);
                        setFailed("");
                        installOffer(offer)
                          .catch((problem: unknown) =>
                            setFailed(errorMessage(problem)),
                          )
                          .finally(() => {
                            setInstalling(undefined);
                            installed();
                          });
                      }}
                    />
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {errors.map((unread) => (
        <p key={unread.index} className="text-xs text-destructive">
          {unread.error}
        </p>
      ))}
      {(failed || error) && (
        <p role="alert" className="text-sm text-destructive">
          {failed || error}
        </p>
      )}
    </Section>
  );
}

/** An extension being written, from a folder on the kernel's computer. */
function LoadFolder({ busy, perform }: { busy: boolean; perform: Perform }) {
  const [folder, setFolder] = useState("");
  return (
    <Section title="Load from a folder">
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
  official = [],
  marketplace,
  marketplaceError = "",
  installed = () => {},
  error,
  owns,
  busy,
  perform,
}: {
  extensions: Extension[] | undefined;
  /** The official extensions this kernel brings. */
  official?: OfficialExtension[];
  /** What the indexes offer. */
  marketplace?: Marketplace;
  marketplaceError?: string;
  /** One of them was installed, or failed to be. */
  installed?: () => void;
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
      {error && <p className="text-sm text-destructive">{error}</p>}
      {extensions?.length === 0 && (
        <p className="text-sm text-muted-foreground">No extensions.</p>
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
      <Available official={official} owns={owns} installed={installed} />
      <MarketplaceSection
        marketplace={marketplace}
        error={marketplaceError}
        owns={owns}
        installed={installed}
      />
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
  const { official, reload: reloadOfficial } = useOfficialExtensions();
  const {
    marketplace,
    error: marketplaceError,
    reload: reloadMarketplace,
  } = useMarketplace();
  // The list is read again after each change made here, done or refused, besides the
  // kernel's notices of changes made anywhere.
  const act: Perform = (operation) =>
    perform(operation).finally(() => void reload());
  return (
    <ExtensionList
      extensions={extensions}
      official={official}
      marketplace={marketplace}
      marketplaceError={marketplaceError}
      installed={() => {
        void reload();
        void reloadOfficial();
        void reloadMarketplace();
      }}
      error={error}
      owns={owns}
      busy={busy}
      perform={act}
    />
  );
}
