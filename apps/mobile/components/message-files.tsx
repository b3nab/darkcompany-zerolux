import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  downloadFile,
  errorMessage,
  fileKind,
  fileSize,
  linkedFiles,
} from "@zerolux/chat";
import type { FileLink, StoredFile } from "@zerolux/chat";
import { FileGlyph } from "@/components/file";
import { MessageBody } from "@/components/message-body";
import { dataUrl, saveFile } from "@/components/save-file";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";

/** The largest photo shown in the chat itself; a larger one is a card to open. */
const PREVIEW = 8 * 1024 ** 2;

// A photo is read once while the app runs, however often its message is drawn.
const previews = new Map<string, Promise<string>>();

/** A photo's bytes, to show, read once. */
function usePreview(id: string | undefined, kernel: string) {
  const [uri, setUri] = useState<string>();
  useEffect(() => {
    if (!id) return;
    let shown = true;
    const key = `${kernel} ${id}`;
    let read = previews.get(key);
    if (!read) {
      read = downloadFile(id, kernel).then(({ blob }) => dataUrl(blob));
      previews.set(key, read);
      read.catch(() => previews.delete(key));
    }
    read.then(
      (url) => shown && setUri(url),
      () => undefined,
    );
    return () => {
      shown = false;
    };
  }, [id, kernel]);
  return uri;
}

/** A file a message links to: a photo as itself, anything else as its name and size. */
function FileCard({
  link,
  file,
  by,
}: {
  link: FileLink;
  file: StoredFile | undefined;
  by: "human" | "agent";
}) {
  const { url } = useSession();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const [busy, setBusy] = useState(false);
  const photo =
    file && fileKind(file) === "image" && file.size <= PREVIEW
      ? file.id
      : undefined;
  const preview = usePreview(photo, url);
  const open = () => {
    setBusy(true);
    downloadFile(link.id, url)
      .then(({ blob, name }) => saveFile(blob, name ?? link.name))
      .catch((e: unknown) => Alert.alert(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={link.name}
      onPress={open}
      disabled={busy}
      className="mt-1 self-start overflow-hidden rounded-md border border-border bg-card active:opacity-80"
    >
      {preview ? (
        <Image
          source={{ uri: preview }}
          resizeMode="cover"
          style={{ width: 240, height: 180 }}
        />
      ) : (
        <View className="max-w-[260px] flex-row items-center gap-2.5 px-3 py-2.5">
          <FileGlyph
            file={file ?? { content_type: "application/octet-stream" }}
            by={by}
          />
          <View className="min-w-0 shrink gap-0.5">
            <Text numberOfLines={1} className="text-sm">
              {file?.name ?? link.name}
            </Text>
            {file ? (
              <Text className="font-mono text-[11px] text-faint">
                {fileSize(file.size)}
              </Text>
            ) : null}
          </View>
          {busy ? <ActivityIndicator size="small" color={muted} /> : null}
        </View>
      )}
    </Pressable>
  );
}

/**
 * A message's text with the files it links as cards under it; a link inside a sentence
 * stays there as the file's name.
 */
export function MessageContent({
  text,
  shared,
  by,
}: {
  text: string;
  shared: Map<string, StoredFile>;
  by: "human" | "agent";
}) {
  const read = useMemo(() => linkedFiles(text), [text]);
  return (
    <>
      {read.text ? <MessageBody text={read.text} /> : null}
      {read.files.map((link) => (
        <FileCard
          key={link.id}
          link={link}
          file={shared.get(link.id)}
          by={by}
        />
      ))}
    </>
  );
}
