import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRightIcon, LibraryIcon, SearchIcon } from "lucide-react";
import {
  marketplaceIndexes,
  marketplaceName,
  offerAction,
  offerVersions,
} from "@zerolux/chat";
import type { Extension, Marketplace, MarketplaceOffer } from "@zerolux/chat";
import { ExtensionIcon } from "./extension-bits";
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
  [offer.name, offer.description, offer.publisher, offer.id].some((text) =>
    text.toLowerCase().includes(query),
  );

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
  return (
    <li
      className="flex min-h-40 cursor-pointer flex-col gap-2.5 rounded-xl border bg-card p-3.5 transition-[border-color,translate] hover:-translate-y-px hover:border-input"
      onClick={() => navigate(`/extensions/${encodeURIComponent(offer.id)}`)}
    >
      <div className="flex items-start gap-3">
        <ExtensionIcon id={offer.id} extension={installed} />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">{offer.name}</h2>
          <span className="text-xs text-faint">{offer.publisher}</span>
        </div>
      </div>
      <p className="line-clamp-2 text-[13px] text-muted-foreground">
        {offer.description}
      </p>
      <div className="mt-auto flex items-center gap-2 text-xs text-faint">
        <span className="font-mono">{offerVersions(offer)}</span>
        <span className="ml-auto" onClick={(event) => event.stopPropagation()}>
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

/**
 * The marketplace, a page of its own: what every marketplace offers, searched together, with
 * what waits to be updated first; each opens its page.
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
  const offers = (marketplace?.offers ?? []).filter((offer) =>
    matches(offer, query.trim().toLowerCase()),
  );
  const updates = offers.filter((offer) => offerAction(offer) === "update");
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
      <label className="flex h-10 items-center gap-2 rounded-md border border-input bg-secondary px-3 text-faint focus-within:border-ring">
        <SearchIcon className="size-4" />
        <input
          aria-label="Search extensions"
          placeholder="Search extensions, publishers and ids"
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
      {updates.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold">Updates</h2>
          <ul className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
            {updates.map(tile)}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold">
          {query.trim() ? "Found" : "All"}
        </h2>
        {offers.length ? (
          <ul className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
            {offers.map(tile)}
          </ul>
        ) : (
          marketplace && (
            <p className="text-sm text-muted-foreground">No extensions.</p>
          )
        )}
      </section>
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
