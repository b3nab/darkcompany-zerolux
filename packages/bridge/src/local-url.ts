/** A plain loopback HTTP origin: ZeroLux's kernel on this computer, nothing else. */
export function localURL(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a plain loopback HTTP URL, e.g. http://127.0.0.1:4310",
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}
