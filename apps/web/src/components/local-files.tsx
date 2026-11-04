import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderOpenIcon,
  ImageIcon,
} from "lucide-react";
import { cn } from "cn";
import { localImage, localPath, useSessionMedia } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { openImage, revealFile } from "@/desktop";

/** The session whose words name files: where they are read, and what can be done with them. */
export interface SessionFiles {
  /** The session, whose computer reads them. */
  id: string;
  /** Its folder: relative paths are its own. */
  folder: string;
  /** Every image its words show, in their order: the lightbox goes through them. */
  images: string[];
  /** Its files are on this computer, in the desktop app: shown in the Finder, an image opened. */
  here: boolean;
  /** A file of its folder in the file viewer, by its path there. */
  openFile?: (path: string) => void;
}

const Files = createContext<
  (SessionFiles & { show: (image: string) => void }) | undefined
>(undefined);

/** A file's name: the last part of its path. */
const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** A path inside the session's folder, as the folder has it; none outside it. */
export function inFolder(folder: string, path: string) {
  const inside = path.startsWith("./")
    ? path.slice(2)
    : path.startsWith(`${folder.replace(/\/$/, "")}/`)
      ? path.slice(folder.replace(/\/$/, "").length + 1)
      : undefined;
  return inside?.split("/").includes("..") ? undefined : inside;
}

/** A path the computer finds whole: relative ones are the session folder's. */
const whole = (folder: string, path: string) =>
  /^(\/|~\/|[a-z]:[\\/])/i.test(path)
    ? path
    : `${folder.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;

/** Where a text's Markdown links and images go, outside its code. */
const destinations = (text: string) =>
  [
    ...text
      .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, "")
      .replace(/`[^`\n]*`/g, "")
      .matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))/g),
  ].map((link) => link[1] ?? link[2]!);

/** The images on its computer that an agent's words show, in their order, each once. */
export const imagesIn = (texts: string[]) =>
  [
    ...new Set(
      texts
        .flatMap(destinations)
        .map(localPath)
        .filter((path) => path !== undefined && localImage(path)),
    ),
  ] as string[];

/**
 * The files a session's words name, read from its computer: each image they show opens in a
 * lightbox that goes through all of them.
 */
export function SessionFilesProvider({
  files,
  children,
}: {
  files: SessionFiles;
  children: ReactNode;
}) {
  const [shown, setShown] = useState<string>();
  const value = useMemo(() => ({ ...files, show: setShown }), [files]);
  return (
    <Files.Provider value={value}>
      {children}
      {shown !== undefined && (
        <Lightbox
          files={files}
          first={shown}
          close={() => setShown(undefined)}
        />
      )}
    </Files.Provider>
  );
}

const CHIP =
  "inline-flex max-w-full items-baseline gap-1 rounded-sm border bg-background/60 px-1.5 py-px align-baseline font-mono text-[12px] text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * A file an agent's words name on its computer, as a chip that never leaves the page: an image
 * opens in the lightbox; another file opens in the file viewer when it is in the session's
 * folder, else in the Finder in the desktop app, or its path is copied. Outside a session the
 * path stays, with nothing to open.
 */
export function LocalFile({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const files = useContext(Files);
  const [copied, setCopied] = useState(false);
  const image = localImage(path);
  const inside = files && inFolder(files.folder, path);
  const open = !files
    ? undefined
    : image
      ? () => files.show(path)
      : inside !== undefined && files.openFile
        ? () => files.openFile!(inside)
        : files.here
          ? () => void revealFile(whole(files.folder, path))
          : () =>
              void navigator.clipboard.writeText(path).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
  const Icon = copied ? CheckIcon : image ? ImageIcon : FileIcon;
  const label = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 self-center" />
      <span className="truncate">{children}</span>
    </>
  );
  return open ? (
    <button type="button" title={path} onClick={open} className={CHIP}>
      {label}
    </button>
  ) : (
    <span title={path} className={CHIP}>
      {label}
    </span>
  );
}

/**
 * The images a paragraph's chips name, small, under it, each opening the lightbox; none while
 * it loads or when it cannot be read, so its chip alone stays.
 */
