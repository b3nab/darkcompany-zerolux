import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowUpCircleIcon,
  ChevronRightIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  PencilIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ago,
  disableExtension,
  enableExtension,
  errorMessage,
  loadExtensionFolder,
  marketplaceName,
  offerAction,
  offerFor,
  offerVersions,
  removeExtension,
  runAction,
  setExtensionSettings,
} from "@zerolux/chat";
import type {
  Extension,
  ExtensionAction,
  ExtensionSetting,
  JsonSchema,
  Marketplace,
  MarketplaceOffer,
  Perform,
  UiSpace,
} from "@zerolux/chat";
import { cn } from "cn";
import { ActionForm } from "./ActionForm";
import {
  ExtensionIcon,
  StateChip,
  partLines,
  partNames,
} from "./extension-bits";
import type { Consent } from "./extension-bits";
import { lucideIcon } from "./native-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const navigate = useNavigate();
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
              }).then((done) => done && navigate("/extensions"))
            }
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const spaces: Record<UiSpace, string> = {
  page: "A page in the bar",
  session: "Beside a session",
  chat: "Beside a chat",
  message: "In a message's menu",
  settings: "In settings",
};

const effects = {
  read: { icon: EyeIcon, mark: "text-muted-foreground" },
  write: { icon: PencilIcon, mark: "border-attention/40 text-attention" },
  destructive: {
    icon: TriangleAlertIcon,
    mark: "border-destructive/40 text-destructive",
  },
};

function Rows({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <ul className="flex flex-col divide-y rounded-lg border text-sm">
        {children}
      </ul>
    </section>
  );
}

/** What it contains, what it can do, where it shows and when it runs by itself. */
function Access({
  extension,
  offer,
}: {
  extension?: Extension;
  offer?: MarketplaceOffer;
}) {
  const [running, setRunning] = useState<ExtensionAction>();
  const parts = extension?.parts ?? offer?.parts ?? [];
  const contributes = extension?.contributes;
  const actions = contributes?.actions ?? [];
  const pieces = contributes?.ui ?? [];
  const triggers = contributes?.triggers ?? [];
  const needs = Object.entries(extension?.dependencies ?? {});
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      {parts.length > 0 && (
        <Rows title="What it contains">
          {parts.map((part) => (
            <li key={part} className="px-3.5 py-2.5">
              {partNames[part] ?? part}
              <span className="block text-xs text-muted-foreground">
                {partLines[part]}
              </span>
            </li>
          ))}
        </Rows>
      )}
      {actions.length > 0 && (
        <Rows title="What it can do">
          {actions.map((action) => {
            const effect = effects[action.effects];
            return (
              <li
                key={action.name}
                className="flex items-center gap-3 px-3.5 py-2.5"
              >
                <effect.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  {action.title}{" "}
                  <span className="font-mono text-[11.5px] text-faint">
                    {action.name}
                  </span>
                  {action.description && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {action.description}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-2 font-mono text-[11px]",
                    effect.mark,
                  )}
                >
                  {action.effects}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!extension?.enabled}
                  onClick={() =>
                    setRunning({ ...action, extension: extension!.id })
                  }
                >
                  Run
                </Button>
              </li>
            );
          })}
        </Rows>
      )}
      {pieces.length > 0 && (
        <Rows title="Where it shows">
          {pieces.map((piece) => {
            const Icon = lucideIcon(piece.icon);
            return (
              <li
                key={`${piece.space}/${piece.name}`}
                className="flex items-center gap-3 px-3.5 py-2.5"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span>
                  {piece.title}{" "}
                  <span className="text-muted-foreground">
                    · {spaces[piece.space]}
                  </span>
                </span>
              </li>
            );
          })}
        </Rows>
      )}
      {triggers.length > 0 && (
        <Rows title="When it runs by itself">
          {triggers.map((trigger) => (
            <li
              key={`${trigger.on} ${trigger.action}`}
              className="px-3.5 py-2.5"
            >
              <span className="font-mono text-[12px]">{trigger.on}</span>
              <span className="text-muted-foreground"> → {trigger.action}</span>
            </li>
          ))}
        </Rows>
      )}
      {needs.length > 0 && (
        <Rows title="What it needs">
          {needs.map(([id, version]) => (
            <li key={id} className="px-3.5 py-2.5 font-mono text-[12.5px]">
              {id} {version}
            </li>
          ))}
        </Rows>
      )}
      {running && (
        <ActionDialog action={running} close={() => setRunning(undefined)} />
      )}
    </div>
  );
}

