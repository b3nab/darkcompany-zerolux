import { useRouter } from "expo-router";
import type { Href } from "expo-router";
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  MonitorIcon,
  MoonIcon,
  PhoneIcon,
  SunIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Wordmark } from "@/components/brand";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { WorkspaceSettings } from "@/components/workspace-settings";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useKernel, useSession } from "../../src/kernel";
import { chooseTheme, useTheme } from "../../src/theme";
import type { Theme } from "../../src/theme";

const themes: [Theme, string, LucideIcon][] = [
  ["system", "System", MonitorIcon],
  ["light", "Daylight", SunIcon],
  ["dark", "Night", MoonIcon],
];
const realtime = {
  live: "Kernel · live",
  connecting: "Kernel · connecting…",
  offline: "Kernel · realtime offline",
};

/** The rest of the workspace, your theme, and the kernel this phone talks to. */
export default function More() {
  const { url, forget } = useKernel();
  const { chat, version, workspace, renameWorkspace } = useSession();
  const { chosen } = useTheme();
  const router = useRouter();
  const [muted, faint] = useCSSVariable([
    "--color-muted-foreground",
    "--color-faint",
  ]).map(String);
  const row = (
    Icon: LucideIcon,
    label: string,
    onPress: () => void,
    trailing: ReactNode,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
    >
      <Icon color={muted} size={18} strokeWidth={1.5} />
      <Text className="flex-1 text-base">{label}</Text>
      {trailing}
    </Pressable>
  );
  const go = (href: Href) => () => router.push(href);
  const next = <ChevronRightIcon color={faint} size={18} strokeWidth={1.5} />;

  return (
    <Screen title="More">
      <ScrollView contentContainerClassName="gap-6 px-5 pb-10">
        <Section title="Workspace">
          {workspace && (
            <WorkspaceSettings
              workspace={workspace.workspace}
              save={renameWorkspace}
            />
          )}
          {row(FolderIcon, "Storage", go("/storage"), next)}
          {row(PhoneIcon, "Meetings", go("/meetings"), next)}
        </Section>
        <Section title="Theme">
          {themes.map(([theme, label, Icon]) =>
            row(
              Icon,
              label,
              () => void chooseTheme(theme),
              chosen === theme ? (
                <CheckIcon color={muted} size={18} strokeWidth={2} />
              ) : null,
            ),
          )}
        </Section>
        <Section title="Kernel">
          <View className="gap-1 px-4 py-3">
            <View className="flex-row items-center gap-2">
              <View
                className={cn(
                  "size-1.5 rounded-full",
                  chat.realtime === "live"
                    ? "bg-success"
                    : chat.realtime === "connecting"
                      ? "bg-faint"
                      : "bg-destructive",
                )}
              />
              <Text className="font-mono text-[13px] text-muted-foreground">
                {realtime[chat.realtime]}
              </Text>
            </View>
            <Text className="font-mono text-[13px] text-faint">
              {url?.replace(/^https?:\/\//, "")}
              {version ? ` · v${version}` : ""}
            </Text>
          </View>
          <View className="border-t border-border px-4 py-3">
            <Button variant="outline" onPress={() => void forget()}>
              <Text>Connect to another kernel</Text>
            </Button>
          </View>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Eyebrow>{title}</Eyebrow>
      <View className="overflow-hidden rounded-md border border-border bg-card">
        {children}
      </View>
    </View>
  );
}
