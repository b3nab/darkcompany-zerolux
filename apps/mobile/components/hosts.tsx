import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable, Switch, View } from "react-native";
import { ago, errorMessage, useHosts } from "@zerolux/chat";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/**
 * The computers that run the workspace's sessions, each a person's. Yours you name and open to
 * the others, who then start their own sessions on it with their own harness accounts.
 */
export function Hosts() {
  const { workspace, url } = useSession();
  const { me } = useMe();
  const hosts = useHosts(url);
  const router = useRouter();
  const [error, setError] = useState("");
  const change = (id: string, next: { name?: string; open?: boolean }) => {
    setError("");
    hosts.change(id, next).catch((e: unknown) => setError(errorMessage(e)));
  };
  const person = (id: string) =>
    workspace?.actors.find((a) => a.id === id)?.name ?? "Someone";
  return (
    <>
      {hosts.hosts?.map((host, index) => {
        const mine = host.person_id === me?.id;
        return (
          <View
            key={host.id}
            className={cn(
              "flex-row items-center gap-3 px-4 py-3",
              index > 0 && "border-t border-border",
            )}
          >
            <Pressable
              className="min-w-0 flex-1"
              accessibilityRole={mine ? "button" : undefined}
              disabled={!mine || Platform.OS !== "ios"}
              onPress={() =>
                Alert.prompt(
                  "Rename this computer",
                  undefined,
                  (name) =>
                    name.trim() && change(host.id, { name: name.trim() }),
                  "plain-text",
                  host.name,
                )
              }
            >
              <Text numberOfLines={1} className="text-[15px]">
                {host.name}
                {host.here ? (
                  <Text className="text-xs text-faint"> · runs the kernel</Text>
                ) : null}
              </Text>
              <Text numberOfLines={1} className="text-xs text-faint">
                {mine ? "Yours" : person(host.person_id)} · seen{" "}
                {ago(host.seen_at)}
                {!mine && host.open ? " · open to you" : ""}
              </Text>
            </Pressable>
            {!mine && host.here && host.open ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/accounts/${host.id}`)}
                hitSlop={6}
              >
                <Text className="text-[13px] font-medium text-human-foreground">
                  Your accounts
                </Text>
              </Pressable>
            ) : null}
            {mine ? (
              <Switch
                accessibilityLabel={`Open ${host.name} to people`}
                value={host.open}
                onValueChange={(open) => change(host.id, { open })}
              />
            ) : null}
          </View>
        );
      })}
      <Text
        className={cn(
          "border-t border-border px-4 py-3 text-xs",
          error || hosts.error ? "text-destructive" : "text-faint",
        )}
      >
        {error ||
          hosts.error ||
          "Sessions run on a computer of their person's. Open yours with the switch, and the others start their own sessions on it, with their own harness accounts."}
      </Text>
    </>
  );
}
