import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { errorMessage } from "@zerolux/chat";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useKernel } from "../src/kernel";

export default function Connect() {
  const kernel = useKernel();
  const router = useRouter();
  const [address, setAddress] = useState(kernel.url ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      await kernel.connect(address);
      router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeArea className="flex-1 justify-center gap-4 bg-background p-6">
      <Wordmark height={22} />
      <Text className="text-[34px] font-light tracking-tight">
        Where is your kernel?
      </Text>
      <Text className="text-base leading-6 text-muted-foreground">
        The address of the computer that runs ZeroLux, on the same network as
        this device.
      </Text>
      <Input
        className="h-12 text-lg"
        value={address}
        onChangeText={setAddress}
        placeholder="192.168.1.10:4310"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={connect}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <View>
        <Button size="lg" disabled={busy || !address.trim()} onPress={connect}>
          <Text>{busy ? "Connecting…" : "Connect"}</Text>
        </Button>
      </View>
    </SafeArea>
  );
}
