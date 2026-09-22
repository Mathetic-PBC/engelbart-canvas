'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openNotesDb } = require('../store/db.cjs');
const { findProject } = require('../store/projects.cjs');
const { assertTrustedRenderer, parseExternalUrl } = require('../ipc-validation.cjs');
const { cardBounds, layoutFromBounds, inTrash } = require('./geometry.cjs');

const CARD_URL = 'engelbart://app/post-it.html';

// Native siblings of the browser, each with only its own card's IPC capability.
function createPostItViews({ electron, getWindow, getContext, send }) {
  const { WebContentsView, clipboard, shell } = electron;
  const entries = new Map();
  let projectId = null, database = null, suspended = false, gesture = null;
  let operations = Promise.resolve();
  const exclusive = (work) => {
    const result = operations.then(work);
    operations = result.catch(() => {});
    return result;
  };
  const windowNow = () => { const win = getWindow(); return win && !win.isDestroyed() ? win : null; };
  const zoom = () => windowNow()?.webContents.getZoomFactor() || 1;
  const viewport = () => windowNow()?.getContentBounds() || { x: 0, y: 0, width: 1200, height: 800 };
  const report = (error) => send('post-its:error', String(error.message || error));

  function save(entry) {
    const row = { ...entry.row };
    const saving = entry.pending.catch(() => {}).then(() => entry.db.update(row.id, row));
    entry.pending = saving;
    saving.then(() => { entry.error = null; }, (error) => { entry.error = error; report(error); });
    return saving;
  }

  async function flush() {
    await Promise.all([...entries.values()].map(async (entry) => {
      if (entry.ready && !entry.crashed && !entry.view.webContents.isDestroyed()) await entry.view.webContents.executeJavaScript('window.postItAPI.flush()');
      await entry.pending;
    }));
  }

  function raise() {
    const win = windowNow();
    if (!win) return;
    for (const entry of [...entries.values()].sort((a, b) => a.row.z - b.row.z)) win.contentView.addChildView(entry.view);
  }

  function layout() {
    for (const entry of entries.values()) {
      if (gesture?.entry === entry) continue;
      entry.view.webContents.setZoomFactor(zoom());
      entry.view.setBounds(cardBounds(entry.row, viewport(), zoom()));
    }
  }

  function focus(entry) {
    entry.row.z = Math.max(Date.now(), ...[...entries.values()].map((e) => e.row.z + 1));
    raise();
    void save(entry).catch(() => {});
  }

  function attach(row, fresh = false) {
    const win = windowNow();
    if (!win) return;
    const view = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, '../../post-it-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
    } });
    const entry = { row, view, db: database, pending: Promise.resolve(), fresh, error: null };
    entries.set(row.id, entry);
    view.setBackgroundColor('#00000000');
    view.setBounds(cardBounds(row, viewport(), zoom()));
    view.setVisible(false);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setZoomFactor(zoom());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.on('will-redirect', (event) => event.preventDefault());
    wc.on('focus', () => focus(entry));
    wc.on('render-process-gone', () => { entry.crashed = true; cancelGesture(); report(new Error('A post-it stopped responding. Reopen the project to restore it.')); });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        cancelGesture();
        windowNow()?.webContents.focus();
        event.preventDefault();
      }
    });
    wc.loadURL(CARD_URL).catch(report);
  }

  function detach(entry) {
    entries.delete(entry.row.id);
    if (gesture?.entry === entry) cancelGesture();
    windowNow()?.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  function activate(id) {
    return exclusive(async () => {
      if (id === projectId) return;
      await flush();
      cancelGesture();
      for (const entry of [...entries.values()]) detach(entry);
      projectId = null; database = null;
      if (id == null) return;
      const ctx = await getContext();
      const project = findProject(ctx, id);
      database = (await openNotesDb(project.dir)).postIts;
      const rows = await database.list();
      projectId = id;
      for (const row of rows) attach(row);
      raise();
    });
  }

  function create(id) {
    return exclusive(async () => {
      if (projectId !== id || !database) throw new Error('Open this project before adding a post-it');
      const offset = entries.size % 8;
      const row = await database.create({ id: randomUUID(), text: '', nx: .22 + offset * .045, ny: .16 + offset * .045, width: 300, height: 240, z: Date.now() });
      attach(row, true);
      raise();
      return row.id;
    });
  }

  function setSuspended(value) {
    if (typeof value !== 'boolean') throw new TypeError('Suspended must be boolean');
    suspended = value;
    if (suspended) cancelGesture();
    for (const entry of entries.values()) entry.view.setVisible(!suspended && !!entry.ready);
    if (!suspended) { layout(); raise(); }
  }

  function forEvent(event) {
    assertTrustedRenderer(event, CARD_URL);
    const entry = [...entries.values()].find((e) => e.view.webContents === event.sender);
    if (!entry) throw new Error('IPC rejected: unknown post-it');
    return entry;
  }

  function ready(entry) {
    entry.ready = true;
    entry.view.setVisible(!suspended);
    if (entry.fresh && !suspended) entry.view.webContents.focus();
    return { id: entry.row.id, text: entry.row.text, fresh: entry.fresh };
  }

  function edit(entry, text) {
    if (typeof text !== 'string' || text.length > 400000) throw new TypeError('Post-it text must be at most 400000 characters');
    entry.row.text = text;
    return save(entry).then(() => true);
  }

  async function remove(entry) {
    await entry.pending.catch(() => {});
    await entry.db.remove(entry.row.id);
    const focused = entry.view.webContents.isFocused();
    detach(entry);
    if (focused) windowNow()?.webContents.focus();
    return true;
  }

  function cancelGesture() {
    if (!gesture) return;
    const entry = gesture.entry;
    gesture = null;
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.setBounds(cardBounds(entry.row, viewport(), zoom()));
      entry.view.webContents.send('post-it:gesture-cancelled');
    }
    send('post-its:drag', { active: false, over: false });
  }

  function move(entry, input) {
    if (!input || !['begin', 'move', 'end', 'cancel'].includes(input.phase)) throw new TypeError('Invalid post-it gesture');
    if (input.phase === 'cancel') { if (gesture?.entry === entry) cancelGesture(); return; }
    if (![input.x, input.y].every((n) => Number.isFinite(n) && Math.abs(n) < 100000)) throw new TypeError('Invalid pointer coordinates');
    if (input.phase === 'begin') {
      if (suspended || !['drag', 'resize'].includes(input.kind)) return;
      cancelGesture();
      focus(entry);
      gesture = { entry, kind: input.kind, x: input.x, y: input.y, bounds: entry.view.getBounds(), moved: false };
      return;
    }
    if (gesture?.entry !== entry) return;
    const g = gesture, dx = input.x - g.x, dy = input.y - g.y;
    if (Math.hypot(dx, dy) >= 4) g.moved = true;
    const vp = viewport(), scale = zoom();
    const over = g.kind === 'drag' && inTrash({ x: input.x - vp.x, y: input.y - vp.y }, vp, scale);
    const b = { ...g.bounds };
    if (g.kind === 'drag') { b.x += dx; b.y += dy; }
    else { b.width = Math.max(180 * scale, Math.min(2400 * scale, b.width + dx)); b.height = Math.max(140 * scale, Math.min(2400 * scale, b.height + dy)); }
    if (g.moved) {
      entry.view.setBounds(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])));
      if (g.kind === 'drag') {
        send('post-its:drag', { active: true, over });
        entry.view.webContents.send('post-it:trash', over);
      }
    }
    if (input.phase !== 'end') return;
    gesture = null;
    send('post-its:drag', { active: false, over: false });
    entry.view.webContents.send('post-it:trash', false);
    if (!g.moved) return;
    if (over) { void exclusive(() => remove(entry)).catch(report); return; }
    const preferred = layoutFromBounds(b, vp, scale);
    // Moving a temporarily clamped card does not shrink its preferred size.
    if (g.kind === 'drag') { preferred.width = entry.row.width; preferred.height = entry.row.height; }
    Object.assign(entry.row, preferred);
    entry.view.setBounds(cardBounds(entry.row, vp, scale));
    void save(entry).catch(() => {});
  }

  function register({ ipcMain, trustedHandler }) {
    ipcMain.handle('post-its:activate', trustedHandler(activate));
    ipcMain.handle('post-its:create', trustedHandler(create));
    ipcMain.handle('post-its:suspend', trustedHandler(setSuspended));
    ipcMain.handle('post-its:layout', trustedHandler(layout));
    ipcMain.handle('post-it:ready', (event) => ready(forEvent(event)));
    ipcMain.handle('post-it:edit', (event, text) => edit(forEvent(event), text));
    ipcMain.handle('post-it:copy', (event, text) => {
      forEvent(event);
      if (typeof text !== 'string' || text.length > 400000) throw new TypeError('Invalid text');
      clipboard.writeText(text);
    });
    ipcMain.handle('post-it:open-link', (event, url) => { forEvent(event); return shell.openExternal(parseExternalUrl(url).href); });
    ipcMain.on('post-it:gesture', (event, input) => { try { move(forEvent(event), input); } catch (error) { report(error); } });
  }

  return { activate, create, register, raise, layout, setSuspended, flush, cancelGesture };
}

module.exports = { createPostItViews, CARD_URL };
