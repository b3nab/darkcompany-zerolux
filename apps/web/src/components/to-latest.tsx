import { ArrowDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Back to the latest items, once the reader is more than a screen above them. No height of its
 * own: it rides the bottom edge of the scrolled view without moving what is in it.
 */
export function ToLatest({
  shown,
  label,
  onClick,
}: {
  shown: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="sticky bottom-0 mx-auto h-0 max-w-3xl">
      <Button
        variant="outline"
        size="icon"
        aria-label={label}
        title={label}
        aria-hidden={!shown}
        tabIndex={shown ? undefined : -1}
        data-shown={shown || undefined}
        className="pointer-events-none absolute right-0 bottom-0 translate-y-2 scale-90 rounded-full bg-card opacity-0 shadow-md transition-[opacity,translate,scale] duration-200 data-shown:pointer-events-auto data-shown:translate-y-0 data-shown:scale-100 data-shown:opacity-100 motion-reduce:transition-none"
        onClick={onClick}
      >
        <ArrowDownIcon />
      </Button>
    </div>
  );
}
