import "../global.css";
import { PortalHost } from "@rn-primitives/portal";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { KernelProvider, useKernel } from "../src/kernel";
import { requiresSignIn } from "@zerolux/chat";
import { useAuthentication } from "../src/auth";
import { restoreDensity } from "../src/density";
import { noticeChoice } from "../src/notices";
import { restoreDrafts, restoreSeen } from "../src/saved";
import { restoreTheme, useTheme } from "../src/theme";

// Before any box is drawn, so none starts empty over a kept draft.
restoreDrafts();

export default function Layout() {
  const { resolved } = useTheme();
  useEffect(() => {
    void restoreTheme();
    void restoreSeen();
    void restoreDensity();
    void noticeChoice.restore();
  }, []);
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <KernelProvider>
          <StatusBar style={resolved === "dark" ? "light" : "dark"} />
          <Navigator />
          <PortalHost />
        </KernelProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function Navigator() {
  const background = useCSSVariable("--color-background");
  const { url } = useKernel();
  const auth = useAuthentication();
  // Signed in, or a kernel without sign-in at all.
  const authorized = Boolean(
    url &&
    (auth?.identity?.actor_id ||
      (auth?.health && !requiresSignIn(auth.health))),
  );
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: String(background) },
      }}
    >
      <Stack.Protected guard={authorized}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="chat/new" options={{ presentation: "modal" }} />
        <Stack.Screen name="member/[id]" />
        <Stack.Screen name="meetings" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="admin" />
        <Stack.Screen name="invites" />
        <Stack.Screen name="session/new" options={{ presentation: "modal" }} />
        <Stack.Screen name="session/[id]" />
        <Stack.Screen name="terminal/[id]" />
        <Stack.Screen name="background/[id]" />
        <Stack.Screen name="background-command/[id]" />
        <Stack.Screen name="changes/[id]" />
        <Stack.Screen name="diff/[id]" />
        <Stack.Screen name="files/[id]" />
        <Stack.Screen name="file/[id]" />
        <Stack.Screen name="subagent/[id]" />
        <Stack.Screen name="accounts/[id]" />
        <Stack.Screen name="extensions" />
        <Stack.Screen
          name="consent"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: "fitToContents",
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="piece" />
        <Stack.Screen name="action" options={{ presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(url) && !authorized}>
        <Stack.Screen name="auth" />
      </Stack.Protected>
      <Stack.Protected guard={!url}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
    </Stack>
  );
}
