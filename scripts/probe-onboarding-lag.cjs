'use strict';

// npm run build && npx electron scripts/probe-onboarding-lag.cjs                         (scans in the scanner process)
// npm run build && ENGELBART_SCANNER=inline npx electron scripts/probe-onboarding-lag.cjs  (scans on the main process, as before)
// Round 3 (2026-10-13): "There is some lag during onboarding, I often see the Mac spinner for like a second between
// screens." The spinner is macOS saying the main process stopped answering. This measures the longest stall of the main
// process's event loop while onboarding's scans run (connect-detect, the recent-projects digest, the tool evidence) over
// this Mac's real Claude Code and Codex sessions, with a throwaway data root (ENGELBART_ROOT_DIR): nothing of the person's
// Engelbart is read or written, and the agents are fakes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-lag-probe-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_ROOT_DIR = path.join(root, 'root');
process.env.ENGELBART_TEST_MODE = 'off';
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300', codex: '0.160.0' });
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
process.env.ENGELBART_PROVIDERS_FAKE = 'anthropic';
process.env.ENGELBART_DISK_ACCESS = 'denied';
fs.mkdirSync(process.env.ENGELBART_ROOT_DIR, { recursive: true });

// ENGELBART_PROBE_FS=1: which synchronous file calls the main process spends its time in, by the caller's file and line.
const blame = new Map();
if (process.env.ENGELBART_PROBE_FS === '1') {
  for (const name of ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'accessSync', 'openSync', 'lstatSync', 'realpathSync']) {
    const original = fs[name];
    fs[name] = function probed(...args) {
      const at = process.hrtime.bigint();
      try { return original.apply(this, args); } finally {
        const ms = Number(process.hrtime.bigint() - at) / 1e6;
        const frame = (new Error().stack.split('\n').slice(2).find((line) => /src\/main/.test(line)) || '?').trim().replace(/^at /, '').replace(/^.*\/src\/main\//, '');
        const key = `${name} ${frame}`;
        const was = blame.get(key) || { ms: 0, n: 0 };
        blame.set(key, { ms: was.ms + ms, n: was.n + 1 });
      }
    };
  }
}
process.on('exit', () => { if (blame.size) for (const [key, value] of [...blame].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)) console.log(`fs ${value.ms.toFixed(0)} ms × ${value.n}  ${key}`); });

require('../src/main/index.cjs');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 600) {
  for (let i = 0; i < tries; i++) { try { const out = await fn(); if (out) return out; } catch { /* not yet */ } await pause(50); }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'the window');
    win.setFocusable(false);
    const wc = win.webContents;
    await until(() => wc.executeJavaScript('!!window.engelbartAPI && !!document.querySelector("[data-onboarding]")', true), 'onboarding');
    // The longest gap between 10 ms ticks of the main process, per phase.
    let last = Date.now();
    let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
    const phase = async (label, work) => { await pause(300); worst = 0; last = Date.now(); const at = Date.now(); await work(); return `${label} ${Date.now() - at} ms (stall ${worst} ms)`; };
    const lines = [];
    // The library opened first, as the app has it open by the time onboarding asks anything.
    lines.push(await phase('library open', () => wc.executeJavaScript('window.engelbartAPI.library()', true)));
    lines.push(await phase('connect-detect', () => wc.executeJavaScript('window.engelbartAPI.connectDetect()', true)));
    lines.push(await phase('recent projects', async () => {
      await wc.executeJavaScript('window.engelbartAPI.importDiscoverProjects({ provider: "anthropic" })', true);
      await until(() => wc.executeJavaScript('window.engelbartAPI.importDiscovery().then((d)=>d.projects.status==="done"||d.projects.status==="failed")', true), 'the projects', 1200);
    }));
    lines.push(await phase('tools', async () => {
      await wc.executeJavaScript('window.engelbartAPI.importDiscoverTools({ provider: "anthropic", browserId: null, keychain: "declined" })', true);
      await until(() => wc.executeJavaScript('window.engelbartAPI.importDiscovery().then((d)=>d.tools.status==="done")', true), 'the tools', 1200);
    }));
    clearInterval(tick);
    console.log(`probe-onboarding-lag (${process.env.ENGELBART_SCANNER === 'inline' ? 'inline' : 'scanner process'}): ${lines.join('; ')}`);
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
