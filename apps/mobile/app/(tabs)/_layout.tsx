import { Redirect } from "expo-router";
import { Platform } from "react-native";
import { NativeTabs } from "expo-router/native-tabs";
import { homeLabel, requestsFor, unreadIn, waitingChats } from "@zerolux/chat";
import { useCSSVariable } from "uniwind";
import { useKernel, useSession } from "../../src/kernel";
import { useMe } from "../../src/me";
import { useSessionNotices } from "../../src/notices";

export default function TabsLayout() {
  const { url } = useKernel();
  if (url === undefined) return null;
  return url ? <Connected /> : <Redirect href="/connect" />;
}

/** A count on a tab, as the system draws it; nothing when there is nothing. */
const badge = (count: number) =>
  count > 0 ? (
    <NativeTabs.Trigger.Badge>{String(count)}</NativeTabs.Trigger.Badge>
  ) : null;

/**
 * The system's own tab bar (Liquid Glass on iOS, Material on Android): the home, the agents'
 * console, the chats, the organization, and the rest. What waits for you is counted on them.
 */
function Connected() {
  const { chat } = useSession();
  const { me } = useMe();
  useSessionNotices();
  const [tint, muted, bar, indicator] = useCSSVariable([
    "--color-human-foreground",
    "--color-muted-foreground",
    "--color-card",
    "--color-accent",
  ]).map(String);
  // Android draws Material Symbols white and only the selected label: the theme colors them,
  // and every label shows, as on iOS. iOS keeps the system's own look.
  const android =
    Platform.OS === "android"
      ? {
          iconColor: { default: muted, selected: tint },
          labelStyle: { default: { color: muted }, selected: { color: tint } },
          labelVisibilityMode: "labeled" as const,
          backgroundColor: bar,
          indicatorColor: indicator,
        }
      : {};
  // The requests waiting for you: those of your sessions.
  const pending = requestsFor(chat, me?.id).length;
  const unread = chat.conversations.filter(
    (c) => c.kind !== "thread" && unreadIn(c, chat.seen) > 0,
  ).length;
  const waiting = waitingChats(
    chat.conversations,
    chat.approvals,
    chat.sessions,
  ).size;
  const home = homeLabel();
  const night = home === "Tonight";
  return (
    <NativeTabs tintColor={tint} {...android}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{home}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={night ? "moon.stars" : "sun.max"}
          md={night ? "dark_mode" : "light_mode"}
        />
        {badge(pending)}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="console">
        <NativeTabs.Trigger.Label>Console</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "terminal", selected: "terminal.fill" }}
          md="terminal"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
          md="forum"
        />
        {badge(waiting || unread)}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="org">
        <NativeTabs.Trigger.Label>Org</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "person.3", selected: "person.3.fill" }}
          md="account_tree"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
