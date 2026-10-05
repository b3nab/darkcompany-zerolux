import index from "./index.html";
import { isLocalRequest } from "./dev-security";

const kernel = new URL(Bun.env.ZEROLUX_KERNEL ?? "http://127.0.0.1:4310");
if (
  kernel.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(kernel.hostname) ||
  kernel.username ||
  kernel.password ||
  kernel.pathname !== "/" ||
  kernel.search ||
  kernel.hash
) {
  throw new Error("ZEROLUX_KERNEL must be a plain loopback HTTP URL");
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 5173,
  development: { hmr: true, console: true },
  routes: {
    // Every page address serves the app; it reads the address itself.
    "/*": index,
    "/api/*": async (request) => {
      if (!isLocalRequest(request))
        return Response.json(
          { error: "Only local, same-origin requests are allowed" },
          { status: 403 },
        );
      const incoming = new URL(request.url);
      const target = new URL(incoming.pathname + incoming.search, kernel);
      const headers = new Headers(request.headers);
      headers.set("host", target.host);
      if (headers.has("origin")) headers.set("origin", target.origin);
      try {
        return await fetch(target, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return Response.json(
          { error: "Kernel unavailable. Start cargo run -- serve." },
          { status: 502 },
        );
      }
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});
console.log(`ZeroLux web: ${server.url} → kernel ${kernel.origin}`);
