import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn } from "react-native-reanimated";
import { useOpen } from "../src/density";

/**
 * A line that opens what it folds on a tap, like the web's details, with a light tap you can
 * feel. Open as the density says (detailed opens every step) until you choose; closed, a long
 * session keeps only what is open on screen.
 */
export function Fold({
  summary,
  children,
}: {
  summary: (open: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useOpen();
  return (
    <View>
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={4}
        className="active:opacity-70"
      >
        {summary(open)}
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)}>
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}
