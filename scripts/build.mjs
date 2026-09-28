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
await copyFile('src/renderer/post-its/post-it.html', 'dist/post-it.html');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
// pdf.js optional assets (fonts for PDFs without embedded fonts, CJK cmaps, JBIG2/JPX decoders).
import { cp } from 'node:fs/promises';
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/${folder}`, { recursive: true, force: true });
}
// A developer build (ENGELBART_DEVELOPER=1; `npm run relaunch` makes one) keeps test mode once packaged; any other
// package, which is what ships, has none (src/main/developer.cjs). Written on every build, so none lingers from before.
import { writeFile } from 'node:fs/promises';
await writeFile('dist/build.json', `${JSON.stringify({ developer: process.env.ENGELBART_DEVELOPER === '1' })}\n`);
