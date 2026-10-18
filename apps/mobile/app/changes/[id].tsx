import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ArrowUpRightIcon,
  GitBranchIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
  changeLabels,
  checksOf,
  errorMessage,
  isStaged,
  isUnstaged,
  useSessionGit,
  useSessionPullRequest,
} from "@zerolux/chat";
import type { Check, GitChange, PullRequest } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/** A change's letter in its color: added green, deleted red, a conflict loud, the rest amber. */
const letterTone = (letter: string) =>
  letter === "A" || letter === "?"
    ? "text-success"
    : letter === "D"
      ? "text-destructive"
      : letter === "U"
        ? "text-attention"
        : "text-warning";

const fileName = (path: string) => path.split("/").at(-1) ?? path;
const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

const checkTone: Record<Check["state"], string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  pending: "bg-warning",
  skipped: "bg-faint",
};

/**
 * What the session changed in its folder, as git sees it, for its owner: the branch and its
 * pull request with the checks, what is staged and what is not, each file's diff a tap away,
 * and the box to commit. It is read again as the agent writes.
 */
export default function ChangesPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, url } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const faint = String(useCSSVariable("--color-faint"));
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const session = chat.sessions.find((s) => s.id === id);
  const git = useSessionGit(id, session?.output_at, url);
  const pr = useSessionPullRequest(id, session?.output_at, url);
  const [message, setMessage] = useState("");
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      void Haptics.selectionAsync();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const status = git.status;
  const staged = status?.changes.filter(isStaged) ?? [];
  const unstaged = status?.changes.filter(isUnstaged) ?? [];
  const discard = (paths: string[], what: string) =>
    Alert.alert(
      `Discard ${what}?`,
      "What is not staged is lost, and an untracked file is removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => void act(() => git.discard(paths)),
        },
      ],
    );
  const menu = (change: GitChange, inStaged: boolean) => {
    const actions = [
      inStaged
        ? {
            label: "Unstage",
            run: () => void act(() => git.unstage([change.path])),
          }
        : {
            label: "Stage",
            run: () => void act(() => git.stage([change.path])),
          },
      ...(inStaged
        ? []
        : [
            {
              label: "Discard changes",
              run: () => discard([change.path], fileName(change.path)),
            },
          ]),
      {
        label: "Copy path",
        run: () => void Clipboard.setStringAsync(change.path),
      },
    ];
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: change.path,
          options: [...actions.map((a) => a.label), "Cancel"],
          cancelButtonIndex: actions.length,
          destructiveButtonIndex: inStaged ? undefined : 1,
        },
        (index) => actions[index]?.run(),
      );
    else
      Alert.alert(
        change.path,
        undefined,
        actions.map((a) => ({ text: a.label, onPress: a.run })),
        { cancelable: true },
      );
  };
  const diff = (change: GitChange, inStaged: boolean) =>
    router.push({
      pathname: "/diff/[id]",
      params: { id, path: change.path, staged: String(inStaged) },
    });
  const commit = () =>
    act(async () => {
      await git.commit(message.trim());
      setMessage("");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
  return (
    <Screen
      back
      title="Changes"
      subtitle={
        status
          ? `${status.changes.length} ${status.changes.length === 1 ? "file" : "files"} changed`
          : undefined
      }
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 py-4"
        keyboardDismissMode="interactive"
      >
        {git.error || error ? (
          <Text className="px-4 text-sm text-destructive">
            {error || git.error}
          </Text>
        ) : null}
        {status ? (
          <View className="mx-4 gap-3 rounded-md border border-border bg-card px-3.5 py-3">
            <View className="flex-row items-center gap-2.5">
              <GitBranchIcon color={muted} size={17} strokeWidth={1.5} />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="font-mono text-[14px]">
                  {status.branch ?? "Detached HEAD"}
                </Text>
                <Text numberOfLines={1} className="text-xs text-faint">
                  {status.upstream
                    ? `${status.upstream} · ${status.ahead} ahead, ${status.behind} behind`
                    : "Not pushed yet"}
                </Text>
              </View>
              {status.branch && (status.ahead > 0 || !status.upstream) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onPress={() => void act(() => git.push())}
                >
                  <Text>Push</Text>
                </Button>
              ) : null}
            </View>
            <PullRequestView
              pullRequest={pr.pullRequest}
              error={pr.error}
              canOpen={Boolean(status.branch && status.upstream)}
              open={() => setOpening(true)}
            />
          </View>
        ) : !git.error ? (
          <Text className="px-4 text-sm text-faint">Reading git…</Text>
        ) : null}
        {status && !status.changes.length ? (
          <Text className="px-4 text-sm text-faint">
            Nothing changed since the last commit.
          </Text>
        ) : null}
        {staged.length ? (
          <Section
            title="Staged"
            count={staged.length}
            actions={[
              {
                label: "Unstage all",
                run: () =>
                  void act(() => git.unstage(staged.map((c) => c.path))),
              },
            ]}
            busy={busy}
          >
            {staged.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                letter={change.staged}
                staged
                busy={busy}
                open={() => diff(change, true)}
                toggle={() => void act(() => git.unstage([change.path]))}
                menu={() => menu(change, true)}
              />
            ))}
          </Section>
        ) : null}
        {unstaged.length ? (
          <Section
            title="Not staged"
            count={unstaged.length}
            actions={[
              {
                label: "Discard all",
                destructive: true,
                run: () =>
                  discard(
                    unstaged.map((c) => c.path),
                    `all ${unstaged.length} changes`,
                  ),
              },
              {
                label: "Stage all",
                run: () =>
                  void act(() => git.stage(unstaged.map((c) => c.path))),
              },
            ]}
            busy={busy}
          >
            {unstaged.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                letter={change.unstaged}
                staged={false}
                busy={busy}
                open={() => diff(change, false)}
                toggle={() => void act(() => git.stage([change.path]))}
                menu={() => menu(change, false)}
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>
      {status ? (
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
          <View
            className="flex-row items-end gap-2 border-t border-border bg-background px-3 pt-2"
            style={{ paddingBottom: 8 + insets.bottom }}
          >
            <TextInput
              value={message}
              onChangeText={setMessage}
              multiline
              editable={!busy}
              placeholder={
                staged.length
                  ? "Commit message"
                  : "Stage changes to commit them"
              }
              placeholderTextColor={faint}
              accessibilityLabel="Commit message"
              className="max-h-28 flex-1 rounded-md border border-input bg-card px-3 py-2 font-sans text-[15px] text-foreground"
            />
            <Button
              disabled={busy || !staged.length || !message.trim()}
              onPress={() => void commit()}
            >
              <Text>Commit</Text>
            </Button>
          </View>
        </KeyboardStickyView>
      ) : null}
      <Modal
        visible={opening}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpening(false)}
      >
        <OpenPullRequest
          branch={status?.branch ?? ""}
          open={(input) => pr.open(input).then(() => setOpening(false))}
          close={() => setOpening(false)}
        />
      </Modal>
    </Screen>
  );
}

