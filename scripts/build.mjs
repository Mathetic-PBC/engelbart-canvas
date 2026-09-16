import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/renderer/index.jsx'],
  bundle: true,
  outdir: 'dist',
  entryNames: 'index',
  assetNames: 'assets/[name]-[hash]',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome148',
  sourcemap: true,
  loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file' },
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  logLevel: 'warning',
});
await copyFile('src/renderer/index.html', 'dist/index.html');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
// pdf.js optional assets (fonts for PDFs without embedded fonts, CJK cmaps, JBIG2/JPX decoders).
import { cp } from 'node:fs/promises';
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${folder}`, `dist/${folder}`, { recursive: true, force: true });
}
