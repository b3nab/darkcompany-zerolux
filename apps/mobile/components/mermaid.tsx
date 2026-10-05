"use dom";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

/**
 * One Mermaid diagram, drawn by the same library the web uses, inside Expo's DOM component.
 * Nothing is loaded from outside; a malformed diagram shows its source and the parser's reason.
 */
export default function Mermaid({
  code,
  dark,
  dom,
}: {
  code: string;
  /** Drawn for the app's theme: night or daylight. */
  dark: boolean;
  dom?: import("expo/dom").DOMProps;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      darkMode: dark,
      fontFamily: "system-ui, sans-serif",
    });
    let cancelled = false;
    const id = `d${Math.random().toString(36).slice(2)}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!cancelled && host.current) {
          host.current.innerHTML = svg;
          setFailure("");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [code, dark]);
  void dom;
  return (
    <div style={{ margin: 0, padding: 0, background: "transparent" }}>
      {failure ? (
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            color: "#939ba9",
          }}
        >
          {code}
          {"\n\n"}
          {failure}
        </pre>
      ) : null}
      <div ref={host} style={{ display: failure ? "none" : "block" }} />
    </div>
  );
}
