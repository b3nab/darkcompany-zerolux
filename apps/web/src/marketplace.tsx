import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronRightIcon, LibraryIcon, SearchIcon } from "lucide-react";
import {
  extensionCategories,
  marketplaceIndexes,
  marketplaceName,
  offerAction,
  offerVersions,
} from "@zerolux/chat";
import type { Extension, Marketplace, MarketplaceOffer } from "@zerolux/chat";
import { ExtensionIcon } from "./extension-bits";
import { cn } from "cn";
import type { Consent } from "./extension-bits";
import { Button, buttonVariants } from "@/components/ui/button";

function Crumbs({ here }: { here: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-[12.5px] text-faint"
    >
      <Link
        to="/extensions"
        className="text-muted-foreground hover:text-foreground"
      >
        Extensions
      </Link>
      <ChevronRightIcon className="size-3.5" />
      <span>{here}</span>
    </nav>
  );
}

const listed = (names: string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(names);

const matches = (offer: MarketplaceOffer, query: string) =>
  !query ||
  [
    offer.name,
    offer.description,
    offer.publisher,
    offer.id,
    ...(offer.card?.keywords ?? []),
  ].some((text) => text.toLowerCase().includes(query));

const inCategory = (offer: MarketplaceOffer, category: string | null) =>
  !category || !!offer.card?.categories.includes(category);

function OfferTile({
  offer,
  installed,
  owns,
  consent,
}: {
  offer: MarketplaceOffer;
  installed?: Extension;
  owns: boolean;
  consent: (consent: Consent) => void;
}) {
  const navigate = useNavigate();
  const action = offerAction(offer);
  const category = extensionCategories.find(
    (c) => c.id === offer.card?.categories[0],
  )?.name;
  return (
    <li
      className="flex min-h-40 cursor-pointer flex-col gap-2.5 rounded-xl border bg-card p-3.5 transition-[border-color,translate] hover:-translate-y-px hover:border-input"
      onClick={() => navigate(`/extensions/${encodeURIComponent(offer.id)}`)}
    >
      <div className="flex items-start gap-3">
        <ExtensionIcon id={offer.id} extension={installed} card={offer.card} />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">{offer.name}</h2>
          <span className="text-xs text-faint">{offer.publisher}</span>
        </div>
      </div>
      <p className="line-clamp-2 text-[13px] text-muted-foreground">
        {offer.description}
      </p>
      <div className="mt-auto flex items-center gap-2 text-xs text-faint">
        <span className="flex min-w-0 flex-col gap-0.5">
          {category && <span className="truncate">{category}</span>}
          <span className="truncate font-mono">{offerVersions(offer)}</span>
        </span>
        <span
          className="ml-auto shrink-0"
          onClick={(event) => event.stopPropagation()}
        >
          {action === "installed" ? (
            <span className="rounded-full border px-2 py-0.5 text-[11.5px] text-muted-foreground">
              Installed
            </span>
          ) : (
            owns && (
              <Button
                size="sm"
                variant={action === "update" ? "default" : "outline"}
                onClick={() => consent({ offer, installed })}
              >
                {action === "update" ? "Update" : "Install"}
              </Button>
            )
          )}
        </span>
      </div>
    </li>
  );
}

/** A category to look in, with how many it holds; one that holds none is shown, faint. */
function CategoryButton({
  name,
  count,
  chosen,
  choose,
}: {
  name: string;
  count: number;
  chosen: boolean;
  choose: () => void;
}) {
  return (
    <button
      aria-current={chosen || undefined}
      disabled={!count && !chosen}
      onClick={choose}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45",
        "max-lg:border aria-current:bg-accent aria-current:font-medium aria-current:text-foreground",
      )}
    >
      <span className="flex-1">{name}</span>
      <span className="font-mono text-[11px] text-faint">{count || "–"}</span>
    </button>
  );
}

/**
 * The marketplace, a page of its own: what every marketplace offers, searched together and by
 * category, with what waits to be updated first; each opens its page.
 */
