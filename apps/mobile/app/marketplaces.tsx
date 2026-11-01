import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import {
  addMarketplace,
  errorMessage,
  removeMarketplace,
  useMarketplaces,
} from "@zerolux/chat";
import type { InstanceMarketplace } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useKernel } from "../src/kernel";

/**
 * Where every workspace of the kernel installs extensions from: this computer's own
 * marketplaces, which stay, and those the instance added, which its administrator adds and
 * removes.
 */
export default function Marketplaces() {
  const { here } = useKernel();
  const { marketplaces, administers, error } = useMarketplaces(
    here,
    Boolean(here),
  );
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  if (!here) return null;

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setFailure("");
    try {
      await work();
      return true;
    } catch (e) {
      setFailure(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add() {
    if (busy || !url.trim() || !here) return;
    if (await act(() => addMarketplace(here, url))) setUrl("");
  }
  const remove = (marketplace: InstanceMarketplace) =>
    Alert.alert(`Remove ${marketplace.name ?? marketplace.url}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => void act(() => removeMarketplace(here, marketplace.url)),
      },
    ]);

  return (
    <Screen back title="Marketplaces" subtitle={new URL(here).host}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 py-4"
      >
        {marketplaces === undefined && !error ? (
          <ActivityIndicator className="self-start" />
        ) : marketplaces === null ? (
          <Text className="text-sm text-muted-foreground">
            Update this kernel to manage its marketplaces.
          </Text>
        ) : marketplaces ? (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {marketplaces.length === 0 ? (
              <Text className="p-4 text-sm text-muted-foreground">
                No marketplaces.
              </Text>
            ) : null}
            {marketplaces.map((marketplace, i) => (
              <View
                key={marketplace.url}
                className={cn(
                  "min-h-14 flex-row items-center gap-3 px-3.5 py-2.5",
                  i > 0 && "border-t border-border",
                )}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text numberOfLines={1} className="text-[15px] font-medium">
                    {marketplace.name ??
                      (marketplace.computer
                        ? "This computer"
                        : marketplace.url)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="font-mono text-[12px] text-muted-foreground"
                  >
                    {marketplace.url}
                  </Text>
                </View>
                {administers && !marketplace.computer ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onPress={() => remove(marketplace)}
                  >
                    <Text className="text-destructive">Remove</Text>
                  </Button>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
        {administers ? (
          <View className="gap-2">
            <Text className="text-sm">Add a marketplace</Text>
            <Input
              accessibilityLabel="Marketplace address"
              value={url}
              onChangeText={setUrl}
              placeholder="https://… or file://…"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              editable={!busy}
              onSubmitEditing={() => void add()}
            />
            <Button disabled={busy || !url.trim()} onPress={() => void add()}>
              <Text>{busy ? "Adding…" : "Add"}</Text>
            </Button>
          </View>
        ) : null}
        {failure || error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {failure || error}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
