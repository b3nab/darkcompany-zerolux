import { useCallback, useState } from "react";
import type { RefObject } from "react";
import { ArrowDownIcon } from "lucide-react-native";
import { Pressable } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import type { LegendListRef } from "@legendapp/list/react-native";

/** Whether a list is more than a screen above its end, from its scrolling. */
export function useAway() {
  const [away, setAway] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const below =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    setAway(below > layoutMeasurement.height);
  }, []);
  return { away, onScroll };
}

/**
 * Back to a list's end, fading in while it is away from it. It rises with the keyboard as the
 * composer does, so it stays just above it.
 */
export function ToLatest({
  list,
  shown,
  label,
}: {
  list: RefObject<LegendListRef | null>;
  shown: boolean;
  label: string;
}) {
  const insets = useSafeAreaInsets();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  return (
    <KeyboardStickyView
      offset={{ closed: 0, opened: insets.bottom }}
      pointerEvents="box-none"
      style={{ position: "absolute", right: 16, bottom: 16 }}
    >
      {shown ? (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(150)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => void list.current?.scrollToEnd({ animated: true })}
            hitSlop={8}
            className="size-10 items-center justify-center rounded-full border border-border bg-card shadow-md active:bg-accent"
          >
            <ArrowDownIcon color={muted} size={20} strokeWidth={1.75} />
          </Pressable>
        </Animated.View>
      ) : null}
    </KeyboardStickyView>
  );
}