/** A group of changes, with what applies to all of them. */
function Section({
  title,
  count,
  actions,
  busy,
  children,
}: {
  title: string;
  count: number;
  actions: { label: string; run: () => void; destructive?: boolean }[];
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <View>
      <View className="flex-row items-center gap-3 px-4 pb-1.5">
        <Text className="flex-1 text-[13px] font-medium text-muted-foreground">
          {title} · {count}
        </Text>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            disabled={busy}
            onPress={action.run}
            hitSlop={8}
          >
            <Text
              className={cn(
                "text-[13px] font-medium",
                action.destructive
                  ? "text-destructive"
                  : "text-human-foreground",
              )}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View className="border-y border-border">{children}</View>
    </View>
  );
}

/** One changed file: its letter, its name and folder; a tap shows its diff, the side button
 * stages or unstages it, a long press has the rest. */
function ChangeRow({
  change,
  letter,
  staged,
  busy,
  open,
  toggle,
  menu,
}: {
  change: GitChange;
  letter: string;
  staged: boolean;
  busy: boolean;
  open: () => void;
  toggle: () => void;
  menu: () => void;
}) {
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const folder = folderOf(change.path);
  return (
    <Pressable
      onPress={open}
      onLongPress={menu}
      accessibilityRole="button"
      accessibilityLabel={`${change.path}, ${changeLabels[letter] ?? letter}`}
      className="flex-row items-center gap-3 py-2 pr-2 pl-4 active:bg-accent"
    >
      <Text
        className={cn(
          "w-4 text-center font-mono text-[13px] font-semibold",
          letterTone(letter),
        )}
      >
        {letter}
      </Text>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-[15px]">
          {fileName(change.path)}
        </Text>
        {change.from || folder ? (
          <Text
            numberOfLines={1}
            className="font-mono text-[11.5px] text-faint"
          >
            {change.from ? `from ${change.from}` : folder}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={staged ? "Unstage" : "Stage"}
        disabled={busy}
        onPress={toggle}
        hitSlop={6}
        className="size-9 items-center justify-center rounded-sm active:bg-accent"
      >
        {staged ? (
          <MinusIcon color={muted} size={18} strokeWidth={1.5} />
        ) : (
          <PlusIcon color={muted} size={18} strokeWidth={1.5} />
        )}
      </Pressable>
    </Pressable>
  );
}

const prState = (pr: PullRequest) =>
  pr.state === "OPEN"
    ? pr.isDraft
      ? "Draft"
      : "Open"
    : pr.state === "MERGED"
      ? "Merged"
      : "Closed";
const reviewWords: Record<PullRequest["reviewDecision"], string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
  "": "",
};

/** The branch's pull request and its checks, each opening on GitHub; or the way to open one. */
function PullRequestView({
  pullRequest,
  error,
  canOpen,
  open,
}: {
  pullRequest: PullRequest | null | undefined;
  error: string;
  canOpen: boolean;
  open: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  if (error) return <Text className="text-xs text-faint">{error}</Text>;
  if (pullRequest === undefined) return null;
  if (!pullRequest)
    return canOpen ? (
      <Button size="sm" variant="outline" onPress={open}>
        <Text>Open a pull request</Text>
      </Button>
    ) : (
      <Text className="text-xs text-faint">
        Push the branch to open a pull request.
      </Text>
    );
  const checks = checksOf(pullRequest);
  const facts = [
    prState(pullRequest),
    `${pullRequest.headRefName} → ${pullRequest.baseRefName}`,
    reviewWords[pullRequest.reviewDecision],
    pullRequest.mergeable === "CONFLICTING" ? "Conflicts" : "",
  ].filter(Boolean);
  return (
    <View className="gap-2 border-t border-border pt-3">
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(pullRequest.url)}
        className="flex-row items-start gap-2 active:opacity-70"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-medium">
            #{pullRequest.number} {pullRequest.title}
          </Text>
          <Text
            className={cn(
              "text-xs text-faint",
              pullRequest.mergeable === "CONFLICTING" && "text-attention",
            )}
          >
            {facts.join(" · ")}
          </Text>
        </View>
        <ArrowUpRightIcon color={faint} size={16} strokeWidth={1.5} />
      </Pressable>
      {checks.map((check, index) => (
        <Pressable
          key={`${check.name}-${index}`}
          accessibilityRole={check.url ? "link" : undefined}
          disabled={!check.url}
          onPress={() => check.url && void Linking.openURL(check.url)}
          className="flex-row items-center gap-2.5 active:opacity-70"
        >
          <View className={cn("size-2 rounded-full", checkTone[check.state])} />
          <Text numberOfLines={1} className="flex-1 text-[13px]">
            {check.name}
          </Text>
          <Text className="text-xs text-faint">{check.state}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A pull request for the branch: its title, what it says, and whether it is a draft. */
function OpenPullRequest({
  branch,
  open,
  close,
}: {
  branch: string;
  open: (input: {
    title: string;
    body: string;
    draft: boolean;
  }) => Promise<unknown>;
  close: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <Pressable accessibilityRole="button" onPress={close} hitSlop={12}>
          <Text className="text-base text-muted-foreground">Cancel</Text>
        </Pressable>
        <Text className="text-[17px] font-semibold">Pull request</Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !title.trim()}
          onPress={() => {
            setBusy(true);
            setError("");
            open({ title: title.trim(), body, draft })
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          hitSlop={12}
          className="disabled:opacity-40"
        >
          <Text className="text-base font-medium text-human-foreground">
            Open
          </Text>
        </Pressable>
      </View>
      <ScrollView contentContainerClassName="gap-4 px-5 py-4">
        <Text className="font-mono text-xs text-faint">{branch}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoFocus
          placeholder="Title"
          placeholderTextColor={faint}
          className="rounded-md border border-input bg-card px-3 py-2.5 font-sans text-[15px] text-foreground"
        />
        <TextInput
          value={body}
          onChangeText={setBody}
          multiline
          placeholder="What it changes, and why"
          placeholderTextColor={faint}
          textAlignVertical="top"
          className="min-h-40 rounded-md border border-input bg-card px-3 py-2.5 font-sans text-[15px] text-foreground"
        />
        <View className="flex-row items-center justify-between">
          <Text className="text-[15px]">Draft</Text>
          <Switch value={draft} onValueChange={setDraft} />
        </View>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
