import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { autostartSettings, DesktopSettings } from "./DesktopSettings";
import type { AutostartStatus } from "./DesktopSettings";

test("reading startup preferences never enables login startup", async () => {
  const calls: unknown[] = [];
  const settings = autostartSettings(async (command, args) => {
    calls.push([command, args]);
    return { enabled: false, supported: true };
  });
  await settings.change();
  expect(calls).toEqual([["autostart_status", undefined]]);
  expect(settings.snapshot().state?.enabled).toBe(false);
});

test("an OS failure preserves the confirmed preference and allows a retry", async () => {
  let fail = true;
  const settings = autostartSettings(async (command, args) => {
    if (command === "autostart_set" && fail)
      throw new Error("Login settings could not be changed");
    return { enabled: args?.enabled ?? true, supported: true };
  });
  await settings.change();
  await settings.change(false);
  expect(settings.snapshot()).toEqual({
    state: { enabled: true, supported: true },
    pending: false,
    error: "Login settings could not be changed",
  });
  fail = false;
  await settings.change(false);
  expect(settings.snapshot()).toEqual({
    state: { enabled: false, supported: true },
    pending: false,
  });
});

test("a pending startup change cannot race a refresh or another change", async () => {
  const confirmation = Promise.withResolvers<AutostartStatus>();
  const calls: string[] = [];
  const settings = autostartSettings(async (command) => {
    calls.push(command);
    return command === "autostart_status"
      ? { enabled: false, supported: true }
      : confirmation.promise;
  });
  await settings.change();
  const changing = settings.change(true);
  await settings.change();
  await settings.change(false);
  expect(settings.snapshot().state?.enabled).toBe(false);
  expect(calls).toEqual(["autostart_status", "autostart_set"]);
  confirmation.resolve({ enabled: true, supported: true });
  await changing;
  expect(settings.snapshot().state?.enabled).toBe(true);
});

test("unsupported hosts and browser views do not offer startup changes", async () => {
  let calls = 0;
  const settings = autostartSettings(async () => {
    calls++;
    return { enabled: false, supported: false };
  });
  await settings.change();
  await settings.change(true);
  expect(calls).toBe(1);
  expect(renderToStaticMarkup(<DesktopSettings />)).toBe("");
});
