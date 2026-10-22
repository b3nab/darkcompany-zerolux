import { useEffect, useState } from "react";
import { BlocksIcon } from "lucide-react";
import {
  cardFileUrl,
  cardIcon,
  consentParts,
  enableExtension,
  errorMessage,
  fetchKernel,
  installOffer,
  marketplaceName,
  offerAction,
  offerVersions,
  updateExtensions,
} from "@zerolux/chat";
import type {
  CardFile,
  Extension,
  ExtensionCard,
  Marketplace,
  MarketplaceOffer,
  UpdatesDone,
} from "@zerolux/chat";
import { cn } from "cn";
import { lucideIcon } from "./native-ui";
import { useTheme } from "./theme";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** What each part of an extension is, by name and in a line. */
export const partNames: Record<string, string> = {
  kernel: "Kernel module",
  process: "Process",
  interface: "Interface",
  remote: "Remote",
};
export const partLines: Record<string, string> = {
  kernel: "Runs inside the kernel",
  process: "Runs beside the kernel, as its own program",
  interface: "Drawn inside the apps, with your access",
  remote: "Runs on another server",
};

const tints = [
  "bg-author-0/15 text-author-0",
  "bg-author-1/15 text-author-1",
  "bg-author-2/15 text-author-2",
  "bg-author-3/15 text-author-3",
  "bg-author-4/15 text-author-4",
  "bg-author-5/15 text-author-5",
];
const tintOf = (id: string) =>
  tints[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % tints.length];

const read = new Map<string, Promise<string>>();

/**
 * A card's file as the page shows it: read from the kernel once, kept by its digest, and shown
 * from memory, since pages draw only what they hold.
 */
export function useCardFile(file: CardFile | null | undefined, load = true) {
  const [shown, setShown] = useState<{ sha256: string; url: string }>();
  const sha256 = file?.sha256;
  useEffect(() => {
    if (!file || !load) return;
    let live = true;
    let reading = read.get(file.sha256);
    if (!reading) {
      reading = fetchKernel(cardFileUrl(file))
        .then((response) => {
          if (!response.ok) throw new Error(`${file.name} could not be read`);
          return response.blob();
        })
        .then((blob) => URL.createObjectURL(blob));
      read.set(file.sha256, reading);
      // A failed read is tried again the next time it is shown.
      reading.catch(() => read.delete(file.sha256));
    }
    reading.then(
      (url) => live && setShown({ sha256: file.sha256, url }),
      () => {},
    );
    return () => {
      live = false;
    };
    // The same digest is the same file, in whichever list it came.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha256, load]);
  return shown?.sha256 === sha256 ? shown?.url : undefined;
}

/**
 * An extension's mark: the icon of its card, for the theme; without one, the icon of its first
 * piece of interface, in a color of its own.
 */
export function ExtensionIcon({
  extension,
  card,
  id,
  size = "md",
}: {
  extension?: Extension;
  /** Its card, when not the installed one's. */
  card?: ExtensionCard | null;
  id: string;
  size?: "sm" | "md" | "lg";
}) {
  const { resolved } = useTheme();
  const icon = cardIcon(card ?? extension?.card, resolved === "dark");
  const url = useCardFile(icon);
  const named = extension?.contributes?.ui?.find((piece) => piece.icon)?.icon;
  const Icon = named ? lucideIcon(named) : BlocksIcon;
  const box = cn(
    "shrink-0",
    size === "sm" && "size-8 rounded-md",
    size === "md" && "size-10 rounded-lg",
    size === "lg" && "size-16 rounded-xl",
  );
  return icon ? (
    url ? (
      <img aria-hidden alt="" src={url} className={cn(box, "object-cover")} />
    ) : (
      <span aria-hidden className={cn(box, "bg-muted")} />
    )
  ) : (
    <span
      aria-hidden
      className={cn(
        box,
        "grid place-items-center",
        tintOf(id),
        size === "sm" && "[&_svg]:size-4",
        size === "md" && "[&_svg]:size-5",
        size === "lg" && "[&_svg]:size-8",
      )}
    >
      <Icon />
    </span>
  );
}

/** Whether it runs, and if not, why; an update waiting, or that it comes from a folder. */
export function StateChip({
  extension,
  offer,
}: {
  extension: Extension;
  offer?: MarketplaceOffer;
}) {
  const chip =
    "inline-flex h-5.5 items-center gap-1.5 rounded-full border px-2 text-[11.5px] whitespace-nowrap";
  if (extension.error)
    return (
      <span className={cn(chip, "border-destructive/40 text-destructive")}>
        Error
      </span>
    );
  if (extension.dev)
    return (
      <span className={cn(chip, "border-agent/40 text-agent")}>
        In development
      </span>
    );
  if (offer && offerAction(offer) === "update")
    return (
      <span className={cn(chip, "border-attention/45 text-attention")}>
        {offerVersions(offer)}
      </span>
    );
  if (!extension.enabled)
    return (
      <span className={cn(chip, "text-muted-foreground")}>
        <span className="size-1.5 rounded-full bg-faint" />
        Disabled
      </span>
    );
  return (
    <span className={cn(chip, "text-muted-foreground")}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          extension.running ? "bg-success" : "bg-attention",
        )}
      />
      {extension.running ? "Running" : "Restarting"}
    </span>
  );
}

/** What a consent is for: an offer to install or update, or an agent's proposal to enable. */
/** An update waiting: the offer, and the extension it updates. */
export type Update = { offer: MarketplaceOffer; installed: Extension };

