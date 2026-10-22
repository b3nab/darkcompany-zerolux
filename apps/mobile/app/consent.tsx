import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import {
  consentParts,
  enableExtension,
  errorMessage,
  extensionsNotice,
  installOffer,
  marketplaceName,
  offerAction,
  offerFor,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type { Extension } from "@zerolux/chat";
import {
  Chip,
  ExtensionIcon,
  partOf,
  useProposer,
} from "@/components/extensions";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/** Who wrote a proposal and from where, as the consent says it. */
function Proposed({ extension }: { extension: Extension }) {
  const agent = useProposer(extension);
  return (
    <Fact label="Proposed by" value={agent}>
      <Text className="text-xs text-faint">
        From the folder {extension.source}, signed by no one: it is shown as
        written by {agent}.
      </Text>
    </Fact>
  );
}

function Fact({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <View className="gap-0.5">
      <View className="flex-row gap-3">
        <Text className="w-24 text-sm text-muted-foreground">{label}</Text>
        <Text className="flex-1 text-sm">{value}</Text>
      </View>
      {children}
    </View>
  );
}

const doing = {
  Install: "Installing…",
  Update: "Updating…",
  Enable: "Enabling…",
};

/**
 * Installing, updating or enabling an extension, said before it is done: who signed it and
 * where it comes from, what it runs, and in an update only what changes.
 */
export default function Consent() {
  const { id, index } = useLocalSearchParams<{ id: string; index?: string }>();
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const { extensions } = useExtensions(url);
  const { marketplace } = useMarketplace(url, owner);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const installed = extensions?.find((e) => e.id === id);
  const proposal = installed?.proposed_by ? installed : undefined;
  const offers = marketplace?.offers ?? [];
  const offer = proposal
    ? undefined
    : installed
      ? offerFor(installed, offers)
      : offers.find((o) => o.id === id && (!index || o.index === index));
  const subject = proposal ?? offer;
  if (!subject)
    return (
      <View className="bg-background p-6">
        <Text className="text-sm text-faint">
          {extensions && marketplace
            ? "This extension is gone."
            : "Reading it…"}
        </Text>
      </View>
    );
  const update = Boolean(offer && installed && offerAction(offer) === "update");
  const verb = proposal ? "Enable" : update ? "Update" : "Install";
  const changes = proposal
    ? proposal.parts.map((part) => ({ part, change: "new" as const }))
    : consentParts(offer!, installed);
  const shown = update ? changes.filter((c) => c.change !== "kept") : changes;
  const kept = update ? changes.filter((c) => c.change === "kept") : [];
  const confirm = () => {
    setBusy(true);
    setFailure("");
    (proposal ? enableExtension(proposal.id, url) : installOffer(offer!, url))
      .then(() => {
        extensionsNotice();
        router.back();
      })
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <ScrollView
      className="bg-background"
      contentContainerClassName="gap-4 px-5 pt-6 pb-8"
    >
      <View className="flex-row items-center gap-3">
        <ExtensionIcon
          id={subject.id}
          name={subject.name}
          card={subject.card}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-[19px] font-semibold">
            {verb} {subject.name}
            {update ? ` to ${offer!.version}` : ""}?
          </Text>
          <Text className="font-mono text-xs text-muted-foreground">
            {update
              ? `${installed!.version} → ${offer!.version}`
              : subject.version}
          </Text>
        </View>
      </View>
      <View className="gap-2 rounded-xl bg-muted px-3.5 py-3">
        {proposal ? (
          <Proposed extension={proposal} />
        ) : (
          <>
            <Fact label="Signed by" value={offer!.publisher} />
            <Fact
              label="From"
              value={marketplaceName(offer!.index, marketplace)}
            />
          </>
        )}
      </View>
      <View className="gap-2">
        <Text className="text-[15px] font-semibold">
          {update ? "What changes" : "It will run"}
        </Text>
        {shown.length ? (
          <View className="overflow-hidden rounded-xl border border-border bg-card">
            {shown.map(({ part, change }, i) => (
              <View
                key={part}
                className={cn(
                  "flex-row items-center gap-3 px-3.5 py-3",
                  i > 0 && "border-t border-border",
                )}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-[15px]">{partOf(part).title}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {partOf(part).text}
                  </Text>
                </View>
                {update ? (
                  <Chip tone={change === "gone" ? "off" : "attention"}>
                    {change === "gone" ? "removed" : "new"}
                  </Chip>
                ) : null}
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-sm text-muted-foreground">
            {update
              ? "Nothing it runs changes."
              : "Nothing beyond its actions."}
          </Text>
        )}
        {kept.length ? (
          <Text className="text-[13px] text-muted-foreground">
            Unchanged: {kept.map((c) => partOf(c.part).title).join(", ")}.
          </Text>
        ) : null}
      </View>
      {failure ? (
        <Text className="text-sm text-destructive">{failure}</Text>
      ) : null}
      <View className="gap-2">
        <Button size="lg" disabled={busy || !owner} onPress={confirm}>
          <Text>{busy ? doing[verb] : verb}</Text>
        </Button>
        <Button variant="ghost" size="lg" onPress={() => router.back()}>
          <Text>Cancel</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
