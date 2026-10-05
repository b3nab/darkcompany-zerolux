// Every diagram type, in one file with no imports of its own: see `load` in
// src/components/message-text.tsx.
import { createMermaidPlugin } from "@streamdown/mermaid";

// One per theme: a diagram is drawn for night or daylight.
export const mermaid = createMermaidPlugin({ config: { theme: "dark" } });
export const mermaidLight = createMermaidPlugin({
  config: { theme: "default" },
});
