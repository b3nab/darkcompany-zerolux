import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import {
  agentLaunchSettings,
  agentSettingFields,
  claudeModes,
  codexApprovalPolicies,
  codexSandboxes,
  errorMessage,
  harnessLabels,
  recentFolders,
  useSessionCatalog,
  accountReady,
  joinedHarnesses,
  ownComputers,
  sessionComputer,
  startsHere,
  useHostAccounts,
} from "@zerolux/chat";
import type {
  ClaudeMode,
  CodexApprovalPolicy,
  CodexSandbox,
  NewSession,
} from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Choice } from "@/components/choice";
import { SettingSelect } from "@/components/setting-select";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

/** The harnesses the kernel can start a session of. */
const startable = {
  "claude-code": harnessLabels["claude-code"],
  codex: harnessLabels.codex,
  pi: harnessLabels.pi,
} as const;
type Startable = keyof typeof startable;
/** Who the session works for: no agent, a new one, or an existing one by id. */
const NEW = "new";

/**
 * A new session the kernel starts in a folder on its own computer, or on one of yours joined
 * to the workspace: on its own, for a new agent, or as another session of an existing one;
 * then it opens. What is left unset follows the harness's own configuration. From the Org tab
 * it starts with a new agent.
 */
export default function NewSessionScreen() {
  const { chat, actors, url, hosts } = useSession();
  const { me } = useMe();
  // Where it runs: the kernel's computer, if yours or open to you, or one of yours online.
  const reloadHosts = hosts.reload;
  useEffect(() => void reloadHosts(), [reloadHosts]);
  const here = hosts.hosts?.find((h) => h.here);
  const hereAllowed = startsHere(hosts.hosts, me?.id, true);
  const computers = ownComputers(hosts.hosts, me?.id);
  const [place, setPlace] = useState("");
  const elsewhere =
    computers.find((c) => c.id === place) ??
    (hereAllowed ? undefined : computers[0]);
  // On the kernel's computer open to you, sessions run with your own accounts: they come first.
  const guest =
    !elsewhere && here && here.person_id !== me?.id ? here : undefined;
  const accounts = useHostAccounts(guest?.id, url);
  const router = useRouter();
  const params = useLocalSearchParams<{ agent?: string }>();
  const [chosen, setHarness] = useState<Startable>("claude-code");
  // What a joined computer runs so far, in the usual order.
  const joinable = (Object.keys(startable) as Startable[]).filter((h) =>
    joinedHarnesses.includes(h),
  );
  const harness =
    elsewhere && !joinable.includes(chosen) ? joinable[0]! : chosen;
  const [agent, setAgent] = useState(params.agent === NEW ? NEW : "");
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [worktree, setWorktree] = useState<string>();
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
  const existing = agents.find((a) => a.id === agent);
  const catalog = useSessionCatalog(harness, url);
  const launchFields = agentSettingFields(
    harness,
    catalog.data?.models ?? [],
    model || existing?.model,
  ).slice(0, 2);
  const folders = recentFolders(
    chat.sessions.filter(
      (s) => sessionComputer(s, hosts.hosts)?.id === elsewhere?.id,
    ),
  );
  const label = harnessLabels[harness];
  const unconnected = Boolean(
    guest && accounts.accounts && !accountReady(accounts.accounts, harness),
  );
  const ready =
    workspace.trim().length > 0 && !unconnected && (hereAllowed || !!elsewhere);
  const chooseHarness = (next: Startable) => {
    setHarness(next);
    if (agent !== NEW) setAgent("");
    setModel("");
    setEffort("");
    setMode("default");
    setPolicy("");
    setSandbox("");
  };
  const choosePlace = (id: string) => {
    setPlace(id);
    if (id && !joinable.includes(harness)) chooseHarness(joinable[0]!);
  };

  async function start() {
    if (!ready) return;
    setBusy(true);
    setError("");
    const common = {
      workspace: workspace.trim(),
      ...agentLaunchSettings(model, effort),
      ...(worktree !== undefined ? { worktree: worktree.trim() } : {}),
      ...(elsewhere ? { host: elsewhere.id } : {}),
      ...(existing
        ? { actor_id: existing.id }
        : agent === NEW
          ? { name: name.trim() || label }
          : {}),
    };
    const input: NewSession =
      harness === "claude-code"
        ? { harness, ...common, permission_mode: mode }
        : harness === "pi"
          ? { harness, ...common }
          : {
              harness,
              ...common,
              ...(policy ? { approval_policy: policy } : {}),
              ...(sandbox ? { sandbox } : {}),
            };
    try {
      const { session } = await chat.createSession(input);
      router.replace(`/session/${session.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen back="close" title="New session">
      <ScrollView
        contentContainerClassName="gap-5 p-5"
        keyboardShouldPersistTaps="handled"
      >
        {computers.length ? (
          <View className="gap-2">
            <Choice
              label="Where"
              options={Object.fromEntries(computers.map((c) => [c.id, c.name]))}
              value={elsewhere?.id ?? ""}
              onChange={choosePlace}
              none={
                hereAllowed
                  ? (here?.name ?? "The kernel's computer")
                  : undefined
              }
            />
            {elsewhere && joinable.length < Object.keys(startable).length ? (
              <Text className="text-xs text-muted-foreground">
                Only {joinable.map((h) => startable[h]).join(" and ")} run
                there.
              </Text>
            ) : null}
          </View>
        ) : null}
        <Choice
          label="Harness"
          options={
            elsewhere
              ? Object.fromEntries(joinable.map((h) => [h, startable[h]]))
              : startable
          }
          value={harness}
          onChange={(next) => next && chooseHarness(next)}
        />
        <Choice
          label="Agent"
          options={{
            [NEW]: "A new agent",
            ...Object.fromEntries(
              agents.map((a) => [a.id, `Another session of ${a.name}`]),
            ),
          }}
          value={agent}
          onChange={(id) => {
            const chosen = agents.find((a) => a.id === id);
            setAgent(id);
            setMode((chosen?.permission_mode as ClaudeMode) || "default");
            setPolicy((chosen?.approval_policy as CodexApprovalPolicy) || "");
            setSandbox((chosen?.sandbox as CodexSandbox) || "");
          }}
          none="No agent"
        />
        {agent === NEW ? (
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
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-sm font-medium">
              In a new worktree
            </Text>
            <Switch
              value={worktree !== undefined}
              onValueChange={(on) => setWorktree(on ? "" : undefined)}
            />
          </View>
          {worktree !== undefined ? (
            <Input
              value={worktree}
              onChangeText={setWorktree}
              placeholder="Branch, or ZeroLux names one"
              autoCapitalize="none"
              autoCorrect={false}
              className="font-mono"
            />
          ) : null}
        </View>
        {launchFields.map(({ key, label, options }) => (
          <SettingSelect
            key={key}
            label={label}
            value={key === "model" ? model : effort}
            options={options}
            none={existing ? "The agent's choice" : "The harness's own default"}
            disabled={
              busy || catalog.loading || Object.keys(options).length === 0
            }
            onChange={(value) => {
              if (key === "model") {
                setModel(value);
                setEffort("");
              } else setEffort(value);
            }}
          />
        ))}
        {!catalog.loading && catalog.data?.models.length === 0 && (
          <Text className="text-xs text-muted-foreground">
            No model choices yet.
          </Text>
        )}
        {catalog.error && (
          <Text className="text-xs text-attention">{catalog.error}</Text>
        )}
        {harness === "claude-code" ? (
          <Choice
            label="Permissions"
            options={claudeModes}
            value={mode}
            onChange={(next) => next && setMode(next)}
          />
        ) : harness === "pi" ? null : (
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
        {unconnected && guest ? (
          <View className="gap-2 rounded-md border border-attention/40 bg-attention/5 px-3.5 py-3">
            <Text className="text-sm">
              Connect your {label} account on {guest.name}.
            </Text>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onPress={() => router.push(`/accounts/${guest.id}`)}
            >
              <Text>Your accounts</Text>
            </Button>
          </View>
        ) : null}
        <Button size="lg" disabled={busy || !ready} onPress={start}>
          <Text>{busy ? "Starting…" : "Start"}</Text>
        </Button>
      </ScrollView>
    </Screen>
  );
}
