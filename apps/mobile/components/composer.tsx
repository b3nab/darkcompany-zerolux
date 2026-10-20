import * as Haptics from "expo-haptics";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  FileTextIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useEffect } from "react";
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
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
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
  /** Dictate or Record pressed, and released: a tap records on, a hold until released. */
  press(use: VoiceUse): void;
  release(): void;
  discard(): void;
}

// A held finger may drift off the button without ending the recording.
const RETAIN = { top: 60, bottom: 60, left: 120, right: 60 };

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
  // Record, and the filled button while recording, answer to the press itself.
  const held = action === "record" || recording;
  const press = (use: VoiceUse) => {
    if (!recording) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    voice.press(use);
  };
  const dictating = voice.use === "dictation";
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
          {recording ? (
            <Recording use={voice.use!} seconds={voice.seconds} />
          ) : busy ? (
            <View className="min-h-12 flex-row items-center gap-2.5 px-3.5 pt-3 pb-1">
              <ActivityIndicator size="small" color={muted} />
              <Text className="text-base text-muted-foreground">
                Transcribing…
              </Text>
            </View>
          ) : (
            <TextInput
              ref={inputRef}
              {...input}
              multiline
              placeholderTextColor={faint}
              className={cn(
                "max-h-36 min-h-12 px-3.5 pt-3 pb-1 font-sans text-base text-foreground",
                input.editable === false && "opacity-60",
              )}
            />
          )}
          <View className="min-h-12 flex-row items-center gap-0.5 px-1.5 pt-0.5 pb-1.5">
            {recording ? (
              tool(XIcon, "Discard", voice.discard)
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dictate"
                accessibilityState={{ disabled: busy, selected: dictating }}
                disabled={busy}
                onPressIn={() => press("dictation")}
                onPressOut={voice.release}
                pressRetentionOffset={RETAIN}
                hitSlop={4}
                className={cn(
                  "size-10 items-center justify-center rounded-lg active:bg-accent",
                  dictating && "bg-destructive/10",
                  busy && "opacity-35",
                )}
              >
                <MicIcon
                  color={dictating ? destructive : muted}
                  size={20}
                  strokeWidth={1.5}
                />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={labels[action]}
              accessibilityState={{ disabled: waiting || busy }}
              disabled={waiting || busy}
              onPress={
                held
                  ? undefined
                  : () => {
                      void Haptics.selectionAsync();
                      onAction(action);
                    }
              }
              onPressIn={held ? () => press(voice.use ?? "message") : undefined}
              onPressOut={held ? voice.release : undefined}
              onLongPress={held ? undefined : onHold}
              delayLongPress={350}
              pressRetentionOffset={RETAIN}
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
          </View>
        </View>
      </View>
    </KeyboardStickyView>
  );
}

/** In the words' place while the microphone records: what for, and for how long. */
function Recording({ use, seconds }: { use: VoiceUse; seconds: number }) {
  const lit = useSharedValue(1);
  useEffect(() => {
    lit.value = withRepeat(withTiming(0.3, { duration: 700 }), -1, true);
  }, [lit]);
  const dot = useAnimatedStyle(() => ({ opacity: lit.value }));
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
    </View>
  );
}
