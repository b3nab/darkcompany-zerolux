import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowUpCircleIcon,
  BugIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  GlobeIcon,
  PencilIcon,
  PlayIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ago,
  cardFileNamed,
  disableExtension,
  enableExtension,
  errorMessage,
  extensionCategories,
  loadExtensionFolder,
  marketplaceName,
  offerAction,
  offerFor,
  offerVersions,
  readCardText,
  removeInstalled,
  runAction,
  setExtensionSettings,
} from "@zerolux/chat";
import type {
  CardFile,
  Extension,
  ExtensionAction,
  ExtensionCard,
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
  useCardFile,
  partNames,
} from "./extension-bits";
import type { Consent } from "./extension-bits";
import { lucideIcon } from "./native-ui";
import { MessageText } from "./components/message-text";
import type { MarkdownDocument } from "./components/message-text";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
                await removeInstalled(extension);
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
  tray: "In the tray's panel",
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

/** A card's README or CHANGELOG, read from the kernel once for each digest. */
function useCardText(file: CardFile | null | undefined) {
  const [read, setRead] = useState<{
    sha256: string;
    text?: string;
    error?: string;
  }>();
  const sha256 = file?.sha256;
  useEffect(() => {
    if (!file) return;
    let live = true;
    readCardText(file).then(
      (text) => live && setRead({ sha256: file.sha256, text }),
      (error: unknown) =>
        live && setRead({ sha256: file.sha256, error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
    // The same digest is the same text, in whichever list it came.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha256]);
  return read?.sha256 === sha256 ? read : undefined;
}

/** A README or CHANGELOG as Markdown, with the images of its card. */
function CardText({ card, file }: { card: ExtensionCard; file: CardFile }) {
  const read = useCardText(file);
  const document = useMemo<MarkdownDocument>(
    () => ({
      image: (src, alt) => {
        const named = cardFileNamed(card, src);
        return named?.kind === "image" ? (
          <CardImage file={named} alt={alt} className="rounded-lg border" />
        ) : null;
      },
    }),
    [card],
  );
  if (read?.error)
    return <p className="text-sm text-destructive">{read.error}</p>;
  return read?.text !== undefined ? (
    <article className="max-w-3xl">
      <MessageText text={read.text} document={document} />
    </article>
  ) : null;
}

/** An image of a card, once read. */
function CardImage({
  file,
  alt = "",
  className,
}: {
  file: CardFile;
  alt?: string;
  className?: string;
}) {
  const url = useCardFile(file);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

/** A card's video, read when it is played: it may be large. */
function CardVideo({ file }: { file: CardFile }) {
  const [play, setPlay] = useState(false);
  const url = useCardFile(file, play);
  return url ? (
    <video
      src={url}
      controls
      autoPlay
      className="size-full bg-black object-contain"
    />
  ) : (
    <button
      aria-label="Play the video"
      onClick={() => setPlay(true)}
      className="grid size-full place-items-center bg-gradient-to-br from-muted to-accent text-foreground"
    >
      <span className="grid size-12 place-items-center rounded-full bg-background/80 shadow-sm backdrop-blur">
        {play ? <Spinner /> : <PlayIcon className="ml-0.5 size-5" />}
      </span>
    </button>
  );
}

/** A card's images and video, side by side; an image opens large, and the arrows go through them. */
function Gallery({ media }: { media: CardFile[] }) {
  const images = media.filter((file) => file.kind === "image");
  const [open, setOpen] = useState<number>();
  const step = (by: number) =>
    setOpen((at) =>
      at === undefined ? at : (at + by + images.length) % images.length,
    );
  const shown = open === undefined ? undefined : images[open];
  return (
    <>
      <ul
        className={cn(
          "mb-6 grid snap-x grid-flow-col gap-3 overflow-x-auto pb-1.5",
          // One alone is shown large; more, side by side.
          media.length === 1
            ? "max-w-3xl auto-cols-fr"
            : "auto-cols-[min(300px,80%)]",
        )}
      >
        {media.map((file) => (
          <li
            key={file.sha256}
            className="aspect-[16/10] snap-start overflow-hidden rounded-lg border bg-muted"
          >
            {file.kind === "video" ? (
              <CardVideo file={file} />
            ) : (
              <button
                aria-label={`Open ${file.name}`}
                onClick={() => setOpen(images.indexOf(file))}
                className="size-full cursor-zoom-in"
              >
                <CardImage
                  file={file}
                  className="size-full object-cover transition-transform duration-300 hover:scale-[1.02]"
                />
              </button>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={shown !== undefined}
        onOpenChange={(opened) => !opened && setOpen(undefined)}
      >
        <DialogContent
          className="gap-3 p-3 sm:max-w-5xl"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") step(1);
            if (event.key === "ArrowLeft") step(-1);
          }}
        >
          <DialogTitle className="sr-only">{shown?.name}</DialogTitle>
          {shown && (
            <CardImage
              file={shown}
              className="max-h-[80vh] w-full rounded-md object-contain"
            />
          )}
          {images.length > 1 && (
            <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon />
              </Button>
              {(open ?? 0) + 1} / {images.length}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next"
                onClick={() => step(1)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const linkKinds = [
  ["homepage", "Website", GlobeIcon],
  ["repository", "Source", CodeIcon],
  ["issues", "Report a problem", BugIcon],
  ["privacy", "Privacy", ShieldIcon],
] as const;

/** A card's categories by their names. */
const categoryNames = (card?: ExtensionCard | null) =>
  (card?.categories ?? []).map(
    (id) => extensionCategories.find((c) => c.id === id)?.name ?? id,
  );

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
  const newBuild = update && offer.installed === offer.version;
  // The installed one's card; the newer one's for what changed.
  const card = extension?.card ?? offer?.card;
  const changes = update ? offer!.card : card;
  const links = linkKinds.filter(([kind]) => card?.links?.[kind]);
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
      {newBuild ? "Update" : `Update to ${offer!.version}`}
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
        <ExtensionIcon id={id} extension={extension} card={card} size="lg" />
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
            {categoryNames(card).map((category) => (
              <span
                key={category}
                className="rounded-full border px-2 py-0.5 text-[11.5px]"
              >
                {category}
              </span>
            ))}
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
            {newBuild ? "A new build of " : ""}
            <span className="font-semibold">{offer!.version}</span> is available
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
            <>
              {!!card?.media.length && <Gallery media={card.media} />}
              {card?.readme ? (
                <CardText card={card} file={card.readme} />
              ) : (
                <p className="max-w-2xl text-sm leading-relaxed">
                  {extension?.description || offer?.description}
                </p>
              )}
            </>
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
          {shown === "versions" && changes?.changelog && (
            <div className="mt-6">
              <CardText card={changes} file={changes.changelog} />
            </div>
          )}
        </div>
        <aside className="flex h-fit flex-col gap-6 text-[13px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 [&_dd]:text-right [&_dt]:text-faint">
            <dt>Version</dt>
            <dd className="font-mono">
              {extension?.version ?? offer!.version}
            </dd>
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
            {card?.license && (
              <>
                <dt>License</dt>
                <dd className="font-mono text-[12px]">{card.license}</dd>
              </>
            )}
            <dt>Id</dt>
            <dd className="truncate font-mono text-[12px]">{id}</dd>
          </dl>
          {!!card?.keywords.length && (
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] font-medium tracking-wider text-faint uppercase">
                Keywords
              </h2>
              <ul className="flex flex-wrap gap-1.5">
                {card.keywords.map((keyword) => (
                  <li
                    key={keyword}
                    className="rounded-full border px-2 py-0.5 text-[11.5px] text-muted-foreground"
                  >
                    {keyword}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {links.length > 0 && (
            <section className="flex flex-col gap-1">
              <h2 className="mb-1 text-[11px] font-medium tracking-wider text-faint uppercase">
                Links
              </h2>
              {links.map(([kind, label, Icon]) => (
                <a
                  key={kind}
                  href={card!.links![kind]!}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 py-1 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
                >
                  <Icon />
                  {label}
                </a>
              ))}
            </section>
          )}
        </aside>
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
