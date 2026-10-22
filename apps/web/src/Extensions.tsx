import { WithMenu } from "./native-menus";
import type { MenuEntry } from "@zerolux/ui";
import { FolderInput } from "./folder-input";
import { useContext, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router";
import {
  ArrowUpCircleIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FlaskConicalIcon,
  LibraryIcon,
  RotateCwIcon,
  SearchIcon,
  StoreIcon,
} from "lucide-react";
import {
  enableExtension,
  extensionGroups,
  disableExtension,
  loadExtensionFolder,
  offerAction,
  offerFor,
  proposer,
  removeExtension,
  useExtensions,
  useMarketplace,
} from "@zerolux/chat";
import type {
  ChatSession,
  Extension,
  Marketplace,
  MarketplaceOffer,
  Perform,
} from "@zerolux/chat";
import {
  ConsentDialog,
  ExtensionIcon,
  partNames,
  StateChip,
  UpdatesDialog,
} from "./extension-bits";
import type { Consent } from "./extension-bits";
import { ExtensionPage } from "./extension-page";
import { MarketplacePage, MarketplacesPage } from "./marketplace";
import { UiActors } from "./native-ui";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

type Act = (operation: () => Promise<unknown>) => void;

/** An installed extension in the list: what it is and how it is, what it waits for; it opens its page. */
function Row({
  extension,
  offer,
  owns,
  busy,
  act,
  consent,
}: {
  extension: Extension;
  offer?: MarketplaceOffer;
  owns: boolean;
  busy: boolean;
  act: Act;
  consent: (consent: Consent) => void;
}) {
  const update = !!offer && offerAction(offer) === "update";
  const navigate = useNavigate();
  const page = `/extensions/${encodeURIComponent(extension.id)}`;
  // A right click does what its buttons do, and opens it; Remove asks on its page.
  const menu: MenuEntry[] = [
    { title: "Open", icon: "panel-right-open", onPress: () => navigate(page) },
    ...(owns
      ? ([
          { divider: true },
          ...(update
            ? [
                {
                  title: "Update…",
                  icon: "arrow-up-circle",
                  onPress: () =>
                    consent({ offer: offer!, installed: extension }),
                },
              ]
            : []),
          extension.enabled
            ? {
                title: "Disable",
                icon: "circle-pause",
                disabled: busy,
                onPress: () => act(() => disableExtension(extension.id)),
              }
            : {
                title: "Enable",
                icon: "circle-play",
                disabled: busy,
                onPress: () => act(() => enableExtension(extension.id)),
              },
          ...(extension.dev
            ? [
                {
                  title: "Load again",
                  icon: "rotate-cw",
                  disabled: busy,
                  onPress: () =>
                    act(() => loadExtensionFolder(extension.source)),
                },
              ]
            : []),
        ] as MenuEntry[])
      : []),
  ];
  return (
    <WithMenu entries={menu} render={<li />}>
      <Link
        to={`/extensions/${encodeURIComponent(extension.id)}`}
        aria-label={extension.name}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3.5 rounded-lg px-3.5 py-3 transition-colors hover:bg-accent"
      >
        <ExtensionIcon id={extension.id} extension={extension} />
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="font-semibold">{extension.name}</span>
            <span className="font-mono text-xs text-faint">
              {extension.version}
            </span>
            <span className="text-xs text-faint">{extension.publisher}</span>
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {extension.error ?? extension.description}
          </span>
        </span>
        <span
          className="flex items-center gap-2"
          onClick={(event) => event.preventDefault()}
        >
          <StateChip extension={extension} offer={offer} />
          {owns && update && (
            <Button
              size="sm"
              onClick={() => consent({ offer: offer!, installed: extension })}
            >
              Update
            </Button>
          )}
          {owns && !update && !extension.enabled && !extension.dev && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => enableExtension(extension.id))}
            >
              Enable
            </Button>
          )}
          {owns && extension.dev && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => loadExtensionFolder(extension.source))}
            >
              <RotateCwIcon data-icon="inline-start" />
              Load again
            </Button>
          )}
        </span>
        <ChevronRightIcon className="size-4 text-faint" />
      </Link>
    </WithMenu>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode[];
}) {
  if (!children.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="px-3.5 font-mono text-[11px] tracking-[0.06em] text-faint uppercase">
        {title} <span className="ml-1">{children.length}</span>
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

const tab =
  "relative inline-flex items-center gap-2 pb-2.5 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-foreground";

/** Installed and Proposals, side by side; the marketplace is a page of its own, a button away. */
export function ExtensionsHome({
  view,
  extensions,
  marketplace,
  error,
  proposerOf,
  owns,
  busy,
  act,
  consent,
}: {
  view: "installed" | "proposals";
  extensions: Extension[] | undefined;
  marketplace?: Marketplace;
  error: string;
  proposerOf: (extension: Extension) => string;
  owns: boolean;
  busy: boolean;
  act: Act;
  consent: (consent: Consent) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const offers = marketplace?.offers ?? [];
  const typed = query.trim().toLowerCase();
  const found = (extensions ?? []).filter(
    (e) =>
      !typed ||
      [e.name, e.description, e.publisher, e.id].some((text) =>
        text.toLowerCase().includes(typed),
      ),
  );
  const groups = extensionGroups(found, offers);
  const all = extensionGroups(extensions ?? [], offers);
  const settled = (extensions?.length ?? 0) - all.proposals.length;
  const row = (extension: Extension) => (
    <Row
      key={extension.id}
      extension={extension}
      offer={offerFor(extension, offers)}
      owns={owns}
      busy={busy}
      act={act}
      consent={consent}
    />
  );
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end gap-4 border-b">
        <div className="flex flex-col gap-3.5">
          <h1 className="text-2xl font-semibold tracking-tight">Extensions</h1>
          <nav aria-label="Extensions" className="flex gap-5">
            <NavLink to="/extensions" end className={tab}>
              Installed
              <span className="font-mono text-[11.5px] text-faint">
                {settled}
              </span>
            </NavLink>
            <NavLink to="/extensions/proposals" className={tab}>
              Proposals
              {all.proposals.length > 0 && (
                <span className="min-w-4.5 rounded-full bg-agent px-1.5 text-center text-[11px] leading-4.5 font-semibold text-background">
                  {all.proposals.length}
                </span>
              )}
            </NavLink>
          </nav>
        </div>
        <div className="mb-2.5 ml-auto flex items-center gap-2">
          {view === "installed" && (
            <label className="flex h-8.5 w-60 items-center gap-2 rounded-md border border-input bg-secondary px-2.5 text-faint focus-within:border-ring">
              <SearchIcon className="size-4" />
              <input
                aria-label="Search installed"
                placeholder="Search installed"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
              />
            </label>
          )}
          <Link to="/extensions/marketplace" className={buttonVariants()}>
            <StoreIcon data-icon="inline-start" />
            Marketplace
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="icon" aria-label="More" />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => navigate("/extensions/marketplaces")}
              >
                <LibraryIcon />
                Marketplaces
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate("/extensions/develop")}>
                <FlaskConicalIcon />
                Develop
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {view === "installed" ? (
        <>
          {all.updates.length > 0 && (
            <div className="flex items-center gap-3.5 rounded-lg border border-attention/35 bg-attention/5 px-3.5 py-3">
              <ArrowUpCircleIcon className="size-4.5 shrink-0 text-attention" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {all.updates.length === 1
                    ? "1 update available"
                    : `${all.updates.length} updates available`}
                </p>
                <p className="truncate text-[12.5px] text-muted-foreground">
                  {all.updates
                    .map(({ extension }) => extension.name)
                    .join(", ")}
                </p>
              </div>
              {owns && (
                <Button
                  size="sm"
                  onClick={() =>
                    consent(
                      all.updates.length === 1
                        ? {
                            offer: all.updates[0]!.offer,
                            installed: all.updates[0]!.extension,
                          }
                        : {
                            updates: all.updates.map(
                              ({ offer, extension }) => ({
                                offer,
                                installed: extension,
                              }),
                            ),
                          },
                    )
                  }
                >
                  {all.updates.length === 1 ? "Update" : "Update all"}
                </Button>
              )}
            </div>
          )}
          <Group title="Active">{groups.active.map(row)}</Group>
          <Group title="Disabled">{groups.disabled.map(row)}</Group>
          <Group title="In development">{groups.development.map(row)}</Group>
          {extensions && !settled && (
            <p className="text-sm text-muted-foreground">No extensions.</p>
          )}
        </>
      ) : (
        <Proposals
          proposals={all.proposals}
          proposerOf={proposerOf}
          owns={owns}
          busy={busy}
          act={act}
          consent={consent}
        />
      )}
    </div>
  );
}

