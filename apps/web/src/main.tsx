import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { preloadRenderer } from "./components/message-text";
import { keepDraftsIn, lookWith } from "@zerolux/chat";
import { WorkspaceRoot } from "./instance";
import { startTheme } from "./theme";
import { trayPanel } from "./tray";
import { TrayPanel } from "./TrayPanel";

startTheme();
// Unsent messages survive a reload, in this browser only.
const DRAFTS = "zerolux-drafts";
try {
  const restored = window.zeroluxRestoredDrafts;
  delete window.zeroluxRestoredDrafts;
  keepDraftsIn(
    restored ?? JSON.parse(localStorage.getItem(DRAFTS) ?? "{}"),
    (all) => {
      try {
        localStorage.setItem(DRAFTS, JSON.stringify(all));
      } catch {
        // Without storage a draft lasts until the page reloads.
      }
    },
  );
} catch {
  // Unreadable or no storage: drafts start empty.
}
// A right click opens the app's own menus; the browser's only where text is written or chosen,
// for its Cut, Copy and Paste.
document.addEventListener("contextmenu", (event) => {
  const writing = (event.target as Element | null)?.closest(
    "input, textarea, [contenteditable]:not([contenteditable='false'])",
  );
  if (!writing && window.getSelection()?.isCollapsed !== false)
    event.preventDefault();
});
// What arrives is read only while this page is in view.
lookWith(
  () => document.visibilityState === "visible",
  (changed) => document.addEventListener("visibilitychange", changed),
);

// The desktop's tray panel is a page of its own: it hears every open workspace.
if (trayPanel()) document.documentElement.dataset.tray = "";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {trayPanel() ? (
      <TrayPanel />
    ) : (
      <WorkspaceRoot>
        <App />
      </WorkspaceRoot>
    )}
  </StrictMode>,
);

// The renderer loads once the page is idle: the chat itself comes first.
if ("requestIdleCallback" in window)
  requestIdleCallback(preloadRenderer, { timeout: 5_000 });
else setTimeout(preloadRenderer, 2_000);
