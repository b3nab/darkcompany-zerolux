import { useState } from "react";
import { View } from "react-native";
import { errorMessage, readInviteLink } from "@zerolux/chat";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { setPendingInvite } from "../src/invite";
import { useKernel } from "../src/kernel";

export default function Connect() {
  const kernel = useKernel();
  const [address, setAddress] = useState(kernel.url ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError("");
    // An invitation link names the kernel too: connect there, then join with it.
    const link = readInviteLink(address);
    try {
      setPendingInvite(link?.invite ?? null);
      await kernel.connect(link?.kernel ?? address);
    } catch (e) {
      setPendingInvite(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (kernel.url === undefined)
    return (
      <SafeArea className="flex-1 justify-center bg-background p-6">
        <Text>Opening the saved connection…</Text>
      </SafeArea>
    );

  return (
    <SafeArea className="flex-1 justify-center gap-4 bg-background p-6">
      <Wordmark height={22} />
      <Text className="text-[34px] font-light tracking-tight">
        Where is your kernel?
      </Text>
      <Input
        className="h-12 text-lg"
        value={address}
        onChangeText={setAddress}
        placeholder="http://192.168.1.10:4310 or an invitation link"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={connect}
      />
      {error || kernel.error ? (
        <Text className="text-sm text-destructive">
          {error || kernel.error}
        </Text>
      ) : null}
      <View>
        <Button size="lg" disabled={busy || !address.trim()} onPress={connect}>
          <Text>{busy ? "Connecting…" : "Connect"}</Text>
        </Button>
      </View>
    </SafeArea>
  );
}
