import { Fragment, useEffect, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  HouseIcon,
} from "lucide-react";
import { errorMessage, readFolders } from "@zerolux/chat";
import type { FolderListing } from "@zerolux/chat";
import type { FolderInputProps } from "@zerolux/ui";
import { cn } from "cn";
import { chooseFolder, kernelHere } from "./desktop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

/** A folder's path as the steps to it, each with its own path; a path not from the root is one step. */
const steps = (path: string) =>
  path.startsWith("/")
    ? [
        { name: "/", path: "/" },
        ...path
          .split("/")
          .filter(Boolean)
          .map((name, at, all) => ({
            name,
            path: `/${all.slice(0, at + 1).join("/")}`,
          })),
      ]
    : [{ name: path, path }];

/**
 * The folders of the computer ZeroLux runs on, walked as in the system's own panel: one opens
 * with a double click or its arrow, one is chosen with a click, the one open if none is.
 */
function FolderSheet({
  start,
  close,
  choose,
}: {
  start: string | null;
  close: () => void;
  choose: (path: string) => void;
}) {
  const [path, setPath] = useState<string | undefined>(start ?? undefined);
  const [listing, setListing] = useState<FolderListing>();
  const [picked, setPicked] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    readFolders(path).then(
      (read) => {
        if (!live) return;
        setListing(read);
        setPicked(undefined);
      },
      (problem: unknown) => live && setError(errorMessage(problem)),
    );
    return () => {
      live = false;
    };
  }, [path]);
  const shown = listing?.folders.filter((folder) => !folder.hidden) ?? [];
  const chosen = picked ?? listing?.path;
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            On the computer ZeroLux runs on.
          </DialogDescription>
        </DialogHeader>
        <div className="grid h-80 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border bg-background">
          <div className="flex items-center gap-1 border-b px-1.5 py-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Up"
              title="Up"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && setPath(listing.parent)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Home"
              title="Home"
              disabled={!listing?.home}
              onClick={() => listing?.home && setPath(listing.home)}
            >
              <HouseIcon />
            </Button>
            <nav
              aria-label="Folder"
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-[12.5px]"
            >
              {listing &&
                steps(listing.path).map((step, at, all) => (
                  <Fragment key={step.path}>
                    {at > 1 && (
                      <ChevronRightIcon className="size-3 shrink-0 text-faint" />
                    )}
                    <button
                      type="button"
                      onClick={() => setPath(step.path)}
                      className={cn(
                        "shrink-0 rounded-sm px-1.5 py-0.5 hover:bg-accent",
                        at === all.length - 1
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {step.name}
                    </button>
                  </Fragment>
                ))}
            </nav>
          </div>
          <ul
            role="listbox"
            aria-label="Folders"
            className="overflow-y-auto p-1"
          >
            {error ? (
              <li role="alert" className="p-3 text-sm text-destructive">
                {error}
              </li>
            ) : !listing ? (
              <li className="grid h-full place-items-center">
                <Spinner />
              </li>
            ) : !shown.length ? (
              <li className="p-3 text-sm text-muted-foreground">No folders</li>
            ) : (
              shown.map((folder) => (
                <li
                  key={folder.path}
                  role="option"
                  aria-selected={picked === folder.path}
                  onClick={() => setPicked(folder.path)}
                  onDoubleClick={() => setPath(folder.path)}
                  className="flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-sm select-none hover:bg-accent aria-selected:bg-ring/20"
                >
                  <FolderIcon className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Open ${folder.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPath(folder.path);
                    }}
                  >
                    <ChevronRightIcon />
                  </Button>
                </li>
              ))
            )}
          </ul>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {chosen}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!chosen} onClick={() => chosen && choose(chosen)}>
              Choose
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A folder of the computer ZeroLux runs on, chosen and never typed: macOS's own panel in the
 * desktop app on that computer, else the sheet that walks its folders.
 */
export function FolderInput({
  value,
  onChange,
  label,
  disabled,
}: FolderInputProps) {
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const choose = () => {
    if (!kernelHere()) return setBrowsing(true);
    setError("");
    chooseFolder(value ?? undefined).then(
      (path) => path && onChange(path),
      (problem: unknown) => setError(errorMessage(problem)),
    );
  };
  const field = (
    <div className="flex flex-col gap-1">
      <div className="flex h-9 items-center gap-2.5 rounded-md border border-input bg-background pr-1 pl-2.5">
        <FolderIcon className="size-4 shrink-0 text-faint" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            value ? "font-mono text-xs" : "text-muted-foreground",
          )}
        >
          {value || "No folder chosen"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          disabled={disabled}
          onClick={choose}
        >
          {value ? "Change…" : "Choose…"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {browsing && (
        <FolderSheet
          start={value}
          close={() => setBrowsing(false)}
          choose={(path) => {
            onChange(path);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
  return label ? (
    <Field className="gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      {field}
    </Field>
  ) : (
    field
  );
}
