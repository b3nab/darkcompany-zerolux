import { Stack } from "expo-router";
import { useCSSVariable } from "uniwind";

/** A tab of Extensions: its list, and the pages it opens over it, with the tab bar kept. */
export default function ExtensionStack() {
  const background = useCSSVariable("--color-background");
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: String(background) },
      }}
    />
  );
}
