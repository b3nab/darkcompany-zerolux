import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { preloadRenderer } from "./components/message-text";
import { applyTheme } from "./theme";

applyTheme();

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
