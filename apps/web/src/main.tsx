import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { preloadRenderer } from "./components/message-text";
import { keepDraftsIn, keepSeenIn, setKernelUrl } from "@zerolux/chat";
import { kernelAddress } from "./desktop";
import { startTheme } from "./theme";

startTheme();
// In the desktop app the page is packaged and the kernel is wherever the workspace says.
setKernelUrl(kernelAddress());
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
// What you have seen of each session, in this browser only.
const SEEN = "zerolux-seen";
try {
  keepSeenIn(JSON.parse(localStorage.getItem(SEEN) ?? "{}"), (all) => {
    try {
      localStorage.setItem(SEEN, JSON.stringify(all));
    } catch {
      // Without storage it lasts until the page reloads.
    }
  });
} catch {
  // Unreadable or no storage: nothing is seen yet.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>
  </StrictMode>,
);

// The renderer loads once the page is idle: the chat itself comes first.
if ("requestIdleCallback" in window)
  requestIdleCallback(preloadRenderer, { timeout: 5_000 });
else setTimeout(preloadRenderer, 2_000);
