import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import {
  ago,
  errorMessage,
  extensionsNotice,
  removeExtension,
  useExtensions,
} from "@zerolux/chat";
import type { Extension } from "@zerolux/chat";
import { ExtensionsMenu } from "@/components/extensions-menu";
import {
  Chip,
  ExtensionIcon,
  partOf,
  useProposer,
} from "@/components/extensions";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../../../src/kernel";
import { useMe } from "../../../src/me";

/** An agent's proposal: who proposed it, what it does and runs, and where it comes from. */
function Proposal({
  extension,
  busy,
  decline,
}: {
  extension: Extension;
  busy: boolean;
  decline: () => void;
}) {
  const router = useRouter();
  const { owner } = useMe();
  const agent = useProposer(extension);
  const actions = extension.contributes?.actions ?? [];
  const open = () => router.push(`/extensions/proposals/${extension.id}`);
  return (
    // Opened by a touch anywhere; to those who hear the screen, by its name.
    <Pressable
      accessible={false}
      onPress={open}
      className="flex-row gap-3 rounded-xl border border-border bg-card p-3.5 active:bg-accent"
    >
      <ExtensionIcon
        id={extension.id}
        name={extension.name}
        card={extension.card}
      />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-baseline gap-1.5">
          <Text
            accessibilityRole="button"
            onPress={open}
            numberOfLines={1}
            className="shrink text-[15px] font-semibold"
          >
            {extension.name}
          </Text>
          <Text className="font-mono text-xs text-faint">
            {extension.version}
          </Text>
        </View>
        <Text className="text-[13px] text-agent-foreground">
          Proposed by {agent} · {ago(extension.installed_at)}
        </Text>
        {extension.description ? (
          <Text className="text-[13px] text-muted-foreground">
            {extension.description}
          </Text>
        ) : null}
        <View className="mt-1 flex-row flex-wrap gap-1.5">
          {extension.parts.map((part) => (
            <Chip key={part}>{partOf(part).title}</Chip>
          ))}
          {actions.map((action) => (
            <Chip
              key={action.name}
              tone={action.effects === "read" ? undefined : "attention"}
            >
              {`${action.name} · ${action.effects}`}
            </Chip>
          ))}
        </View>
        <Text className="mt-1 text-xs text-faint">
          From the folder {extension.source}, signed by no one: it is shown as
          written by {agent}.
        </Text>
        {owner ? (
          <View className="mt-2 flex-row gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={busy}
              onPress={() =>
                router.push({
                  pathname: "/consent",
                  params: { id: extension.id },
                })
              }
            >
              <Text>Review and install</Text>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onPress={() =>
                Alert.alert(`Decline ${extension.name}?`, undefined, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Decline", style: "destructive", onPress: decline },
                ])
              }
            >
              <Text>Decline</Text>
            </Button>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Extensions agents proposed, waiting for the owner: nothing runs before they are enabled. */
export default function Proposals() {
  const { url } = useSession();
  const { extensions, error } = useExtensions(url);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState("");
  const proposals = extensions?.filter((e) => e.proposed_by);
  const decline = (id: string) => {
    setBusy(id);
    setFailure("");
    removeExtension(id, url)
      .then(extensionsNotice)
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(undefined));
  };
  return (
    <Screen back large title="Extensions" action={<ExtensionsMenu />}>
      <ScrollView contentContainerClassName="gap-3 px-4 pb-32">
        {error || failure ? (
          <Text className="text-sm text-destructive">{failure || error}</Text>
        ) : null}
        {!proposals ? (
          <Text className="text-sm text-faint">Reading the proposals…</Text>
        ) : proposals.length ? (
          proposals.map((extension) => (
            <Proposal
              key={extension.id}
              extension={extension}
              busy={busy === extension.id}
              decline={() => decline(extension.id)}
            />
          ))
        ) : (
          <Text className="text-sm text-faint">
            No agent proposes anything.
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}
