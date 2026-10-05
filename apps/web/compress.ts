import { brotliCompressSync, constants } from "node:zlib";
import { rename, stat } from "node:fs/promises";

// Brotli and gzip copies next to every text asset, for the kernel to serve precompressed. The
// original always stays. Builds go in place, so only what changed since its copy is redone.
const dir = Bun.argv[2] ?? "dist";
// Written aside, then renamed: the kernel never serves a copy that is half written.
const put = async (copy: string, bytes: Uint8Array) => {
  await Bun.write(`${copy}.tmp`, bytes);
  await rename(`${copy}.tmp`, copy);
};
for (const name of new Bun.Glob("**/*.{js,css,html,svg}").scanSync(dir)) {
  const path = `${dir}/${name}`;
  const source = await stat(path);
  const fresh = async (copy: string) =>
    (await stat(copy).catch(() => undefined))?.mtimeMs! >= source.mtimeMs;
  if ((await fresh(`${path}.br`)) && (await fresh(`${path}.gz`))) continue;
  const bytes = await Bun.file(path).bytes();
  await put(`${path}.gz`, Bun.gzipSync(bytes, { level: 9 }));
  await put(
    `${path}.br`,
    brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  );
}
