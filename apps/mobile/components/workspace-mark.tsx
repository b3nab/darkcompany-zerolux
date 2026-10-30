import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { authorColor } from "@zerolux/chat";
import { Eyebrow } from "@/components/meter";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { keptKey, keptName, useKernel } from "../src/kernel";
import type { ElsewhereState as State } from "../src/kernel";

const sizes = {
  sm: "size-7 rounded-[7px]",
  md: "size-9 rounded-[9px]",
  lg: "size-16 rounded-2xl",
};
const letters = { sm: "text-[13px]", md: "text-base", lg: "text-[28px]" };

/** A workspace's mark: its initial, in a color of its own. The name is said beside it. */
export function WorkspaceMark({
  id,
  name,
  size = "md",
}: {
  id: string;
  name: string;
  size?: keyof typeof sizes;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn(
        "items-center justify-center border border-border bg-muted",
        sizes[size],
      )}
    >
      <Text className={cn("font-semibold", authorColor(id), letters[size])}>
        {(name.trim()[0] ?? "·").toUpperCase()}
      </Text>
    </View>
  );
}

/** What waits in the workspaces that are not open: their requests and chats with unread messages. */
export function useWaitingElsewhere() {
  const { elsewhere, workspaces, current } = useKernel();
  const open = current && keptKey(current);
  return workspaces.reduce((sum, w) => {
    const state = keptKey(w) === open ? undefined : elsewhere[keptKey(w)];
    return sum + (state?.state === "ready" ? state.requests + state.unread : 0);
  }, 0);
}

/** The open workspace's mark in a tab's header: it opens the workspaces, and counts what waits in the others. */
export function WorkspaceButton() {
  const { current } = useKernel();
  const router = useRouter();
  const waiting = useWaitingElsewhere();
  if (!current) return null;
  return (
    <Pressable
      onPress={() => router.push("/workspaces")}
      accessibilityRole="button"
      accessibilityLabel={`Workspaces: ${keptName(current)}`}
      accessibilityHint={waiting ? `${waiting} waiting elsewhere` : undefined}
      hitSlop={8}
      className="size-10 items-center justify-center rounded-full active:bg-accent"
    >
      <WorkspaceMark id={current.id} name={keptName(current)} size="sm" />
      {waiting ? (
        <View className="absolute -top-0.5 -right-1 h-[18px] min-w-[18px] items-center justify-center rounded-full bg-attention px-1">
          <Text className="text-[11px] font-bold text-background">
            {waiting > 99 ? "99+" : waiting}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** What a workspace that is not open says under its name: what waits in it, or why it cannot be read. */
export function elsewhereLine(state?: State) {
  if (!state) return "";
  if (state.state === "signed-out") return "Signed out";
  if (state.state === "offline") return "Offline";
  const said = [
    state.requests &&
      `${state.requests} ${state.requests === 1 ? "request" : "requests"}`,
    state.unread &&
      `${state.unread} unread ${state.unread === 1 ? "chat" : "chats"}`,
  ].filter(Boolean);
  return said.length ? said.join(" · ") : "Nothing waiting";
}

/** A count of what waits, in the app's attention color. */
export function Waiting({ count }: { count: number }) {
  return (
    <View className="h-[22px] min-w-[22px] items-center justify-center rounded-full bg-attention px-1.5">
      <Text className="text-[12px] font-bold text-background">
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  );
}

/** In Today, what waits in the other workspaces on this phone; a row opens one. */
export function Elsewhere() {
  const kernel = useKernel();
  const open = kernel.current && keptKey(kernel.current);
  const rows = kernel.workspaces.flatMap((w) => {
    const state = kernel.elsewhere[keptKey(w)];
    return keptKey(w) !== open &&
      state?.state === "ready" &&
      state.requests + state.unread > 0
      ? [{ w, state, count: state.requests + state.unread }]
      : [];
  });
  if (!rows.length) return null;
  return (
    <View className="gap-2.5">
      <Eyebrow>Elsewhere</Eyebrow>
      <View className="overflow-hidden rounded-md border border-border bg-card">
        {rows.map(({ w, state, count }, i) => (
          <Pressable
            key={keptKey(w)}
            accessibilityRole="button"
            onPress={() => void kernel.open(w.kernel, w)}
            className={cn(
              "min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-accent",
              i > 0 && "border-t border-border",
            )}
          >
            <WorkspaceMark id={w.id} name={keptName(w)} />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[15px] font-medium">
                {keptName(w)}
              </Text>
              <Text
                numberOfLines={1}
                className="text-[13px] text-muted-foreground"
              >
                {elsewhereLine(state)}
              </Text>
            </View>
            <Waiting count={count} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
