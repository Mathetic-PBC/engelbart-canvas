// Import your context as built, as one HTML file (2026-10-13, the "Onboarding" workspace: "output a similar HTML as this
// w same like edit features and way to see popups and stuff but with the exact UI you implement"):
// src/renderer/import/standalone.jsx (the app's ImportFlow and ImportStatus, a mock of main, the mockup's controls)
// bundled with every picture inlined, into design/onboarding-implemented/Onboarding.html.
//
//   node scripts/build-import-mockup.mjs

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const out = await build({
  entryPoints: ['src/renderer/import/standalone.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  minify: true,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.html': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Engelbart · Import your context (implemented)</title>
<!-- Built by scripts/build-import-mockup.mjs from the app's own components (src/renderer/import). Sample data only: no
     account, permission, file or agent is touched. -->
</head>
<body>
<div id="root"></div>
<script id="saved-design" type="application/json">{}</script>
<script>${js}</script>
</body>
</html>
`;
await mkdir('design/onboarding-implemented', { recursive: true });
await writeFile('design/onboarding-implemented/Onboarding.html', html);
console.log(`design/onboarding-implemented/Onboarding.html: ${(html.length / 1024).toFixed(0)} KB`);
