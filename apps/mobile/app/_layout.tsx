import "../global.css";
import { PortalHost } from "@rn-primitives/portal";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { KernelProvider, useKernel } from "../src/kernel";
import { lookWith, requiresSignIn } from "@zerolux/chat";
import { useAuthentication } from "../src/auth";
import { restoreDensity } from "../src/density";
import { noticeChoice } from "../src/notices";
import { restoreDrafts } from "../src/saved";
import { restoreTheme, useTheme } from "../src/theme";

// Before any box is drawn, so none starts empty over a kept draft.
restoreDrafts();
// What arrives is read only while the app is in front of you.
lookWith(
  () => AppState.currentState === "active",
  (changed) => void AppState.addEventListener("change", changed),
);

export default function Layout() {
  const { resolved } = useTheme();
  useEffect(() => {
    void restoreTheme();
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
  const { url, here } = useKernel();
  const auth = useAuthentication();
  const unsigned = Boolean(auth?.health && !requiresSignIn(auth.health));
  // Signed in to the open kernel, or a kernel without sign-in at all.
  const signedIn = Boolean(here && (auth?.identity || unsigned));
  // In the open workspace, as its person.
  const authorized = Boolean(url && (auth?.member?.actor_id || unsigned));
  // A change of access opens where it leads, also from a sheet left open over a screen it closed.
  const router = useRouter();
  const access = authorized
    ? "/"
    : signedIn
      ? "/start"
      : here
        ? "/auth"
        : "/connect";
  const was = useRef(access);
  useEffect(() => {
    if (was.current === access) return;
    was.current = access;
    router.replace(access);
  }, [access, router]);
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
        <Stack.Screen name="native/[id]" />
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
        <Stack.Screen
          name="update-all"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: "fitToContents",
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="piece" />
        <Stack.Screen name="action" options={{ presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(here) && !signedIn}>
        <Stack.Screen name="auth" />
      </Stack.Protected>
      {/* Signed in: the kernel's workspaces to open, join or create. */}
      <Stack.Protected guard={signedIn && !authorized}>
        <Stack.Screen name="start" />
      </Stack.Protected>
      <Stack.Protected guard={!here}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
      {/* The kernels and workspaces on this phone, open or still to sign in to. */}
      <Stack.Protected guard={Boolean(here)}>
        <Stack.Screen
          name="workspaces"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="workspace-add"
          options={{ presentation: "modal" }}
        />
        <Stack.Screen
          name="workspace-new"
          options={{ presentation: "modal" }}
        />
      </Stack.Protected>
    </Stack>
  );
}
