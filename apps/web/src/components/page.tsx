import { cn } from "cn";

/** A page that scrolls under the topbar, its content centered at reading width. */
export function Page({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex max-w-295 flex-col gap-6 px-4 pt-7 pb-14 md:px-7",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
