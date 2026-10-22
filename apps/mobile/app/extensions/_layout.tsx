import { NativeTabs } from "expo-router/native-tabs";
import { useExtensions } from "@zerolux/chat";
import { badge, useTabBarLook } from "@/components/tab-bar";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

/**
 * Extensions as a space of its own, with the system's tab bar: what is installed and what
 * agents propose together, and the marketplace apart, in its own bubble on iOS.
 */
export default function ExtensionsLayout() {
  const { url } = useSession();
  const { owner } = useMe();
  const look = useTabBarLook();
  const proposals =
    useExtensions(url).extensions?.filter((e) => e.proposed_by).length ?? 0;
  return (
    <NativeTabs {...look}>
      <NativeTabs.Trigger name="installed">
        <NativeTabs.Trigger.Label>Installed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "puzzlepiece.extension",
            selected: "puzzlepiece.extension.fill",
          }}
          md="extension"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="proposals" hidden={!owner}>
        <NativeTabs.Trigger.Label>Proposals</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        {badge(proposals)}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="marketplace" role="search" hidden={!owner}>
        <NativeTabs.Trigger.Label>Marketplace</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="storefront" md="storefront" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
