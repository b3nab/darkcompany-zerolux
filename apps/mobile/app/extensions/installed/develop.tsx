import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import {
  errorMessage,
  extensionsNotice,
  loadExtensionFolder,
  removeInstalled,
  useExtensions,
} from "@zerolux/chat";
import {
  ExtensionRow,
  Group,
  RowButton,
  StateChip,
} from "@/components/extensions";
import { FolderInput } from "@/components/folder-input";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../../../src/kernel";

/**
 * Extensions being written, from folders on the kernel's computer: loaded by their path, run
 * as written, signed by no one, and loaded again after a change.
 */
export default function Develop() {
  const { url } = useSession();
  const router = useRouter();
  const { extensions, error } = useExtensions(url);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState("");
  const loaded = extensions?.filter((e) => e.dev && !e.proposed_by);
  const act = (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setFailure("");
    return work()
      .then(extensionsNotice)
      .catch((e: unknown) => {
        setFailure(errorMessage(e));
        throw e;
      })
      .finally(() => setBusy(undefined));
  };
  const load = () =>
    folder.trim() &&
    act("folder", () => loadExtensionFolder(folder.trim(), url)).then(
      () => setFolder(""),
      () => {},
    );
  return (
    <Screen back large title="Develop">
      <ScrollView
        contentContainerClassName="gap-4 px-4 pb-32"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-muted-foreground">
          An extension from a folder on the kernel's computer runs as written,
          signed by no one.
        </Text>
        <View className="gap-2">
          <FolderInput value={folder || null} onChange={setFolder} />
          <Button
            disabled={Boolean(busy) || !folder.trim()}
            onPress={() => void load()}
            className="self-start"
          >
            <Text>{busy === "folder" ? "Loading…" : "Load"}</Text>
          </Button>
        </View>
        {error || failure ? (
          <Text className="text-sm text-destructive">{failure || error}</Text>
        ) : null}
        {loaded?.length ? (
          <Group label="Loaded from folders" count={loaded.length}>
            {loaded.map((extension, i) => (
              <ExtensionRow
                key={extension.id}
                id={extension.id}
                name={extension.name}
                card={extension.card}
                version={extension.version}
                publisher={extension.source}
                description={extension.error ?? ""}
                first={i === 0}
                onPress={() =>
                  router.push(`/extensions/installed/${extension.id}`)
                }
              >
                <StateChip extension={extension} />
                <RowButton
                  label={busy === extension.id ? "Loading…" : "Load again"}
                  variant="outline"
                  disabled={Boolean(busy)}
                  onPress={() =>
                    void act(extension.id, () =>
                      loadExtensionFolder(extension.source, url),
                    ).catch(() => {})
                  }
                />
                <RowButton
                  label="Remove"
                  variant="ghost"
                  danger
                  disabled={Boolean(busy)}
                  onPress={() =>
                    Alert.alert(`Remove ${extension.name}?`, undefined, [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: () =>
                          void act(extension.id, () =>
                            removeInstalled(extension, url),
                          ).catch(() => {}),
                      },
                    ])
                  }
                />
              </ExtensionRow>
            ))}
          </Group>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
