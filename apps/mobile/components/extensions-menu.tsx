import { useRouter } from "expo-router";
import { extensionsNotice } from "@zerolux/chat";
import { Menu } from "@/components/action-menu";
import { useMe } from "../src/me";

/** What the Extensions header keeps one menu away: extensions in development, and updates. */
export function ExtensionsMenu() {
  const router = useRouter();
  const { owner } = useMe();
  if (!owner) return null;
  return (
    <Menu
      label="More"
      items={[
        {
          title: "Develop",
          icon: "flask-conical",
          onPress: () => router.push("/extensions/installed/develop"),
        },
        {
          title: "Check for updates",
          icon: "refresh-cw",
          onPress: extensionsNotice,
        },
      ]}
    />
  );
}
