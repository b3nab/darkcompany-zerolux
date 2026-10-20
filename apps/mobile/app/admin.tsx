import { useRouter } from "expo-router";
import { ChevronRightIcon, UserIcon } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { activeActors, capabilityStatus, useUiPieces } from "@zerolux/chat";
import { ExtensionView } from "@/components/extension-view";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { Row, Section, Unavailable } from "@/components/settings";
import { WorkspaceSettings } from "@/components/workspace-settings";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/** The workspace as its owner runs it: its name, people, agents, modules, storage, updates. */
export default function Administration() {
  const { workspace, version, capabilities, renameWorkspace, url } =
    useSession();
  const settings = useUiPieces("settings", url);
  const { owner } = useMe();
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  if (!owner || !workspace)
    return (
      <Screen back title="Administration">
        <Text className="px-5 py-6 text-sm text-muted-foreground">
          Only the owner of the workspace can see this.
        </Text>
      </Screen>
    );
  const people = activeActors(workspace.actors).filter(
    (a) => a.kind === "human",
  );
  return (
    <Screen back title="Administration">
      <ScrollView contentContainerClassName="gap-6 px-5 py-6">
        <Section title="Workspace">
          <WorkspaceSettings
            workspace={workspace.workspace}
            save={renameWorkspace}
          />
        </Section>
        {settings.map((piece) => (
          <View key={`${piece.extension}/${piece.name}`} className="gap-2">
            <Eyebrow>{piece.title}</Eyebrow>
            <ExtensionView piece={piece} context={{}} />
          </View>
        ))}
        <Section title="People">
          {people.map((person) => (
            <Row
              key={person.id}
              icon={UserIcon}
              label={person.name}
              onPress={() => router.push(`/member/${person.id}`)}
              trailing={
                <ChevronRightIcon color={faint} size={18} strokeWidth={1.5} />
              }
            />
          ))}
          {/* TODO: kernel: invite people, give them roles and say who reports to whom. */}
          <Unavailable>
            Inviting people and roles: not available yet.
          </Unavailable>
        </Section>
        <Section title="Agents">
          {/* TODO: kernel: instructions for every agent, and the model and effort new agents start with. */}
          <Unavailable>
            Instructions for all agents and defaults for new ones: not available
            yet.
          </Unavailable>
        </Section>
        <Section title="Modules">
          {/* TODO: kernel: modules and themes the workspace turns on. */}
          <Unavailable>Not available yet.</Unavailable>
        </Section>
        <Section title="Storage">
          {/* TODO: kernel: where the workspace's files live and the space they take. */}
          <Unavailable>Not available yet.</Unavailable>
        </Section>
        <Section title="Features">
          {capabilityStatus(capabilities).map((feature, i) => (
            <View
              key={feature.id}
              className={cn(
                "flex-row items-start gap-3 px-4 py-3",
                i > 0 && "border-t border-border",
              )}
            >
              <Text className="min-w-0 flex-1 text-base">{feature.name}</Text>
              <Text
                className={cn(
                  "text-sm",
                  feature.available ? "text-success" : "text-faint",
                )}
              >
                {feature.available ? "Available" : "Not yet"}
              </Text>
            </View>
          ))}
        </Section>
        <Section title="Updates">
          <View className="px-4 py-3">
            <Text className="font-mono text-[13px] text-muted-foreground">
              {version ? `Kernel v${version}` : "Kernel version unknown"}
            </Text>
          </View>
          {/* TODO: kernel: signed updates and the backup taken before each one. */}
          <Unavailable>
            Signed updates and backups: not available yet.
          </Unavailable>
        </Section>
      </ScrollView>
    </Screen>
  );
}
