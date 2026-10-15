import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import {
  ago,
  errorMessage,
  folderName,
  harnessLabels,
  sessionState,
  sessionTone,
} from "@zerolux/chat";
import type { Actor, ChatSession } from "@zerolux/chat";
import { ActorMark, Fact, Lamp } from "@/components/member";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";
import { useMe } from "@/src/me";

/**
 * One agent session as the Console lists it, like a chat in the list of chats: the agent and
 * its harness, then what it does while it works, else the session's title.
 */
export function SessionRow({
  session,
  agent,
}: {
  session: ChatSession;
  agent?: Actor;
}) {
  const router = useRouter();
  const tone = sessionTone(session);
  return (
    <Pressable
      onPress={() => router.push(`/session/${session.id}`)}
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-5 py-2.5 active:bg-accent"
    >
      <ActorMark kind="agent" name={agent?.name ?? "?"} tone={tone} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text
            numberOfLines={1}
            className="shrink font-mono text-sm text-agent-foreground"
          >
            {agent?.name ?? "Agent"}
          </Text>
          <Text className="font-mono text-[11px] text-faint">
            {harnessLabels[session.harness] ?? session.harness}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          className={cn(
            "text-[13px]",
            tone === "working"
              ? "text-agent-foreground"
              : "text-muted-foreground",
          )}
        >
          {tone === "working"
            ? sessionState(session)
            : session.title || "Untitled session"}
        </Text>
      </View>
    </Pressable>
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
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm font-medium">
            {session.title || "Untitled session"}
          </Text>
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {facts
              ? sessionState(session)
              : `${harness} · ${folderName(session.workspace)}`}
          </Text>
        </View>
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
