import { useRouter } from "expo-router";
import { ChevronLeftIcon, XIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";

/**
 * A screen's frame: the safe area on top, then its title and an action. A tab has a large
 * title; a screen opened over the tabs (`back`) has a compact bar that goes back, or closes
 * a sheet (`back="close"`). A space of its own opened over them (`back` and `large`) goes back
 * above its large title.
 */
export function Screen({
  title,
  subtitle,
  back,
  large,
  leading,
  action,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: boolean | "close";
  /** The large title of a tab, under the way back. */
  large?: boolean;
  /** Beside the title in the compact bar, such as a chat's mark. */
  leading?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const ink = String(useCSSVariable("--color-foreground"));
  const goBack = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={back === "close" ? "Close" : "Back"}
      className="size-9 items-center justify-center rounded-sm active:bg-accent"
    >
      {back === "close" ? (
        <XIcon color={ink} size={22} strokeWidth={1.5} />
      ) : (
        <ChevronLeftIcon color={ink} size={24} strokeWidth={1.5} />
      )}
    </Pressable>
  );
  const largeTitle = (
    <Text className="text-[28px] font-semibold tracking-tight">{title}</Text>
  );
  return (
    <SafeArea className="flex-1 bg-background" edges={["top"]}>
      {back && large ? (
        <View className="gap-1 px-2 pt-1 pb-3">
          <View className="flex-row items-center justify-between">
            {goBack}
            {action}
          </View>
          <View className="px-3">{largeTitle}</View>
        </View>
      ) : back ? (
        <View className="flex-row items-center gap-2.5 border-b border-border px-2 py-2">
          {goBack}
          {leading}
          <View className="min-w-0 flex-1">
            <Text className="text-[17px] font-semibold" numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text
                className="text-[13px] text-muted-foreground"
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
          {action}
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-3 px-5 pt-2 pb-3">
          {largeTitle}
          {action}
        </View>
      )}
      {children}
    </SafeArea>
  );
}
