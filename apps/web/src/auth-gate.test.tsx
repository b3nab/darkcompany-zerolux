import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
