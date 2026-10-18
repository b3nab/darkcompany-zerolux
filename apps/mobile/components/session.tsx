import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { ChevronRightIcon, PinIcon, UsersIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import {
  ago,
  delegatedBy,
  delegatedTo,
  errorMessage,
  folderName,
  harnessLabels,
  sessionName,
  sessionState,
  sessionTone,
  shareChoice,
  sharedAs,
  shareLabels,
} from "@zerolux/chat";
import type {
  Actor,
  Approval,
  Attention,
  ChatSession,
  ShareChoice,
} from "@zerolux/chat";
import { ActorMark, Fact, Lamp } from "@/components/member";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";
import { Segmented } from "@/components/segmented";
import { useAccess, useMe } from "@/src/me";

/** Pin, archive, rename and budget a session, keeping the kernel's reason when it refuses. */
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
    /** Stops the session's turns at this cost in dollars; 0 lifts it. */
    budget: (usd: number) => change({ budget_usd: usd }),
  };
}

/**
 * One session as the Console's inbox lists it, like a chat in the list of chats: its agent
 * (or its title, without one) and harness, when it last wrote, then what it asks of you,
 * what it does while it works, why it stopped, else its latest in a line; a dot while it has
 * written what you have not seen. Held, it is pinned, archived or renamed: the system's menu on iOS.
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
  const { workspace, chat } = useSession();
  const faint = String(useCSSVariable("--color-faint"));
  const unseen = attention === "unseen";
  // A session another started works for it: the row says which.
  const parent = delegatedBy(session, chat.sessions);
  // Another person's session, shared with you: the row says whose.
  const { me } = useMe();
  const person =
    session.owner_id !== me?.id
      ? (workspace?.actors.find((a) => a.id === session.owner_id)?.name ??
        "another person")
      : undefined;
  // Why it stopped and waits for you, as the kernel says: a budget reached, a lost link.
  const stopped =
    session.status === "attention" && session.attention_reason
      ? session.attention_reason
      : undefined;
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
              <Text
                numberOfLines={1}
                className="shrink font-mono text-[11px] text-faint"
              >
                {harnessLabels[session.harness] ?? session.harness}
                {person ? ` · by ${person}` : ""}
              </Text>
              <View className="ml-auto flex-row items-center gap-1">
                {session.shared ? (
                  <UsersIcon
                    accessibilityLabel={`Shared to ${session.shared}`}
                    color={faint}
                    size={11}
                    strokeWidth={2}
                  />
                ) : null}
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
                  (asks || stopped) && "text-attention",
                  unseen && "font-medium text-foreground",
                )}
              >
                {attention === "working"
                  ? sessionState(session)
                  : asks
                    ? `Asks: ${asks.summary}`
                    : stopped
                      ? session.attention_reason
                      : session.summary ||
                        (agent ? title : sessionState(session))}
              </Text>
            </View>
            {parent ? (
              <Text numberOfLines={1} className="text-xs text-faint">
                Started by {sessionName(parent, workspace?.actors ?? [])}
              </Text>
            ) : null}
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

const shareHints: Record<ShareChoice, string> = {
  private: "Only you see it.",
  read: "The workspace's people follow it: its work, its code and its requests.",
  write:
    "The workspace's people also work in it, as you do. Its title, budget, sharing, forks and requests stay yours.",
};

/**
 * In About: who sees the session. Its person keeps it private or shares it with the
 * workspace's people, to read or to work in it; the others see how it was shared with them.
 */
export function Sharing({ session }: { session: ChatSession }) {
  const { workspace, chat } = useSession();
  const { mine } = useAccess(session);
  const [error, setError] = useState("");
  const person =
    workspace?.actors.find((a) => a.id === session.owner_id)?.name ??
    "Its person";
  if (!mine)
    return (
      <View className="gap-1">
        <Text className="text-sm text-faint">Shared</Text>
        <Text className="text-[15px]">
          {person} shared it with you to{" "}
          {session.shared === "write" ? "work in" : "read"}.
        </Text>
      </View>
    );
  const choice = shareChoice(session.shared);
  return (
    <View className="gap-2">
      <Text className="text-sm text-faint">Share</Text>
      <Segmented<ShareChoice>
        options={Object.entries(shareLabels) as [ShareChoice, string][]}
        value={choice}
        choose={(next) => {
          setError("");
          chat
            .updateSession(session.id, { shared: sharedAs(next) })
            .catch((e: unknown) => setError(errorMessage(e)));
        }}
      />
      <Text
        className={cn("text-xs", error ? "text-destructive" : "text-faint")}
      >
        {error || shareHints[choice]}
      </Text>
    </View>
  );
}

/**
 * In About: the session that started this one, and the sessions this one started to work
 * for it, the latest first; a tap opens one.
 */
export function Delegation({
  session,
  close,
}: {
  session: ChatSession;
  close: () => void;
}) {
  const { workspace, chat } = useSession();
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const actors = workspace?.actors ?? [];
  const parent = delegatedBy(session, chat.sessions);
  const children = delegatedTo(session.id, chat.sessions);
  if (!parent && !children.length) return null;
  const open = (id: string) => {
    close();
    router.push(`/session/${id}`);
  };
  const row = (other: ChatSession) => (
    <Pressable
      key={other.id}
      accessibilityRole="button"
      onPress={() => open(other.id)}
      className="flex-row items-center gap-2.5 py-2 active:opacity-70"
    >
      <Lamp kind="agent" tone={sessionTone(other)} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-[15px]">
          {sessionName(other, actors)}
        </Text>
        <Text numberOfLines={1} className="text-xs text-faint">
          {harnessLabels[other.harness] ?? other.harness} ·{" "}
          {other.summary || sessionState(other)}
        </Text>
      </View>
      <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
    </Pressable>
  );
  return (
    <View className="gap-1">
      {parent ? (
        <>
          <Text className="text-sm text-faint">Started by</Text>
          {row(parent)}
        </>
      ) : null}
      {children.length ? (
        <>
          <Text className="text-sm text-faint">
            Delegated · {children.length}
          </Text>
          {children.map(row)}
        </>
      ) : null}
    </View>
  );
}

/**
 * Stopping the turn the session is working on; the session stays linked. Whoever works in it may,
 * and only while it works. The kernel says why when it cannot, and that reason is kept as it is.
 */
export function useInterrupt(session: ChatSession) {
  const { chat } = useSession();
  const { write } = useAccess(session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    allowed: write && sessionTone(session) === "working",
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
