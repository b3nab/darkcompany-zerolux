import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import { addMarketplace, removeMarketplace } from "./marketplaces";

afterEach(() => setKernelFetch());

/** A kernel that notes each call: its method, address and body. */
function kernel() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (init?.method === "POST")
      return Response.json({
        marketplace: {
          url: "https://market.example/index.json",
          name: "Aspen market",
          added_at: 1,
          computer: false,
        },
      });
    return Response.json({ marketplaces: [], administers: true });
  });
  return calls;
}

test("a marketplace is added and removed for the whole instance, at the kernel's root from any workspace", async () => {
  const calls = kernel();
  const base = "http://192.168.1.10:4310/w/ws-a";
  const added = await addMarketplace(
    base,
    " https://market.example/index.json ",
  );
  expect(added.name).toBe("Aspen market");
  await removeMarketplace(base, "https://market.example/index.json");
  expect(calls).toEqual([
    {
      method: "POST",
      url: "http://192.168.1.10:4310/api/marketplaces",
      body: { url: "https://market.example/index.json" },
    },
    { method: "GET", url: "http://192.168.1.10:4310/api/marketplaces" },
    {
      method: "DELETE",
      url: "http://192.168.1.10:4310/api/marketplaces",
      body: { url: "https://market.example/index.json" },
    },
    { method: "GET", url: "http://192.168.1.10:4310/api/marketplaces" },
  ]);
});
