import { useVideoPlayer, VideoView } from "expo-video";
import { ChevronRightIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  cardFileNamed,
  cardFileUrl,
  errorMessage,
  readCardText,
} from "@zerolux/chat";
import type { CardFile, ExtensionCard } from "@zerolux/chat";
import { MessageBody } from "@/components/message-body";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";

/** A card's video, still until it is played: the system's own player, its controls and sound. */
function Video({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
      style={{ width: 300, aspectRatio: 16 / 10 }}
    />
  );
}

/** A card's images and video, side by side: the video first, as the one to watch. */
export function Gallery({ card }: { card?: ExtensionCard | null }) {
  const { url } = useSession();
  const media = [...(card?.media ?? [])]
    .filter((file) => file.kind === "image" || file.kind === "video")
    .sort((a, b) => Number(b.kind === "video") - Number(a.kind === "video"));
  if (!media.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="-mx-4 grow-0"
      contentContainerClassName="gap-2.5 px-4"
    >
      {media.map((file) => (
        <View
          key={file.sha256}
          className="overflow-hidden rounded-xl border border-border bg-muted"
        >
          {file.kind === "video" ? (
            <Video uri={cardFileUrl(file, url)} />
          ) : (
            <Image
              source={{ uri: cardFileUrl(file, url) }}
              accessibilityLabel={file.name}
              resizeMode="cover"
              style={{ width: 300, aspectRatio: 16 / 10 }}
            />
          )}
        </View>
      ))}
    </ScrollView>
  );
}

/** A card's Markdown, read from the kernel once per file. */
function useCardText(file?: CardFile | null) {
  const { url } = useSession();
  const [read, setRead] = useState<{
    sha256: string;
    text?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (!file) return;
    let shown = true;
    readCardText(file, url).then(
      (text) => shown && setRead({ sha256: file.sha256, text }),
      (e: unknown) =>
        shown && setRead({ sha256: file.sha256, error: errorMessage(e) }),
    );
    return () => {
      shown = false;
    };
    // The file is read for its digest, not for being a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.sha256, url]);
  return file && read?.sha256 === file.sha256 ? read : undefined;
}

/** A card's README or CHANGELOG, its images from the card's own files. */
export function CardText({
  card,
  file,
}: {
  card: ExtensionCard;
  file: CardFile;
}) {
  const { url } = useSession();
  const read = useCardText(file);
  if (!read) return <Text className="text-sm text-faint">Reading it…</Text>;
  if (read.error)
    return <Text className="text-sm text-destructive">{read.error}</Text>;
  return (
    <MessageBody
      text={read.text ?? ""}
      picture={(src) => {
        const named = cardFileNamed(card, src);
        return named?.kind === "image" ? cardFileUrl(named, url) : undefined;
      }}
    />
  );
}

const linkLabels = {
  homepage: "Website",
  repository: "Source",
  issues: "Report a problem",
  privacy: "Privacy",
} as const;

/** A card's links, each opened in the browser. */
export function CardLinks({ card }: { card?: ExtensionCard | null }) {
  const faint = String(useCSSVariable("--color-faint"));
  const links = (Object.keys(linkLabels) as (keyof typeof linkLabels)[])
    .map((key) => [key, card?.links?.[key]] as const)
    .filter((link): link is [keyof typeof linkLabels, string] =>
      Boolean(link[1]),
    );
  if (!links.length) return null;
  return (
    <View className="overflow-hidden rounded-xl border border-border bg-card">
      {links.map(([key, href], i) => (
        <Pressable
          key={key}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(href)}
          className={cn(
            "flex-row items-center gap-3 px-3.5 py-3 active:bg-accent",
            i > 0 && "border-t border-border",
          )}
        >
          <Text className="flex-1 text-[15px]">{linkLabels[key]}</Text>
          <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
        </Pressable>
      ))}
    </View>
  );
}
