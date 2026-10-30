import { useRouter } from "expo-router";
import { CheckIcon, PlusIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage, requiresSignIn } from "@zerolux/chat";
import type { MenuEntry } from "@zerolux/ui";
import { Menu, RowMenu } from "@/components/action-menu";
import { PageSheet } from "@/components/page-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import {
  elsewhereLine,
  Waiting,
  WorkspaceMark,
} from "@/components/workspace-mark";
import { cn } from "@/lib/utils";
import { useAuthentication } from "../src/auth";
import { keptKey, keptName, useKernel, useOpenSession } from "../src/kernel";
import type { ElsewhereState, KeptWorkspace, KernelState } from "../src/kernel";

/** What a workspace says under its name: here, what waits in it, or why it cannot be read. */
const line = (open: boolean, state?: ElsewhereState) =>
  open ? "Here now" : elsewhereLine(state);

/**
 * The kernels on this phone, each signed in to once, with the account's workspaces on them:
 * the open one, what waits in the others, and a new one. A tap opens a workspace, staying
 * signed in to every kernel.
 */
export default function Workspaces() {
  const kernel = useKernel();
  const auth = useAuthentication();
  const session = useOpenSession();
  const router = useRouter();
  const tick = String(useCSSVariable("--color-agent-foreground"));
  const ink = String(useCSSVariable("--color-foreground"));
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const [renaming, setRenaming] = useState<KeptWorkspace>();
  const [error, setError] = useState("");
  const look = kernel.look;
  useEffect(() => look(), [look]);
  const current = kernel.current && keptKey(kernel.current);
  const unsigned = Boolean(auth?.health && !requiresSignIn(auth.health));
  // The open kernel is as its sign-in says; the others as last read.
  const stateOf = (origin: string): KernelState | undefined =>
    origin !== kernel.here
      ? kernel.states[origin]
      : auth?.identity || unsigned
        ? "ready"
        : auth?.health
          ? "signed-out"
          : auth?.error
            ? "offline"
            : undefined;

  async function act(work: () => Promise<void>) {
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function open(workspace: KeptWorkspace) {
    if (keptKey(workspace) === current) return router.back();
    void act(() => kernel.open(workspace.kernel, workspace));
  }
  const workspaceMenu = (w: KeptWorkspace): MenuEntry[] => [
    ...(keptKey(w) === current
      ? []
      : [
          {
            title: `Switch to ${keptName(w)}`,
            icon: "arrow-right-left",
            onPress: () => open(w),
          },
        ]),
    {
      title: "Rename on this phone",
      icon: "pencil",
      onPress: () => setRenaming(w),
    },
  ];
  const kernelMenu = (origin: string, state?: KernelState): MenuEntry[] => {
    const host = new URL(origin).host;
    const here = origin === kernel.here;
    return [
      ...(state === "ready" && !unsigned
        ? [
            {
              title: "Sign out",
              icon: "log-out",
              onPress: () =>
                void act(async () => {
                  if (!here) return kernel.signOut(origin);
                  if (session && !session.chat.canLeave())
                    throw new Error(
                      "Wait for pending chat messages before signing out.",
                    );
                  await auth?.signOut();
                }),
            },
            { divider: true as const },
          ]
        : []),
      {
        title: "Remove from this phone",
        icon: "trash-2",
        tone: "danger" as const,
        onPress: () =>
          Alert.alert(`Remove ${host} from this phone?`, undefined, [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () => void act(() => kernel.forget(origin)),
            },
          ]),
      },
    ];
  };

  // The sheet sizes its first child to itself only when it is the scroll view.
  return (
    <>
      <ScrollView contentContainerClassName="gap-2 px-5 pt-6 pb-10">
        <Text className="text-[21px] font-semibold">Workspaces</Text>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        {kernel.kernels.map(({ kernel: origin, multi }) => {
          const mine = kernel.workspaces.filter((w) => w.kernel === origin);
          const state = stateOf(origin);
          const host = new URL(origin).host;
          return (
            <View key={origin} className="gap-1.5 pt-3">
              <View className="flex-row items-center gap-2 pl-0.5">
                <View
                  className={cn(
                    "size-1.5 rounded-full",
                    state === "ready" ? "bg-success" : "bg-faint",
                  )}
                />
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 font-mono text-[12px] text-muted-foreground"
                >
                  {host}
                  {state === "offline"
                    ? " · offline"
                    : state === "signed-out"
                      ? " · signed out"
                      : ""}
                </Text>
                {state === "signed-out" ? (
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => void act(() => kernel.openKernel(origin))}
                  >
                    <Text className="text-[14px] font-semibold text-human-foreground">
                      Sign in
                    </Text>
                  </Pressable>
                ) : null}
                <Menu label={host} items={kernelMenu(origin, state)} />
              </View>
              <View className="overflow-hidden rounded-md border border-border bg-card">
                {mine.map((w, i) => {
                  const here = keptKey(w) === current;
                  const status = kernel.elsewhere[keptKey(w)];
                  const dimmed = !here && state !== "ready";
                  const waiting =
                    status?.state === "ready"
                      ? status.requests + status.unread
                      : 0;
                  return (
                    <RowMenu key={keptKey(w)} items={workspaceMenu(w)}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: here }}
                        onPress={() => open(w)}
                        className={cn(
                          "min-h-14 flex-row items-center gap-3 bg-card px-3.5 py-2.5 active:bg-accent",
                          i > 0 && "border-t border-border",
                        )}
                      >
                        <View className={cn(dimmed && "opacity-50")}>
                          <WorkspaceMark id={w.id} name={keptName(w)} />
                        </View>
                        <View
                          className={cn(
                            "min-w-0 flex-1",
                            dimmed && "opacity-50",
                          )}
                        >
                          <Text
                            numberOfLines={1}
                            className="text-[15px] font-medium"
                          >
                            {keptName(w)}
                          </Text>
                          <Text
                            numberOfLines={1}
                            className="text-[13px] text-muted-foreground"
                          >
                            {line(here, status)}
                          </Text>
                        </View>
                        {here ? (
                          <CheckIcon color={tick} size={18} strokeWidth={2.2} />
                        ) : waiting ? (
                          <Waiting count={waiting} />
                        ) : null}
                      </Pressable>
                    </RowMenu>
                  );
                })}
                {multi && state === "ready" ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: "/workspace-new",
                        params: { kernel: origin },
                      })
                    }
                    className={cn(
                      "min-h-12 flex-row items-center gap-3 bg-card px-3.5 py-2.5 active:bg-accent",
                      mine.length > 0 && "border-t border-border",
                    )}
                  >
                    <View className="size-9 items-center justify-center">
                      <PlusIcon color={muted} size={18} strokeWidth={2} />
                    </View>
                    <Text className="text-[15px] text-muted-foreground">
                      New workspace
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        })}
        <View className="pt-4">
          <Button
            variant="outline"
            onPress={() => router.push("/workspace-add")}
          >
            <PlusIcon color={ink} size={17} strokeWidth={2} />
            <Text>Connect a kernel</Text>
          </Button>
        </View>
      </ScrollView>
      {renaming ? (
        <Rename
          workspace={renaming}
          done={() => setRenaming(undefined)}
          save={(alias) => kernel.rename(renaming, alias)}
        />
      ) : null}
    </>
  );
}

/** A name for a workspace on this phone only; empty, it shows its own again. */
function Rename({
  workspace,
  save,
  done,
}: {
  workspace: KeptWorkspace;
  save: (alias: string) => Promise<void>;
  done: () => void;
}) {
  const [alias, setAlias] = useState(workspace.alias ?? "");
  const [error, setError] = useState("");
  return (
    <PageSheet open onClose={done}>
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <Pressable accessibilityRole="button" onPress={done} hitSlop={12}>
          <Text className="text-base font-medium text-human-foreground">
            Cancel
          </Text>
        </Pressable>
        <Text className="text-[17px] font-semibold">Rename on this phone</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void save(alias).then(done, (e: unknown) =>
              setError(errorMessage(e)),
            )
          }
          hitSlop={12}
        >
          <Text className="text-base font-semibold text-human-foreground">
            Save
          </Text>
        </Pressable>
      </View>
      <View className="gap-2 px-5 pt-5">
        <Input
          value={alias}
          onChangeText={setAlias}
          placeholder={workspace.name}
          autoFocus
          returnKeyType="done"
          maxLength={80}
        />
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
      </View>
    </PageSheet>
  );
}
