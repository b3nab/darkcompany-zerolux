import { useLocalSearchParams } from "expo-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  PlusIcon,
  PowerIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
  closeTerminal,
  errorMessage,
  folderName,
  followTerminal,
  openTerminal,
  resizeTerminal,
  sessionTerminals,
  terminalReader,
  terminalWriter,
  writeTerminal,
} from "@zerolux/chat";
import type { TerminalInfo } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import TerminalView from "@/components/terminal-view";
import type { TerminalHandle } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useTheme } from "../../src/theme";

type Size = { cols: number; rows: number };

/** The keys a phone's keyboard lacks, as a terminal needs them. */
const KEYS: { label: string; key: string; icon?: LucideIcon }[] = [
  { label: "Esc", key: "\x1b" },
  { label: "Tab", key: "\t" },
  { label: "Left", key: "left", icon: ArrowLeftIcon },
  { label: "Down", key: "down", icon: ArrowDownIcon },
  { label: "Up", key: "up", icon: ArrowUpIcon },
  { label: "Right", key: "right", icon: ArrowRightIcon },
  { label: "|", key: "|" },
  { label: "~", key: "~" },
  { label: "/", key: "/" },
  { label: "-", key: "-" },
];

/** A key typed with Ctrl: the control character it makes, else the key as it is. */
const control = (text: string) =>
  /^[ @-~]$/.test(text) ? String.fromCharCode(text.charCodeAt(0) & 0x1f) : text;

/**
 * A session's terminal: a login shell in its folder on the kernel's host, for its owner, as
 * a terminal app shows it. It opens on the shell the session has open, or a new one; the
 * row above the keyboard has the keys a phone's lacks, with Ctrl for the next one.
 */