/** What agents proposed, waiting for the owner: nothing runs before they enable it. */
function Proposals({
  proposals,
  proposerOf,
  owns,
  busy,
  act,
  consent,
}: {
  proposals: Extension[];
  proposerOf: (extension: Extension) => string;
  owns: boolean;
  busy: boolean;
  act: Act;
  consent: (consent: Consent) => void;
}) {
  if (!proposals.length)
    return <p className="text-sm text-muted-foreground">No proposals.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((proposal) => {
        const agent = proposerOf(proposal);
        return (
          <li
            key={proposal.id}
            aria-label={proposal.name}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-4 rounded-xl border bg-card p-4.5"
          >
            <ExtensionIcon id={proposal.id} extension={proposal} />
            <div className="flex min-w-0 flex-col gap-2">
              <p className="flex flex-wrap items-baseline gap-2.5">
                <Link
                  to={`/extensions/${encodeURIComponent(proposal.id)}`}
                  className="font-semibold hover:underline"
                >
                  {proposal.name}
                </Link>
                <span className="font-mono text-xs text-faint">
                  {proposal.version}
                </span>
                <span className="text-[12.5px] text-agent">
                  Proposed by {agent}
                </span>
              </p>
              {proposal.description && (
                <p className="text-[13px] text-muted-foreground">
                  {proposal.description}
                </p>
              )}
              <p className="flex flex-wrap gap-1.5">
                {proposal.parts.map((part) => (
                  <span
                    key={part}
                    className="rounded-full border px-2 text-[11.5px] text-muted-foreground"
                  >
                    {partNames[part] ?? part}
                  </span>
                ))}
              </p>
            </div>
            {owns && (
              <div className="flex flex-col items-stretch gap-2">
                <Button size="sm" onClick={() => consent({ proposal, agent })}>
                  Review and enable
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(() => removeExtension(proposal.id))}
                >
                  Remove
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Extensions being written, from folders on the kernel's computer. */
function Develop({
  extensions,
  owns,
  busy,
  perform,
  act,
}: {
  extensions: Extension[] | undefined;
  owns: boolean;
  busy: boolean;
  perform: Perform;
  act: Act;
}) {
  const [folder, setFolder] = useState("");
  const loaded = (extensions ?? []).filter((e) => e.dev);
  return (
    <div className="flex flex-col gap-6">
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
        <span>Develop</span>
      </nav>
      <h1 className="text-2xl font-semibold tracking-tight">Develop</h1>
      {owns && (
        <form
          className="flex gap-2 rounded-xl border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const path = folder.trim();
            if (path)
              void perform(async () => {
                await loadExtensionFolder(path);
              }).then((done) => done && setFolder(""));
          }}
        >
          <div className="min-w-0 flex-1">
            <FolderInput value={folder || null} onChange={setFolder} />
          </div>
          <Button type="submit" disabled={busy || !folder.trim()}>
            Load
          </Button>
        </form>
      )}
      {loaded.length > 0 && (
        <section
          aria-label="Loaded from folders"
          className="flex flex-col gap-2"
        >
          <h2 className="font-mono text-[11px] tracking-[0.06em] text-faint uppercase">
            Loaded from folders
          </h2>
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {loaded.map((extension) => (
              <li
                key={extension.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 p-3.5"
              >
                <ExtensionIcon id={extension.id} extension={extension} />
                <span className="min-w-0">
                  <Link
                    to={`/extensions/${encodeURIComponent(extension.id)}`}
                    className="font-semibold hover:underline"
                  >
                    {extension.name}
                  </Link>{" "}
                  <span className="font-mono text-xs text-faint">
                    {extension.version}
                  </span>
                  <span className="block truncate font-mono text-[12px] text-faint">
                    {extension.source}
                  </span>
                  {extension.error && (
                    <span
                      role="alert"
                      className="block text-xs text-destructive"
                    >
                      {extension.error}
                    </span>
                  )}
                </span>
                {owns && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(() => loadExtensionFolder(extension.source))
                    }
                  >
                    <RotateCwIcon data-icon="inline-start" />
                    Load again
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Opened(props: Omit<Parameters<typeof ExtensionPage>[0], "id">) {
  const { id = "" } = useParams();
  return <ExtensionPage id={id} {...props} />;
}

/**
 * The workspace's extensions: Installed and Proposals, the Marketplace a page of its own, each
 * extension a page; installing, updating and enabling ask first, in one dialog.
 */
export function ExtensionsPage({
  sessions,
  owns,
  busy,
  perform,
}: {
  /** The workspace's sessions, which may have proposed an extension. */
  sessions: ChatSession[];
  owns: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const actors = useContext(UiActors);
  const { extensions, error, reload } = useExtensions();
  const {
    marketplace,
    error: marketplaceError,
    reload: reloadMarketplace,
  } = useMarketplace();
  const [consent, setConsent] = useState<Consent>();
  const reloadAll = () => {
    void reload();
    void reloadMarketplace();
  };
  // The lists are read again after each change made here, done or refused, besides the
  // kernel's notices of changes made anywhere.
  const performed: Perform = (operation) =>
    perform(operation).finally(reloadAll);
  const act: Act = (operation) =>
    void performed(async () => {
      await operation();
    });
  const home = (view: "installed" | "proposals") => (
    <ExtensionsHome
      view={view}
      extensions={extensions}
      marketplace={marketplace}
      error={error}
      proposerOf={(extension) => proposer(extension, actors, sessions)}
      owns={owns}
      busy={busy}
      act={act}
      consent={setConsent}
    />
  );
  return (
    <div className="flex flex-col">
      <Routes>
        <Route index element={home("installed")} />
        <Route path="proposals" element={home("proposals")} />
        <Route
          path="marketplace"
          element={
            <MarketplacePage
              marketplace={marketplace}
              error={marketplaceError}
              extensions={extensions}
              owns={owns}
              consent={setConsent}
            />
          }
        />
        <Route
          path="marketplaces"
          element={<MarketplacesPage marketplace={marketplace} />}
        />
        <Route
          path="develop"
          element={
            <Develop
              extensions={extensions}
              owns={owns}
              busy={busy}
              perform={performed}
              act={act}
            />
          }
        />
        <Route
          path=":id"
          element={
            <Opened
              extensions={extensions}
              marketplace={marketplace}
              owns={owns}
              busy={busy}
              perform={performed}
              consent={setConsent}
            />
          }
        />
      </Routes>
      {consent &&
        ("updates" in consent ? (
          <UpdatesDialog
            updates={consent.updates}
            close={() => setConsent(undefined)}
            done={reloadAll}
          />
        ) : (
          <ConsentDialog
            consent={consent}
            marketplace={marketplace}
            close={() => setConsent(undefined)}
            done={reloadAll}
          />
        ))}
    </div>
  );
}
