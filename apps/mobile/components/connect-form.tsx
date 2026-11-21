import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import {
  errorMessage,
  readInviteLink,
  secureKernelAddress,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useNetworkKernels } from "../src/discovery";
import { setPendingInvite } from "../src/invite";
import { useKernel } from "../src/kernel";

/**
 * Where a kernel is: one found on this network, its address, a workspace's address on it, or
 * an invitation link. The kernel is checked, kept and opened to sign in; the workspace named
 * opens after that.
 */
export function ConnectForm({ autoFocus }: { autoFocus?: boolean }) {
  const kernel = useKernel();
  const nearby = useNetworkKernels();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect(found?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    // An invitation link names the kernel and the workspace too: open it, then join with it.
    const link = found ? null : readInviteLink(address);
    try {
      const typed = (found ?? link?.kernel ?? address)
        .trim()
        .replace(/\/+$/, "");
      const at = secureKernelAddress(
        /^https?:\/\//i.test(typed) ? typed : `http://${typed}`,
      );
      setPendingInvite(link ? { base: at, token: link.invite } : null);
      await kernel.connect(at);
    } catch (e) {
      setPendingInvite(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-4">
      {nearby.kernels.length ? (
        <View className="gap-2">
          <Text className="font-mono text-[11px] tracking-wider text-faint uppercase">
            On this network
          </Text>
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {nearby.kernels.map((found, i) => (
              <Pressable
                key={found.id}
                disabled={busy}
                onPress={() => void connect(found.address)}
                accessibilityRole="button"
                className={cn(
                  "gap-0.5 px-4 py-3 active:bg-accent",
                  i > 0 && "border-t border-border",
                )}
              >
                <Text className="text-base font-medium">{found.name}</Text>
                <Text className="font-mono text-xs text-faint">
                  {found.computer}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : nearby.state === "denied" ? (
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-sm text-muted-foreground">
            Local network access is off
          </Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() => void Linking.openSettings()}
          >
            <Text>Settings</Text>
          </Button>
        </View>
      ) : null}
      <Input
        className="h-12 text-lg"
        value={address}
        onChangeText={setAddress}
        placeholder="http://192.168.1.10:4310 or an invitation link"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void connect()}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View>
        <Button
          size="lg"
          disabled={busy || !address.trim()}
          onPress={() => void connect()}
        >
          <Text>{busy ? "Connecting…" : "Connect"}</Text>
        </Button>
      </View>
    </View>
  );
}
