import { useRouter } from "expo-router";
import { CheckIcon, PlusIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage } from "@zerolux/chat";
import type { MenuEntry } from "@zerolux/ui";
import { RowMenu } from "@/components/action-menu";
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
import { keptKey, keptName, useKernel } from "../src/kernel";
import type { ElsewhereState, KeptWorkspace } from "../src/kernel";

/** What a kept workspace says under its name: here, what waits in it, or why it cannot be read. */
const line = (open: boolean, state?: ElsewhereState) =>
  open ? "Here now" : elsewhereLine(state);

/**
 * The workspaces on this phone, by kernel: the open one, what waits in the others, the ones
 * to sign in to again or out of reach, and what each kernel serves besides. A tap opens one,
 * staying signed in to all.
 */
export default function Workspaces() {
  const kernel = useKernel();
  const router = useRouter();
  const tick = String(useCSSVariable("--color-agent-foreground"));
  const ink = String(useCSSVariable("--color-foreground"));
  const [renaming, setRenaming] = useState<KeptWorkspace>();
  const [error, setError] = useState("");
  const look = kernel.look;
  useEffect(() => look(), [look]);
  const kernels = [...new Set(kernel.workspaces.map((w) => w.kernel))];
  const current = kernel.current && keptKey(kernel.current);

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
    void act(() =>
      kernel.open(workspace.kernel, {
        id: workspace.id,
        name: workspace.name,
        base: workspace.base,
      }),
    );
  }
  const menu = (w: KeptWorkspace): MenuEntry[] => {
    const here = keptKey(w) === current;
    const state = kernel.elsewhere[keptKey(w)];
    return [
      ...(here
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
      ...(here || state?.state === "signed-out"
        ? []
        : [
            {
              title: "Sign out",
              icon: "log-out",
              onPress: () => void act(() => kernel.signOut(w)),
            },
          ]),
      { divider: true },
      {
        title: "Remove from this phone",
        icon: "trash-2",
        tone: "danger" as const,
        onPress: () =>
          Alert.alert(`Remove ${keptName(w)} from this phone?`, undefined, [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () => void act(() => kernel.forget(w)),
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
        {kernels.map((origin) => {
          const mine = kernel.workspaces.filter((w) => w.kernel === origin);
          const offline = mine.every(
            (w) =>
              keptKey(w) !== current &&
              kernel.elsewhere[keptKey(w)]?.state === "offline",
          );
          const more = kernel.available[origin] ?? [];
          return (
            <View key={origin} className="gap-1.5 pt-3">
              <View className="flex-row items-center gap-2 px-0.5">
                <View
                  className={cn(
                    "size-1.5 rounded-full",
                    offline ? "bg-faint" : "bg-success",
                  )}
                />
                <Text className="font-mono text-[12px] text-muted-foreground">
                  {new URL(origin).host}
                  {offline ? " · offline" : ""}
                </Text>
              </View>
              <View className="overflow-hidden rounded-md border border-border bg-card">
                {mine.map((w, i) => {
                  const here = keptKey(w) === current;
                  const state = kernel.elsewhere[keptKey(w)];
                  const dimmed =
                    !here &&
                    (state?.state === "signed-out" ||
                      state?.state === "offline");
                  const waiting =
                    state?.state === "ready"
                      ? state.requests + state.unread
                      : 0;
                  return (
                    <RowMenu key={keptKey(w)} items={menu(w)}>
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
                            {line(here, state)}
                          </Text>
                        </View>
                        {here ? (
                          <CheckIcon color={tick} size={18} strokeWidth={2.2} />
                        ) : state?.state === "signed-out" ? (
                          <Text className="text-[14px] font-semibold text-human-foreground">
                            Sign in
                          </Text>
                        ) : waiting ? (
                          <Waiting count={waiting} />
                        ) : null}
                      </Pressable>
                    </RowMenu>
                  );
                })}
                {more.map((w) => (
                  <Pressable
                    key={w.id}
                    accessibilityRole="button"
                    onPress={() => void act(() => kernel.open(origin, w))}
                    className="min-h-14 flex-row items-center gap-3 border-t border-border bg-card px-3.5 py-2.5 active:bg-accent"
                  >
                    <WorkspaceMark id={w.id} name={w.name} />
                    <Text
                      numberOfLines={1}
                      className="min-w-0 flex-1 text-[15px] font-medium"
                    >
                      {w.name}
                    </Text>
                    <Text className="text-[14px] font-semibold text-human-foreground">
                      Add
                    </Text>
                  </Pressable>
                ))}
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
            <Text>Add workspace</Text>
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
