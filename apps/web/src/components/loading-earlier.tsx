import { Spinner } from "@/components/ui/spinner";

/** Earlier items on their way: over the top of a scrolled view, never moving what is in it. */
export function LoadingEarlier({
  loading,
  label,
}: {
  loading: boolean;
  label: string;
}) {
  return (
    <div className="pointer-events-none sticky top-0 z-10 h-0">
      <div
        data-shown={loading || undefined}
        aria-hidden={!loading}
        className="absolute inset-x-0 top-1 flex justify-center opacity-0 transition-opacity duration-200 data-shown:opacity-100 motion-reduce:transition-none"
      >
        <span className="rounded-full border bg-background/90 p-1.5 shadow-xs backdrop-blur-sm">
          <Spinner
            aria-label={label}
            className="size-3.5 text-muted-foreground"
          />
        </span>
      </div>
    </div>
  );
}
