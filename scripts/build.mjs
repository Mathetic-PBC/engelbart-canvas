import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: { index: 'src/renderer/index.jsx', 'post-it': 'src/renderer/post-its/Card.jsx' },
  bundle: true,
  outdir: 'dist',
  entryNames: '[name]',
  assetNames: 'assets/[name]-[hash]',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome148',
  sourcemap: true,
  loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  logLevel: 'warning',
});
await copyFile('src/renderer/index.html', 'dist/index.html');
// A narrow, bundled preload for the remote Stage pages; no app bridge is exposed.
await build({ entryPoints: ['src/main/browser/recording-preload.js'], bundle: true,
  outfile: 'dist/recording-preload.cjs', platform: 'browser', format: 'cjs',
  external: ['electron'], target: 'chrome148', logLevel: 'warning' });
await build({ entryPoints: ['src/main/zotero/preload.js'], bundle: true,
  outfile: 'dist/zotero-preload.cjs', platform: 'browser', format: 'cjs',
  external: ['electron'], target: 'chrome148', logLevel: 'warning' });
await build({ entryPoints: ['src/main/google/preload.js'], bundle: true,
  outfile: 'dist/google-preload.cjs', platform: 'browser', format: 'cjs',
  external: ['electron'], target: 'chrome148', logLevel: 'warning' });
await build({ entryPoints: ['src/main/overleaf/preload.js'], bundle: true,
  outfile: 'dist/overleaf-preload.cjs', platform: 'browser', format: 'cjs',
  external: ['electron'], target: 'chrome148', logLevel: 'warning' });
await build({ entryPoints: ['src/main/browser/catalog-preload.js'], bundle: true,
  outfile: 'dist/catalog-preload.cjs', platform: 'browser', format: 'cjs',
  external: ['electron'], target: 'chrome148', logLevel: 'warning' });
await build({ entryPoints: ['src/renderer/recordings/player.js'], bundle: true,
  outfile: 'dist/recording-player.js', format: 'iife', target: 'chrome148', logLevel: 'warning' });
await copyFile('src/renderer/recordings/player.html', 'dist/recording-player.html');
await copyFile('src/renderer/post-its/post-it.html', 'dist/post-it.html');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
// pdf.js optional assets (fonts for PDFs without embedded fonts, CJK cmaps, JBIG2/JPX decoders).
import { cp } from 'node:fs/promises';
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/${folder}`, { recursive: true, force: true });
}
