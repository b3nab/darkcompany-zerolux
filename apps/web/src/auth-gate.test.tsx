import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthHealth } from "@zerolux/chat";
import { SignIn } from "./AuthGate";

const health = (setupRequired: boolean): AuthHealth => ({
  api_version: 2,
  capabilities: ["workspaces-v1", "instance-auth-v1"],
  instance: { id: "aspen" },
  auth: { setup_required: setupRequired },
});

const inputIds = (html: string) =>
  [...html.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);

const signIn = (setupRequired: boolean, invited = false) =>
  renderToStaticMarkup(
    <SignIn
      health={health(setupRequired)}
      invitation={
        invited
          ? { workspace: "birch", invited_by: "Owner", expires_at: 0 }
          : undefined
      }
      place="192.0.2.10:4310"
      busy={false}
      error=""
      submit={() => {}}
    />,
  );

test("a kernel without accounts offers its first one, with name, email, password and its confirmation", () => {
  expect(inputIds(signIn(true))).toEqual([
    "auth-name",
    "auth-email",
    "auth-password",
    "auth-confirmation",
  ]);
});

test("a kernel with accounts offers sign-in, and an invitation a new account", () => {
  expect(inputIds(signIn(false))).toEqual(["auth-email", "auth-password"]);
  expect(inputIds(signIn(false, true))).toEqual([
    "auth-name",
    "auth-email",
    "auth-password",
    "auth-confirmation",
  ]);
});

test("a new account cannot be submitted until its name and passwords are given", () => {
  expect(signIn(true)).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  expect(signIn(false)).not.toMatch(
    /<button[^>]*type="submit"[^>]*disabled=""/,
  );
});
