import { cn } from "cn";
import { mark, stroke, wordmark } from "@zerolux/theme/logo";

/** The wordmark: "zerolux" with the mark as its "o", in the logo's own inks. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={wordmark.viewBox}
      role="img"
      aria-label="ZeroLux"
      className={cn("h-4 w-auto", className)}
    >
      <path d={wordmark.letters} className="fill-logo-ink" />
      <path
        d={wordmark.ring}
        fill="none"
        strokeWidth={stroke}
        className="stroke-logo-ink"
      />
      <circle {...wordmark.dot} className="fill-logo-dot" />
    </svg>
  );
}

/** The mark alone. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={mark.viewBox}
      role="img"
      aria-label="ZeroLux"
      className={cn("size-5", className)}
    >
      <path
        d={mark.ring}
        fill="none"
        strokeWidth={stroke}
        className="stroke-logo-ink"
      />
      <circle {...mark.dot} className="fill-logo-dot" />
    </svg>
  );
}
