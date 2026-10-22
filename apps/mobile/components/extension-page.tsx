import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  disableExtension,
  enableExtension,
  errorMessage,
  extensionsNotice,
  loadExtensionFolder,
  marketplaceName,
  offerAction,
  offerFor,
  useActions,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type { Extension, ExtensionAction } from "@zerolux/chat";
import { Menu } from "@/components/action-menu";
import { CardLinks, CardText, Gallery } from "@/components/extension-card";
import {
  Chip,
  ExtensionIcon,
  ExtensionSettings,
  Group,
  categoryName,
  partOf,
  removeInstalled,
  StateChip,
  useProposer,
} from "@/components/extensions";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";
import { dismissNotice } from "../src/notices";

type Tab = "Overview" | "Access" | "Settings" | "Versions";

/** Where each space shows an extension's interface on the phone. */
const spaces: Record<string, string> = {
  page: "A page, under More",
  session: "Beside a session's work",
  chat: "In a chat's About",
  message: "In a message's menu",
  settings: "In the workspace's settings",
};

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

function Row({
  first,
  children,
  onPress,
}: {
  first: boolean;
  children: ReactNode;
  onPress?: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const className = cn(
    "flex-row items-center gap-3 px-3.5 py-3",
    !first && "border-t border-border",
    onPress && "active:bg-accent",
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={className}
    >
      {children}
      <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
    </Pressable>
  ) : (
    <View className={className}>{children}</View>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <Text className="flex-1 text-[15px] text-muted-foreground">{label}</Text>
      <Text
        numberOfLines={1}
        className={cn("shrink text-[15px]", mono && "font-mono text-[13px]")}
      >
        {value}
      </Text>
    </>
  );
}

/** What an action does, by its effect. */
function Effect({ action }: { action: Pick<ExtensionAction, "effects"> }) {
  return (
    <Chip tone={action.effects === "read" ? undefined : "attention"}>
      {action.effects}
    </Chip>
  );
}

function Proposer({ extension }: { extension: Extension }) {
  const agent = useProposer(extension);
  return (
    <Text className="text-[13px] text-agent-foreground">
      Proposed by {agent}
    </Text>
  );
}

/**
 * An extension's page, installed or offered: who made it and where it comes from, what it
 * does, what it contains and can reach, its settings, its versions. The owner installs,
 * updates, enables or removes it; Install and Update ask first.
 */
export default function ExtensionPage() {
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const { extensions, error } = useExtensions(url);
  const { marketplace } = useMarketplace(url, owner);
  const actions = useActions(url).actions?.filter((a) => a.extension === id);
  const [tab, setTab] = useState<Tab>("Overview");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // Its proposal's notification goes once you look at it.
  useEffect(() => dismissNotice(`extension:${id}`), [id]);
  const installed = extensions?.find((e) => e.id === id);
  const offers = marketplace?.offers ?? [];
  const offer = installed
    ? offerFor(installed, offers)
    : offers.find((o) => o.id === id && (!index || o.index === index));
  const update =
    installed &&
    !installed.proposed_by &&
    offer &&
    offerAction(offer) === "update"
      ? offer
      : undefined;
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure("");
    work()
      .then(extensionsNotice)
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const consent = () =>
    router.push({
      pathname: "/consent",
      params: { id, ...(offer && !installed ? { index: offer.index } : {}) },
    });
  const shown = installed ?? offer;
  if (!shown)
    return (
      <Screen back title="Extension">
        <Text className="px-5 pt-2 text-sm text-faint">
          {error || (extensions ? "This extension is gone." : "Reading it…")}
        </Text>
      </Screen>
    );
  const parts = installed?.parts ?? offer?.parts ?? [];
  // What it says of itself: its own folder's card once installed, the index's before.
  const card = installed?.card ?? offer?.card;
  const from = (index: string) => marketplaceName(index, marketplace);
  const pieces = installed?.contributes?.ui ?? [];
  const tabs: Tab[] = [
    "Overview",
    "Access",
    ...(owner && installed?.settings.length ? (["Settings"] as const) : []),
    "Versions",
  ];
  const remove = () =>
    Alert.alert(`Remove ${shown.name}?`, "Its settings and data are deleted.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          act(async () => {
            await removeInstalled(installed!, url);
            router.back();
          }),
      },
    ]);
  const primary = !owner ? null : !installed ? (
    <Button size="lg" className="flex-1" onPress={consent}>
      <Text>Install</Text>
    </Button>
  ) : installed.proposed_by ? (
    <Button size="lg" className="flex-1" onPress={consent}>
      <Text>Review and install</Text>
    </Button>
  ) : update ? (
    <Button size="lg" className="flex-1" onPress={consent}>
      <Text>Update to {update.version}</Text>
    </Button>
  ) : installed.dev ? (
    <Button
      size="lg"
      variant="outline"
      className="flex-1"
      disabled={busy}
      onPress={() => act(() => loadExtensionFolder(installed.source, url))}
    >
      <Text>Load again</Text>
    </Button>
  ) : !installed.enabled ? (
    <Button
      size="lg"
      className="flex-1"
      disabled={busy}
      onPress={() => act(() => enableExtension(installed.id, url))}
    >
      <Text>Enable</Text>
    </Button>
  ) : null;
  const menu =
    owner && installed
      ? [
          ...(installed.enabled && !installed.proposed_by
            ? [
                {
                  title: "Disable",
                  onPress: () => act(() => disableExtension(installed.id, url)),
                },
              ]
            : []),
          {
            title: installed.proposed_by ? "Decline" : "Remove",
            tone: "danger" as const,
            onPress: remove,
          },
        ]
      : [];
  return (
    <Screen
      back
      title=""
      action={menu.length ? <Menu label="More" items={menu} /> : undefined}
    >
      <ScrollView contentContainerClassName="gap-4 px-4 pt-3 pb-32">
        <View className="flex-row items-center gap-3.5">
          <ExtensionIcon id={shown.id} name={shown.name} card={card} large />
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-baseline gap-1.5">
              <Text numberOfLines={1} className="shrink text-[22px] font-bold">
                {shown.name}
              </Text>
              <Text className="font-mono text-xs text-faint">
                {installed?.version ?? offer?.version}
              </Text>
            </View>
            <Text className="text-[13px] text-muted-foreground">
              {[
                shown.publisher,
                installed?.dev
                  ? "From a folder"
                  : offer
                    ? from(offer.index)
                    : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {installed?.proposed_by ? (
              <Proposer extension={installed} />
            ) : installed ? (
              <StateChip extension={installed} offer={update} />
            ) : null}
          </View>
        </View>
        {card?.summary || shown.description ? (
          <Text className="text-[15px] leading-[22px] text-muted-foreground">
            {card?.summary || shown.description}
          </Text>
        ) : null}
        {card?.categories.length ? (
          <View className="flex-row flex-wrap gap-1.5">
            {card.categories.map((id) => (
              <Chip key={id}>{categoryName(id)}</Chip>
            ))}
          </View>
        ) : null}
        {primary ? <View className="flex-row">{primary}</View> : null}
        {update ? (
          <View className="rounded-xl border border-attention/40 bg-attention/10 px-3.5 py-3">
            <Text className="text-sm">
              <Text className="text-sm font-semibold">
                {update.version === installed!.version
                  ? "A new build is available"
                  : `${update.version} is available`}
              </Text>
              {` · from ${from(update.index)}`}
            </Text>
          </View>
        ) : null}
        {installed?.error ? (
          <Text className="text-sm text-destructive">{installed.error}</Text>
        ) : null}
        <Gallery card={card} />
        {failure ? (
          <Text className="text-sm text-destructive">{failure}</Text>
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="-mx-4 grow-0 border-b border-border"
          contentContainerClassName="gap-5 px-4"
        >
          {tabs.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === name }}
              onPress={() => setTab(name)}
              className={cn(
                "py-2.5",
                tab === name && "border-b-2 border-foreground",
              )}
            >
              <Text
                className={cn(
                  "text-[15px]",
                  tab === name ? "font-semibold" : "text-muted-foreground",
                )}
              >
                {name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {tab === "Overview" ? (
          <>
            {card?.readme ? <CardText card={card} file={card.readme} /> : null}
            {installed && Object.keys(installed.dependencies).length ? (
              <Text className="text-sm text-muted-foreground">
                Needs{" "}
                {Object.entries(installed.dependencies)
                  .map(([name, range]) => `${name} ${range}`)
                  .join(", ")}
              </Text>
            ) : null}
            <Group label="Information">
              <Row first>
                <Fact
                  label="Version"
                  value={installed?.version ?? offer!.version}
                  mono
                />
              </Row>
              <Row first={false}>
                <Fact label="Publisher" value={shown.publisher} />
              </Row>
              {offer ? (
                <Row first={false}>
                  <Fact label="From" value={from(offer.index)} />
                </Row>
              ) : installed?.dev ? (
                <Row first={false}>
                  <Fact label="Folder" value={installed.source} mono />
                </Row>
              ) : null}
              {installed ? (
                <>
                  <Row first={false}>
                    <Fact
                      label="Installed"
                      value={day(installed.installed_at)}
                    />
                  </Row>
                  <Row first={false}>
                    <Fact label="Updated" value={day(installed.updated_at)} />
                  </Row>
                </>
              ) : null}
              {card?.license ? (
                <Row first={false}>
                  <Fact label="License" value={card.license} mono />
                </Row>
              ) : null}
            </Group>
            {card?.keywords.length ? (
              <View className="flex-row flex-wrap gap-1.5">
                {card.keywords.map((word) => (
                  <Chip key={word}>{word}</Chip>
                ))}
              </View>
            ) : null}
            <CardLinks card={card} />
          </>
        ) : tab === "Access" ? (
          <>
            <Group label="What it contains">
              {parts.length ? (
                parts.map((part, i) => (
                  <Row key={part} first={i === 0}>
                    <View className="min-w-0 flex-1">
                      <Text className="text-[15px] font-medium">
                        {partOf(part).title}
                      </Text>
                      <Text className="text-[13px] text-muted-foreground">
                        {partOf(part).text}
                      </Text>
                    </View>
                  </Row>
                ))
              ) : (
                <Row first>
                  <Text className="text-[15px] text-muted-foreground">
                    Its actions only
                  </Text>
                </Row>
              )}
            </Group>
            {actions?.length || installed?.contributes?.actions.length ? (
              <Group
                label="What it can do"
                count={(actions ?? installed?.contributes?.actions)?.length}
              >
                {(actions ?? installed!.contributes!.actions).map(
                  (action, i) => (
                    <Row
                      key={action.name}
                      first={i === 0}
                      // An enabled extension's actions run from here.
                      onPress={
                        actions?.length
                          ? () =>
                              router.push({
                                pathname: "/action",
                                params: {
                                  extension: shown.id,
                                  name: action.name,
                                },
                              })
                          : undefined
                      }
                    >
                      <View className="min-w-0 flex-1">
                        <Text className="text-[15px]">{action.title}</Text>
                        <Text className="font-mono text-xs text-faint">
                          {action.name}
                        </Text>
                      </View>
                      <Effect action={action} />
                    </Row>
                  ),
                )}
              </Group>
            ) : null}
            {pieces.length ? (
              <Group label="Where it shows">
                {pieces.map((piece, i) => (
                  <Row key={`${piece.space}/${piece.name}`} first={i === 0}>
                    <View className="min-w-0 flex-1">
                      <Text className="text-[15px] font-medium">
                        {piece.title}
                      </Text>
                      <Text className="text-[13px] text-muted-foreground">
                        {spaces[piece.space] ?? piece.space}
                      </Text>
                    </View>
                  </Row>
                ))}
              </Group>
            ) : null}
          </>
        ) : tab === "Settings" && installed ? (
          <ExtensionSettings extension={installed} kernel={url} />
        ) : (
          <>
            <Group>
              {installed ? (
                <Row first>
                  <Fact label="Installed" value={installed.version} mono />
                </Row>
              ) : null}
              {offer ? (
                <Row first={!installed}>
                  <Fact
                    label={`From ${from(offer.index)}`}
                    value={offer.version}
                    mono
                  />
                </Row>
              ) : null}
            </Group>
            {card?.changelog ? (
              <CardText card={card} file={card.changelog} />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
