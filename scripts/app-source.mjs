// The main process as a release ships it (2026-10-07; from scripts/package-mac.mjs, which the Windows release now shares
// it with: scripts/package-windows.mjs): src/main, src/shared and the two preloads, minified one file at a time into
// release/.app-src (the same layout, so every path and require stays as it is). Not protection, but the source is not
// there to read. The config takes the folder from ENGELBART_APP_SOURCE.

import { transform } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

/** src/main, src/shared and the two preloads, minified one file at a time into release/.app-src/src. → that folder */
export async function minifiedSources(ROOT) {
  const out = path.join(ROOT, 'release', '.app-src');
  fs.rmSync(out, { recursive: true, force: true });
  const files = ['src/preload.cjs', 'src/post-it-preload.cjs'];
  for (const dir of ['src/main', 'src/shared']) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) if (String(entry).endsWith('.cjs')) files.push(path.join(dir, String(entry)));
  }
  for (const file of files) {
    const { code } = await transform(fs.readFileSync(path.join(ROOT, file), 'utf8'), { loader: 'js', minify: true, platform: 'node', target: 'node22', sourcefile: file });
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.writeFileSync(path.join(out, file), code);
  }
  return path.join(out, 'src');
}
