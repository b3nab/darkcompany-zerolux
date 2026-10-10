import { useState } from "react";
import { MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { drawsWindowControls, windowControl } from "@/desktop";

/** The three window buttons of the desktop app on Windows and Linux, where the page is the title bar. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  if (!drawsWindowControls()) return null;
  const act = (action: "minimize" | "toggle_maximize" | "close") => () =>
    windowControl(action).then(
      (state) => setMaximized(state.maximized),
      () => {},
    );
  return (
    <div className="ml-1 flex items-center" role="group" aria-label="Window">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        onClick={act("minimize")}
      >
        <MinusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={act("toggle_maximize")}
      >
        <SquareIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        className="hover:bg-destructive hover:text-destructive-foreground"
        onClick={act("close")}
      >
        <XIcon />
      </Button>
    </div>
  );
}
