import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { PlusIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Platform, Pressable, Switch, View } from "react-native";
import { ago, errorMessage, joinCommand, useHostJoining } from "@zerolux/chat";
import type { Host, HostLink } from "@zerolux/chat";
import { Row } from "@/components/settings";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/**
 * The computers that run the workspace's sessions, each a person's. Yours you name, open to
 * the others, who then start their own sessions on it with their own harness accounts, add
 * with a code and remove.
 */
export function Hosts() {
  const { workspace, url, hosts } = useSession();
  const { me } = useMe();
  const router = useRouter();
  const [error, setError] = useState("");
  const [link, setLink] = useState<HostLink>();
  const joining = useHostJoining(link, hosts.hosts, hosts.reload);
  // Once the added computer is online, or removed, its code and commands are done with.
  const online = Boolean(joining?.online);
  const removed = Boolean(link && hosts.hosts && !joining);
  useEffect(() => {
    if (!online && !removed) return;
    if (online)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setLink(undefined);
  }, [online, removed]);
  const act = (work: () => Promise<unknown>) => {
    setError("");
    work().catch((e: unknown) => setError(errorMessage(e)));
  };
  const change = (id: string, next: { name?: string; open?: boolean }) =>
    act(() => hosts.change(id, next));
  const rename = (host: Host) =>
    Alert.prompt(
      "Rename this computer",
      undefined,
      (name) => name.trim() && change(host.id, { name: name.trim() }),
      "plain-text",
      host.name,
    );
  const add = (name?: string) => act(() => hosts.link(name).then(setLink));
  const person = (id: string) =>
    workspace?.actors.find((a) => a.id === id)?.name ?? "Someone";
  return (
    <>
      {hosts.hosts?.map((host, index) => {
        const mine = host.person_id === me?.id;
        return (
          <View
            key={host.id}
            className={cn(
              "flex-row items-center gap-3 px-4 py-3",
              index > 0 && "border-t border-border",
            )}
          >
            <View
              className={cn(
                "size-2 rounded-full",
                host.online ? "bg-success" : "bg-faint",
              )}
            />
            <Pressable
              className="min-w-0 flex-1"
              accessibilityRole={mine ? "button" : undefined}
              disabled={!mine || (host.here && Platform.OS !== "ios")}
              onPress={() =>
                host.here
                  ? rename(host)
                  : Alert.alert(
                      host.name,
                      "Removing it disconnects it from the workspace, and its secret stops working.",
                      [
                        ...(Platform.OS === "ios"
                          ? [{ text: "Rename", onPress: () => rename(host) }]
                          : []),
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => act(() => hosts.remove(host.id)),
                        },
                        { text: "Cancel", style: "cancel" },
                      ],
                    )
              }
            >
              <Text numberOfLines={1} className="text-[15px]">
                {host.name}
                {host.here ? (
                  <Text className="text-xs text-faint"> · runs the kernel</Text>
                ) : null}
              </Text>
              <Text numberOfLines={1} className="text-xs text-faint">
                {[
                  mine ? "Yours" : person(host.person_id),
                  !host.joined
                    ? "waiting to join"
                    : host.online
                      ? "online"
                      : `offline · seen ${ago(host.seen_at)}`,
                  !mine && host.open ? "open to you" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Pressable>
            {!mine && host.here && host.open ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/accounts/${host.id}`)}
                hitSlop={6}
              >
                <Text className="text-[13px] font-medium text-human-foreground">
                  Your accounts
                </Text>
              </Pressable>
            ) : null}
            {mine && host.joined ? (
              <Switch
                accessibilityLabel={`Open ${host.name} to people`}
                value={host.open}
                onValueChange={(open) => change(host.id, { open })}
              />
            ) : null}
          </View>
        );
      })}
      {link ? (
        <Joining
          name={joining?.name ?? link.host.name}
          joined={Boolean(joining?.joined)}
          command={joinCommand(url, link.code)}
          done={() => setLink(undefined)}
        />
      ) : hosts.hosts ? (
        <View className="border-t border-border">
          <Row
            icon={PlusIcon}
            label="Add a computer"
            onPress={() =>
              Platform.OS === "ios"
                ? Alert.prompt(
                    "Add a computer",
                    "Its name in the workspace.",
                    (name) => add(name.trim() || undefined),
                    "plain-text",
                  )
                : add()
            }
          />
        </View>
      ) : null}
      <Text
        className={cn(
          "border-t border-border px-4 py-3 text-xs",
          error || hosts.error ? "text-destructive" : "text-faint",
        )}
      >
        {error ||
          hosts.error ||
          "Sessions run on a computer of their person's. Open yours with the switch, and the others start their own sessions on it, with their own harness accounts."}
      </Text>
    </>
  );
}

/** An added computer until it connects: the command that joins it with its code, then the one that connects it. */
function Joining({
  name,
  joined,
  command,
  done,
}: {
  name: string;
  joined: boolean;
  command: string;
  done: () => void;
}) {
  const shown = joined ? "zerolux host run" : command;
  return (
    <View className="gap-2.5 border-t border-border px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-[13px] text-muted-foreground">
          {joined
            ? `${name} joined. To connect it, run there:`
            : `On ${name}, run:`}
        </Text>
        <Pressable accessibilityRole="button" onPress={done} hitSlop={6}>
          <Text className="text-[13px] font-medium text-human-foreground">
            Done
          </Text>
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy the command"
        onPress={() => {
          void Clipboard.setStringAsync(shown);
          void Haptics.selectionAsync();
        }}
        className="rounded-md border border-border bg-background px-3 py-2.5 active:opacity-70"
      >
        <Text selectable className="font-mono text-[13px] leading-5">
          {shown}
        </Text>
      </Pressable>
      <Text className="text-xs text-faint">
        {joined
          ? "Waiting for it to connect…"
          : "Tap to copy. The code works once, within ten minutes; then zerolux host run connects it."}
      </Text>
    </View>
  );
}
