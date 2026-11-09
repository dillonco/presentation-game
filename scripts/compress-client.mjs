// Compresses the built app ahead of time, so phones download less and the server does no work per request.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const ROOT = "dist/client";
const COMPRESSIBLE = /\.(js|css|html|svg|json)$/;
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

for (const entry of await readdir(ROOT, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const body = await readFile(path);
  await writeFile(`${path}.br`, await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  await writeFile(`${path}.gz`, await gz(body, { level: 9 }));
}
