import { SquareIcon, Volume2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Hears an agent's words in its own voice, or stops them; what went wrong shows under it. */
export function Listen({
  reading,
  error,
  toggle,
}: {
  reading: boolean;
  error?: string;
  toggle: () => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={reading ? "Stop reading" : "Listen"}
        title={reading ? "Stop reading" : "Listen"}
        aria-pressed={reading}
        onClick={toggle}
        className="text-faint hover:text-foreground aria-pressed:text-agent-foreground"
      >
        {reading ? <SquareIcon /> : <Volume2Icon />}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
