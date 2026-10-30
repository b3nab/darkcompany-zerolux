import { useState } from "react";
import { View } from "react-native";
import { errorMessage } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useKernel } from "../src/kernel";

/** A new workspace on a kept kernel, the account its owner; it opens once created. */
export function NewWorkspaceForm({
  kernel: origin,
  autoFocus,
}: {
  kernel: string;
  autoFocus?: boolean;
}) {
  const kernel = useKernel();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const client = kernel.connection(origin);
      // The open kernel is verified by its sign-in; another one, here.
      if (origin !== kernel.here) await client.restore();
      await kernel.open(origin, await client.createWorkspace(name));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <Input
        accessibilityLabel="Name"
        value={name}
        onChangeText={setName}
        placeholder="Name"
        autoFocus={autoFocus}
        maxLength={80}
        returnKeyType="done"
        editable={!busy}
        onSubmitEditing={() => void create()}
      />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      <Button disabled={busy || !name.trim()} onPress={() => void create()}>
        <Text>{busy ? "Creating…" : "Create workspace"}</Text>
      </Button>
    </View>
  );
}
