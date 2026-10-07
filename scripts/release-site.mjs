// What a release uploads (2026-09-28): scripts/package-mac.mjs calls writeSite once electron-builder has made the .dmg
// and .zip for both kinds of Mac. release/upload/ gets those, the update feed (latest-mac.yml, which the app and the
// install command read), the install command (install.sh, from scripts/install-mac.sh), SHA256SUMS.txt and a download
// page (index.html). All of it goes into the one folder on the web the build was made for.
//
// Windows (2026-10-07, docs/windows-port-log.md "One-command install"): `npm run upload:win` calls writeWindowsSite with
// the installer and latest.yml CI made (scripts/package-windows.mjs). release/upload-win/ gets those, the install
// command (install.ps1, from scripts/install-windows.ps1), SHA256SUMS-windows.txt and the download page as it is live
// with its Windows section put in. The page is shared, so each platform's release keeps the other's section: the Mac's
// reads the live latest.yml (liveWindows) for it; without one the Mac page is what it always was.
//
// Linux (2026-10-07, docs/windows-port-log.md "Linux"): `npm run upload:linux` calls writeLinuxSite with the AppImage and
// latest-linux.yml CI made (scripts/package-linux.mjs). release/upload-linux/ gets those, install-linux.sh (from
// scripts/install-linux.sh), SHA256SUMS-linux.txt, the live page with its Linux section, and the live install.sh with
// the block that hands Linux to install-linux.sh (scripts/install-mac.sh, between its >>> linux and <<< linux lines),
// so the Mac's command works on Linux too; SHA256SUMS.txt then gets that install.sh's new sum. The Mac release keeps
// the Linux section as it keeps the Windows one (liveLinux).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHES = [
  { arch: 'arm64', label: 'Apple silicon', hint: 'M1 and later' },
  { arch: 'x64', label: 'Intel', hint: 'older Macs' },
];

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const megabytes = (file) => `${Math.round(fs.statSync(file).size / 1024 / 1024)} MB`;
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A feed (latest-mac.yml, latest.yml) → { version, files: [{ url, sha512, size }] }. */
export function parseFeed(text) {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] || null;
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^\s*-\s*url:\s*['"]?([^'"\s]+)/.exec(line))) files.push({ url: m[1] });
    else if (files.length && (m = /^\s+sha512:\s*['"]?([^'"\s]+)/.exec(line))) files.at(-1).sha512 ??= m[1];
    else if (files.length && (m = /^\s+size:\s*(\d+)/.exec(line))) files.at(-1).size ??= Number(m[1]);
  }
  return { version, files };
}

/** The download page's Windows section: the install command, and the installer to download. `windows`: { version,
 *  installer, size } (size in bytes). Marked, so the next Windows release replaces it (withWindows). */
export function windowsSection({ downloads, windows }) {
  const command = `irm ${downloads}install.ps1 | iex`;
  return `
  <!-- windows -->
  <h2 id="windows">On Windows</h2>
  <p>Version ${escape(windows.version)} · for 64-bit Windows 10 and 11. Open PowerShell (Start menu, type PowerShell), paste this line and press Enter.</p>
  <div class="command"><code id="command-windows">${escape(command)}</code><button type="button" id="copy-windows">Copy</button></div>
  <p class="note">It downloads Engelbart, installs it for your Windows account and opens it. Engelbart needs Git for Windows: if it is missing, the command installs it with winget, or says where to get it. Running the command again updates Engelbart; your projects and notes are kept.</p>
  <div class="row">
        <a class="dl" href="${escape(windows.installer)}"><span>Windows installer</span><small>x64 · ${Math.round(windows.size / 1024 / 1024)} MB</small></a>
  </div>
  <p class="note">The installer is not signed yet, so Windows may say it protected your PC: click More info, then Run anyway. The command above avoids this.</p>
  <script>
    document.getElementById('copy-windows').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(document.getElementById('command-windows').textContent);
      event.target.textContent = 'Copied';
      setTimeout(() => { event.target.textContent = 'Copy'; }, 1500);
    });
  </script>
  <!-- /windows -->
`;
}

/** The download page `html` with `section` (windowsSection) in place of its Windows section, or at its end. */
export function withWindows(html, section) {
  return withSection(html, 'windows', section);
}

/** The download page `html` with `section` in place of its section marked `name` (<!-- name --> … <!-- /name -->), or
 *  at the end of the page. */
export function withSection(html, name, section) {
  const marked = new RegExp(`\\n  <!-- ${name} -->\\n[\\s\\S]*?<!-- \\/${name} -->\\n`);
  if (marked.test(html)) return html.replace(marked, () => section);
  if (!html.includes('</main>')) throw new Error(`the download page has no </main> to put the ${name[0].toUpperCase()}${name.slice(1)} section before`);
  return html.replace('</main>', () => `${section}</main>`);
}

/** The download page's Linux section: the install command (the Mac's), and the AppImage. `linux`: { version, appImage,
 *  size } (size in bytes). Marked, so the next Linux release replaces it (withSection). */
export function linuxSection({ downloads, linux }) {
  const command = `curl -fsSL ${downloads}install.sh | bash`;
  return `
  <!-- linux -->
  <h2 id="linux">On Linux</h2>
  <p>Version ${escape(linux.version)} · for 64-bit Intel and AMD PCs (x86_64), such as Ubuntu 22.04 or later. Open a terminal, paste this line (the same as on a Mac) and press Enter.</p>
  <div class="command"><code id="command-linux">${escape(command)}</code><button type="button" id="copy-linux">Copy</button></div>
  <p class="note">It installs Engelbart for your account (in ~/.local/share/engelbart, with an engelbart command and an entry in the app menu) and opens it. Engelbart needs Git: if it is missing, the command says how to install it. On Ubuntu 23.10 and later it offers to add an AppArmor profile for Engelbart (it asks for your password) so Chromium's sandbox stays on. Running the command again updates Engelbart; your projects and notes are kept.</p>
  <div class="row">
        <a class="dl" href="${escape(linux.appImage)}"><span>AppImage</span><small>x86_64 · ${Math.round(linux.size / 1024 / 1024)} MB</small></a>
  </div>
  <p class="note">To run the AppImage itself, make it executable; it needs FUSE (libfuse2), which Ubuntu 22.04 and later leave out. The command above does not.</p>
  <script>
    document.getElementById('copy-linux').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(document.getElementById('command-linux').textContent);
      event.target.textContent = 'Copied';
      setTimeout(() => { event.target.textContent = 'Copy'; }, 1500);
    });
  </script>
  <!-- /linux -->
`;
}

const LINUX_BLOCK = /^# >>> linux[^\n]*\n[\s\S]*?^# <<< linux\n/m;
const DARWIN_CHECK = '[ "$(uname -s)" = Darwin ] || fail "this installer is for macOS."\n';

/** The install command `install` (install.sh as it is live) with the block that hands Linux to install-linux.sh, taken
 *  from `ours` (scripts/install-mac.sh), in place of the one it has or before its macOS check. */
export function withLinuxHandoff(install, ours) {
  const block = LINUX_BLOCK.exec(ours)?.[0];
  if (!block) throw new Error('scripts/install-mac.sh has no >>> linux block');
  if (LINUX_BLOCK.test(install)) return install.replace(LINUX_BLOCK, () => block);
  if (!install.includes(DARWIN_CHECK)) throw new Error('install.sh has no macOS check to put the Linux block before');
  return install.replace(DARWIN_CHECK, () => `${block}${DARWIN_CHECK}`);
}

/** What the live Linux feed at `downloads` offers, for the Mac release's page: { version, appImage, size }, or null. */
export async function liveLinux(downloads, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${downloads}latest-linux.yml?nc=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const { version, files } = parseFeed(await response.text());
    const file = files.find((f) => f.url === `Engelbart-${version}-x86_64.AppImage`);
    return version && file?.size ? { version, appImage: file.url, size: file.size } : null;
  } catch {
    return null;
  }
}

/** What the live Windows feed at `downloads` offers, for the Mac release's page: { version, installer, size }, or null
 *  when there is none (or it cannot be read: the page then has no Windows section, as before). */
export async function liveWindows(downloads, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${downloads}latest.yml?nc=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const { version, files } = parseFeed(await response.text());
    const file = files.find((f) => f.url === `Engelbart-${version}-x64.exe`);
    return version && file?.size ? { version, installer: file.url, size: file.size } : null;
  } catch {
    return null;
  }
}

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

