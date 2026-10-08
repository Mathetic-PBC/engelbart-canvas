'use strict';

// npm run build && npx electron scripts/smoke-connect-tools.cjs
// "signing into claude code and/or codex must be done before this step": the real app, hidden, in test mode on disposable
// data, on a pretend Mac (ENGELBART_TOOLS_FAKE) where Claude Code is installed but signed out and Codex is missing. The
// tools screen comes before Connect your library, each agent's row with its own Sign in or Install; Continue waits; Claude
// Code's Sign in (the fake's, which ends by itself) makes it ready; Continue goes on to Connect, "3 of 5".
// ENGELBART_CONNECT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-tools-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300 signed-out', codex: 'missing' });
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: true });
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => {
  const { x, y } = await until(() => spot(wc, selector), selector);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const step = (wc) => js(wc, 'document.querySelector("[data-onboarding]") && document.querySelector("[data-onboarding]").dataset.step');
const SHOTS = process.env.ENGELBART_CONNECT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'tools', 'the tools screen, before Connect');
    await until(() => js(wc, '!!document.querySelector("[data-tool-row=claude] [data-tool-action=sign-in]")'), 'Claude Code\'s Sign in');
    assert.equal(await js(wc, '!!document.querySelector("[data-tool-row=codex] [data-tool-action=install]")'), true, 'Codex\'s Install');
    assert.equal(await js(wc, 'document.querySelector("[data-onboarding-continue] button").disabled'), true, 'Continue waits for an agent');
    assert.equal(await js(wc, 'document.querySelector("[data-onboarding-step-of]").textContent'), '2 of 5', 'welcome, tools, connect, create, context');
    await shot(wc, 'tools-1-signed-out');
    await press(wc, '[data-tool-row=claude] [data-tool-action=sign-in] button');
    await until(() => js(wc, '!document.querySelector("[data-onboarding-continue] button").disabled'), 'Claude Code signed in: Continue', 400);
    await shot(wc, 'tools-2-ready');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'connect', 'Connect your library next');
    await until(() => js(wc, '!!document.querySelector("[data-connect-library=choose]")'), 'its choose screen');
    assert.equal(await js(wc, 'document.querySelector("[data-onboarding-step-of]").textContent'), '3 of 5');
    assert.equal(await js(wc, '!!document.querySelector("[data-connect-agent-setup]")'), false, 'an agent is ready: nothing to sign in to here');
    console.log(`Connect tools smoke passed. Data: ${root}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    const wc = BrowserWindow.getAllWindows()[0] && BrowserWindow.getAllWindows()[0].webContents;
    if (wc) { console.error(await js(wc, 'document.body.innerText').catch(() => '')); await shot(wc, 'tools-failed').catch(() => {}); }
    app.exit(1);
  }
});