/**
 * What a consent is for: an offer to install or update, an agent's proposal to enable, or
 * every update waiting at once.
 */
export type Consent =
  | { offer: MarketplaceOffer; installed?: Extension }
  | { proposal: Extension; agent: string }
  | { updates: Update[] };

const changeMark = {
  new: "border-success/45 text-success",
  gone: "border-faint/40 text-faint line-through",
  kept: "",
};

/**
 * Installing, updating or enabling asks first, in a dialog: who signed it and where it comes
 * from, what it runs, and in an update only what changes.
 */
export function ConsentDialog({
  consent,
  marketplace,
  close,
  done,
}: {
  consent: Exclude<Consent, { updates: Update[] }>;
  marketplace?: Marketplace;
  close: () => void;
  /** It was installed, updated or enabled, or failed to be. */
  done: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const offer = "offer" in consent ? consent.offer : undefined;
  const extension = "offer" in consent ? consent.installed : consent.proposal;
  const update = offer && offerAction(offer) === "update";
  const name = offer?.name ?? extension!.name;
  const parts = offer
    ? consentParts(offer, update ? extension : undefined)
    : extension!.parts.map((part) => ({ part, change: "kept" as const }));
  const verb = !offer ? "Enable" : update ? "Update" : "Install";
  const go = () => {
    setBusy(true);
    setError("");
    (offer ? installOffer(offer) : enableExtension(extension!.id))
      .then(
        () => close(),
        (problem: unknown) => setError(errorMessage(problem)),
      )
      .finally(() => {
        setBusy(false);
        done();
      });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-center gap-3">
          <ExtensionIcon
            id={offer?.id ?? extension!.id}
            extension={extension}
            card={offer?.card ?? extension?.card}
          />
          <div className="flex flex-col gap-0.5">
            <DialogTitle>
              {verb} {name}
              {update && offer.installed !== offer.version
                ? ` to ${offer.version}`
                : ""}
              ?
            </DialogTitle>
            <span className="font-mono text-[11.5px] text-faint">
              {offer ? offerVersions(offer) : extension!.version}
            </span>
          </div>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-accent px-3.5 py-3 text-sm">
          <dt className="text-faint">Signed by</dt>
          <dd>
            {offer ? (
              offer.publisher
            ) : (
              <>
                <span className="text-attention">No one</span> · written by{" "}
                {"agent" in consent ? consent.agent : ""}
              </>
            )}
          </dd>
          <dt className="text-faint">From</dt>
          <dd className="truncate">
            {offer
              ? marketplaceName(offer.index, marketplace)
              : "A folder, on this computer"}
          </dd>
        </dl>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {update ? "What it runs now" : "It runs"}
          </h3>
          <ul className="flex flex-col divide-y rounded-lg border text-sm">
            {parts.map(({ part, change }) => (
              <li key={part} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="flex-1">
                  {partNames[part] ?? part}
                  <span className="block text-xs text-muted-foreground">
                    {partLines[part]}
                  </span>
                </span>
                {change !== "kept" && (
                  <span
                    className={cn(
                      "rounded-full border px-2 font-mono text-[11px]",
                      changeMark[change],
                    )}
                  >
                    {change}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={go}>
            {busy
              ? `${verb === "Enable" ? "Enabling" : verb === "Update" ? "Updating" : "Installing"}…`
              : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every update waiting, asked for at once: each extension with its versions and only what
 * changes in what it runs. Only those shown are updated; then each says whether it was, and
 * why not.
 */
export function UpdatesDialog({
  updates,
  close,
  done,
}: {
  updates: Update[];
  close: () => void;
  /** They were updated, or some failed to be. */
  done: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UpdatesDone>();
  const go = () => {
    setBusy(true);
    setError("");
    updateExtensions(updates.map(({ offer }) => offer.id))
      .then(
        (updated) => {
          setResult(updated);
          if (!updated.failed.length) close();
        },
        (problem: unknown) => setError(errorMessage(problem)),
      )
      .finally(() => {
        setBusy(false);
        done();
      });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Update {updates.length}{" "}
            {updates.length === 1 ? "extension" : "extensions"}?
          </DialogTitle>
        </DialogHeader>
        <ul className="flex max-h-96 flex-col divide-y overflow-y-auto rounded-lg border">
          {updates.map(({ offer, installed }) => {
            const changes = consentParts(offer, installed).filter(
              ({ change }) => change !== "kept",
            );
            const failed = result?.failed.find((one) => one.id === offer.id);
            const updated = result?.updated.some((one) => one.id === offer.id);
            return (
              <li key={offer.id} className="flex items-start gap-3 px-3.5 py-3">
                <ExtensionIcon
                  id={offer.id}
                  extension={installed}
                  card={offer.card}
                  size="sm"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-baseline gap-2 text-sm">
                    <span className="font-medium">{offer.name}</span>
                    <span className="font-mono text-[11.5px] text-faint">
                      {offerVersions(offer)}
                    </span>
                  </span>
                  {changes.length > 0 && (
                    <span className="flex flex-wrap gap-1.5">
                      {changes.map(({ part, change }) => (
                        <span
                          key={part}
                          className={cn(
                            "rounded-full border px-2 text-[11px]",
                            changeMark[change],
                          )}
                        >
                          {partNames[part] ?? part} · {change}
                        </span>
                      ))}
                    </span>
                  )}
                  {failed && (
                    <span role="alert" className="text-xs text-destructive">
                      {failed.error}
                    </span>
                  )}
                </div>
                {updated && (
                  <span className="text-xs text-success">Updated</span>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={go}>
                {busy ? "Updating…" : "Update all"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
