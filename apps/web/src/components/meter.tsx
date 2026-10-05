import { cn } from "cn";

const fill = {
  human: "bg-human",
  agent: "bg-agent",
  success: "bg-success",
} as const;

/** A labelled bar: how much of something is used or done. */
export function Meter({
  value,
  max,
  label,
  valueLabel,
  tone = "agent",
}: {
  value: number;
  max: number;
  label: React.ReactNode;
  valueLabel: string;
  tone?: keyof typeof fill;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-mono text-muted-foreground">
          {valueLabel}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", fill[tone])}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}
