import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InstanceMarketplace } from "@zerolux/chat";
import { Marketplaces } from "./Marketplaces";

const marketplaces: InstanceMarketplace[] = [
  {
    url: "file:///srv/aspen/index.json",
    name: null,
    added_at: null,
    computer: true,
  },
  {
    url: "https://market.example/index.json",
    name: "Birch market",
    added_at: Date.UTC(2026, 10, 1),
    computer: false,
  },
];

const shown = (administers: boolean) =>
  renderToStaticMarkup(
    <Marketplaces
      marketplaces={marketplaces}
      administers={administers}
      busy={false}
      add={async () => true}
      remove={() => {}}
    />,
  );

test("whoever administers the instance adds marketplaces and removes those it added, not the computer's own", () => {
  const html = shown(true);
  expect(html.match(/<li/g)).toHaveLength(2);
  expect(html).toContain("<form");
  // One removal, for the added marketplace; the computer's own stays.
  expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(1);
});

test("anyone else sees the instance's marketplaces and changes none", () => {
  const html = shown(false);
  expect(html.match(/<li/g)).toHaveLength(2);
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<button");
});
