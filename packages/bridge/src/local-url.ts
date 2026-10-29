/** A plain loopback HTTP address of ZeroLux's kernel on this computer, nothing else: its
 * origin, or one of its workspaces at `/w/<id>`. */
export function localURL(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !(path === "" || /^\/w\/[\w-]+$/.test(path)) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a plain loopback HTTP URL, e.g. http://127.0.0.1:4310",
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin + path;
}
