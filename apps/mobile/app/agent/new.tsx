import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import {
  agentLaunchSettings,
  claudeModes,
  codexApprovalPolicies,
  codexSandboxes,
  errorMessage,
  harnessLabels,
} from "@zerolux/chat";
import type {
  ClaudeMode,
  CodexApprovalPolicy,
  CodexSandbox,
} from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Choice } from "@/components/choice";
import { useSession } from "../../src/kernel";

/** The harnesses the kernel can start a session of. */
const startable = {
  "claude-code": harnessLabels["claude-code"],
  codex: harnessLabels.codex,
  pi: harnessLabels.pi,
} as const;
type Startable = keyof typeof startable;

/**
 * A new agent the kernel starts in a folder on its own computer, as a new agent or as
 * another session of an existing one. The same choices as the web app: what is left unset
 * for Codex follows the user's own Codex configuration.
 */
export default function NewAgent() {
  const { chat, actors } = useSession();
  const router = useRouter();
  const [harness, setHarness] = useState<Startable>("claude-code");
  const [actorId, setActorId] = useState<string | "">("");
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState<ClaudeMode>("default");
  const [policy, setPolicy] = useState<CodexApprovalPolicy | "">("");
  const [sandbox, setSandbox] = useState<CodexSandbox | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agents = actors.filter(
    (a) => a.kind === "agent" && !a.archived && a.harness === harness,
  );
  const folders = [...new Set(chat.sessions.map((s) => s.workspace))];
  const label = harnessLabels[harness];
  const ready = workspace.trim().length > 0;

  async function start() {
    if (!ready) return;
    setBusy(true);
    setError("");
    const common = {
      name: name.trim() || label,
      workspace: workspace.trim(),
      ...agentLaunchSettings(model, effort),
      ...(actorId ? { actor_id: actorId } : {}),
    };
    try {
      if (harness === "claude-code")
        await chat.startClaude({ ...common, permission_mode: mode });
      else if (harness === "pi") await chat.startPi(common);
      else
        await chat.startCodex({
          ...common,
          ...(policy ? { approval_policy: policy } : {}),
          ...(sandbox ? { sandbox } : {}),
        });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen back="close" title="New agent">
      <Stack.Screen options={{ presentation: "modal" }} />
      <ScrollView
        contentContainerClassName="gap-5 p-5"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-muted-foreground">
          ZeroLux starts it in a folder on the kernel's computer. What you write
          in your chats reaches it as yours.
        </Text>
        <Choice
          label="Harness"
          options={startable}
          value={harness}
          onChange={(next) => {
            if (next) setHarness(next);
            setActorId("");
            setModel("");
            setEffort("");
            setMode("default");
            setPolicy("");
            setSandbox("");
          }}
        />
        {agents.length > 0 ? (
          <Choice
            label="Agent"
            options={Object.fromEntries(
              agents.map((a) => [a.id, `Another session of ${a.name}`]),
            )}
            value={actorId}
            onChange={(id) => {
              const agent = agents.find((agent) => agent.id === id);
              setActorId(id);
              setMode((agent?.permission_mode as ClaudeMode) || "default");
              setPolicy((agent?.approval_policy as CodexApprovalPolicy) || "");
              setSandbox((agent?.sandbox as CodexSandbox) || "");
            }}
            none="A new agent"
          />
        ) : null}
        {!actorId ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">Agent name</Text>
            <Input
              value={name}
              onChangeText={setName}
              placeholder={label}
              maxLength={200}
            />
          </View>
        ) : null}
        <View className="gap-2">
          <Text className="text-sm font-medium">Folder</Text>
          <Input
            value={workspace}
            onChangeText={setWorkspace}
            placeholder="/Users/you/projects/app"
            autoCapitalize="none"
            autoCorrect={false}
            className="font-mono"
          />
          {folders.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {folders.map((folder) => (
                <Pressable
                  key={folder}
                  onPress={() => setWorkspace(folder)}
                  accessibilityRole="button"
                  className="rounded-full border border-border px-2.5 py-1"
                >
                  <Text className="font-mono text-xs" numberOfLines={1}>
                    {folder}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        <View className="gap-2">
          <Text className="text-sm font-medium">Model · optional</Text>
          <Input
            accessibilityLabel="Model"
            value={model}
            onChangeText={setModel}
            placeholder="Agent or harness settings"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
        </View>
        <View className="gap-2">
          <Text className="text-sm font-medium">Effort · optional</Text>
          <Input
            accessibilityLabel="Effort"
            value={effort}
            onChangeText={setEffort}
            placeholder="Agent or harness settings"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
        </View>
        {harness === "claude-code" ? (
          <Choice
            label="Permissions"
            options={claudeModes}
            value={mode}
            onChange={(next) => next && setMode(next)}
          />
        ) : harness === "pi" ? (
          <Text className="text-sm text-muted-foreground">
            Uses pi's own tools and project settings. Blank model and effort
            keep the agent or harness settings.
          </Text>
        ) : (
          <>
            <Choice
              label="Approvals"
              options={codexApprovalPolicies}
              value={policy}
              onChange={setPolicy}
              none="Codex settings"
            />
            <Choice
              label="Sandbox"
              options={codexSandboxes}
              value={sandbox}
              onChange={setSandbox}
              none="Codex settings"
            />
          </>
        )}
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        <Button size="lg" disabled={busy || !ready} onPress={start}>
          <Text>{busy ? "Starting…" : "Start"}</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}