export function MarketplacePage({
  marketplace,
  error,
  extensions,
  owns,
  consent,
}: {
  marketplace?: Marketplace;
  error: string;
  extensions: Extension[] | undefined;
  owns: boolean;
  consent: (consent: Consent) => void;
}) {
  const [query, setQuery] = useState("");
  const [params, setParams] = useSearchParams();
  const category = params.get("category");
  const all = marketplace?.offers ?? [];
  const offers = all.filter(
    (offer) =>
      inCategory(offer, category) && matches(offer, query.trim().toLowerCase()),
  );
  const updates = offers.filter((offer) => offerAction(offer) === "update");
  // Every update waiting, whatever is searched: Update all takes them all.
  const waiting = all.flatMap((offer) => {
    const installed = extensions?.find((e) => e.id === offer.id && !e.dev);
    return installed && offerAction(offer) === "update"
      ? [{ offer, installed }]
      : [];
  });
  const choose = (id: string | null) =>
    setParams(id ? { category: id } : {}, { replace: true });
  const sources = marketplaceIndexes(marketplace);
  const named = (index: string) => marketplaceName(index, marketplace);
  const tile = (offer: MarketplaceOffer) => (
    <OfferTile
      key={`${offer.index} ${offer.id}`}
      offer={offer}
      installed={extensions?.find((e) => e.id === offer.id)}
      owns={owns}
      consent={consent}
    />
  );
  return (
    <div className="flex flex-col gap-6">
      <Crumbs here="Marketplace" />
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
          {sources.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {`Extensions from ${sources.length} ${sources.length === 1 ? "marketplace" : "marketplaces"}: ${listed(sources.map(named))}`}
            </p>
          )}
        </div>
        <Link
          to="/extensions/marketplaces"
          className={buttonVariants({
            variant: "outline",
            className: "ml-auto",
          })}
        >
          <LibraryIcon data-icon="inline-start" />
          Marketplaces
        </Link>
      </header>
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <nav
          aria-label="Categories"
          className="flex h-fit gap-1.5 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:flex-col lg:gap-0.5 lg:overflow-visible"
        >
          <CategoryButton
            name="All"
            count={all.length}
            chosen={!category}
            choose={() => choose(null)}
          />
          <h2 className="mt-4 mb-1.5 px-2.5 text-[11px] font-medium tracking-wider text-faint uppercase max-lg:hidden">
            Categories
          </h2>
          {extensionCategories.map((c) => (
            <CategoryButton
              key={c.id}
              name={c.name}
              count={all.filter((offer) => inCategory(offer, c.id)).length}
              chosen={category === c.id}
              choose={() => choose(c.id)}
            />
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-6">
          <label className="flex h-10 items-center gap-2 rounded-md border border-input bg-secondary px-3 text-faint focus-within:border-ring">
            <SearchIcon className="size-4" />
            <input
              aria-label="Search extensions"
              placeholder="Search extensions, publishers and keywords"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
            />
          </label>
          {(error || !!marketplace?.errors.length) && (
            <div className="flex flex-col gap-1">
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {marketplace?.errors.map((unread) => (
                <p key={unread.index} className="text-xs text-destructive">
                  {named(unread.index)}: {unread.error}
                </p>
              ))}
            </div>
          )}
          {updates.length > 0 && !category && (
            <section className="flex flex-col gap-3">
              <header className="flex items-center justify-between gap-3">
                <h2 className="text-[15px] font-semibold">Updates</h2>
                {owns && waiting.length > 1 && (
                  <Button
                    size="sm"
                    onClick={() => consent({ updates: waiting })}
                  >
                    Update all
                  </Button>
                )}
              </header>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3.5">
                {updates.map(tile)}
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-3">
            <h2 className="text-[15px] font-semibold">
              {query.trim()
                ? "Found"
                : (extensionCategories.find((c) => c.id === category)?.name ??
                  "All")}
            </h2>
            {offers.length ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3.5">
                {offers.map(tile)}
              </ul>
            ) : (
              marketplace && (
                <p className="text-sm text-muted-foreground">No extensions.</p>
              )
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Where extensions come from: each marketplace, how many it offers, or why it is unread. */
export function MarketplacesPage({
  marketplace,
}: {
  marketplace?: Marketplace;
}) {
  const sources = marketplaceIndexes(marketplace);
  return (
    <div className="flex flex-col gap-6">
      <Crumbs here="Marketplaces" />
      <h1 className="text-2xl font-semibold tracking-tight">Marketplaces</h1>
      {sources.length ? (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {sources.map((index) => {
            const count =
              marketplace?.offers.filter((offer) => offer.index === index)
                .length ?? 0;
            const unread = marketplace?.errors.find((e) => e.index === index);
            return (
              <li key={index} className="flex items-center gap-4 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent">
                  <LibraryIcon className="size-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold">
                    {marketplaceName(index, marketplace)}
                  </h2>
                  <p className="truncate font-mono text-[12px] text-faint">
                    {index}
                  </p>
                  {unread && (
                    <p className="text-xs text-destructive">{unread.error}</p>
                  )}
                </div>
                <span className="text-right text-[12.5px] text-muted-foreground">
                  {count} {count === 1 ? "extension" : "extensions"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        marketplace && (
          <p className="text-sm text-muted-foreground">No marketplaces.</p>
        )
      )}
    </div>
  );
}
