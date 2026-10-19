import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, View } from "react-native";
import { errorMessage, terminalCommand } from "@zerolux/chat";
import type { ChatSession, TerminalCommand } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "@/src/kernel";
import { useAccess, useMe } from "@/src/me";

/**
 * In About, for its person: the command that goes on with the session in a terminal of its
 * computer. A session that runs is stopped in ZeroLux first, after asking.
 */
export function ContinueInTerminal({ session }: { session: ChatSession }) {
  const { chat, url, hosts } = useSession();
  const { me } = useMe();
  const { mine } = useAccess(session);
  const [found, setFound] = useState<TerminalCommand>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const host = hosts.hosts?.find(
    (h) => h.id === (found?.host_id ?? session.host_id),
  );
  // On another person's computer it runs with one's own harness folders: it goes on in ZeroLux.
  if (!mine || (host && host.person_id !== me?.id)) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (command: TerminalCommand) => {
    if (command.stop_first) {
      // However the stop went, the kernel says again whether it still runs here; a stop it could
      // not confirm copies nothing, and its error stays on screen.
      const stopped = await chat.stop(session.id).then(
        () => true,
        (e: unknown) => e,
      );
      setFound(await terminalCommand(session.id, url));
      if (stopped !== true) throw stopped;
    }
    await Clipboard.setStringAsync(command.command);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
  };
  return (
    <View className="gap-2">
      <Text className="text-sm text-faint">Continue in terminal</Text>
      {found ? (
        <>
          <Text
            selectable
            className="rounded-md border border-border bg-card px-3 py-2.5 font-mono text-[13px] leading-5"
          >
            {found.command}
          </Text>
          <Text className="text-xs text-faint">
            {`Run it on ${host?.name ?? "the session's computer"}.`}
            {found.stop_first
              ? " ZeroLux stops the session first, so two processes never share it."
              : ""}
          </Text>
          <Button
            variant="outline"
            disabled={busy}
            onPress={() =>
              found.stop_first
                ? Alert.alert(
                    "Stop it in ZeroLux?",
                    "It goes on in your terminal; Resume brings it back here.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Stop and copy",
                        style: "destructive",
                        onPress: () => void act(() => copy(found)),
                      },
                    ],
                  )
                : void act(() => copy(found))
            }
          >
            <Text>
              {copied ? "Copied" : found.stop_first ? "Stop and copy" : "Copy"}
            </Text>
          </Button>
        </>
      ) : (
        <Button
          variant="outline"
          disabled={busy}
          onPress={() =>
            void act(async () =>
              setFound(await terminalCommand(session.id, url)),
            )
          }
        >
          <Text>Show the command</Text>
        </Button>
      )}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
