import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView } from "react-native";
import {
  extensionCategories,
  extensionGroups,
  marketplaceIndexes,
  marketplaceName,
  offerAction,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type { MarketplaceOffer } from "@zerolux/chat";
import {
  Chip,
  ExtensionRow,
  Group,
  categoryName,
  matches,
  partOf,
  RowButton,
  UpdatesBanner,
} from "@/components/extensions";
import { Screen } from "@/components/screen";
import { SearchField } from "@/components/search-field";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../../src/kernel";
import { useMe } from "../../../src/me";

/**
 * What the workspace's marketplaces offer, searched together. A row opens the extension;
 * Install and Update ask first.
 */
export default function Marketplace() {
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const { marketplace, error, reload } = useMarketplace(url, owner);
  const { extensions } = useExtensions(url);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const found = marketplace?.offers.filter(matches(query));
  const offers = found?.filter(
    (o) => !category || o.card?.categories.includes(category),
  );
  // The categories something is offered in, as many as there are.
  const categories = extensionCategories
    .map((c) => ({
      ...c,
      count:
        found?.filter((o) => o.card?.categories.includes(c.id)).length ?? 0,
    }))
    .filter((c) => c.count);
  const names = marketplaceIndexes(marketplace).map((index) =>
    marketplaceName(index, marketplace),
  );
  const chip = (label: string, on: boolean, choose: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={choose}
      className={cn(
        "h-8 justify-center rounded-full border px-3",
        on ? "border-foreground bg-foreground" : "border-border bg-card",
      )}
    >
      <Text
        className={cn(
          "text-[13px]",
          on ? "text-background" : "text-muted-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
  const params = (offer: MarketplaceOffer) => ({
    id: offer.id,
    index: offer.index,
  });
  const button = (offer: MarketplaceOffer) => {
    const action = offerAction(offer);
    return action === "installed" ? (
      <Chip>Installed</Chip>
    ) : (
      <RowButton
        label={action === "update" ? "Update" : "Install"}
        variant={action === "update" ? "default" : "secondary"}
        onPress={() =>
          router.push({ pathname: "/consent", params: params(offer) })
        }
      />
    );
  };
  return (
    <Screen back large title="Marketplace">
      <ScrollView
        contentContainerClassName="gap-4 px-4 pb-32"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void reload().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        {names.length ? (
          <Text className="text-sm text-muted-foreground">
            From {names.join(", ")}
          </Text>
        ) : null}
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search extensions and publishers"
        />
        {extensions && marketplace && !category ? (
          <UpdatesBanner
            updates={extensionGroups(extensions, marketplace.offers).updates}
          />
        ) : null}
        {categories.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-4 grow-0"
            contentContainerClassName="gap-2 px-4"
          >
            {chip(`All ${found?.length ?? 0}`, !category, () =>
              setCategory(undefined),
            )}
            {categories.map((c) =>
              chip(`${c.name} ${c.count}`, category === c.id, () =>
                setCategory(c.id),
              ),
            )}
          </ScrollView>
        ) : null}
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        {marketplace?.errors.map((failed) => (
          <Text
            key={failed.index}
            numberOfLines={3}
            className="text-xs text-destructive"
          >
            {failed.error}
          </Text>
        ))}
        {!offers ? (
          <Text className="text-sm text-faint">Reading the marketplaces…</Text>
        ) : offers.length ? (
          <Group>
            {offers.map((offer, i) => (
              <ExtensionRow
                key={`${offer.index} ${offer.id}`}
                id={offer.id}
                name={offer.name}
                card={offer.card}
                publisher={offer.publisher}
                description={offer.description}
                first={i === 0}
                onPress={() =>
                  router.push({
                    pathname: "/extensions/marketplace/[id]",
                    params: params(offer),
                  })
                }
              >
                {offer.card?.categories.length ? (
                  <Chip>{categoryName(offer.card.categories[0]!)}</Chip>
                ) : null}
                {(offer.parts ?? []).map((part) => (
                  <Chip key={part}>{partOf(part).title}</Chip>
                ))}
                {button(offer)}
              </ExtensionRow>
            ))}
          </Group>
        ) : (
          <Text className="text-sm text-faint">
            {query ? "Nothing matches." : "Nothing is offered."}
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}