export function writeSite({ root, version, downloads, developerId, windows = null, linux = null }) {
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
  const html = page({ version, downloads, developerId, files });
  const withWin = windows ? withWindows(html, windowsSection({ downloads, windows })) : html;
  fs.writeFileSync(path.join(upload, 'index.html'), linux ? withSection(withWin, 'linux', linuxSection({ downloads, linux })) : withWin);
  const sums = wanted.filter((name) => /\.(dmg|zip)$/.test(name)).concat('install.sh').map((name) => `${sha256(path.join(upload, name))}  ${name}`).join('\n');
  fs.writeFileSync(path.join(upload, 'SHA256SUMS.txt'), `${sums}\n`);
  return upload;
}

/** release/upload-win/ (or `out`) from `from`, the folder with what CI made for `version` (the installer, latest.yml and
 *  the installer's blockmap). `livePage`: the download page as it is live, given its Windows section; without one
 *  there is no index.html (CI's install test needs none). → that folder */
export function writeWindowsSite({ root, from, version, downloads, livePage = null, out = path.join(root, 'release', 'upload-win') }) {
  downloads = downloads.replace(/\/*$/, '/');
  const feed = fs.readFileSync(path.join(from, 'latest.yml'), 'utf8');
  const { version: fed, files } = parseFeed(feed);
  if (fed !== version) throw new Error(`latest.yml is for ${fed}, not ${version}`);
  const installer = `Engelbart-${version}-x64.exe`;
  if (!fs.existsSync(path.join(from, installer))) throw new Error(`${installer} is missing`);
  const listed = files.find((f) => f.url === installer);
  if (!listed?.sha512) throw new Error(`latest.yml does not list ${installer}`);
  const size = fs.statSync(path.join(from, installer)).size;
  if (listed.size !== size) throw new Error(`latest.yml gives ${installer} as ${listed.size} bytes, not ${size}`);
  if (createHash('sha512').update(fs.readFileSync(path.join(from, installer))).digest('base64') !== listed.sha512) throw new Error(`${installer} does not match the sha512 latest.yml gives`);
  const wanted = [installer, ...[`${installer}.blockmap`].filter((name) => fs.existsSync(path.join(from, name))), 'latest.yml'];
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const name of wanted) fs.copyFileSync(path.join(from, name), path.join(out, name));
  fs.writeFileSync(path.join(out, 'install.ps1'), fs.readFileSync(path.join(root, 'scripts', 'install-windows.ps1'), 'utf8').replaceAll('__DOWNLOADS__', downloads));
  if (livePage != null) fs.writeFileSync(path.join(out, 'index.html'), withWindows(livePage, windowsSection({ downloads, windows: { version, installer, size } })));
  fs.writeFileSync(path.join(out, 'SHA256SUMS-windows.txt'), `${[installer, 'install.ps1'].map((name) => `${sha256(path.join(out, name))}  ${name}`).join('\n')}\n`);
  return out;
}

/** release/upload-linux/ (or `out`) from `from`, the folder with what CI made for `version` (the AppImage and
 *  latest-linux.yml). `livePage`, `liveInstall`, `liveSums`: the download page, install.sh and SHA256SUMS.txt as they
 *  are live, given the Linux section, the Linux hand-off and that install.sh's sum. Without `liveInstall`, install.sh is
 *  scripts/install-mac.sh for `downloads` (CI's install test); without the others there is no index.html or
 *  SHA256SUMS.txt. → that folder */
export function writeLinuxSite({ root, from, version, downloads, livePage = null, liveInstall = null, liveSums = null, out = path.join(root, 'release', 'upload-linux') }) {
  downloads = downloads.replace(/\/*$/, '/');
  const { version: fed, files } = parseFeed(fs.readFileSync(path.join(from, 'latest-linux.yml'), 'utf8'));
  if (fed !== version) throw new Error(`latest-linux.yml is for ${fed}, not ${version}`);
  const appImage = `Engelbart-${version}-x86_64.AppImage`;
  if (!fs.existsSync(path.join(from, appImage))) throw new Error(`${appImage} is missing`);
  const listed = files.find((f) => f.url === appImage);
  if (!listed?.sha512) throw new Error(`latest-linux.yml does not list ${appImage}`);
  const size = fs.statSync(path.join(from, appImage)).size;
  if (listed.size !== size) throw new Error(`latest-linux.yml gives ${appImage} as ${listed.size} bytes, not ${size}`);
  if (createHash('sha512').update(fs.readFileSync(path.join(from, appImage))).digest('base64') !== listed.sha512) throw new Error(`${appImage} does not match the sha512 latest-linux.yml gives`);
  const ours = fs.readFileSync(path.join(root, 'scripts', 'install-mac.sh'), 'utf8');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const name of [appImage, 'latest-linux.yml']) fs.copyFileSync(path.join(from, name), path.join(out, name));
  fs.writeFileSync(path.join(out, 'install-linux.sh'), fs.readFileSync(path.join(root, 'scripts', 'install-linux.sh'), 'utf8').replaceAll('__DOWNLOADS__', downloads), { mode: 0o755 });
  fs.writeFileSync(path.join(out, 'install.sh'), liveInstall != null ? withLinuxHandoff(liveInstall, ours.replaceAll('__DOWNLOADS__', downloads)) : ours.replaceAll('__DOWNLOADS__', downloads), { mode: 0o755 });
  if (livePage != null) fs.writeFileSync(path.join(out, 'index.html'), withSection(livePage, 'linux', linuxSection({ downloads, linux: { version, appImage, size } })));
  if (liveSums != null) fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), liveSums.replace(/^[0-9a-f]{64} {2}install\.sh$/m, () => `${sha256(path.join(out, 'install.sh'))}  install.sh`));
  fs.writeFileSync(path.join(out, 'SHA256SUMS-linux.txt'), `${[appImage, 'install-linux.sh'].map((name) => `${sha256(path.join(out, name))}  ${name}`).join('\n')}\n`);
  return out;
}

// node scripts/release-site.mjs linux <from> <version> <downloads> <live page|-> <live install.sh|-> <live SHA256SUMS.txt|-> [<out>]
// (scripts/upload-linux.sh, and CI's install test)
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() && process.argv[2] === 'linux') {
  const [from, version, downloads, pageFile, installFile, sumsFile, out] = process.argv.slice(3);
  const read = (file) => (file && file !== '-' ? fs.readFileSync(file, 'utf8') : null);
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log(writeLinuxSite({ root, from, version, downloads, livePage: read(pageFile), liveInstall: read(installFile), liveSums: read(sumsFile), ...(out ? { out: path.resolve(out) } : {}) }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// node scripts/release-site.mjs windows <from> <version> <downloads> [<live page file>, or - for none] [<out>]
// (scripts/upload-windows.sh, and CI's install test)
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() && process.argv[2] === 'windows') {
  const [from, version, downloads, pageFile, out] = process.argv.slice(3);
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const livePage = pageFile && pageFile !== '-' ? fs.readFileSync(pageFile, 'utf8') : null;
    console.log(writeWindowsSite({ root, from, version, downloads, livePage, ...(out ? { out: path.resolve(out) } : {}) }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
