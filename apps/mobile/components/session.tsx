import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { PinIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import {
  ago,
  errorMessage,
  folderName,
  harnessLabels,
  sessionState,
  sessionTone,
} from "@zerolux/chat";
import type { Actor, Approval, Attention, ChatSession } from "@zerolux/chat";
import { ActorMark, Fact, Lamp } from "@/components/member";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";
import { useMe } from "@/src/me";

/** Pin, archive and rename a session, keeping the kernel's reason when it refuses. */
export function useOrganize(session: ChatSession) {
  const { chat } = useSession();
  const change = (update: Parameters<typeof chat.updateSession>[1]) =>
    void chat
      .updateSession(session.id, update)
      .catch((e) => Alert.alert("Not changed", errorMessage(e)));
  return {
    pinned: Boolean(session.pinned_at),
    archived: Boolean(session.archived_at),
    pin: () => change({ pinned: !session.pinned_at }),
    archive: () => change({ archived: !session.archived_at }),
    rename: (title: string) => change({ title: title.trim() }),
  };
}

/**
 * One session as the Console's inbox lists it, like a chat in the list of chats: its agent
 * (or its title, without one) and harness, when it last wrote, then what it asks of you,
 * what it does while it works, else its latest in a line; a dot while it has written what you
 * have not seen. Held, it is pinned, archived or renamed: the system's menu on iOS.
 */
export function SessionRow({
  session,
  agent,
  attention,
  asks,
}: {
  session: ChatSession;
  agent?: Actor;
  attention: Attention;
  /** The request it waits on you for. */
  asks?: Approval;
}) {
  const organize = useOrganize(session);
  const faint = String(useCSSVariable("--color-faint"));
  const unseen = attention === "unseen";
  const title = session.title || "Untitled session";
  const rename = () =>
    Alert.prompt(
      "Rename session",
      undefined,
      organize.rename,
      "plain-text",
      title,
    );
  // Android has no menu on a link: holding the row asks instead.
  const ask = () =>
    Alert.alert(agent?.name ?? title, undefined, [
      { text: organize.pinned ? "Unpin" : "Pin", onPress: organize.pin },
      {
        text: organize.archived ? "Unarchive" : "Archive",
        onPress: organize.archive,
      },
      { text: "Cancel", style: "cancel" },
    ]);
  return (
    <Link href={`/session/${session.id}`} asChild>
      <Link.Trigger>
        <Pressable
          onLongPress={Platform.OS === "ios" ? undefined : ask}
          accessibilityRole="button"
          className="flex-row items-center gap-3 px-5 py-2.5 active:bg-accent"
        >
          <ActorMark
            kind="agent"
            name={agent?.name ?? title}
            tone={sessionTone(session)}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <View className="flex-row items-baseline gap-2">
              <Text
                numberOfLines={1}
                className={cn(
                  "shrink text-sm",
                  agent ? "font-mono text-agent-foreground" : "font-medium",
                )}
              >
                {agent?.name ?? title}
              </Text>
              <Text className="font-mono text-[11px] text-faint">
                {harnessLabels[session.harness] ?? session.harness}
              </Text>
              <View className="ml-auto flex-row items-center gap-1">
                {organize.pinned ? (
                  <PinIcon color={faint} size={11} strokeWidth={2} />
                ) : null}
                {session.output_at ? (
                  <Text className="font-mono text-[11px] text-faint">
                    {ago(session.output_at)}
                  </Text>
                ) : null}
              </View>
            </View>
            <View className="flex-row items-center gap-1.5">
              {unseen ? (
                <View
                  accessibilityLabel="New"
                  className="size-1.5 rounded-full bg-agent"
                />
              ) : null}
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 text-[13px] text-muted-foreground",
                  attention === "working" && "text-agent-foreground",
                  asks && "text-attention",
                  unseen && "font-medium text-foreground",
                )}
              >
                {attention === "working"
                  ? sessionState(session)
                  : asks
                    ? `Asks: ${asks.summary}`
                    : session.summary ||
                      (agent ? title : sessionState(session))}
              </Text>
            </View>
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction
          icon={organize.pinned ? "pin.slash" : "pin"}
          onPress={organize.pin}
        >
          {organize.pinned ? "Unpin" : "Pin"}
        </Link.MenuAction>
        <Link.MenuAction icon="pencil" onPress={rename}>
          Rename
        </Link.MenuAction>
        <Link.MenuAction
          icon={organize.archived ? "tray.and.arrow.up" : "archivebox"}
          onPress={organize.archive}
        >
          {organize.archived ? "Unarchive" : "Archive"}
        </Link.MenuAction>
      </Link.Menu>
    </Link>
  );
}

