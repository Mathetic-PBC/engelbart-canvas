// What a release uploads (2026-09-28): scripts/package-mac.mjs calls writeSite once electron-builder has made the .dmg
// and .zip for both kinds of Mac. release/upload/ gets those, the update feed (latest-mac.yml, which the app and the
// install command read), the install command (install.sh, from scripts/install-mac.sh), SHA256SUMS.txt and a download
// page (index.html). All of it goes into the one folder on the web the build was made for.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ARCHES = [
  { arch: 'arm64', label: 'Apple silicon', hint: 'M1 and later' },
  { arch: 'x64', label: 'Intel', hint: 'older Macs' },
];

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const megabytes = (file) => `${Math.round(fs.statSync(file).size / 1024 / 1024)} MB`;
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function page({ version, downloads, developerId, files }) {
  const command = `curl -fsSL ${downloads}install.sh | bash`;
  const links = ARCHES.map(({ arch, label, hint }) => `<a class="dl" href="${escape(files[arch].dmg)}"><span>${label}</span><small>${hint} · ${escape(files[arch].size)}</small></a>`).join('\n        ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Engelbart</title>
<style>
  :root { --ink: #171717; --mut: #4d4d4d; --fnt: #8f8f8f; --bd: #eaeaea; --tint: #fafafa; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 14.5px/1.7 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 600px; margin: 0 auto; padding: 72px 24px 96px; }
  .mark { font: 500 17px/1 system-ui, -apple-system, sans-serif; letter-spacing: -0.2px; }
  .meta { margin: 10px 0 48px; color: var(--fnt); font-size: 12.5px; }
  h2 { margin: 40px 0 8px; font: 500 19px/1.3 system-ui, -apple-system, sans-serif; letter-spacing: -0.2px; }
  p { margin: 0 0 12px; color: var(--mut); }
  .command { display: flex; align-items: center; gap: 12px; margin: 16px 0 12px; padding: 12px 12px 12px 16px; background: var(--tint); border: 1px solid var(--bd); border-radius: 8px; }
  .command code { flex: 1; min-width: 0; overflow-wrap: anywhere; font: 12.5px/1.6 'Source Code Pro', ui-monospace, SFMono-Regular, Menlo, monospace; }
  button { flex: none; padding: 7px 12px; border: 1px solid var(--bd); border-radius: 8px; background: #fff; color: var(--ink); font: 500 13px/1 system-ui, -apple-system, sans-serif; cursor: pointer; }
  button:hover { border-color: #c9c9c9; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 12px; }
  .dl { flex: 1 1 200px; display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--bd); border-radius: 8px; color: var(--ink); text-decoration: none; }
  .dl:hover { border-color: #c9c9c9; }
  .dl span { font-weight: 500; }
  .dl small { color: var(--fnt); font-size: 12px; }
  .note { font-size: 13px; color: var(--fnt); }
  a { color: #0070f3; }
</style>
</head>
<body>
<main>
  <div class="mark">Engelbart</div>
  <div class="meta">Version ${escape(version)} · for Macs with macOS 13 or later</div>

  <h2>Install</h2>
  <p>Open Terminal (Applications › Utilities › Terminal), paste this line and press Return.</p>
  <div class="command"><code id="command">${escape(command)}</code><button type="button" id="copy">Copy</button></div>
  <p class="note">It downloads the version for your Mac, puts Engelbart in Applications and opens it. Running it again updates Engelbart; your projects and notes are kept.</p>

  <h2>Or download the app</h2>
  <div class="row">
        ${links}
  </div>
  <p class="note">Not sure which Mac you have? Apple menu › About This Mac: it lists a Chip (Apple silicon) or a Processor (Intel). Open the download and drag Engelbart into Applications.${developerId ? '' : ' The first time you open it, macOS says it could not verify Engelbart: click Done, then open System Settings › Privacy &amp; Security, scroll down, click Open Anyway and enter your password. The command above avoids this.'}</p>

  <h2>When it opens</h2>
  <p>Engelbart checks for Git, Claude Code and Codex. Git comes with Engelbart. If neither Claude Code nor Codex is on your Mac, Claude Code installs by itself; sign in with your Claude account when it asks (it opens your browser). Codex is one click away, with a ChatGPT sign-in.</p>
</main>
<script>
  document.getElementById('copy').addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(document.getElementById('command').textContent);
    event.target.textContent = 'Copied';
    setTimeout(() => { event.target.textContent = 'Copy'; }, 1500);
  });
</script>
</body>
</html>
`;
}

export function writeSite({ root, version, downloads, developerId }) {
  const release = path.join(root, 'release');
  const upload = path.join(release, 'upload');
  const feed = fs.readFileSync(path.join(release, 'latest-mac.yml'), 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(feed)) throw new Error(`release/latest-mac.yml is not for ${version}`);
  const files = {};
  const wanted = ['latest-mac.yml'];
  for (const { arch } of ARCHES) {
    const dmg = `Engelbart-${version}-${arch}.dmg`;
    const zip = `Engelbart-${version}-${arch}.zip`;
    for (const name of [dmg, zip]) if (!fs.existsSync(path.join(release, name))) throw new Error(`release/${name} is missing`);
    if (!feed.includes(`url: ${zip}`)) throw new Error(`release/latest-mac.yml does not list ${zip}`);
    files[arch] = { dmg, zip, size: megabytes(path.join(release, dmg)) };
    wanted.push(dmg, zip, ...[`${dmg}.blockmap`, `${zip}.blockmap`].filter((name) => fs.existsSync(path.join(release, name))));
  }
  fs.rmSync(upload, { recursive: true, force: true });
  fs.mkdirSync(upload, { recursive: true });
  for (const name of wanted) fs.copyFileSync(path.join(release, name), path.join(upload, name));
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-mac.sh'), 'utf8').replaceAll('__DOWNLOADS__', downloads);
  fs.writeFileSync(path.join(upload, 'install.sh'), installer, { mode: 0o755 });
  fs.writeFileSync(path.join(upload, 'index.html'), page({ version, downloads, developerId, files }));
  const sums = wanted.filter((name) => /\.(dmg|zip)$/.test(name)).concat('install.sh').map((name) => `${sha256(path.join(upload, name))}  ${name}`).join('\n');
  fs.writeFileSync(path.join(upload, 'SHA256SUMS.txt'), `${sums}\n`);
  return upload;
}
