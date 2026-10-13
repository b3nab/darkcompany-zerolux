import { expect, spyOn, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthHealth, AuthIdentity } from "@zerolux/chat";
import { AuthGate } from "./AuthGate";

test("authentication mounts before any workspace hooks or private content", () => {
  let mounted = false;
  function PrivateWorkspace() {
    mounted = true;
    return <div>Private workspace data</div>;
  }
  const html = renderToStaticMarkup(
    <AuthGate>
      <PrivateWorkspace />
    </AuthGate>,
  );
  expect(mounted).toBe(false);
  expect(html).not.toContain("Private workspace data");
  expect(html).not.toContain('type="password"');
});

/** Effects do not run during SSR. Seed the verified snapshot, checking each replaced
 * hook's initial value so a reordered hook cannot silently change the fixture. */
function ready(setupRequired: boolean, identity: AuthIdentity | null = null) {
  const health: AuthHealth = {
    api_version: 2,
    capabilities: ["auth-v1"],
    workspace: { id: "fixture-workspace", name: "Fixture workspace" },
    auth: { setup_required: setupRequired },
  };
  const useState = React.useState;
  let call = 0;
  const state = spyOn(React, "useState").mockImplementation(((
    initial: unknown,
  ) => {
    switch (++call) {
      case 2:
        expect(initial).toBeUndefined();
        return useState(health);
      case 3:
        expect(initial).toBeNull();
        return useState(identity);
      case 4:
        expect(initial).toBe(true);
        return useState(false);
      default:
        return useState(initial);
    }
  }) as typeof React.useState);
  try {
    return renderToStaticMarkup(
      <AuthGate>
        <div>Private workspace data</div>
      </AuthGate>,
    );
  } finally {
    state.mockRestore();
  }
}

const inputIds = (html: string) =>
  [...html.matchAll(/<input\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);

test("an unclaimed workspace offers account creation with only name, email and password", () => {
  const html = ready(true);
  expect(inputIds(html)).toEqual(["auth-name", "auth-email", "auth-password"]);
  expect(html).toContain("Create account");
  expect(html).not.toContain("One-time");
  expect(html).not.toContain("Private workspace data");
});

test("a claimed workspace offers login without account creation", () => {
  const html = ready(false);
  expect(inputIds(html)).toEqual(["auth-email", "auth-password"]);
  expect(html).toContain("Sign in");
  expect(html).not.toContain("Create account");
  expect(html).not.toContain("Private workspace data");
});

test("an unbound account cannot claim after another account has become owner", () => {
  const html = ready(true, {
    user: { id: "fixture-user", name: "Other", email: "other@example.test" },
    actor_id: null,
    setup_required: false,
  });
  expect(html).toContain("This account is not a member of this workspace.");
  expect(html).not.toContain("Create account");
  expect(html).not.toContain("Connect account");
  expect(html).not.toContain("Private workspace data");
});

test("a restored unbound account can finish enrollment without another field", () => {
  const html = ready(true, {
    user: { id: "fixture-user", name: "Owner", email: "owner@example.test" },
    actor_id: null,
    setup_required: true,
  });
  expect(inputIds(html)).toEqual([]);
  expect(html).toContain("owner@example.test");
  expect(html).toMatch(
    /<button[^>]*type="submit"[^>]*>Connect account<\/button>/,
  );
  expect(html).not.toMatch(
    /<button[^>]* disabled=""[^>]*>Connect account<\/button>/,
  );
  expect(html).not.toContain("Private workspace data");
});
