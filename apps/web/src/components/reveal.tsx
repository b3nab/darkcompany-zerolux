import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * What a line holds, sliding open and closed. It never measures: the grid row grows from
 * nothing to its content and keeps following it, so live output is never cut. Closed, the
 * content leaves the page once the slide is over.
 */
export function Reveal({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  // Mounted with the opening itself, so the row slides from nothing to its content.
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setShown(false), 250);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div
      id={id}
      data-open={open || undefined}
      inert={!open}
      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-open:grid-rows-[1fr] motion-reduce:transition-none"
    >
      <div className="min-h-0 overflow-hidden">{shown && children}</div>
    </div>
  );
}
