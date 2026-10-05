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
import { fileKind } from "@zerolux/chat";
import type { FileKind, StoredFile } from "@zerolux/chat";

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
  file: StoredFile;
  className?: string;
}) {
  const Icon = icons[fileKind(file)];
  return <Icon aria-hidden className={className} />;
}
