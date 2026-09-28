'use strict';
// npm run build && npx electron scripts/smoke-connections.cjs
// Real sidebar/auth IPC, a disposable library, and loopback GitHub. No real account or sandbox.
const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connections-ui-'));
const opened = [];
const authorizations = [];
shell.openExternal = async url => { opened.push(url); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async (wc, code) => {
  try { return await wc.executeJavaScript(code, true); }
  catch (error) { console.error('Fixture expression:', code); throw error; }
};
const click = async (wc, selector) => {
  await until(() => js(wc, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});return !!element&&!element.disabled})()`), `enabled control: ${selector}`);
  return js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
};
async function until(check, label) {
  for (let n = 0; n < 150; n++) { const value = await check(); if (value) return value; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
let origin, challenge;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/github/start') {
    challenge = url.searchParams.get('challenge'); authorizations.push(url.href);
    res.writeHead(302, { location: `/fixture-signin?state=${url.searchParams.get('state')}` }); res.end(); return;
  }
  if (url.pathname === '/fixture-signin') {
    const start = authorizations.find(value => new URL(value).searchParams.get('state') === url.searchParams.get('state'));
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>GitHub sign-in fixture</title><style>body{font:14px system-ui;padding:28px;color:#171717}input{display:block;margin:12px 0;padding:8px}a{display:inline-block;margin:10px 12px 0 0}</style><h2>Sign in to GitHub</h2><p>Local test page — no real credentials.</p><input id="username" placeholder="Username"><a id="authorize" href="${callbackFor(start, { code: 'fixture_code', ticket: 'fixture_ticket' })}">Authorize Engelbart</a><a id="deny" href="${callbackFor(start, { error: 'access_denied' })}">Cancel</a>`); return;
  }
  if (url.pathname.endsWith('/installations/new')) { res.setHeader('content-type', 'text/html'); res.end('<title>Repository access</title><h2>Choose repositories</h2>'); return; }
  if (url.pathname === '/api/github/token') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(createHash('sha256').update(JSON.parse(raw).verifier).digest('base64url'), challenge);
    return json({ access_token: 'fixture_access', refresh_token: 'fixture_refresh', expires_in: 28800 });
  }
  if (url.pathname === '/user') return json({ login: 'researcher', id: 42 });
  if (url.pathname === '/user/installations') return json({ installations: [{ id: 1, account: { login: 'researcher' } }] });
  if (url.pathname === '/user/installations/1/repositories') return json({ repositories: [{ id: 2, full_name: 'researcher/example', pushed_at: '2026-09-27', private: true }] });
  res.statusCode = 404; res.end();
});
const callbackFor = (url, values) => {
  const authorize = new URL(url);
  const callback = new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/oauth/github/callback`);
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), ...values });
  return callback;
};

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_GITHUB_BROKER: origin, ENGELBART_GITHUB_WEB: origin });
  require('../src/main/index.cjs');
  await app.whenReady();
  let win;
  try {
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive();
    // A completed test sign-in must not steal focus from the user's real app.
    win.show = () => {}; win.focus = () => {};
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Connected research',directory:${JSON.stringify(root)}})`);
    const pid = made.project.id;
    const second = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(pid)},{name:'Second workspace',parentId:${JSON.stringify(made.workspaceId)}})`);
    await js(wc, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)}, {kind:'workspace',workspaceId:${JSON.stringify(second.id)}}, '# Second workspace')`);
    await js(wc, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)}, {kind:'workspace',workspaceId:${JSON.stringify(made.workspaceId)}}, ${JSON.stringify('# Connected research\n\nKeep your sources close to your work.')})`);
    for (let n = 1; n <= 20; n++) await js(wc, `window.engelbartAPI.createNote(${JSON.stringify(pid)},{name:'Research note ${n}',workspaceId:${JSON.stringify(made.workspaceId)}})`);
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-rail-connections] button")').catch(() => false), 'Connections entry');
    const entry = '[data-rail-connections] button';
    const action = name => `[data-connection-action="${name}"]`;
    const state = () => js(wc, 'document.querySelector("[data-connection] [role=status]")?.textContent');
    const shot = async name => fs.writeFileSync(path.join(root, `${name}.png`), (await win.capturePage()).toPNG());
    const switchWorkspace = async (id, name) => {
      await click(wc, '[data-switch-workspace]');
      await js(wc, `(()=>{const input=document.querySelector('[data-workspace-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await click(wc, `[data-workspace-item="${id}"]`);
    };
    const signIn = () => until(() => {
      const state = authorizations.length && new URL(authorizations.at(-1)).searchParams.get('state');
      return state && win.contentView.children.find(view => view.webContents?.getURL().includes(`/fixture-signin?state=${state}`))?.webContents;
    }, 'sign-in page in Stage');
    const geometry = () => js(wc, `(()=>{const rect=selector=>document.querySelector(selector)?.getBoundingClientRect().toJSON();return {
      stageWidth:rect('[data-stage]').width, entry:rect('[data-rail-connections] button'), bar:rect('[data-rail-bar]'),
      trash:rect('[data-trash]'), note:rect('[data-add-post-it]'), header:rect('[data-workspace-header]'),
      trashArt:rect('[data-trash] img'), noteArt:rect('[data-add-post-it] img'),
      sidebar:rect('aside[aria-label="Sidebar"]'), search:rect('[data-rail-search]')
    }})()`);
    const checkFooter = layout => {
      assert.ok(layout.bar.height <= 64, 'footer stays one compact row');
      assert.ok(layout.note.left >= layout.bar.left && layout.entry.right <= layout.bar.right, 'controls fit inside the footer');
      assert.ok(layout.note.right <= layout.trash.left && layout.trash.right <= layout.entry.left, 'note and trash precede Connections without overlap');
      for (const name of ['entry', 'trash', 'note']) assert.ok(Math.abs(layout[name].top + layout[name].height / 2 - layout.trash.top - layout.trash.height / 2) <= 1, 'controls align vertically');
      for (const name of ['trash', 'note']) assert.equal(layout[name].width, layout.sidebar.width < 260 ? 40 : 48, 'illustrations retain matching targets and fit a narrow sidebar');
      for (const name of ['trash', 'note']) assert.equal(layout[`${name}Art`].width, layout.sidebar.width < 260 ? 36 : 40, 'larger illustrations fit inside the existing click targets');
    };
    const before = await geometry();
    const originalIds = await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    checkFooter(before);
    assert.equal(before.header.top - before.sidebar.top, 10, 'workspace card keeps the current compact top inset');
    assert.ok(before.header.bottom < before.search.top, 'search stays below the workspace selector');
    assert.equal(await js(wc, '!!document.querySelector("[data-next-workspace]")'), false, 'no standalone workspace shortcut');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-rail-section-toggle]")].every(button=>button.querySelectorAll("svg").length===2)'), true, 'every section has a leading chevron and kind icon');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-rail-section-toggle]")].every(e=>e.getAttribute("aria-expanded")==="false")'), true, 'all groups start collapsed');
    assert.equal(await js(wc, '!!document.querySelector("[data-rail-subsection]")'), false);
    await shot('sidebar');
    await switchWorkspace(second.id, 'Second workspace');
    await until(() => js(wc, 'document.querySelector("[data-workspace-name]")?.textContent==="Second workspace"'), 'sub-workspace opens its existing workspace');
    await switchWorkspace(made.workspaceId, 'Getting started');
    await until(() => js(wc, 'document.querySelector("[data-workspace-name]")?.textContent==="Getting started"'), 'return to initial workspace');
    await js(wc, `[...document.querySelectorAll('[data-rail-section-toggle][aria-expanded="true"]')].forEach(button=>button.click())`);
    await pause(160);
    await shot('sidebar-sections');
    await click(wc, '[data-rail-section-toggle="Documents"]');
    await click(wc, entry);
    await until(async () => (await state()) === 'Not connected', 'signed-out status');
    assert.equal(opened.length, 0, 'opening Connections never starts sign-in');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-connection]")].map(e=>e.dataset.connection)'), ['github', 'google-docs', 'overleaf', 'zotero']);
    assert.equal(await js(wc, 'document.querySelector("[data-zotero-action=connect]").disabled'), false, 'Zotero connects through Stage');
    assert.equal(await js(wc, 'document.querySelector("[data-google-action=connect]").disabled'), false, 'Google connects through Stage without app registration');
    assert.equal(authorizations.length, 0, 'opening Connections never starts authentication');
    assert.equal(opened.length, 0, 'opening Connections never opens an external page');
    assert.equal((await geometry()).stageWidth, before.stageWidth, 'panel does not resize Stage');
    await shot('disconnected');
    await js(wc, `document.querySelector('aside[aria-label="Sidebar"]').firstElementChild.scrollTop=10000`);
    assert.equal((await geometry()).entry.top, before.entry.top, 'entry stays fixed while materials scroll');
    await js(wc, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until(() => js(wc, '!document.querySelector("[data-connections-panel]")'), 'Escape closes panel');
    assert.equal(await js(wc, 'document.activeElement===document.querySelector("[data-rail-connections] button")'), true, 'focus returns to entry');
    await click(wc, entry);
    await until(() => js(wc, '!!document.querySelector("[data-connections-panel]")'), 'reopened panel');
    await js(wc, `document.querySelector('[data-editor]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
    await until(() => js(wc, '!document.querySelector("[data-connections-panel]")'), 'outside click dismisses');
    await click(wc, entry);
    await until(async () => (await state()) === 'Not connected', 'ready to connect');
    await click(wc, '[data-right-mode="terminal"]');
    await click(wc, action('connect'));
    await until(async () => (await state()) === 'Connecting…', 'pending sign-in');
    const first = await signIn();
    await until(() => js(wc, 'document.querySelector("[data-stage]").style.display!=="none"'), 'sign-in brings Stage forward');
    const firstView = win.contentView.children.find(view => view.webContents === first);
    await until(() => firstView.getVisible() && firstView.getBounds().width > 200 && firstView.getBounds().height > 200, 'native sign-in view is visible in Stage');
    assert.equal(opened.length, 0, 'sign-in never opens the personal browser');
    assert.equal(await js(first, 'typeof window.engelbartAPI'), 'undefined', 'remote page has no app bridge');
    await until(() => js(first, '!!document.querySelector("#username")'), 'sign-in form');
    await js(first, 'document.querySelector("#username").value="fixture-user"');
    fs.writeFileSync(path.join(root, 'stage-signin-page.png'), (await first.capturePage()).toPNG());
    const firstTabCount = await js(wc, 'document.querySelectorAll("[data-stage-tab]").length');
    await shot('pending');
    await click(wc, entry); await click(wc, entry);
    await until(async () => (await state()) === 'Connecting…', 'pending survives panel dismissal');
    await click(wc, '[data-right-mode="terminal"]');
    await click(wc, action('reopen'));
    await until(() => js(wc, 'document.querySelector("[data-stage]").style.display!=="none"'), 'reopen shows Stage');
    assert.equal(authorizations.length, 1, 'reopen does not restart authorization after redirects');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-stage-tab]").length'), firstTabCount, 'reopen does not duplicate the tab');
    assert.equal(await js(first, 'document.querySelector("#username").value'), 'fixture-user', 'reopen preserves typed input');
    await click(wc, action('cancel'));
    await until(async () => (await state()) === 'Not connected', 'cancel sign-in');
    await click(wc, action('connect'));
    await until(() => authorizations.length === 2, 'new sign-in');
    await click(await signIn(), '#deny');
    await until(() => js(wc, 'document.querySelector("[data-connections-panel] [role=alert]")?.textContent.includes("cancelled")'), 'auth failure shown');
    assert.equal(await js(wc, `document.querySelector('${action('connect')}').textContent`), 'Reconnect');
    await shot('auth-error');
    await click(wc, action('connect'));
    await until(() => authorizations.length === 3, 'reconnect');
    const allowed = await signIn();
    await click(allowed, '#authorize');
    await until(async () => (await state()) === 'Connected · @researcher', 'connected account');
    await until(() => js(allowed, 'document.body.textContent.includes("GitHub connected")').catch(() => false), 'loopback callback rendered in Stage');
    const dots = await js(wc, `(()=>{
      const button=document.querySelector('[data-github-actions]');
      const row=button.closest('[data-connection]').firstElementChild;
      const rect=element=>element.getBoundingClientRect();
      const middle=element=>{const r=rect(element);return r.top+r.height/2};
      return {count:button.querySelectorAll('circle').length,
        rowOffset:middle(button)-middle(row),
        dotOffsets:[...button.querySelectorAll('circle')].map(dot=>middle(dot)-middle(button))};
    })()`);
    assert.equal(dots.count, 3, 'connection options use three vector dots');
    assert.ok(Math.abs(dots.rowOffset) < 0.1, 'options button is vertically centered in its row');
    assert.ok(dots.dotOffsets.every(offset => Math.abs(offset) < 0.1), 'visible dots are vertically centered inside the button');
    await shot('connected');
    assert.equal(await js(wc, '!!document.querySelector("[data-connection-action=disconnect], [data-connection-action=manage], [data-connection-action=refresh]")'), false, 'connected row keeps actions out of the main panel');
    await click(wc, '[data-github-actions]');
    await until(() => js(wc, 'document.activeElement?.dataset.connectionAction === "manage"'), 'options menu focuses repository access');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-github-actions-menu] button")].map(button=>button.textContent)'), ['Repository access', 'Refresh repositories', 'Disconnect']);
    await shot('github-options');
    await js(wc, 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    assert.equal(await js(wc, 'document.activeElement.dataset.connectionAction'), 'refresh');
    await js(wc, 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js(wc, '!document.querySelector("[data-github-actions-menu]")'), 'Escape closes only options');
    assert.ok(await js(wc, '!!document.querySelector("[data-connections-panel]") && document.activeElement.matches("[data-github-actions]")'), 'panel stays open and options trigger regains focus');
    await click(wc, '[data-github-actions]');
    await js(wc, 'document.querySelector("[data-connections-panel]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await until(() => js(wc, '!document.querySelector("[data-github-actions-menu]")'), 'click elsewhere in panel dismisses options');
    await click(wc, '[data-github-actions]');
    await click(wc, action('refresh'));
    await until(() => js(wc, 'document.querySelector("[data-connection-notice]")?.textContent === "Repositories refreshed."'), 'refresh remains available in options');
    await click(wc, '[data-github-actions]');
    await click(wc, action('manage'));
    await until(() => win.contentView.children.some(view => view.webContents?.getURL().endsWith('/installations/new')), 'repository-access page opens in Stage');
    // The original repository picker shares this account; no re-authentication or import.
    await click(wc, '[data-rail-add] > button');
    await until(() => js(wc, '!!document.querySelector("[data-add-github]")'), 'Add context menu');
    await until(() => js(wc, '!document.querySelector("[data-connections-panel]")'), 'menus do not overlap');
    await click(wc, '[data-add-github]');
    await until(() => js(wc, '!!document.querySelector("[data-github-repo]")'), 'original picker uses connected account');
    const authorizedOpens = authorizations.length;
    await click(wc, entry);
    await until(async () => (await state()) === 'Connected · @researcher', 'Connections replaces picker');
    assert.equal(await js(wc, '!!document.querySelector("[data-github-pane]")'), false);
    assert.equal(authorizations.length, authorizedOpens, 'same account is reused');
    await click(wc, '[aria-label="Close connections"]');
    await js(wc, `document.querySelector('aside[aria-label="Sidebar"]').firstElementChild.scrollTop=0`);
    await switchWorkspace(second.id, 'Second workspace');
    await until(() => js(wc, 'document.querySelector("[data-workspace-name]")?.textContent==="Second workspace"'), 'second workspace');
    await click(wc, entry);
    await until(async () => (await state()) === 'Connected · @researcher', 'account is independent of workspace');
    win.setSize(1080, 620);
    await pause(150);
    assert.equal(await js(wc, `(()=>{const r=document.querySelector('[data-connections-panel]').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`), true, 'popover stays in viewport');
    await shot('compact');
    await click(wc, '[data-github-actions]');
    await click(wc, action('disconnect'));
    await until(async () => (await state()) === 'Not connected', 'disconnect');
    await click(wc, '[aria-label="Close connections"]');
    const divider = await js(wc, `(()=>{const r=document.querySelector('[aria-label="Resize sidebar"]').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y+r.height/2)}})()`);
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...divider });
    wc.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: 220, y: divider.y });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 220, y: divider.y });
    await until(() => js(wc, 'document.querySelector(\'aside[aria-label="Sidebar"]\').getBoundingClientRect().width===220'), 'narrowest supported sidebar');
    checkFooter(await geometry());
    assert.equal(await js(wc, `(()=>{const label=document.querySelector('[data-rail-connections] button span'),range=document.createRange();range.selectNodeContents(label);return range.getBoundingClientRect().width<=label.getBoundingClientRect().width+0.1})()`), true, 'Connections label remains readable at 220px');
    await shot('narrow-sidebar');
    await click(wc, '[data-trash]');
    await until(() => js(wc, '!!document.querySelector("[data-trash-panel]")'), 'compact trash control opens panel');
    await click(wc, '[data-trash]');
    await until(() => js(wc, '!document.querySelector("[data-trash-panel]")'), 'trash panel dismisses');
    await click(wc, entry);
    await until(() => js(wc, '!!document.querySelector("[data-connections-panel]")'), 'Connections remains accessible at narrow width');
    await click(wc, '[aria-label="Close connections"]');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), originalIds, 'account controls do not import/remove materials');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.sandboxRuns()'), [], 'account controls do not create sandboxes');
    assert.deepEqual(opened, [], 'no sign-in or account-management page opens in the personal browser');
    // The smaller illustration is still a working native post-it drop target, not just a visual control.
    const cards = () => win.contentView.children.filter(view => view.webContents?.getURL() === 'engelbart://app/post-it.html');
    await click(wc, '[data-add-post-it]');
    const card = await until(() => cards()[0], 'compact note control creates native post-it');
    card.webContents.setBackgroundThrottling(false);
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor]")'), 'post-it editor');
    const cardId = await js(card.webContents, 'window.postItAPI.ready().then(card=>card.id)');
    const can = (await geometry()).trash;
    const destination = { x: can.x + can.width / 2, y: can.y + can.height / 2 };
    const vp = win.getContentBounds(), firstBounds = card.getBounds(), grip = { x: 130, y: 6 };
    const from = { x: firstBounds.x + grip.x, y: firstBounds.y + grip.y };
    card.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...grip, globalX: vp.x + from.x, globalY: vp.y + from.y });
    for (let step = 1; step <= 16; step++) {
      const bounds = card.getBounds();
      const point = { x: from.x + (destination.x - from.x) * step / 16, y: from.y + (destination.y - from.y) * step / 16 };
      card.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y), globalX: Math.round(vp.x + point.x), globalY: Math.round(vp.y + point.y) });
      await pause(25);
    }
    await until(() => js(wc, 'document.querySelector("[data-trash]").dataset.trashOver==="1"'), 'small trash target responds to dragged post-it');
    const lastBounds = card.getBounds();
    card.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(destination.x - lastBounds.x), y: Math.round(destination.y - lastBounds.y), globalX: Math.round(vp.x + destination.x), globalY: Math.round(vp.y + destination.y) });
    await until(() => !cards().length, 'post-it dropped into compact trash');
    await click(wc, '[data-trash]');
    await click(wc, `[data-restore-post-it="${cardId}"]`);
    await until(() => cards().length === 1, 'trashed post-it remains restorable');
    await js(wc, 'window.terminalAPI.bootstrap().then(state=>Promise.all(state.sessions.map(session=>window.terminalAPI.closeSession(session.id))))');
    console.log(JSON.stringify({ ok: true, root, checks: ['current compact top inset', 'icon-led section headers', 'sub-workspace navigation through the workspace switcher', 'workspace search', 'single aligned fixed footer', 'note before trash; smaller art with unchanged click targets', '220px sidebar without clipping', 'compact trash control', 'create, drag-to-trash and restore native post-it', 'no layout shift', 'GitHub and Stage-based Google Docs, Overleaf, and Zotero connections', 'Escape/focus/outside click', 'no automatic sign-in', 'connect/cancel/reopen/reconnect in Stage', 'redirected sign-in tab reused without losing input', 'real PKCE callback through Stage', 'manage access in Stage', 'shared repository-picker account', 'workspace switching', 'viewport placement', 'disconnect', 'no external browser, imports or sandbox runs'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