export default function TerminalPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, url } = useSession();
  const session = chat.sessions.find((s) => s.id === id);
  const { resolved } = useTheme();
  const background = String(useCSSVariable("--color-background"));
  const foreground = String(useCSSVariable("--color-foreground"));
  const primary = String(useCSSVariable("--color-primary"));
  const accent = String(useCSSVariable("--color-accent"));
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const colors = useMemo(
    () => ({ background, foreground, cursor: primary, selection: accent }),
    [background, foreground, primary, accent],
  );
  const insets = useSafeAreaInsets();
  // The keys and the shell stay above the keyboard; without it, above the home indicator.
  const { height: keyboard } = useReanimatedKeyboardAnimation();
  const lifted = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insets.bottom, -keyboard.value),
  }));
  const view = useRef<TerminalHandle>(null);
  const size = useRef<Size>(undefined);
  const resizing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [measured, setMeasured] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [current, setCurrent] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const start = async () => {
    const terminal = await openTerminal(id, size.current!, url);
    setTerminals((list) => [...list, terminal]);
    setCurrent(terminal.id);
  };
  const open = () => act(start);
  // Once it knows its size: the shell the session has open, else a new one.
  useEffect(() => {
    if (!measured) return;
    void act(async () => {
      const live = (await sessionTerminals(id, url)).filter((t) => !t.ended);
      if (!live.length) return start();
      setTerminals(live);
      setCurrent(live[0]!.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, id, url]);
  // All it has kept, then what it writes, in order; at this screen's size.
  useEffect(() => {
    if (!current) return;
    setEnded(false);
    view.current?.reset();
    const stop = followTerminal(
      current,
      terminalReader(current, url),
      (data) => view.current?.write(data),
      () => setEnded(true),
    );
    if (size.current)
      resizeTerminal(current, size.current, url).catch(() => {});
    return stop;
  }, [current, url]);
  const write = useMemo(
    () =>
      current
        ? terminalWriter((data) => writeTerminal(current, data, url))
        : undefined,
    [current, url],
  );
  const type = (data: string) => {
    if (!write || ended) return;
    const text = ctrl ? control(data) : data;
    setCtrl(false);
    write(text).catch((e: unknown) => setError(errorMessage(e)));
  };
  const sized = (cols: number, rows: number) => {
    size.current = { cols, rows };
    setMeasured(true);
    // The keyboard moves in steps: the shell hears the size it stops at.
    clearTimeout(resizing.current);
    resizing.current = setTimeout(() => {
      if (current) resizeTerminal(current, { cols, rows }, url).catch(() => {});
    }, 150);
  };
  useEffect(() => () => clearTimeout(resizing.current), []);
  const shells = terminals.filter((t) => t.id === current || !t.ended);
  return (
    <Screen
      back
      title="Terminal"
      subtitle={session ? folderName(session.workspace) : undefined}
      action={
        <View className="flex-row">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New terminal"
            disabled={busy || !measured}
            onPress={() => void open()}
            hitSlop={6}
            className="size-10 items-center justify-center rounded-sm active:bg-accent"
          >
            <PlusIcon color={muted} size={20} strokeWidth={1.5} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="End this shell"
            disabled={busy || !current || ended}
            onPress={() =>
              current && void act(() => closeTerminal(current, url))
            }
            hitSlop={6}
            className="size-10 items-center justify-center rounded-sm active:bg-accent disabled:opacity-40"
          >
            <PowerIcon color={muted} size={20} strokeWidth={1.5} />
          </Pressable>
        </View>
      }
    >
      <Animated.View style={[{ flex: 1 }, lifted]}>
        {shells.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="grow-0 border-b border-border"
            contentContainerClassName="gap-1.5 px-3 py-2"
          >
            {shells.map((terminal, index) => (
              <Pressable
                key={terminal.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: terminal.id === current }}
                onPress={() => setCurrent(terminal.id)}
                className={cn(
                  "rounded-full border border-border px-3 py-1",
                  terminal.id === current && "border-primary bg-accent",
                )}
              >
                <Text className="text-[13px]">Shell {index + 1}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <TerminalView
          ref={view}
          colors={colors}
          dark={resolved === "dark"}
          onData={type}
          onSize={sized}
          dom={{
            style: { flex: 1, backgroundColor: background },
            scrollEnabled: false,
            bounces: false,
            hideKeyboardAccessoryView: true,
          }}
        />
        {error ? (
          <Text className="bg-card px-3.5 py-1.5 text-sm text-destructive">
            {error}
          </Text>
        ) : null}
        {ended ? (
          <View className="flex-row items-center justify-between gap-3 border-t border-border bg-card px-3.5 py-2">
            <Text className="text-sm text-muted-foreground">
              This shell has ended.
            </Text>
            <Button size="sm" disabled={busy} onPress={() => void open()}>
              <Text>New terminal</Text>
            </Button>
          </View>
        ) : (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            className="grow-0 border-t border-border bg-card"
            contentContainerClassName="gap-1.5 px-2 py-1.5"
          >
            <Key label="Ctrl" on={ctrl} onPress={() => setCtrl((on) => !on)} />
            {KEYS.map(({ label, key, icon }) => (
              <Key
                key={label}
                label={label}
                icon={icon}
                onPress={() => view.current?.press(key)}
              />
            ))}
          </ScrollView>
        )}
      </Animated.View>
    </Screen>
  );
}

/** One key of the row, drawn as a keyboard key; Ctrl stays lit until the next key. */
function Key({
  label,
  icon: Icon,
  on,
  onPress,
}: {
  label: string;
  icon?: LucideIcon;
  on?: boolean;
  onPress: () => void;
}) {
  const ink = String(useCSSVariable("--color-foreground"));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { selected: on }}
      onPress={onPress}
      className={cn(
        "h-9 min-w-10 items-center justify-center rounded-md border border-border bg-background px-2.5 active:bg-accent",
        on && "border-primary bg-primary active:bg-primary",
      )}
    >
      {Icon ? (
        <Icon color={ink} size={17} strokeWidth={1.75} />
      ) : (
        <Text
          className={cn(
            "font-mono text-[14px]",
            on && "text-primary-foreground",
          )}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
