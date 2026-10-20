import * as Haptics from "expo-haptics";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  FileTextIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import type { TextInputInstance, TextInputProps } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, {
  Extrapolation,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { HOLD_MS } from "@zerolux/chat";
import type { ComposerAction, VoiceUse } from "@zerolux/chat";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Something in the box besides its words, until it is sent: a photo or a file. */
export interface Chip {
  key: string;
  uri: string;
  name: string;
  image: boolean;
}

/** The microphone as the composer shows it. */
export interface ComposerVoice {
  /** What it records for now. */
  use?: VoiceUse;
  transcribing: boolean;
  seconds: number;
  /** Dictate is offered: the workspace transcribes. */
  dictation: boolean;
  /** How loud the microphone hears now, from 0 to 1. */
  level(): number;
  /** Dictate or Record pressed, and released: a tap records on, a hold until released. */
  press(use: VoiceUse): void;
  release(): void;
  discard(): void;
}

/** The box's height: one line at least, about six before its words scroll. */
const LOWEST = 48;
const HIGHEST = 144;

/** How far left a held recording slides before it is dropped. */
const CANCEL = 110;
/** Which button a finger holds: none, the microphone, or the filled button. */
const MIC = 1;
const FILLED = 2;

const filled: Record<Exclude<ComposerAction, "transcribing">, LucideIcon> = {
  record: AudioLinesIcon,
  send: ArrowUpIcon,
  interrupt: SquareIcon,
  write: CheckIcon,
};
const labels: Record<ComposerAction, string> = {
  record: "Record",
  send: "Send",
  interrupt: "Interrupt",
  write: "Write it",
  transcribing: "Transcribing",
};

/**
 * The one box to write to anyone, in a chat or to a session. What waits sits above it; in it
 * the photos and files, the words, and one row of controls that ends in the one filled
 * button. Below it, nothing.
 */
export function Composer({
  above,
  chips = [],
  removeChip,
  input,
  inputRef,
  add,
  middle,
  trailing,
  voice,
  action,
  onAction,
  onHold,
  waiting = false,
  error,
}: {
  above?: ReactNode;
  chips?: Chip[];
  removeChip?: (key: string) => void;
  input: Pick<
    TextInputProps,
    "value" | "onChangeText" | "placeholder" | "editable" | "onSelectionChange"
  >;
  inputRef?: Ref<TextInputInstance>;
  /** "+": what can be added to the box. */
  add?: { onPress: () => void; busy?: boolean; disabled?: boolean };
  /** Beside "+": the session's settings. */
  middle?: ReactNode;
  /** Before the microphone: how full the session's context is. */
  trailing?: ReactNode;
  voice: ComposerVoice;
  action: ComposerAction;
  onAction: (action: ComposerAction) => void;
  /** Holding the filled button, where it offers more. */
  onHold?: () => void;
  /** The filled button waits: nothing to send, or a send under way. */
  waiting?: boolean;
  error?: string;
}) {
  const insets = useSafeAreaInsets();
  const [faint, muted, onLamp, destructive] = useCSSVariable([
    "--color-faint",
    "--color-muted-foreground",
    "--color-primary-foreground",
    "--color-destructive",
  ]).map(String);
  const recording = voice.use !== undefined;
  const busy = voice.transcribing;
  // Record, and the filled button while recording, answer to the touch itself.
  const held = action === "record" || recording;
  const dictating = voice.use === "dictation";
  // A press that starts recording may be held: then the finger slides left to drop it.
  const slide = useSharedValue(0);
  const lifted = useSharedValue(0);
  const holder = useSharedValue(0);
  const holding = useRef(false);
  const dropped = useRef(false);
  const [sliding, setSliding] = useState(false);
  // The box grows with its words however they arrive: typed, dictated, a mention or a draft.
  const [height, setHeight] = useState(LOWEST);
  const [binned, setBinned] = useState(false);
  useEffect(() => {
    if (!binned) return;
    const shown = setTimeout(() => setBinned(false), 900);
    return () => clearTimeout(shown);
  }, [binned]);
  const settle = () => {
    holding.current = false;
    setSliding(false);
    lifted.value = withSpring(0);
    slide.value = withSpring(0, { damping: 16, stiffness: 200 });
  };
  const bin = () => {
    voice.discard();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setBinned(true);
  };
  const down = (use: VoiceUse, id: number) => {
    dropped.current = false;
    holder.value = id;
    if (!recording) {
      holding.current = true;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // Held past a tap, it shows how to drop it.
      setTimeout(() => {
        if (!holding.current) return;
        setSliding(true);
        lifted.value = withSpring(1, { damping: 12, stiffness: 220 });
      }, HOLD_MS);
    }
    voice.press(use);
  };
  const move = (dx: number) => {
    if (!holding.current || dropped.current) return;
    slide.value = Math.min(0, Math.max(-CANCEL, dx));
    if (dx > -CANCEL) return;
    dropped.current = true;
    settle();
    bin();
  };
  const up = () => {
    settle();
    if (!dropped.current) voice.release();
  };
  const hold = (use: VoiceUse, id: number) => ({
    slide,
    lifted,
    holder,
    id,
    onDown: () => down(use, id),
    onMove: move,
    onUp: up,
  });
  const Icon = action === "transcribing" ? undefined : filled[action];
  const tool = (
    icon: LucideIcon,
    label: string,
    onPress: () => void,
    disabled = false,
  ) => {
    const ToolIcon = icon;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        hitSlop={4}
        className={cn(
          "size-10 items-center justify-center rounded-lg active:bg-accent",
          disabled && "opacity-35",
        )}
      >
        <ToolIcon color={muted} size={20} strokeWidth={1.5} />
      </Pressable>
    );
  };
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View
        className="gap-2 px-2.5 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        {above}
        {error ? (
          <Text className="px-1.5 text-sm text-destructive">{error}</Text>
        ) : null}
        <View
          className="rounded-xl border border-input bg-card"
          style={{
            shadowColor: "#000",
            shadowOpacity: 0.08,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 6 },
            elevation: 2,
          }}
        >
          {chips.length && !recording && !busy ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 px-2.5 pt-2.5"
            >
              {chips.map((chip, i) => (
                <View key={chip.key} className="pt-1.5 pr-1.5">
                  {chip.image ? (
                    <Image
                      source={{ uri: chip.uri }}
                      accessibilityLabel={`Photo ${i + 1} of ${chips.length}`}
                      className="size-13 rounded-lg border border-border"
                    />
                  ) : (
                    <View className="h-13 max-w-44 flex-row items-center gap-2 rounded-lg border border-border bg-muted px-3">
                      <FileTextIcon color={muted} size={18} strokeWidth={1.5} />
                      <Text numberOfLines={1} className="shrink text-[13px]">
                        {chip.name}
                      </Text>
                    </View>
                  )}
                  {removeChip ? (
                    <Pressable
                      onPress={() => removeChip(chip.key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${chip.name}`}
                      hitSlop={8}
                      className="absolute top-0 right-0 size-5 items-center justify-center rounded-full border border-border bg-card"
                    >
                      <XIcon color={muted} size={11} strokeWidth={2.5} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          ) : null}
          {binned ? (
            <Binned />
          ) : recording ? (
            <Recording
              use={voice.use!}
              seconds={voice.seconds}
              level={voice.level}
            />
          ) : busy ? (
            <View className="min-h-12 flex-row items-center gap-2.5 px-3.5 pt-3 pb-1">
              <ActivityIndicator size="small" color={muted} />
              <Text className="text-base text-muted-foreground">
                Transcribing…
              </Text>
            </View>
          ) : (
            <View>
              {/* The same words, unseen, measure how tall the box must be. */}
              <Text
                aria-hidden
                pointerEvents="none"
                onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
                className="absolute inset-x-0 top-0 px-3.5 pt-3 pb-1 font-sans text-base opacity-0"
              >
                {`${input.value ?? ""}${input.value?.endsWith("\n") ? " " : ""}` ||
                  " "}
              </Text>
              <TextInput
                ref={inputRef}
                {...input}
                multiline
                scrollEnabled={height > HIGHEST}
                placeholderTextColor={faint}
                style={{
                  height: Math.min(HIGHEST, Math.max(LOWEST, height)),
                }}
                className={cn(
                  "px-3.5 pt-3 pb-1 font-sans text-base text-foreground",
                  input.editable === false && "opacity-60",
                )}
              />
            </View>
          )}
          <View className="min-h-12 flex-row items-center gap-0.5 px-1.5 pt-0.5 pb-1.5">
            {recording ? (
              sliding ? (
                <SlideHint slide={slide} />
              ) : (
                tool(XIcon, "Discard", bin)
              )
            ) : (
              <>
                {add ? (
                  add.busy ? (
                    <View className="size-10 items-center justify-center">
                      <ActivityIndicator size="small" color={muted} />
                    </View>
                  ) : (
                    tool(PlusIcon, "Add", add.onPress, add.disabled || busy)
                  )
                ) : null}
                {middle}
              </>
            )}
            <View className="flex-1" />
            {recording ? null : trailing}
            {voice.dictation && (!recording || dictating) ? (
              <HoldButton
                label="Dictate"
                disabled={busy}
                selected={dictating}
                {...hold("dictation", MIC)}
                className={cn(
                  "size-10 items-center justify-center rounded-lg",
                  dictating && "bg-destructive/10",
                  busy && "opacity-35",
                )}
              >
                <MicIcon
                  color={dictating ? destructive : muted}
                  size={20}
                  strokeWidth={1.5}
                />
              </HoldButton>
            ) : null}
            {held ? (
              <HoldButton
                label={labels[action]}
                disabled={waiting || busy}
                {...hold(voice.use ?? "message", FILLED)}
                className={cn(
                  "ml-0.5 size-10 items-center justify-center rounded-lg bg-primary",
                  (waiting || busy) && "opacity-40",
                )}
              >
                {Icon ? (
                  <Icon color={onLamp} size={19} strokeWidth={2} />
                ) : null}
              </HoldButton>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={labels[action]}
                accessibilityState={{ disabled: waiting || busy }}
                disabled={waiting || busy}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onAction(action);
                }}
                onLongPress={onHold}
                delayLongPress={350}
                className={cn(
                  "ml-0.5 size-10 items-center justify-center rounded-lg bg-primary active:opacity-80",
                  (waiting || busy) && "opacity-40",
                )}
              >
                {Icon ? (
                  <Icon
                    color={onLamp}
                    fill={action === "interrupt" ? onLamp : "none"}
                    size={action === "interrupt" ? 14 : 19}
                    strokeWidth={2}
                  />
                ) : (
                  <ActivityIndicator size="small" color={onLamp} />
                )}
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardStickyView>
  );
}

/**
 * Dictate or Record under the finger. It gives a little under a touch; held, it grows and
 * follows the finger sliding left. For VoiceOver, activating it is a tap.
 */
function HoldButton({
  label,
  disabled,
  selected,
  slide,
  lifted,
  holder,
  id,
  onDown,
  onMove,
  onUp,
  className,
  children,
}: {
  label: string;
  disabled: boolean;
  selected?: boolean;
  slide: SharedValue<number>;
  lifted: SharedValue<number>;
  holder: SharedValue<number>;
  id: number;
  onDown: () => void;
  onMove: (dx: number) => void;
  onUp: () => void;
  className: string;
  children: ReactNode;
}) {
  const from = useRef(0);
  const touched = useSharedValue(0);
  const style = useAnimatedStyle(() => {
    const mine = holder.value === id;
    const grown = mine ? lifted.value : 0;
    return {
      zIndex: mine ? 1 : 0,
      transform: [
        { translateX: mine ? slide.value : 0 },
        { scale: 1 + grown * 0.18 - touched.value * (1 - grown) * 0.08 },
      ],
    };
  });
  const release = () => {
    touched.value = withSpring(0);
    onUp();
  };
  return (
    <Animated.View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => {
        if (disabled) return;
        onDown();
        onUp();
      }}
      onStartShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        from.current = event.nativeEvent.pageX;
        touched.value = withTiming(1, { duration: 90 });
        onDown();
      }}
      onResponderMove={(event) =>
        onMove(event.nativeEvent.pageX - from.current)
      }
      onResponderRelease={release}
      onResponderTerminate={release}
      hitSlop={4}
      style={style}
      className={className}
    >
      {children}
    </Animated.View>
  );
}

/** How many of the microphone's last levels the wave shows, newest on the right. */
const BARS = 34;

/**
 * In the words' place while the microphone records: what for, for how long, and the wave of
 * what it hears, moving left as it records and flat in silence.
 */
function Recording({
  use,
  seconds,
  level,
}: {
  use: VoiceUse;
  seconds: number;
  level: () => number;
}) {
  const lit = useSharedValue(1);
  useEffect(() => {
    lit.value = withRepeat(withTiming(0.3, { duration: 700 }), -1, true);
  }, [lit]);
  const dot = useAnimatedStyle(() => ({ opacity: lit.value }));
  // Read here, so only the wave is drawn again as it moves.
  const hear = useRef(level);
  hear.current = level;
  const [levels, setLevels] = useState(() => Array<number>(BARS).fill(0));
  useEffect(() => {
    const heard = setInterval(
      () => setLevels((now) => [...now.slice(1), hear.current()]),
      80,
    );
    return () => clearInterval(heard);
  }, []);
  return (
    <View className="min-h-12 flex-row items-center gap-2.5 px-3.5 pt-3 pb-1">
      <Animated.View
        style={dot}
        className="size-2.5 rounded-full bg-destructive"
      />
      <Text className="font-mono text-sm font-medium">
        {use === "dictation" ? "Listening" : "Recording"}
        <Text className="font-mono text-sm text-faint">
          {" "}
          · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </Text>
      </Text>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="h-6 flex-1 flex-row items-center justify-end gap-0.5 overflow-hidden"
      >
        {levels.map((heard, i) => (
          <View
            key={i}
            className="w-[3px] rounded-full bg-foreground/70"
            style={{ height: 3 + heard * 21 }}
          />
        ))}
      </View>
    </View>
  );
}

/** Where Discard was, while a finger holds the recording: how to drop it, fading as it slides. */
function SlideHint({ slide }: { slide: SharedValue<number> }) {
  const [faint] = useCSSVariable(["--color-faint"]).map(String);
  const nudge = useSharedValue(0);
  useEffect(() => {
    nudge.value = withRepeat(
      withSequence(
        withTiming(-4, { duration: 450 }),
        withTiming(0, { duration: 450 }),
      ),
      -1,
    );
  }, [nudge]);
  const hint = useAnimatedStyle(() => ({
    opacity: interpolate(
      slide.value,
      [-CANCEL, -CANCEL * 0.35, 0],
      [0, 0.55, 1],
      Extrapolation.CLAMP,
    ),
    transform: [{ translateX: slide.value * 0.5 }],
  }));
  const chevron = useAnimatedStyle(() => ({
    transform: [{ translateX: nudge.value }],
  }));
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      style={hint}
      className="h-10 flex-row items-center gap-1 pl-2"
    >
      <Animated.View style={chevron}>
        <ChevronLeftIcon color={faint} size={16} strokeWidth={2} />
      </Animated.View>
      <Text className="text-sm text-muted-foreground">Slide to cancel</Text>
    </Animated.View>
  );
}

/** A dropped recording, gone into the bin. */
function Binned() {
  const [destructive] = useCSSVariable(["--color-destructive"]).map(String);
  const tilt = useSharedValue(0);
  useEffect(() => {
    tilt.value = withSequence(
      withTiming(-14, { duration: 90 }),
      withTiming(12, { duration: 110 }),
      withTiming(-6, { duration: 90 }),
      withTiming(0, { duration: 90 }),
    );
  }, [tilt]);
  const shake = useAnimatedStyle(() => ({
    transform: [{ rotate: `${tilt.value}deg` }],
  }));
  return (
    <Animated.View
      exiting={FadeOut.duration(200)}
      accessibilityLabel="Recording discarded"
      className="min-h-12 flex-row items-center px-3.5 pt-3 pb-1"
    >
      <Animated.View entering={ZoomIn.springify().damping(12)}>
        <Animated.View style={shake}>
          <Trash2Icon color={destructive} size={18} strokeWidth={1.75} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
