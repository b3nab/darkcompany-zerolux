import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import { fileKind } from "@zerolux/chat";
import type { FileKind, StoredFile } from "@zerolux/chat";

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

/** A file's icon, from its type, in the color of who made it. */
export function FileGlyph({
  file,
  by = "agent",
}: {
  file: StoredFile;
  by?: "human" | "agent";
}) {
  const color = String(
    useCSSVariable(
      by === "human" ? "--color-human-foreground" : "--color-agent-foreground",
    ),
  );
  const Icon = icons[fileKind(file)];
  return <Icon color={color} size={18} strokeWidth={1.5} />;
}
