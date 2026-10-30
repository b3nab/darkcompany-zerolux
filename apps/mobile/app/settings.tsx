import {
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import {
  Alert,
  AppState,
  Linking,
  ScrollView,
  Switch,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
import { useCSSVariable } from "uniwind";
import { ago, ApiError, deviceName, errorMessage } from "@zerolux/chat";
import type { AuthDevice } from "@zerolux/chat";
import { themes } from "@zerolux/theme/themes";
import { Screen } from "@/components/screen";
import { Hosts } from "@/components/hosts";
import { Row, Section, Unavailable } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useAuthentication } from "../src/auth";
import { useKernel, useSession } from "../src/kernel";
import { noticeChoice } from "../src/notices";
import { chooseLight, chooseTheme, useTheme } from "../src/theme";
import type { Light } from "../src/theme";

const lights: [Light, string, LucideIcon][] = [
  ["system", "System", MonitorIcon],
  ["light", "Daylight", SunIcon],
  ["dark", "Night", MoonIcon],
];
const realtime = {
  live: "Kernel · live",
  connecting: "Kernel · connecting…",
  offline: "Kernel · realtime offline",
};

/** What is yours and this phone's: notifications, your devices, the look and the kernel. */
export default function MySettings() {
  const { here, kernels, forget } = useKernel();
  const multi = kernels.find((k) => k.kernel === here)?.multi;
  const host = here ? new URL(here).host : "";
  const router = useRouter();
  const { chat, version } = useSession();
  const auth = useAuthentication();
  const { theme, light } = useTheme();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const check = <CheckIcon color={muted} size={18} strokeWidth={2} />;
  const [connectionError, setConnectionError] = useState("");
  async function remove() {
    if (!here) return;
    if (!chat.canLeave()) {
      setConnectionError(
        "Wait for pending chat messages before removing this kernel.",
      );
      return;
    }
    try {
      await forget(here);
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }
  return (
    <Screen back title="My settings">
      <ScrollView contentContainerClassName="gap-6 px-5 py-6">
        <Section title="Notifications">
          <DeviceNotices />
          {/* TODO: kernel: push when the app is closed, email, per chat exceptions and quiet hours. */}
          <Unavailable>
            When the app is closed, by email, quiet hours: not available yet.
          </Unavailable>
        </Section>
        <Section title="Devices">
          <Devices />
        </Section>
        <Section title="Computers">
          <Hosts />
        </Section>
        <Section title="Theme">
          {themes.map((t) => (
            <Row
              key={t.id}
              icon={PaletteIcon}
              label={t.name}
              onPress={() => void chooseTheme(t.id)}
              trailing={theme === t.id ? check : null}
            />
          ))}
        </Section>
        <Section title="Light">
          {lights.map(([value, label, Icon]) => (
            <Row
              key={value}
              icon={Icon}
              label={label}
              onPress={() => void chooseLight(value)}
              trailing={light === value ? check : null}
            />
          ))}
        </Section>
        <Section title="Kernel">
          <View className="gap-1 px-4 py-3">
            <View className="flex-row items-center gap-2">
              <View
                className={cn(
                  "size-1.5 rounded-full",
                  chat.realtime === "live"
                    ? "bg-success"
                    : chat.realtime === "connecting"
                      ? "bg-faint"
                      : "bg-destructive",
                )}
              />
              <Text className="font-mono text-[13px] text-muted-foreground">
                {realtime[chat.realtime]}
              </Text>
            </View>
            <Text className="font-mono text-[13px] text-faint">
              {host}
              {version ? ` · v${version}` : ""}
            </Text>
          </View>
          <View className="gap-2 border-t border-border px-4 py-3">
            {multi ? (
              <Button
                variant="outline"
                disabled={auth?.busy}
                onPress={() => router.push("/workspace-new")}
              >
                <Text>New workspace</Text>
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={auth?.busy}
              onPress={() => router.push("/workspace-add")}
            >
              <Text>Connect a kernel</Text>
            </Button>
            <Button
              variant="ghost"
              disabled={auth?.busy}
              onPress={() =>
                Alert.alert(`Remove ${host} from this phone?`, undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => void remove(),
                  },
                ])
              }
            >
              <Text className="text-destructive">Remove from this phone</Text>
            </Button>
            {connectionError ? (
              <Text className="mt-2 text-sm text-destructive">
                {connectionError}
              </Text>
            ) : null}
          </View>
        </Section>
      </ScrollView>
    </Screen>
  );
}

/**
 * Where you are signed in: this phone, which signs out here, and your other devices, which
 * can be signed out from here. The list needs a sign-in from the last day, so an older one
 * asks for your password first.
 */
function Devices() {
  const auth = useAuthentication();
  const [list, setList] = useState<{
    devices: AuthDevice[];
    current: string | null;
  }>();
  const [confirm, setConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (!auth) return;
    try {
      setList(await auth.devices());
      setConfirm(false);
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setConfirm(true);
      else setError(errorMessage(e));
    }
  }
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    // Read once on opening; signing a device out reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const email = auth?.identity?.user.email;
  if (!auth?.identity) return null;
  if (confirm)
    return (
      <View className="gap-3 px-4 py-3">
        <Text className="text-sm text-muted-foreground">
          Confirm your password to see your devices.
        </Text>
        <Input
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
        />
        <Button
          disabled={busy || !password || !email}
          onPress={() =>
            void act(async () => {
              if (email && (await auth.signIn(email, password)))
                setPassword("");
            })
          }
        >
          <Text>Confirm</Text>
        </Button>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
      </View>
    );
  // This phone first, then the others by their last use.
  const devices = [...(list?.devices ?? [])].sort(
    (a, b) =>
      Number(b.id === list?.current) - Number(a.id === list?.current) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  return (
    <View>
      {devices.map((device, i) => {
        const here = device.id === list?.current;
        return (
          <View
            key={device.id}
            className={cn(
              "flex-row items-center gap-3 px-4 py-3",
              i > 0 && "border-t border-border",
            )}
          >
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-base">
                {deviceName(device.userAgent)}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {here
                  ? "This device"
                  : `Last used ${ago(Date.parse(device.updatedAt))}`}
              </Text>
            </View>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || auth.busy}
              onPress={() =>
                here
                  ? void auth.signOut()
                  : void act(() => auth.signOutDevice(device.token))
              }
            >
              <Text>Sign out</Text>
            </Button>
          </View>
        );
      })}
      {!list && !error ? (
        <Text className="px-4 py-3 text-sm text-muted-foreground">
          Loading…
        </Text>
      ) : null}
      {error || auth.error ? (
        <Text className="px-4 py-3 text-sm text-destructive">
          {error || auth.error}
        </Text>
      ) : null}
    </View>
  );
}

/** What this phone tells you, through its notifications. */
function DeviceNotices() {
  const choice = noticeChoice.use();
  const [permission, setPermission] =
    useState<Notifications.NotificationPermissionsStatus>();
  useEffect(() => {
    const read = () =>
      void Notifications.getPermissionsAsync().then(setPermission);
    read();
    // Back from the phone's Settings, the answer may have changed.
    const watch = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => watch.remove();
  }, []);
  if (!permission) return null;
  if (!permission.granted)
    return (
      <View className="items-start gap-3 px-4 py-3">
        {permission.canAskAgain ? null : (
          <Text className="text-sm text-muted-foreground">
            Notifications for ZeroLux are off in the phone's Settings.
          </Text>
        )}
        <Button
          size="sm"
          onPress={() =>
            void (permission.canAskAgain
              ? Notifications.requestPermissionsAsync().then(setPermission)
              : Linking.openSettings())
          }
        >
          <Text>
            {permission.canAskAgain ? "Allow notifications" : "Open Settings"}
          </Text>
        </Button>
      </View>
    );
  return (
    <View>
      {(
        [
          ["needs", "When you're needed"],
          ["finished", "When a session finishes"],
        ] as const
      ).map(([key, label]) => (
        <View key={key} className="flex-row items-center gap-3 px-4 py-3">
          <Text className="flex-1 text-base">{label}</Text>
          <Switch
            value={choice[key]}
            onValueChange={(on) => noticeChoice.set({ ...choice, [key]: on })}
          />
        </View>
      ))}
    </View>
  );
}
