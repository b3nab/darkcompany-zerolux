import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { CloudUploadIcon, FolderIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import { ago, fileSize, fileUrl } from "@zerolux/chat";
import type { StoredFile } from "@zerolux/chat";
import { FileGlyph } from "@/components/file";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";

type Tab = "all" | "people" | "agents";

/** Reads picked files into named Blobs, each with its own type, ready to upload. */
async function read(assets: DocumentPicker.DocumentPickerAsset[]) {
  return Promise.all(
    assets.map(async (asset) => {
      const blob = await (await fetch(asset.uri)).blob();
      const typed =
        asset.mimeType && blob.type !== asset.mimeType
          ? new Blob([blob], { type: asset.mimeType })
          : blob;
      return Object.assign(typed, { name: asset.name });
    }),
  );
}

/** The company's shared files, uploaded by people or written by agents. */
export default function Storage() {
  const { storage, workspace, chat } = useSession();
  const [tab, setTab] = useState<Tab>("all");
  const [folder, setFolder] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ink, faint] = useCSSVariable([
    "--color-primary-foreground",
    "--color-faint",
  ]);
  const actor = (id: string) => workspace?.actors.find((a) => a.id === id);
  const byPerson = (file: StoredFile) =>
    actor(file.created_by)?.kind === "human";
  const files = storage.files
    .filter((f) => tab === "all" || byPerson(f) === (tab === "people"))
    .filter((f) => folder === undefined || f.folder === folder)
    .sort((a, b) => b.updated_at - a.updated_at);
  const folders = [
    ...new Set(storage.files.map((f) => f.folder).filter(Boolean)),
  ].sort();

  async function upload() {
    const picked = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    setBusy(true);
    await storage.upload(await read(picked.assets), { folder });
    setBusy(false);
  }

  return (
    <Screen
      back
      title="Storage"
      subtitle={`${storage.files.length} files`}
      action={
        <Button
          size="sm"
          disabled={!storage.available || busy}
          onPress={() => void upload()}
        >
          <CloudUploadIcon color={String(ink)} size={16} />
          <Text>{busy ? "Uploading…" : "Upload"}</Text>
        </Button>
      }
    >
      <View className="flex-row gap-5 border-b border-border px-5">
        {(
          [
            ["all", "All files"],
            ["people", "By people"],
            ["agents", "By agents"],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === id }}
            className={cn(
              "-mb-px border-b-2 py-2.5",
              tab === id ? "border-primary" : "border-transparent",
            )}
          >
            <Text
              className={cn(
                "text-sm",
                tab === id ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerClassName="gap-4 px-5 py-4 pb-10">
        {storage.error ? (
          <Text className="text-sm text-destructive">{storage.error}</Text>
        ) : null}
        {folders.length > 0 && (
          <ScrollView horizontal contentContainerClassName="gap-2">
            {folders.map((name) => (
              <Pressable
                key={name}
                onPress={() => setFolder(folder === name ? undefined : name)}
                className={cn(
                  "h-10 flex-row items-center gap-2 rounded-md border bg-card px-3",
                  folder === name ? "border-primary/50" : "border-border",
                )}
              >
                <FolderIcon color={String(faint)} size={16} />
                <Text className="text-sm font-medium">{name}</Text>
                <Text className="font-mono text-xs text-faint">
                  {storage.files.filter((f) => f.folder === name).length}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <View className="rounded-md border border-border bg-card">
          {files.map((file, i) => {
            const by = actor(file.created_by);
            const where = chat.conversations.find(
              (c) => c.id === file.conversation_id,
            );
            return (
              <Pressable
                key={file.id}
                onPress={() => void Linking.openURL(fileUrl(file))}
                className={cn(
                  "flex-row items-center gap-3 px-4 py-3 active:bg-accent",
                  i > 0 && "border-t border-border",
                )}
              >
                <FileGlyph
                  file={file}
                  by={by?.kind === "human" ? "human" : "agent"}
                />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text numberOfLines={1} className="text-sm">
                    {file.name}
                  </Text>
                  <Text numberOfLines={1} className="text-xs text-faint">
                    {[
                      by?.name ?? "Unknown",
                      where?.title ?? file.folder,
                      fileSize(file.size),
                      ago(file.updated_at),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {files.length === 0 && (
            <Text className="p-5 text-center text-sm text-muted-foreground">
              {!storage.available
                ? "This kernel has no storage yet."
                : storage.files.length === 0
                  ? "No files yet."
                  : "No files here."}
            </Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
