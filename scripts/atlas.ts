import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Community Edition: Apache-2.0, local generation, no account or cloud service.
const version = "v1.3.0";
const checksums: Record<string, string> = {
  "darwin-arm64":
    "4e5ffdc10b2b4fd3a06074aba72848150907d5316cacad7b19bae6c6ae3db991",
  "darwin-amd64":
    "650981a024301775ec964e5134e2d5712b7ef1b25fec4b2ec54bad762b4bdf6f",
  "linux-amd64":
    "10d7913e3dce43ab99b8d71534a4cbadaf11a16dc293adf3b91d10e83a0ac70b",
  "linux-arm64":
    "082188c57a53439596a3ee52173b12e785aa83ec718505674e2052db0fec0c4c",
};

function digest(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function atlas() {
  const target = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const checksum = checksums[target];
  if (!checksum)
    throw new Error(
      `Atlas development tooling is not configured for ${target}`,
    );
  const directory = resolve(
    import.meta.dir,
    `../.zerolux/tools/atlas/${version}/${target}`,
  );
  const path = join(directory, "atlas");
  try {
    if (digest(await readFile(path)) !== checksum)
      throw new Error("Cached Atlas checksum mismatch");
    return path;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const response = await fetch(
    `https://atlasbinaries.com/atlas/atlas-community-${target}-${version}`,
    {
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok)
    throw new Error(`Atlas download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== checksum)
    throw new Error("Downloaded Atlas checksum mismatch");
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, path);
  return path;
}

if (import.meta.main) console.log(await atlas());
