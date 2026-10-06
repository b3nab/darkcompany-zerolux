import { useState } from "react";
import { View } from "react-native";
import { creationDateLabel, errorMessage, workspaceAge } from "@zerolux/chat";
import type { WorkspaceInfo } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

export function WorkspaceSettings({
  workspace,
  save,
}: {
  workspace: WorkspaceInfo;
  save: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await save(name.trim());
      setEditing(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View className="gap-2 border-b border-border px-4 py-3">
      <Text className="text-base font-medium">{workspace.name}</Text>
      <Text className="font-mono text-xs text-faint">
        {workspaceAge(workspace)}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {creationDateLabel(workspace)}
      </Text>
      {editing ? (
        <View className="gap-3 pt-2">
          <Input
            accessibilityLabel="Workspace name"
            value={name}
            onChangeText={setName}
            maxLength={200}
            editable={!busy}
            onSubmitEditing={() => void submit()}
          />
          {!!error && (
            <Text
              accessibilityRole="alert"
              className="text-sm text-destructive"
            >
              {error}
            </Text>
          )}
          <View className="flex-row gap-2">
            <Button
              disabled={busy || !name.trim()}
              onPress={() => void submit()}
            >
              <Text>{busy ? "Saving…" : "Save name"}</Text>
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onPress={() => setEditing(false)}
            >
              <Text>Cancel</Text>
            </Button>
          </View>
        </View>
      ) : (
        <Button
          variant="outline"
          onPress={() => {
            setName(workspace.name);
            setError("");
            setEditing(true);
          }}
        >
          <Text>Rename workspace</Text>
        </Button>
      )}
    </View>
  );
}