export function Thumbnails({ paths }: { paths: string[] }) {
  const files = useContext(Files);
  if (!files || !paths.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2 empty:hidden">
      {[...new Set(paths)].map((path) => (
        <Thumbnail
          key={path}
          id={files.id}
          path={path}
          open={() => files.show(path)}
        />
      ))}
    </div>
  );
}

/** An image's small copy; nothing while it loads or when it cannot be read. */
function Thumbnail({
  id,
  path,
  open,
}: {
  id: string;
  path: string;
  open: () => void;
}) {
  const media = useSessionMedia(id, path);
  if (!media.url) return null;
  return (
    <button
      type="button"
      aria-label={`Open ${nameOf(path)}`}
      onClick={open}
      className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <img
        src={media.url}
        alt=""
        className="max-h-48 max-w-full rounded-md border object-contain"
      />
    </button>
  );
}

/**
 * The session's images, large, one at a time from the one opened: arrows or ← → go through
 * them, a click zooms to the image's own size, its path is copied or it is saved; in the
 * desktop app with the session on this computer, shown in the Finder or opened.
 */
function Lightbox({
  files,
  first,
  close,
}: {
  files: SessionFiles;
  first: string;
  close: () => void;
}) {
  const images = files.images.includes(first) ? files.images : [first];
  const [at, setAt] = useState(images.indexOf(first));
  const [zoomed, setZoomed] = useState(false);
  const path = images[at]!;
  const media = useSessionMedia(files.id, path);
  const go = (by: number) => {
    setAt((at + by + images.length) % images.length);
    setZoomed(false);
  };
  const full = whole(files.folder, path);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        onKeyDown={(event) => {
          if (images.length < 2) return;
          if (event.key === "ArrowLeft") go(-1);
          if (event.key === "ArrowRight") go(1);
        }}
        className="flex h-[92vh] max-w-[min(96vw,1400px)] flex-col gap-3 p-3 sm:max-w-[min(96vw,1400px)]"
      >
        <div className="flex min-w-0 items-center gap-2 pr-9">
          <DialogTitle className="min-w-0 truncate font-mono text-[13px]">
            {nameOf(path)}
          </DialogTitle>
          {images.length > 1 && (
            <span className="shrink-0 font-mono text-[12px] text-faint">
              {at + 1} / {images.length}
            </span>
          )}
          <span className="ml-auto flex shrink-0 gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy path"
              title="Copy path"
              onClick={() => void navigator.clipboard.writeText(path)}
            >
              <CopyIcon />
            </Button>
            {media.url && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Save"
                title="Save"
                render={<a href={media.url} download={nameOf(path)} />}
              >
                <DownloadIcon />
              </Button>
            )}
            {files.here && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Show in Finder"
                  title="Show in Finder"
                  onClick={() => void revealFile(full)}
                >
                  <FolderOpenIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open"
                  title="Open"
                  onClick={() => void openImage(full)}
                >
                  <ExternalLinkIcon />
                </Button>
              </>
            )}
          </span>
        </div>
        <div className="relative min-h-0 flex-1 rounded-md bg-muted/40">
          {/* Centered while it fits; zoomed past the frame, it scrolls from its corner. */}
          <div className="absolute inset-0 flex overflow-auto">
            {media.url ? (
              <img
                src={media.url}
                alt={nameOf(path)}
                onClick={() => setZoomed(!zoomed)}
                className={cn(
                  "m-auto",
                  zoomed
                    ? "max-w-none cursor-zoom-out"
                    : "max-h-full max-w-full cursor-zoom-in object-contain",
                )}
              />
            ) : (
              media.failed && (
                <p className="m-auto px-6 text-center font-mono text-[12px] text-muted-foreground">
                  {path}
                </p>
              )
            )}
          </div>
          {images.length > 1 && (
            <>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Previous image"
                onClick={() => go(-1)}
                className="absolute inset-y-0 left-2 my-auto"
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Next image"
                onClick={() => go(1)}
                className="absolute inset-y-0 right-2 my-auto"
              >
                <ChevronRightIcon />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
