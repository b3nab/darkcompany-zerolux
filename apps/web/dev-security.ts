export function isLocalRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return false;
    const origin = request.headers.get("origin");
    return origin === null || origin === url.origin;
  } catch {
    return false;
  }
}
