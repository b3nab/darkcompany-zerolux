import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage, multiWorkspace, workspaceAddress } from "@zerolux/chat";
import type { ServedWorkspace } from "@zerolux/chat";
import { NewWorkspaceForm } from "@/components/new-workspace";
import { Button } from "@/components/ui/button";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { WorkspaceMark } from "@/components/workspace-mark";
import { cn } from "@/lib/utils";
import { useAuthentication } from "../src/auth";
import { setPendingInvite, usePendingInvite } from "../src/invite";
import { keptName, useKernel } from "../src/kernel";

/**
 * Signed in to a kernel, not yet in a workspace there: the invitation's workspace is joined,
 * an older kernel's own bound to its owner, and the workspace named, or the only one, opened.
 * Otherwise the account's workspaces to choose from, and a new one.
 */
export default function Start() {
  const kernel = useKernel();
  const auth = useAuthentication();
  const router = useRouter();
  const invite = usePendingInvite();
  const faint = String(useCSSVariable("--color-faint"));
  const [served, setServed] = useState<ServedWorkspace[]>();
  const [error, setError] = useState("");
  const here = kernel.here;
  const join = auth?.join;
  const member = auth?.member;
  const older = auth?.health ? !multiWorkspace(auth.health) : false;

  useEffect(() => {
    if (!here || !join) return;
    let live = true;
    void (async () => {
      try {
        const invited =
          invite && new URL(invite.base).origin === here ? invite : undefined;
        if (invited) {
          await join(invited.base, invited.token);
          setPendingInvite(null);
        }
        const list = await kernel.list(here);
        if (!live) return;
        setServed(list);
        const wanted = invited
          ? workspaceAddress(invited.base).workspaceId
          : kernel.wanted;
        const chosen =
          list.find((w) => w.id === wanted) ??
          (list.length === 1 ? list[0] : undefined);
        if (chosen && chosen.id !== kernel.current?.id)
          await kernel.open(here, chosen);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => {
      live = false;
    };
    // Once per kernel opened: the rest is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);

  // An older kernel's one workspace, not set up yet: the account signed in becomes its owner.
  const base = kernel.current?.base;
  useEffect(() => {
    if (older && base && member && !member.actor_id && member.setup_required)
      void join?.(base);
  }, [older, base, member, join]);

  if (!here) return null;
  const reading = (!served && !error) || (base && member === undefined);
  const outside =
    kernel.current && member && !member.actor_id && !member.setup_required;
  return (
    <SafeArea className="flex-1 bg-background">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow justify-center gap-5 p-6"
      >
        <View className="gap-1">
          <Text className="text-[28px] font-semibold tracking-tight">
            Workspaces
          </Text>
          <Text className="font-mono text-[13px] text-muted-foreground">
            {new URL(here).host}
            {auth?.identity ? ` · ${auth.identity.user.email}` : ""}
          </Text>
        </View>
        {outside ? (
          <Text className="text-base text-muted-foreground">
            {`This account is not a member of ${keptName(kernel.current!)}.`}
          </Text>
        ) : null}
        {reading ? (
          <ActivityIndicator />
        ) : served?.length ? (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {served.map((w, i) => (
              <Pressable
                key={w.id}
                accessibilityRole="button"
                onPress={() => void kernel.open(here, w)}
                className={cn(
                  "min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-accent",
                  i > 0 && "border-t border-border",
                )}
              >
                <WorkspaceMark id={w.id} name={w.name} />
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-[15px] font-medium"
                >
                  {w.name}
                </Text>
                <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
              </Pressable>
            ))}
          </View>
        ) : null}
        {served && !older ? (
          <View className="gap-2">
            <Text className="text-sm">
              {served.length ? "New workspace" : "Your first workspace"}
            </Text>
            <NewWorkspaceForm kernel={here} />
          </View>
        ) : null}
        {error || auth?.error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error || auth?.error}
          </Text>
        ) : null}
        <Button
          variant="outline"
          disabled={auth?.busy}
          onPress={() => void auth?.signOut()}
        >
          <Text>Sign out</Text>
        </Button>
        {kernel.kernels.length > 1 ? (
          <Button variant="ghost" onPress={() => router.push("/workspaces")}>
            <Text>Choose another workspace</Text>
          </Button>
        ) : null}
      </ScrollView>
    </SafeArea>
  );
}
