import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import { useState } from "react";
import { downloadFile, errorMessage, fileKind, fileSize } from "@zerolux/chat";
import type { FileKind, FileLink, StoredFile } from "@zerolux/chat";

export { fileSize } from "@zerolux/chat";

const icons: Record<FileKind, typeof FileIcon> = {
  image: FileImageIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  archive: FileArchiveIcon,
  sheet: FileSpreadsheetIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileIcon,
};

/** A file's icon, from its type. */
export function FileGlyph({
  file,
  className,
}: {
  file: Pick<StoredFile, "content_type">;
  className?: string;
}) {
  const Icon = icons[fileKind(file)];
  return <Icon aria-hidden className={className} />;
}

/** A file kept as the browser keeps a download; the desktop puts it in Downloads. */
export async function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A file a message shares: its name, kind and size, downloaded with a press. Without Storage
 * it is only its name.
 */
export function FileCard({
  link,
  file,
  available,
}: {
  link: FileLink;
  /** What Storage knows of it, once read. */
  file?: StoredFile;
  available: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const body = (
    <>
      <FileGlyph
        file={file ?? { content_type: "" }}
        className="size-5 shrink-0 text-faint"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{file?.name ?? link.name}</span>
        {file && (
          <span className="font-mono text-[11px] text-faint">
            {fileSize(file.size)}
          </span>
        )}
      </span>
    </>
  );
  const frame =
    "flex w-fit max-w-xs items-center gap-3 rounded-md border bg-card px-3 py-2 text-left";
  if (!available) return <span className={frame}>{body}</span>;
  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        title="Download"
        onClick={() => {
          setBusy(true);
          setFailed("");
          downloadFile(link.id)
            .then(({ blob, name }) => saveFile(blob, name ?? link.name))
            .catch((error: unknown) => setFailed(errorMessage(error)))
            .finally(() => setBusy(false));
        }}
        className={`${frame} transition-colors hover:bg-accent disabled:opacity-60`}
      >
        {body}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {failed}
        </span>
      )}
    </span>
  );
}