/** Its settings, in the page: saved together, a secret replaced or forgotten. */
function Settings({
  extension,
  owns,
  busy,
  perform,
}: {
  extension: Extension;
  owns: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const settings = extension.settings;
  const saved = settings.filter((s) => s.type === "secret" && s.set);
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <ActionForm
        schema={settingsSchema(settings)}
        value={Object.fromEntries(
          settings.flatMap((s) =>
            s.type !== "secret" && s.value != null ? [[s.key, s.value]] : [],
          ),
        )}
        submit="Save"
        busy={busy || !owns}
        run={(input) =>
          void perform(async () => {
            await setExtensionSettings(
              extension.id,
              settingChanges(settings, input),
            );
          })
        }
      />
      {owns && saved.length > 0 && (
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
    </div>
  );
}

function Versions({
  extension,
  offer,
}: {
  extension?: Extension;
  offer?: MarketplaceOffer;
}) {
  const update = offer && offerAction(offer) === "update";
  const row = (version: string, label: string, when?: number) => (
    <li className="flex items-center gap-4 py-3.5">
      <span className="w-28 font-mono text-[13px]">{version}</span>
      <span className="rounded-full border px-2 text-[11.5px] text-muted-foreground">
        {label}
      </span>
      {when !== undefined && (
        <span className="text-xs text-faint">{ago(when)}</span>
      )}
    </li>
  );
  return (
    <ul className="flex max-w-2xl flex-col divide-y">
      {update && row(offerVersions(offer), "Available")}
      {extension && row(extension.version, "Installed", extension.updated_at)}
      {!extension && offer && row(offer.version, "Offered")}
    </ul>
  );
}

export type Tab = "overview" | "access" | "settings" | "versions";

/**
 * One extension's page, installed or offered: who made it and where it comes from, the action
 * it waits for, and its overview, access, settings and versions.
 */
export function ExtensionPage({
  id,
  extensions,
  marketplace,
  owns,
  busy,
  perform,
  consent,
  tab: opening = "overview",
}: {
  id: string;
  extensions: Extension[] | undefined;
  marketplace?: Marketplace;
  owns: boolean;
  busy: boolean;
  perform: Perform;
  consent: (consent: Consent) => void;
  /** The tab it opens on. */
  tab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(opening);
  const [removing, setRemoving] = useState(false);
  const extension = extensions?.find((e) => e.id === id);
  const offers = marketplace?.offers ?? [];
  const offer = extension
    ? offerFor(extension, offers)
    : offers.find((o) => o.id === id);
  if (!extension && !offer)
    return extensions ? (
      <p className="text-sm text-muted-foreground">No such extension.</p>
    ) : null;
  const name = extension?.name ?? offer!.name;
  const update = offer && offerAction(offer) === "update";
  const tabs: Tab[] = [
    "overview",
    "access",
    ...(extension?.settings.length ? (["settings"] as const) : []),
    "versions",
  ];
  const shown = tabs.includes(tab) ? tab : "overview";
  const act = (operation: () => Promise<unknown>) =>
    void perform(async () => {
      await operation();
    });
  const primary = !owns ? null : !extension ? (
    <Button onClick={() => consent({ offer: offer! })}>
      <DownloadIcon data-icon="inline-start" />
      Install
    </Button>
  ) : extension.proposed_by ? null : update ? (
    <Button onClick={() => consent({ offer: offer!, installed: extension })}>
      <ArrowUpCircleIcon data-icon="inline-start" />
      Update to {offer!.version}
    </Button>
  ) : !extension.enabled ? (
    <Button
      disabled={busy}
      onClick={() => act(() => enableExtension(extension.id))}
    >
      Enable
    </Button>
  ) : null;
  return (
    <div className="flex flex-col gap-6">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-[12.5px] text-faint"
      >
        <Link
          to="/extensions"
          className="text-muted-foreground hover:text-foreground"
        >
          Extensions
        </Link>
        <ChevronRightIcon className="size-3.5" />
        {!extension && (
          <>
            <Link
              to="/extensions/marketplace"
              className="text-muted-foreground hover:text-foreground"
            >
              Marketplace
            </Link>
            <ChevronRightIcon className="size-3.5" />
          </>
        )}
        <span>{name}</span>
      </nav>
      <header className="grid grid-cols-[auto_1fr_auto] items-start gap-5">
        <ExtensionIcon id={id} extension={extension} size="lg" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex items-baseline gap-2.5 text-2xl font-semibold tracking-tight">
            {name}
            <span className="font-mono text-[13px] font-normal text-faint">
              {extension?.version ?? offer!.version}
            </span>
          </h1>
          <p className="text-[14.5px] text-muted-foreground">
            {extension?.description || offer?.description}
          </p>
          <div className="flex flex-wrap items-center gap-3.5 text-[12.5px] text-muted-foreground">
            <span>{extension?.publisher ?? offer!.publisher}</span>
            <span>
              {extension?.dev
                ? "From a folder"
                : offer
                  ? marketplaceName(offer.index, marketplace)
                  : "Installed"}
            </span>
            {extension && <StateChip extension={extension} offer={offer} />}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {primary}
          {owns && extension && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="icon" aria-label="More" />
                }
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {extension.enabled && (
                  <DropdownMenuItem
                    onClick={() => act(() => disableExtension(extension.id))}
                  >
                    Disable
                  </DropdownMenuItem>
                )}
                {extension.dev && (
                  <DropdownMenuItem
                    onClick={() =>
                      act(() => loadExtensionFolder(extension.source))
                    }
                  >
                    Load again
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setRemoving(true)}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {extension?.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
        >
          {extension.error}
        </p>
      )}
      {extension && update && (
        <div className="flex items-center gap-3 rounded-lg border border-attention/35 bg-attention/5 px-3.5 py-3 text-sm">
          <ArrowUpCircleIcon className="size-4 shrink-0 text-attention" />
          <span className="flex-1">
            <span className="font-semibold">{offer!.version}</span> is available
            · {offerVersions(offer!)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setTab("versions")}>
            Versions
          </Button>
        </div>
      )}
      <div className="grid gap-9 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <div
            role="tablist"
            className="mb-5 flex gap-5 border-b text-[13.5px] font-medium"
          >
            {tabs.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={shown === t}
                onClick={() => setTab(t)}
                className="relative pb-2.5 text-muted-foreground capitalize transition-colors hover:text-foreground aria-selected:text-foreground aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:-bottom-px aria-selected:after:h-0.5 aria-selected:after:rounded-full aria-selected:after:bg-foreground"
              >
                {t}
              </button>
            ))}
          </div>
          {shown === "overview" && (
            <p className="max-w-2xl text-sm leading-relaxed">
              {extension?.description || offer?.description}
            </p>
          )}
          {shown === "access" && <Access extension={extension} offer={offer} />}
          {shown === "settings" && extension && (
            <Settings
              extension={extension}
              owns={owns}
              busy={busy}
              perform={perform}
            />
          )}
          {shown === "versions" && (
            <Versions extension={extension} offer={offer} />
          )}
        </div>
        <dl className="grid h-fit grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px] [&_dd]:text-right [&_dt]:text-faint">
          <dt>Version</dt>
          <dd className="font-mono">{extension?.version ?? offer!.version}</dd>
          <dt>Publisher</dt>
          <dd>{extension?.publisher ?? offer!.publisher}</dd>
          {extension && (
            <>
              <dt>Installed</dt>
              <dd>{ago(extension.installed_at)}</dd>
              <dt>Updated</dt>
              <dd>{ago(extension.updated_at)}</dd>
            </>
          )}
          <dt>From</dt>
          <dd className="truncate">
            {extension?.dev
              ? extension.source
              : offer
                ? marketplaceName(offer.index, marketplace)
                : "—"}
          </dd>
          <dt>Id</dt>
          <dd className="truncate font-mono text-[12px]">{id}</dd>
        </dl>
      </div>
      {removing && extension && (
        <RemoveDialog
          extension={extension}
          close={() => setRemoving(false)}
          busy={busy}
          perform={perform}
        />
      )}
    </div>
  );
}
