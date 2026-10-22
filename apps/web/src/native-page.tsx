import { Fragment } from "react";
import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import type { PageProps, SectionProps } from "@zerolux/ui";
import { cn } from "cn";
import { WithMenu } from "./native-menus";
import { Button } from "@/components/ui/button";

/**
 * A screen as the app's own: its header with where you are, the search and what you can do;
 * what it shows below, its own right click where nothing is; an inspector beside it while
 * something is open, over it where there is no room.
 */
export function Page({
  title,
  subtitle,
  search,
  actions,
  inspector,
  menu,
  children,
}: PageProps) {
  const crumbs = typeof title === "string" ? [{ title }] : title;
  return (
    <div
      data-screen
      className="@container/page relative flex min-h-0 min-w-0 flex-1"
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b py-2 pr-3 pl-5">
          <nav
            aria-label="Where you are"
            className="flex min-w-0 items-center gap-0.5"
          >
            {crumbs.map((crumb, at) => {
              const here = at === crumbs.length - 1;
              return (
                <Fragment key={at}>
                  {at > 0 && (
                    <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
                  )}
                  {here || !crumb.onPress ? (
                    <h1
                      aria-current={here ? "location" : undefined}
                      className={cn(
                        "truncate px-1.5 text-[15px]",
                        here
                          ? "font-semibold tracking-tight"
                          : "text-muted-foreground",
                      )}
                    >
                      {crumb.title}
                    </h1>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onPress}
                      className="truncate rounded-sm px-1.5 py-0.5 text-[15px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {crumb.title}
                    </button>
                  )}
                </Fragment>
              );
            })}
          </nav>
          {subtitle && (
            <span className="truncate text-[12.5px] text-faint">
              {subtitle}
            </span>
          )}
          <span className="flex-1" />
          {search && (
            <label className="flex h-8 w-56 items-center gap-2 rounded-md border border-input px-2.5 text-faint focus-within:border-ring @max-2xl/page:w-40">
              <SearchIcon className="size-3.5 shrink-0" />
              <input
                type="search"
                aria-label={search.placeholder}
                placeholder={search.placeholder}
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
              />
            </label>
          )}
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
        <WithMenu
          entries={menu}
          render={
            <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5 has-[[role=grid]]:gap-0 has-[[role=grid]]:p-0" />
          }
        >
          {children}
        </WithMenu>
      </section>
      {inspector && (
        <aside
          aria-label={inspector.title}
          className="flex w-80 shrink-0 flex-col border-l bg-background @max-3xl/page:absolute @max-3xl/page:inset-y-0 @max-3xl/page:right-0 @max-3xl/page:z-20 @max-3xl/page:shadow-xl"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-2 border-b pr-2 pl-4">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
              {inspector.title}
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              title="Close"
              onClick={inspector.onClose}
            >
              <XIcon />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {inspector.content}
          </div>
        </aside>
      )}
    </div>
  );
}

/** A group of rows (ListItems) under its name, with what adds to it beside the name. */
export function Section({ title, actions, children }: SectionProps) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5 px-2 pb-3">
      <header className="flex min-h-7 items-center justify-between gap-2 pr-0.5 pl-2">
        <h3 className="truncate font-mono text-[10.5px] font-medium tracking-wider text-faint uppercase">
          {title}
        </h3>
        <div className="flex items-center">{actions}</div>
      </header>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}
