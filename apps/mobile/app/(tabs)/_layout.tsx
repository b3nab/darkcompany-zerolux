import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { homeLabel, unreadIn, waitingChats } from "@zerolux/chat";
import { useCSSVariable } from "uniwind";
import { useKernel, useSession } from "../../src/kernel";

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
 * The system's own tab bar (Liquid Glass on iOS, Material on Android): the home, the chats,
 * the organization, and the rest. What waits for you is counted on them.
 */
function Connected() {
  const { chat } = useSession();
  const tint = String(useCSSVariable("--color-human-foreground"));
  const pending = chat.approvals.filter((a) => a.status === "pending").length;
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
    <NativeTabs tintColor={tint}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{home}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={night ? "moon.stars" : "sun.max"}
          md={night ? "dark_mode" : "light_mode"}
        />
        {badge(pending)}
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
