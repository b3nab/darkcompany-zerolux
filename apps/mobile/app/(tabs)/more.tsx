import { useRouter } from "expo-router";
import type { Href } from "expo-router";
import {
  ChevronRightIcon,
  FolderIcon,
  PhoneIcon,
  SettingsIcon,
  ShieldIcon,
  UserPlusIcon,
} from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Wordmark } from "@/components/brand";
import { ActorMark } from "@/components/member";
import { Screen } from "@/components/screen";
import { Row, Section } from "@/components/settings";
import { Text } from "@/components/ui/text";
import { useMe } from "../../src/me";

/** You first, then your settings, the workspace's administration and the rest of it. */
export default function More() {
  const router = useRouter();
  const { me, email, owner } = useMe();
  const faint = String(useCSSVariable("--color-faint"));
  const go = (href: Href) => () => router.push(href);
  const next = <ChevronRightIcon color={faint} size={18} strokeWidth={1.5} />;
  return (
    <Screen title="More">
      <ScrollView contentContainerClassName="gap-6 px-5 pb-10">
        {me ? (
          <Pressable
            onPress={go(`/member/${me.id}`)}
            accessibilityRole="button"
            accessibilityLabel="Your profile"
            className="flex-row items-center gap-3 rounded-md border border-border bg-card px-4 py-3 active:bg-accent"
          >
            <ActorMark kind="human" name={me.name} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-base font-medium">
                {me.name}
              </Text>
              {email ? (
                <Text
                  numberOfLines={1}
                  className="text-sm text-muted-foreground"
                >
                  {email}
                </Text>
              ) : null}
            </View>
            {next}
          </Pressable>
        ) : null}
        <Section title="Settings">
          <Row
            icon={SettingsIcon}
            label="My settings"
            onPress={go("/settings")}
            trailing={next}
          />
          {owner ? (
            <Row
              icon={ShieldIcon}
              label="Administration"
              onPress={go("/admin")}
              trailing={next}
            />
          ) : null}
          {owner ? (
            <Row
              icon={UserPlusIcon}
              label="Invite people"
              onPress={go("/invites")}
              trailing={next}
            />
          ) : null}
        </Section>
        <Section title="Workspace">
          <Row
            icon={FolderIcon}
            label="Storage"
            onPress={go("/storage")}
            trailing={next}
          />
          <Row
            icon={PhoneIcon}
            label="Meetings"
            onPress={go("/meetings")}
            trailing={next}
          />
        </Section>
        <View className="items-center gap-2 pt-4">
          <Wordmark height={16} />
          <Text className="font-mono text-[11px] text-faint">
            DARK COMPANY OS · MIT
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
