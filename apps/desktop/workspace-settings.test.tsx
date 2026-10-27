import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdoptionForm,
  networkAddress,
  networkSettings,
} from "./workspace-settings";

test("network edits preserve the listen address and clear optional addresses explicitly", () => {
  expect(
    networkSettings("::1", {
      port: " 4310 ",
      expose: " 192.0.2.10 ",
      publicOrigin: " ",
      publicLivekitUrl: "",
    }),
  ).toEqual({
    listen: "::1",
    port: 4310,
    expose: "192.0.2.10",
    publicOrigin: null,
    publicLivekitUrl: null,
  });
});

test("invalid ports are rejected before restarting a workspace", () => {
  for (const port of ["", "0", "65536", "4310.5", "1e3", "-1", "4310x"]) {
    expect(() =>
      networkSettings("127.0.0.1", {
        port,
        expose: "",
        publicOrigin: "",
        publicLivekitUrl: "",
      }),
    ).toThrow("Choose a port between 1 and 65535.");
  }
});

test("network addresses preserve public URLs and format private IPv6 correctly", () => {
  const network = {
    listen: "127.0.0.1",
    port: 4310,
    expose: "fd00::1",
    publicOrigin: null,
    publicLivekitUrl: null,
  };
  expect(networkAddress(network)).toBe("http://[fd00::1]:4310");
  expect(
    networkAddress({ ...network, publicOrigin: "https://workspace.example" }),
  ).toBe("https://workspace.example");
});

test("a workspace cannot be adopted before its folder has been verified", () => {
  let adopted = 0;
  const html = renderToStaticMarkup(
    <AdoptionForm
      id="profile-a"
      disabled={false}
      busy={() => {}}
      adopt={async () => {
        adopted++;
      }}
      cancel={() => {}}
    />,
  );
  const confirm = html.match(
    /<button[^>]*disabled=""[^>]*>Run with this app<\/button>/,
  );
  expect(confirm).not.toBeNull();
  expect(html).toContain('readOnly=""');
  expect(adopted).toBe(0);
});
