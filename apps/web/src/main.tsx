import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { preloadRenderer } from "./components/message-text";
import { keepDraftsIn } from "@zerolux/chat";
import { applyTheme } from "./theme";

applyTheme();
// Unsent messages survive a reload, in this browser only.
const DRAFTS = "zerolux-drafts";
try {
  keepDraftsIn(JSON.parse(localStorage.getItem(DRAFTS) ?? "{}"), (all) => {
    try {
      localStorage.setItem(DRAFTS, JSON.stringify(all));
    } catch {
      // Without storage a draft lasts until the page reloads.
    }
  });
} catch {
  // Unreadable or no storage: drafts start empty.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// The renderer loads once the page is idle: the chat itself comes first.
if ("requestIdleCallback" in window)
  requestIdleCallback(preloadRenderer, { timeout: 5_000 });
else setTimeout(preloadRenderer, 2_000);
