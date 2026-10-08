import { useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

/**
 * The panel's width in pixels, kept in this browser: a width kept as a share of the window
 * would change with the window. Without storage it lasts until the page reloads.
 */
function useWidth(id: string, size: number) {
  const key = `zerolux-panel-${id}`;
  const [kept, setKept] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key) ?? NaN);
      return Number.isFinite(stored) ? stored : size;
    } catch {
      return size;
    }
  });
  const width = useRef(kept);
  return {
    kept,
    resized: (pixels: number) => {
      width.current = pixels;
    },
    keep: () => {
      const pixels = Math.round(width.current);
      setKept(pixels);
      try {
        localStorage.setItem(key, String(pixels));
      } catch {
        // Nothing to keep it in.
      }
    },
  };
}

/**
 * A page with a panel beside it that you drag wider or narrower; each page remembers its width.
 * The panel sits on the right, or on the left (`side="start"`) as a list beside what it opens.
 * A `collapsible` panel closes when dragged past its narrowest, and opens when dragged back.
 * When the screen is too narrow (`wide` false) the page keeps its own layout: `className` lays
 * out the content and the panel as before. On a wide screen the content stays mounted while the
 * panel comes and goes, so it keeps its scroll and focus.
 */
export function SidePanel({
  id,
  wide,
  panel,
  side = "end",
  size,
  min,
  max,
  collapsible,
  panelRef,
  className,
  children,
}: {
  id: string;
  wide: boolean;
  panel: ReactNode;
  side?: "start" | "end";
  /** The panel's width in pixels: at first, and the narrowest and widest you can drag it to. */
  size: number;
  min: number;
  max: number;
  collapsible?: boolean;
  /** Opens and closes the panel from elsewhere, such as a keyboard shortcut. */
  panelRef?: Ref<PanelImperativeHandle | null>;
  className?: string;
  children: ReactNode;
}) {
  const width = useWidth(id, size);
  if (!wide)
    return (
      <div className={className}>
        {children}
        {panel}
      </div>
    );
  const content = (
    <ResizablePanel
      key="content"
      id={`${id}-content`}
      minSize={360}
      className="flex min-h-0 min-w-0 flex-col"
    >
      {children}
    </ResizablePanel>
  );
  const aside = panel
    ? [
        <ResizablePanel
          key="panel"
          id={`${id}-panel`}
          defaultSize={width.kept}
          minSize={min}
          maxSize={max}
          collapsible={collapsible}
          panelRef={panelRef}
          onResize={(size) => width.resized(size.inPixels)}
          groupResizeBehavior="preserve-pixel-size"
          className="flex min-h-0 flex-col"
        >
          {panel}
        </ResizablePanel>,
        <ResizableHandle key="handle" />,
      ]
    : [];
  return (
    <ResizablePanelGroup
      id={id}
      onLayoutChanged={width.keep}
      className="min-h-0 flex-1"
    >
      {side === "start" ? [...aside, content] : [content, ...aside.reverse()]}
    </ResizablePanelGroup>
  );
}
