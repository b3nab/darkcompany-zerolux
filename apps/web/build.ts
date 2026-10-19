// The web app as the kernel serves it, in ZEROLUX_WEB_OUTDIR (dist by default), with its
// precompressed copies. The folder is read here, not in the package script, so that every
// system's shell builds it the same way.
import { $ } from "bun";

const outdir = process.env.ZEROLUX_WEB_OUTDIR || "dist";
await $`bun build ./index.html --outdir ${outdir} --target browser --production --public-path /`;
await $`bun compress.ts ${outdir}`;
