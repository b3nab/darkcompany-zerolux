"use dom";
import { useEffect, useRef } from "react";
import type { DOMProps } from "expo/dom";

/**
 * An extension's own page, in a sandboxed frame with no origin of its own, as on the web:
 * it reaches the app only through its messages, which `ask` answers as JSON-RPC.
 */
export default function WebPiece({
  url,
  title,
  ask,
}: {
  url: string;
  title: string;
  /** A message from the page, as JSON: the reply to post back, or nothing. */
  ask: (message: string) => Promise<string>;
  dom?: DOMProps;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      // Only the page's own frame is answered.
      if (event.source !== frame.current?.contentWindow) return;
      void ask(JSON.stringify(event.data)).then((reply) => {
        // The frame has no origin to name: "*" is the only target that reaches it.
        if (reply)
          frame.current?.contentWindow?.postMessage(JSON.parse(reply), "*");
      });
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [ask]);
  return (
    <iframe
      ref={frame}
      src={url}
      title={title}
      sandbox="allow-scripts allow-forms"
      style={{
        border: 0,
        display: "block",
        width: "100%",
        height: "100vh",
        background: "transparent",
      }}
    />
  );
}
