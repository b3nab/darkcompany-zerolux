import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { CloudUploadIcon, FolderIcon } from "lucide-react";
import { ago, fileUrl } from "@zerolux/chat";
import type { Chat, Storage as Files, StoredFile } from "@zerolux/chat";
import type { Workspace } from "./api";
import { Button } from "@/components/ui/button";
import { FileGlyph, fileSize } from "@/components/file";
import { Page } from "@/components/page";
import { ActorMark, Eyebrow } from "@/components/presence";

type Tab = "all" | "people" | "agents";
const row =
  "grid grid-cols-[1.125rem_minmax(0,1fr)_7rem] items-center gap-3.5 px-4 md:grid-cols-[1.125rem_minmax(0,1fr)_9.5rem_8rem_4.5rem_4.5rem]";

/** The company's shared files, uploaded by people or written by agents, and where they belong. */
export function Storage({
  workspace,
  chat,
  storage,
}: {
  workspace: Workspace;
  chat: Chat;
  storage: Files;
}) {
  const ready = storage.available;
  const [tab, setTab] = useState<Tab>("all");
  const [folder, setFolder] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const actor = (id: string) => workspace.actors.find((a) => a.id === id);
  const byPerson = (file: StoredFile) =>
    actor(file.created_by)?.kind === "human";
  const files = storage.files
    .filter((f) => tab === "all" || byPerson(f) === (tab === "people"))
    .filter((f) => folder === undefined || f.folder === folder)
    .sort((a, b) => b.updated_at - a.updated_at);
  const folders = [
    ...new Set(storage.files.map((f) => f.folder).filter(Boolean)),
  ].sort();

  async function upload(list: FileList | null) {
    if (!ready || !list?.length) return;
    setBusy(true);
    await storage.upload([...list], { folder });
    setBusy(false);
  }
  const over = (event: DragEvent, on: boolean) => {
    event.preventDefault();
    setDragging(on && ready);
  };
  const tabs: [Tab, string][] = [
    ["all", `All files · ${storage.files.length}`],
    ["people", "By people"],
    ["agents", "By agents"],
  ];

  return (
    <Page>
      <div className="flex flex-wrap items-end gap-2 border-b">
        <div role="group" aria-label="Files" className="flex flex-1 gap-5">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className="-mb-px border-b-2 border-transparent pb-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-primary aria-pressed:text-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          className="mb-2"
          disabled={!ready || busy}
          onClick={() => picker.current?.click()}
        >
          <CloudUploadIcon />
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
      {storage.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {storage.error}
        </p>
      )}
      {folders.length > 0 && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {folders.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={folder === name}
              onClick={() => setFolder(folder === name ? undefined : name)}
              className="flex h-12 items-center gap-2.5 rounded-md border bg-card px-3.5 text-left text-sm font-medium transition-colors hover:border-faint aria-pressed:border-primary/50"
            >
              <FolderIcon className="size-4.5 text-faint" />
              <span className="truncate">{name}</span>
              <span className="ml-auto font-mono text-xs text-faint">
                {storage.files.filter((f) => f.folder === name).length}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-md border bg-card">
        <div className={cn(row, "h-8.5")}>
          <span />
          <Eyebrow>Name</Eyebrow>
          <Eyebrow>Created by</Eyebrow>
          <Eyebrow className="max-md:hidden">Shared in</Eyebrow>
          <Eyebrow className="max-md:hidden">Size</Eyebrow>
          <Eyebrow className="max-md:hidden">Edited</Eyebrow>
        </div>
        {files.map((file) => {
          const by = actor(file.created_by);
          const where = chat.conversations.find(
            (c) => c.id === file.conversation_id,
          );
          return (
            <div
              key={file.id}
              className={cn(
                row,
                "h-10.5 border-t text-sm transition-colors hover:bg-accent",
              )}
            >
              <FileGlyph
                file={file}
                className={cn(
                  "size-4",
                  by?.kind === "human"
                    ? "text-human-foreground"
                    : "text-agent-foreground",
                )}
              />
              <a
                href={fileUrl(file)}
                target="_blank"
                rel="noreferrer"
                className="truncate hover:underline"
              >
                {file.name}
              </a>
              <span className="flex min-w-0 items-center gap-1.5">
                <ActorMark
                  kind={by?.kind ?? "agent"}
                  name={by?.name ?? "?"}
                  className="size-5 text-[9px]"
                />
                <span
                  className={cn(
                    "truncate text-xs",
                    by?.kind !== "human" && "font-mono text-agent-foreground",
                  )}
                >
                  {by?.name ?? "Unknown"}
                </span>
              </span>
              <span className="truncate text-xs text-faint max-md:hidden">
                {where ? (
                  <Link to={`/chats/${where.id}`} className="hover:underline">
                    {where.title}
                  </Link>
                ) : (
                  file.folder || "—"
                )}
              </span>
              <span className="font-mono text-xs text-faint max-md:hidden">
                {fileSize(file.size)}
              </span>
              <span className="font-mono text-xs text-faint max-md:hidden">
                {ago(file.updated_at)}
              </span>
            </div>
          );
        })}
        {files.length === 0 && (
          <p className="border-t px-4 py-6 text-center text-sm text-muted-foreground">
            {!ready
              ? "This kernel has no storage yet."
              : storage.files.length === 0
                ? "No files yet."
                : "No files here."}
          </p>
        )}
      </div>
      <div
        onDragOver={(e) => over(e, true)}
        onDragLeave={(e) => over(e, false)}
        onDrop={(e) => {
          over(e, false);
          void upload(e.dataTransfer.files);
        }}
        className={cn(
          "flex h-16 items-center justify-center gap-2.5 rounded-md border border-dashed border-faint text-sm text-faint transition-colors",
          dragging && "border-primary bg-primary/10 text-foreground",
          !ready && "opacity-50",
        )}
      >
        <CloudUploadIcon className="size-4.5" />
        Drop files here to share them with the company
      </div>
    </Page>
  );
}
