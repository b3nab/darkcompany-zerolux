import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  consentParts,
  errorMessage,
  extensionGroups,
  extensionsNotice,
  marketplaceName,
  offerVersions,
  updateExtensions,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type { UpdatesDone } from "@zerolux/chat";
import { Chip, ExtensionIcon, partOf } from "@/components/extensions";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/**
 * Every update the workspace waits for, asked once: each extension with its versions, who
 * signed it and only what changes in what it runs. Only those shown are updated; then each
 * says what it did.
 */
export default function UpdateAll() {
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const { extensions } = useExtensions(url);
  const { marketplace } = useMarketplace(url, owner);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState<UpdatesDone>();
  const waiting =
    extensions && marketplace
      ? extensionGroups(extensions, marketplace.offers).updates
      : undefined;
  // What was asked stays on the sheet with its outcome, once the updates leave the list.
  const [asked, setAsked] = useState<typeof waiting>();
  const updates = asked ?? waiting;
  if (!updates?.length)
    return (
      <View className="bg-background p-6">
        <Text className="text-sm text-faint">
          {updates ? "Everything is up to date." : "Reading them…"}
        </Text>
      </View>
    );
  const confirm = () => {
    setBusy(true);
    setFailure("");
    setAsked(updates);
    updateExtensions(
      updates.map(({ extension }) => extension.id),
      url,
    )
      .then((result) => {
        setDone(result);
        extensionsNotice();
      })
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <ScrollView
      className="bg-background"
      contentContainerClassName="gap-4 px-5 pt-6 pb-8"
    >
      <Text className="text-[19px] font-semibold">
        {done
          ? `${done.updated.length} of ${updates.length} updated`
          : `Update ${updates.length} extensions?`}
      </Text>
      <View className="overflow-hidden rounded-xl border border-border bg-card">
        {updates.map(({ extension, offer }, i) => {
          const changes = consentParts(offer, extension).filter(
            (c) => c.change !== "kept",
          );
          const updated = done?.updated.find((u) => u.id === extension.id);
          const failed = done?.failed.find((f) => f.id === extension.id);
          return (
            <View
              key={extension.id}
              className={cn(
                "gap-2 px-3.5 py-3",
                i > 0 && "border-t border-border",
              )}
            >
              <View className="flex-row items-center gap-3">
                <ExtensionIcon
                  id={extension.id}
                  name={extension.name}
                  card={extension.card}
                />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-[15px] font-semibold">
                    {extension.name}
                  </Text>
                  <Text className="font-mono text-xs text-muted-foreground">
                    {offerVersions(offer)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="text-xs text-muted-foreground"
                  >
                    {`${offer.publisher} · ${marketplaceName(offer.index, marketplace)}`}
                  </Text>
                </View>
                {updated ? (
                  <Chip tone="on">Updated</Chip>
                ) : failed ? (
                  <Chip tone="error">Failed</Chip>
                ) : null}
              </View>
              {failed ? (
                <Text className="text-[13px] text-destructive">
                  {failed.error}
                </Text>
              ) : done ? null : changes.length ? (
                <View className="flex-row flex-wrap gap-1.5">
                  {changes.map(({ part, change }) => (
                    <Chip
                      key={part}
                      tone={change === "gone" ? "off" : "attention"}
                    >
                      {`${partOf(part).title} ${change === "gone" ? "removed" : "new"}`}
                    </Chip>
                  ))}
                </View>
              ) : (
                <Text className="text-[13px] text-muted-foreground">
                  Nothing it runs changes.
                </Text>
              )}
            </View>
          );
        })}
      </View>
      {failure ? (
        <Text className="text-sm text-destructive">{failure}</Text>
      ) : null}
      {done ? (
        <Button size="lg" onPress={() => router.back()}>
          <Text>Done</Text>
        </Button>
      ) : (
        <View className="gap-2">
          <Button size="lg" disabled={busy || !owner} onPress={confirm}>
            <Text>{busy ? "Updating…" : "Update all"}</Text>
          </Button>
          <Button variant="ghost" size="lg" onPress={() => router.back()}>
            <Text>Cancel</Text>
          </Button>
        </View>
      )}
    </ScrollView>
  );
}
