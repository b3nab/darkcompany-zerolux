import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import {
  addMarketplace,
  errorMessage,
  kernelUrl,
  removeMarketplace,
  useMarketplaces,
} from "@zerolux/chat";
import type { InstanceMarketplace } from "@zerolux/chat";
import { Settings } from "./Account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Where every workspace of this kernel's instance installs its extensions from. */
export function MarketplacesPage() {
  const { marketplaces, administers, error } = useMarketplaces();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailed("");
    try {
      await work();
      return true;
    } catch (error) {
      setFailed(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Settings eyebrow={new URL(kernelUrl()).host} title="Marketplaces">
      {(error || failed) && (
        <p role="alert" className="text-sm text-destructive">
          {failed || error}
        </p>
      )}
      {marketplaces === null ? (
        <p className="text-sm text-muted-foreground">
          Not available on this kernel.
        </p>
      ) : (
        marketplaces && (
          <Marketplaces
            marketplaces={marketplaces}
            administers={administers}
            busy={busy}
            add={(url) => act(() => addMarketplace(kernelUrl(), url))}
            remove={(url) => act(() => removeMarketplace(kernelUrl(), url))}
          />
        )
      )}
    </Settings>
  );
}

/**
 * The marketplaces every workspace installs from: this computer's own stay; those the instance
 * added are added and removed by whoever administers it.
 */
export function Marketplaces({
  marketplaces,
  administers,
  busy,
  add,
  remove,
}: {
  marketplaces: InstanceMarketplace[];
  administers: boolean;
  busy: boolean;
  add: (url: string) => Promise<boolean>;
  remove: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  return (
    <>
      {marketplaces.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {marketplaces.map((marketplace) => (
            <li
              key={marketplace.url}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {marketplace.computer
                    ? "This computer"
                    : (marketplace.name ?? marketplace.url)}
                </span>
                <span className="font-mono text-[11.5px] break-all text-muted-foreground">
                  {marketplace.url}
                </span>
              </span>
              {marketplace.added_at !== null && (
                <time
                  dateTime={new Date(marketplace.added_at).toISOString()}
                  className="shrink-0 font-mono text-[11px] text-faint"
                >
                  {new Date(marketplace.added_at).toLocaleDateString()}
                </time>
              )}
              {administers && !marketplace.computer && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${marketplace.name ?? marketplace.url}`}
                  title="Remove"
                  disabled={busy}
                  onClick={() => remove(marketplace.url)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {administers && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim())
              void add(url.trim()).then((added) => added && setUrl(""));
          }}
        >
          <Input
            type="url"
            aria-label="Marketplace address"
            placeholder="https://…/index.json"
            value={url}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            className="font-mono text-[13px]"
          />
          <Button type="submit" disabled={busy || !url.trim()}>
            <PlusIcon data-icon="inline-start" />
            Add
          </Button>
        </form>
      )}
    </>
  );
}
