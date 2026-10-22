import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import {
  disableExtension,
  enableExtension,
  errorMessage,
  extensionsNotice,
  extensionGroups,
  loadExtensionFolder,
  removeInstalled,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type { Extension, MarketplaceOffer } from "@zerolux/chat";
import type { MenuItem } from "@zerolux/ui";
import { ExtensionsMenu } from "@/components/extensions-menu";
import { RowMenu } from "@/components/action-menu";
import {
  ExtensionRow,
  Group,
  matches,
  RowButton,
  StateChip,
} from "@/components/extensions";
import { Screen } from "@/components/screen";
import { SearchField } from "@/components/search-field";
import { Text } from "@/components/ui/text";
import { useSession } from "../../../src/kernel";
import { useMe } from "../../../src/me";

/**
 * What the workspace runs, by what it waits for: the updates first, then those running, those
 * disabled, and those loaded from a folder. A row opens the extension; its button does what
 * it waits for, and an update asks first.
 */
export default function Installed() {
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const { extensions, error, reload } = useExtensions(url);
  const { marketplace, reload: recheck } = useMarketplace(url, owner);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const groups = extensions
    ? extensionGroups(
        extensions.filter(matches(query)),
        marketplace?.offers ?? [],
      )
    : undefined;
  const updates = new Map(
    groups?.updates.map((u) => [u.extension.id, u.offer]),
  );
  const act = (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setFailure("");
    work()
      .then(extensionsNotice)
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(undefined));
  };
  const open = (id: string) => router.push(`/extensions/installed/${id}`);
  const consent = (id: string) =>
    router.push({ pathname: "/consent", params: { id } });
  const button = (extension: Extension, offer?: MarketplaceOffer) =>
    !owner ? null : offer ? (
      <RowButton label="Update" onPress={() => consent(extension.id)} />
    ) : extension.dev ? (
      <RowButton
        label={busy === extension.id ? "Loading…" : "Load again"}
        variant="outline"
        disabled={Boolean(busy)}
        onPress={() =>
          act(extension.id, () => loadExtensionFolder(extension.source, url))
        }
      />
    ) : !extension.enabled ? (
      <RowButton
        label={busy === extension.id ? "Enabling…" : "Enable"}
        variant="outline"
        disabled={Boolean(busy)}
        onPress={() =>
          act(extension.id, () => enableExtension(extension.id, url))
        }
      />
    ) : null;
  // The row's actions, held down: what its page and its button offer.
  const menu = (extension: Extension, offer?: MarketplaceOffer): MenuItem[] =>
    owner
      ? [
          { title: "Open", icon: "eye", onPress: () => open(extension.id) },
          ...(offer
            ? [
                {
                  title: "Update",
                  icon: "download",
                  onPress: () => consent(extension.id),
                },
              ]
            : []),
          ...(extension.dev
            ? [
                {
                  title: "Load again",
                  icon: "rotate-cw",
                  onPress: () =>
                    act(extension.id, () =>
                      loadExtensionFolder(extension.source, url),
                    ),
                },
              ]
            : []),
          extension.enabled
            ? {
                title: "Disable",
                icon: "power-off",
                onPress: () =>
                  act(extension.id, () => disableExtension(extension.id, url)),
              }
            : {
                title: "Enable",
                icon: "power",
                onPress: () =>
                  act(extension.id, () => enableExtension(extension.id, url)),
              },
          {
            title: "Remove",
            icon: "trash-2",
            tone: "danger",
            onPress: () =>
              Alert.alert(`Remove ${extension.name}?`, undefined, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () =>
                    act(extension.id, () => removeInstalled(extension, url)),
                },
              ]),
          },
        ]
      : [];
  const group = (label: string, list: Extension[]) =>
    list.length ? (
      <Group label={label} count={list.length}>
        {list.map((extension, i) => (
          <RowMenu
            key={extension.id}
            items={menu(extension, updates.get(extension.id))}
          >
            <ExtensionRow
              key={extension.id}
              id={extension.id}
              name={extension.name}
              card={extension.card}
              version={extension.version}
              publisher={extension.publisher}
              description={extension.description}
              first={i === 0}
              onPress={() => open(extension.id)}
            >
              <StateChip
                extension={extension}
                offer={updates.get(extension.id)}
              />
              {button(extension, updates.get(extension.id))}
            </ExtensionRow>
          </RowMenu>
        ))}
      </Group>
    ) : null;
  const single = groups?.updates.length === 1 ? groups.updates[0] : undefined;
  return (
    <Screen back large title="Extensions" action={<ExtensionsMenu />}>
      <ScrollView
        contentContainerClassName="gap-4 px-4 pb-32"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void Promise.all([reload(), recheck()]).finally(() =>
                setRefreshing(false),
              );
            }}
          />
        }
      >
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search installed"
        />
        {error || failure ? (
          <Text className="text-sm text-destructive">{failure || error}</Text>
        ) : null}
        {groups?.updates.length ? (
          <View className="flex-row items-center gap-3 rounded-xl border border-attention/40 bg-attention/10 px-3.5 py-3">
            <View className="min-w-0 flex-1">
              <Text className="text-[15px] font-semibold">
                {groups.updates.length === 1
                  ? "1 update available"
                  : `${groups.updates.length} updates available`}
              </Text>
              <Text
                numberOfLines={2}
                className="text-[13px] text-muted-foreground"
              >
                {groups.updates
                  .map(
                    ({ extension, offer }) =>
                      `${extension.name} ${offer.version}`,
                  )
                  .join(", ")}
              </Text>
            </View>
            {single && owner ? (
              <RowButton
                label="Update"
                onPress={() => consent(single.extension.id)}
              />
            ) : null}
          </View>
        ) : null}
        {!groups ? (
          <Text className="text-sm text-faint">Reading the extensions…</Text>
        ) : groups.active.length +
            groups.disabled.length +
            groups.development.length ===
          0 ? (
          <Text className="text-sm text-faint">
            {query ? "Nothing matches." : "No extension is installed."}
          </Text>
        ) : (
          <>
            {group("Active", groups.active)}
            {group("Disabled", groups.disabled)}
            {group("In development", groups.development)}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