/**
 * Stopping the turn the session is working on; the session stays linked. Only the owner may,
 * and only while it works. The kernel says why when it cannot, and that reason is kept as it is.
 */
export function useInterrupt(session: ChatSession) {
  const { chat } = useSession();
  const { owner } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    allowed: owner && sessionTone(session) === "working",
    busy,
    error,
    async interrupt() {
      setBusy(true);
      setError("");
      try {
        await chat.interrupt(session.id);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Interrupt as a button beside a session, with the kernel's reason under it when it fails. */
export function Interrupt({ session }: { session: ChatSession }) {
  const { allowed, busy, error, interrupt } = useInterrupt(session);
  if (!allowed) return null;
  return (
    <View className="items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onPress={() => void interrupt()}
      >
        <Text>{busy ? "Interrupting…" : "Interrupt"}</Text>
      </Button>
      {error ? (
        <Text className="max-w-48 text-right text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

// Sessions ZeroLux runs, and pi ones it can continue from their saved file with a verified
// profile: the kernel refuses what it cannot verify, never picks defaults.
const resumable = (s: ChatSession) =>
  (s.harness === "pi" || s.origin === "owned") &&
  (s.status === "stopped" || s.status === "attention");
// A pi hired from a terminal: ZeroLux can take it over while it is idle there.
const takeable = (s: ChatSession) =>
  s.harness === "pi" && s.origin === "attached" && s.status === "connected";

/**
 * One session of an agent with its controls: Interrupt, Take over, Stop and Resume, and with
 * `facts` its harness, folder and who started it. Stop asks first: it ends the link and
 * cancels a turn only this chat started.
 */
export function SessionCard({
  session,
  name,
  facts,
}: {
  session: ChatSession;
  name: string;
  facts?: boolean;
}) {
  const { chat } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirmStop = () =>
    Alert.alert(
      `Stop ${name}?`,
      "It will no longer reply in ZeroLux or resume this session. Your chats and their history stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: () => void perform(() => chat.stop(session.id)),
        },
      ],
    );
  const confirmTakeover = () =>
    Alert.alert(
      `Take over ${name}?`,
      "The idle terminal closes and the same session continues under ZeroLux: same history, same verified launch profile. Refused if it is working, has queued input or its profile cannot be verified; nothing is killed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take over",
          onPress: () => void perform(() => chat.takeoverPi(session.id)),
        },
      ],
    );
  const harness = harnessLabels[session.harness] ?? session.harness;
  return (
    <View className="gap-2 rounded-lg border border-border bg-card p-3">
      <View className="min-w-0">
        <Text numberOfLines={1} className="text-sm font-medium">
          {session.title || "Untitled session"}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {facts
            ? sessionState(session)
            : `${harness} · ${folderName(session.workspace)}`}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-start justify-end gap-2">
        <Interrupt session={session} />
        {takeable(session) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onPress={confirmTakeover}
          >
            <Text>Take over</Text>
          </Button>
        ) : null}
        {session.status !== "stopped" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onPress={confirmStop}
          >
            <Text>Stop</Text>
          </Button>
        ) : null}
        {resumable(session) ? (
          <Button
            size="sm"
            disabled={busy}
            onPress={() => void perform(() => chat.resume(session.id))}
          >
            <Text>Resume</Text>
          </Button>
        ) : null}
      </View>
      {facts ? (
        <View>
          <Fact label="Harness">
            <Text className="text-sm">{harness}</Text>
          </Fact>
          <Fact label="Folder">
            <Text className="font-mono text-xs">{session.workspace}</Text>
          </Fact>
          <Fact label="Started by">
            <Text className="text-sm">
              {session.origin === "owned" ? "ZeroLux" : "You, then hired"}
            </Text>
          </Fact>
        </View>
      ) : null}
      {session.attention_reason ? (
        <Text className="text-xs text-attention">
          {session.attention_reason}
        </Text>
      ) : null}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
