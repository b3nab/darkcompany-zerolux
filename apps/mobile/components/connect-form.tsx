import { CheckIcon, ChevronRightIcon } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  errorMessage,
  readInstance,
  readInviteLink,
  workspaceAddress,
} from "@zerolux/chat";
import type { KernelInstance, ServedWorkspace } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { WorkspaceMark } from "@/components/workspace-mark";
import { cn } from "@/lib/utils";
import { setPendingInvite } from "../src/invite";
import { useKernel } from "../src/kernel";

/**
 * Where a kernel is: its address, a workspace's address on it, or an invitation link. A
 * workspace named, or a kernel's only one, opens at once; several are offered here to choose.
 */
export function ConnectForm({ autoFocus }: { autoFocus?: boolean }) {
  const kernel = useKernel();
  const faint = String(useCSSVariable("--color-faint"));
  const tick = String(useCSSVariable("--color-agent-foreground"));
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<KernelInstance>();
  const [opening, setOpening] = useState<string>();

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    // An invitation link names the kernel and the workspace too: open it, then join with it.
    const link = readInviteLink(address);
    try {
      const typed = (link?.kernel ?? address).trim().replace(/\/+$/, "");
      const named = workspaceAddress(
        /^https?:\/\//i.test(typed) ? typed : `http://${typed}`,
      );
      const instance = await readInstance(named.kernel);
      const chosen = named.workspaceId
        ? instance.workspaces.find((w) => w.id === named.workspaceId)
        : instance.workspaces.length === 1
          ? instance.workspaces[0]
          : undefined;
      if (named.workspaceId && !chosen)
        throw new Error("This kernel serves no such workspace");
      setPendingInvite(link?.invite ?? null);
      if (chosen) await kernel.open(instance.kernel, chosen);
      else setChoice(instance);
    } catch (e) {
      setPendingInvite(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(instance: KernelInstance, workspace: ServedWorkspace) {
    setOpening(workspace.id);
    setError("");
    try {
      await kernel.open(instance.kernel, workspace);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(undefined);
    }
  }
  const kept = new Set(
    kernel.workspaces
      .filter((w) => w.kernel === choice?.kernel)
      .map((w) => w.id),
  );

  return (
    <View className="gap-4">
      <Input
        className="h-12 text-lg"
        value={address}
        onChangeText={(next) => {
          setAddress(next);
          setChoice(undefined);
        }}
        placeholder="http://192.168.1.10:4310 or an invitation link"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void connect()}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {choice ? (
        choice.workspaces.length === 0 ? (
          <Text className="text-sm text-faint">No workspaces</Text>
        ) : (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {choice.workspaces.map((w, i) => (
              <Pressable
                key={w.id}
                accessibilityRole="button"
                disabled={Boolean(opening)}
                onPress={() => void open(choice, w)}
                className={cn(
                  "min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-accent",
                  i > 0 && "border-t border-border",
                )}
              >
                <WorkspaceMark id={w.id} name={w.name} />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-[15px] font-medium">
                    {w.name}
                  </Text>
                  {kept.has(w.id) ? (
                    <Text className="text-[13px] text-muted-foreground">
                      On this phone
                    </Text>
                  ) : null}
                </View>
                {opening === w.id ? (
                  <ActivityIndicator />
                ) : kept.has(w.id) ? (
                  <CheckIcon color={tick} size={18} strokeWidth={2.2} />
                ) : (
                  <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
                )}
              </Pressable>
            ))}
          </View>
        )
      ) : (
        <View>
          <Button
            size="lg"
            disabled={busy || !address.trim()}
            onPress={() => void connect()}
          >
            <Text>{busy ? "Connecting…" : "Connect"}</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
