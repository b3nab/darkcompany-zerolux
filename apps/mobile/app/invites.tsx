import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Share, View } from "react-native";
import {
  clockTime,
  createInvite,
  dayLabel,
  errorMessage,
  inviteLink,
  listInvites,
  withdrawInvite,
} from "@zerolux/chat";
import type { Invite } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

const when = (time: number) => `${dayLabel(time)} at ${clockTime(time)}`;

/**
 * The owner brings people in: an invitation is a link, valid once for seven days, that the
 * person opens to sign up with their own account and bring their own agents and sessions.
 * The link is shown once, when made; the ones not used yet can be withdrawn.
 */
export default function Invites() {
  const { url } = useSession();
  const { owner } = useMe();
  const [invites, setInvites] = useState<Invite[]>();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(
    () =>
      listInvites(url).then(setInvites, (e: unknown) =>
        setError(errorMessage(e)),
      ),
    [url],
  );
  useEffect(() => {
    if (owner) void reload();
  }, [owner, reload]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!owner)
    return (
      <Screen back title="Invite people">
        <Text className="px-5 py-6 text-sm text-muted-foreground">
          Only the workspace's owner invites people.
        </Text>
      </Screen>
    );
  return (
    <Screen back title="Invite people">
      <ScrollView contentContainerClassName="gap-6 px-5 py-5">
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Who you invite signs up with their own account and brings their own
          agents and sessions. Chats and meetings are shared; sessions stay
          private until their person shares them.
        </Text>
        <Button
          disabled={busy}
          onPress={() =>
            void act(async () => {
              const { token } = await createInvite(url);
              setLink(inviteLink(url, token));
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              );
              await reload();
            })
          }
        >
          <Text>New invitation</Text>
        </Button>
        {link ? (
          <View className="gap-3 rounded-md border border-border bg-card p-4">
            <Text selectable className="font-mono text-[13px]">
              {link}
            </Text>
            <Text className="text-xs text-faint">
              Send it now: it is shown only once. It works once, for seven days,
              wherever this kernel's address can be reached.
            </Text>
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onPress={() => void Share.share({ message: link })}
              >
                <Text>Share</Text>
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onPress={() => {
                  void Clipboard.setStringAsync(link);
                  void Haptics.selectionAsync();
                }}
              >
                <Text>Copy</Text>
              </Button>
            </View>
          </View>
        ) : null}
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        <View className="gap-2">
          <Text className="text-sm text-faint">
            Waiting{invites ? ` · ${invites.length}` : ""}
          </Text>
          {invites?.length ? (
            <View className="overflow-hidden rounded-md border border-border">
              {invites.map((invite, index) => (
                <View
                  key={invite.id}
                  className={
                    index
                      ? "flex-row items-center gap-3 border-t border-border bg-card px-3 py-2.5"
                      : "flex-row items-center gap-3 bg-card px-3 py-2.5"
                  }
                >
                  <View className="min-w-0 flex-1">
                    <Text className="text-[15px]">
                      Made {when(invite.created_at)}
                    </Text>
                    <Text className="text-xs text-faint">
                      Until {when(invite.expires_at)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    hitSlop={8}
                    onPress={() =>
                      Alert.alert(
                        "Withdraw this invitation?",
                        "Its link stops working.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Withdraw",
                            style: "destructive",
                            onPress: () =>
                              void act(async () => {
                                await withdrawInvite(invite.id, url);
                                await reload();
                              }),
                          },
                        ],
                      )
                    }
                  >
                    <Text className="text-[13px] font-medium text-destructive">
                      Withdraw
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : invites ? (
            <Text className="text-sm text-faint">
              No invitation is waiting to be used.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
