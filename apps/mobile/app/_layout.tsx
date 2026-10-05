import "../global.css";
import { PortalHost } from "@rn-primitives/portal";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { KernelProvider } from "../src/kernel";
import { restoreTheme, useTheme } from "../src/theme";

export default function Layout() {
  // The navigator paints around the screens: same token as what Uniwind paints inside them.
  const background = useCSSVariable("--color-background");
  const { resolved } = useTheme();
  useEffect(() => void restoreTheme(), []);
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <KernelProvider>
          <StatusBar style={resolved === "dark" ? "light" : "dark"} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: String(background) },
            }}
          />
          <PortalHost />
        </KernelProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
