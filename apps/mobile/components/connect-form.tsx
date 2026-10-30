import { useState } from "react";
import { View } from "react-native";
import {
  errorMessage,
  readInviteLink,
  secureKernelAddress,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { setPendingInvite } from "../src/invite";
import { useKernel } from "../src/kernel";

/**
 * Where a kernel is: its address, a workspace's address on it, or an invitation link. The
 * kernel is checked, kept and opened to sign in; the workspace named opens after that.
 */
export function ConnectForm({ autoFocus }: { autoFocus?: boolean }) {
  const kernel = useKernel();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    // An invitation link names the kernel and the workspace too: open it, then join with it.
    const link = readInviteLink(address);
    try {
      const typed = (link?.kernel ?? address).trim().replace(/\/+$/, "");
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
