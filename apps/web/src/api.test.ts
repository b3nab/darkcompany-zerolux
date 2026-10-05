import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { actionsFor } from "./api";
import { App } from "./App";
import { isLocalRequest } from "../dev-security";

describe("human task controls", () => {
  test("only drafts and failures can be queued directly", () => {
    expect(actionsFor("draft")).toEqual(["queue"]);
    expect(actionsFor("failed")).toEqual(["queue"]);
  });
  test("only review allows approval or revision", () => {
    expect(actionsFor("review")).toEqual(["approve", "request_changes"]);
    for (const status of ["queued", "running", "done"] as const)
      expect(actionsFor(status)).toEqual([]);
  });
  test("initial UI explains how to start the Rust kernel", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(App)),
    );
    expect(html).toContain("cargo run -- serve");
    expect(html).toContain("Connecting to your kernel");
  });
});

describe("Bun API proxy trust boundary", () => {
  const request = (host: string, origin?: string) =>
    new Request("http://127.0.0.1:5173/api/projects", {
      headers: { host, ...(origin === undefined ? {} : { origin }) },
    });
  test("accepts local same-origin browser requests and local clients", () => {
    expect(
      isLocalRequest(request("127.0.0.1:5173", "http://127.0.0.1:5173")),
    ).toBe(true);
    expect(isLocalRequest(request("localhost:5173"))).toBe(true);
    expect(isLocalRequest(request("[::1]:5173", "http://[::1]:5173"))).toBe(
      true,
    );
  });
  test("rejects foreign/null origins and DNS rebinding", () => {
    expect(
      isLocalRequest(request("127.0.0.1:5173", "https://example.com")),
    ).toBe(false);
    expect(
      isLocalRequest(request("127.0.0.1:5173", "http://localhost:9999")),
    ).toBe(false);
    expect(isLocalRequest(request("127.0.0.1:5173", "null"))).toBe(false);
    expect(isLocalRequest(request("attacker.example"))).toBe(false);
    expect(
      isLocalRequest(new Request("http://127.0.0.1:5173/api/projects")),
    ).toBe(false);
  });
});
