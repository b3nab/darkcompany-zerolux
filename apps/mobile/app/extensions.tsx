import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  errorMessage,
  installExtension,
  installOffer,
  loadExtensionFolder,
  offerAction,
  useExtensions,
  useMarketplace,
  useOfficialExtensions,
} from "@zerolux/chat";
import type { MarketplaceOffer } from "@zerolux/chat";
import { extensionState, StateDot } from "@/components/extensions";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/**
 * The workspace's extensions, each with what it is and how it stands; a tap opens it. The
 * owner installs the official ones ZeroLux brings and those the indexes offer, and loads one
 * from a folder on the kernel's computer, in development.
 */
export default function Extensions() {
  const { url } = useSession();
  const { owner } = useMe();
  const { extensions, error } = useExtensions(url);
  const available = useOfficialExtensions(url, owner).official?.filter(
    (e) => !e.installed,
  );
  const { marketplace } = useMarketplace(url, owner);
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  // What is being installed or loaded, while the kernel starts it.
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState("");
  const add = (what: string, work: () => Promise<{ id: string }>) => {
    setBusy(what);
    setFailure("");
    work()
      .then((extension) => router.push(`/extension/${extension.id}`))
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(undefined));
  };
  // Code that runs inside the kernel is installed only once its publisher is named.
  const install = (offer: MarketplaceOffer) => {
    const run = () =>
      add(`${offer.index} ${offer.id}`, () => installOffer(offer, url));
    if (!offer.parts?.includes("kernel")) return run();
    Alert.alert(
      `${offerAction(offer) === "update" ? "Update" : "Install"} ${offer.name}?`,
      `It runs inside the kernel, signed by ${offer.publisher}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: offerAction(offer) === "update" ? "Update" : "Install",
          onPress: run,
        },
      ],
    );
  };
  const load = (folder: string) =>
    folder.trim() && add(folder, () => loadExtensionFolder(folder.trim(), url));
  return (
    <Screen back title="Extensions">
      <ScrollView contentContainerClassName="gap-4 px-5 pb-10 pt-2">
        {error || failure ? (
          <Text className="text-sm text-destructive">{failure || error}</Text>
        ) : null}
        {extensions === undefined ? (
          <Text className="text-sm text-faint">Reading the extensions…</Text>
        ) : extensions.length === 0 ? (
          <Text className="text-sm text-faint">No extension is installed.</Text>
        ) : (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {extensions.map((extension, index) => {
              const state = extensionState(extension);
              return (
                <Pressable
                  key={extension.id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/extension/${extension.id}`)}
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3 active:bg-accent",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <StateDot extension={extension} />
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-[15px]">
                      {extension.name}
                    </Text>
                    <Text numberOfLines={1} className="text-xs text-faint">
                      {[
                        state.label,
                        extension.version,
                        extension.publisher,
                        extension.dev ? "In development" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
                </Pressable>
              );
            })}
          </View>
        )}
        {available?.length ? (
          <View className="gap-2">
            <Text className="text-sm text-faint">Available</Text>
            <View className="overflow-hidden rounded-md border border-border bg-card">
              {available.map((extension, index) => (
                <View
                  key={extension.id}
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-[15px]">
                      {extension.name}
                    </Text>
                    <Text numberOfLines={2} className="text-xs text-faint">
                      {extension.description}
                    </Text>
                  </View>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onPress={() =>
                      add(extension.id, () =>
                        installExtension(extension.id, url),
                      )
                    }
                  >
                    <Text>
                      {busy === extension.id ? "Installing…" : "Install"}
                    </Text>
                  </Button>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {marketplace?.offers.length || marketplace?.errors.length ? (
          <View className="gap-2">
            <Text className="text-sm text-faint">Marketplace</Text>
            {marketplace.offers.length ? (
              <View className="overflow-hidden rounded-md border border-border bg-card">
                {marketplace.offers.map((offer, index) => {
                  const action = offerAction(offer);
                  const key = `${offer.index} ${offer.id}`;
                  return (
                    <View
                      key={key}
                      className={cn(
                        "flex-row items-center gap-3 px-4 py-3",
                        index > 0 && "border-t border-border",
                      )}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text numberOfLines={1} className="text-[15px]">
                          {offer.name}
                        </Text>
                        <Text numberOfLines={1} className="text-xs text-faint">
                          {[
                            offer.publisher,
                            action === "update"
                              ? `${offer.installed} → ${offer.version}`
                              : offer.version,
                            offer.parts?.includes("kernel") ? "Kernel" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                        {offer.description ? (
                          <Text
                            numberOfLines={2}
                            className="text-xs text-muted-foreground"
                          >
                            {offer.description}
                          </Text>
                        ) : null}
                      </View>
                      <Button
                        size="sm"
                        variant={action === "update" ? "default" : "outline"}
                        disabled={Boolean(busy) || action === "installed"}
                        onPress={() => install(offer)}
                      >
                        <Text>
                          {busy === key
                            ? action === "update"
                              ? "Updating…"
                              : "Installing…"
                            : action === "update"
                              ? "Update"
                              : action === "install"
                                ? "Install"
                                : "Installed"}
                        </Text>
                      </Button>
                    </View>
                  );
                })}
              </View>
            ) : null}
            {marketplace.errors.map((failed) => (
              <Text
                key={failed.index}
                numberOfLines={2}
                className="text-xs text-destructive"
              >
                {failed.error}
              </Text>
            ))}
          </View>
        ) : null}
        {owner && Platform.OS === "ios" ? (
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onPress={() =>
              Alert.prompt(
                "Load from a folder",
                "On the kernel's computer",
                load,
                "plain-text",
              )
            }
          >
            <Text>Load from a folder</Text>
          </Button>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
