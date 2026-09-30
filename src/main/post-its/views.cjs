'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openNotesDb } = require('../store/db.cjs');
const { findProject, findWorkspace, createNote } = require('../store/projects.cjs');
const { assertTrustedRenderer, parseExternalUrl } = require('../ipc-validation.cjs');
const {
  cardBounds, layoutFromBounds, inTrash, trashRect, crumpleAmount, draggedBounds, overlaps, blockingRects, grown,
} = require('./geometry.cjs');

const CARD_URL = 'engelbart://app/post-it.html';
const TRASH_DAYS = 7; // a card in the trash is purged a week after it was thrown in (2026-09-22)
const DAY = 24 * 60 * 60 * 1000;
const SIDE = 260; // a new card is square (2026-09-22)

/** A note's name from a post-it's first line of words (markdown markers dropped), or null when it has none. */
function noteName(text) {
  let fenced = false;
  for (const raw of String(text || '').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    let line = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]?\]\s*|[-*+]\s+|\d+[.)]\s+)/, '');
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
      .replace(/@\[([^\]]*)\]\(ws:[\w-]+\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/@\[([^\]]*)\]/g, '$1')
      .replace(/\*\*|__|~~|`|\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    if (line.length > 60) {
      const cut = line.slice(0, 60), space = cut.lastIndexOf(' ');
      line = (space > 30 ? cut.slice(0, space) : cut).trim();
    }
    return line;
  }
  return null;
}

// Native siblings of the browser, each with only its own card's IPC capability.
// `buildFor(projectId, postItId)` (2026-09-25): the card's latest quick task (main/build), so a card opened later shows its state.
function createPostItViews({ electron, getWindow, getContext, send, buildFor = async () => null, now = () => Date.now() }) {
  const { WebContentsView, clipboard } = electron;
  const entries = new Map();
  let projectId = null, database = null, gesture = null, trash = null, blocking = [];
  let standIns = '[]'; // what the window was last told to draw in place of covered cards (JSON, to send only changes)
  let hidden = false; // the sidebar's show/hide toggle (2026-09-25): every card out of sight, none touched
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
  const alive = (entry) => !entry.crashed && !entry.view.webContents.isDestroyed();
  const cssRect = (bounds, scale = zoom()) => ({ x: bounds.x / scale, y: bounds.y / scale, width: bounds.width / scale, height: bounds.height / scale });

  function save(entry) {
    const row = { ...entry.row };
    const saving = entry.pending.catch(() => {}).then(() => entry.db.update(row.id, row));
    entry.pending = saving;
    saving.then(() => { entry.error = null; }, (error) => { entry.error = error; report(error); });
    return saving;
  }

  async function flush() {
    await Promise.all([...entries.values()].map(async (entry) => {
      if (entry.ready && alive(entry)) await entry.view.webContents.executeJavaScript('window.postItAPI.flush()');
      await entry.pending;
    }));
  }

  // Cards above everything else, in their stacking order. Re-adding a view that is already where it belongs is not free:
  // on macOS it re-parents the view, which takes the keyboard away from a card being typed in (2026-09-22: the caret left
  // the card while writing a list, whenever the browser re-placed its page). So only a wrong order is touched, and a card
  // that had the keyboard gets it back.
  function raise() {
    const win = windowNow();
    if (!win) return;
    const cards = [...entries.values()].sort((a, b) => a.row.z - b.row.z).map((entry) => entry.view);
    const children = win.contentView.children;
    const top = children.slice(children.length - cards.length);
    if (top.length === cards.length && top.every((view, i) => view === cards[i])) return;
    const typing = [...entries.values()].find((entry) => alive(entry) && entry.view.webContents.isFocused());
    for (const view of cards) win.contentView.addChildView(view);
    if (typing) typing.view.webContents.focus();
  }

  // A card hides while the toggle hides them all, or while one of the app's own menus or dialogs is open over it (hover
  // previews do not count: the renderer leaves those out), and never the one being dragged.
  const overHere = (entry) => { const own = cssRect(entry.view.getBounds()); return blocking.filter((rect) => overlaps(own, rect)); };
  function visible(entry) {
    if (!entry.ready || !alive(entry) || hidden) return false;
    if (gesture?.entry === entry) return true;
    return overHere(entry).length === 0;
  }
  // Covered (2026-09-27: the Build panels "should be … the top layer so if any post its overlap this covers them"): every
  // panel over the card is one that covers. A native card cannot go under the window's own drawing, so it is swapped for a
  // picture of itself, which the window draws under the panel (post-its/ProjectPostIts.jsx) — the rest of it stays in sight.
  function covered(entry) {
    if (!entry.ready || !alive(entry) || hidden || gesture?.entry === entry) return false;
    const over = overHere(entry);
    return over.length > 0 && over.every((rect) => rect.cover);
  }

  // Pictures of the cards, kept ready (`entry.shot`, a data: URL) so a panel can cover a card at once. Anything that
  // changes how a card looks marks its picture stale; a stale one is taken again while the card shows.
  const capture = (entry) => entry.view.webContents.capturePage().then((image) => (image.isEmpty() ? null : image.toDataURL()), () => null);
  function stale(entry, wait = 400) {
    entry.shotStale = true;
    clearTimeout(entry.shotTimer);
    entry.shotTimer = setTimeout(() => { void freshShot(entry); }, wait);
  }
  async function freshShot(entry) {
    if (!entry.ready || !alive(entry) || !entry.view.getVisible() || !entry.shotStale) return;
    entry.shotStale = false;
    const url = await capture(entry);
    if (url && alive(entry)) entry.shot = url;
  }

  let refreshing = 0;
  function refresh() {
    const turn = ++refreshing;
    const waits = [];
    for (const entry of entries.values()) {
      const show = visible(entry);
      // A card about to be covered whose picture is stale is pictured first, while it still shows, then hidden.
      if (!show && covered(entry) && entry.view.getVisible() && (entry.shotStale || !entry.shot)) { waits.push(entry); continue; }
      if (entry.view.getVisible() !== show) entry.view.setVisible(show);
    }
    if (!waits.length) { tellStandIns(); return; }
    void Promise.all(waits.map(async (entry) => {
      entry.shotStale = false;
      const url = await capture(entry);
      if (url && alive(entry)) entry.shot = url;
    })).then(() => {
      if (turn !== refreshing) return; // a later refresh has settled it
      for (const entry of waits) if (entries.has(entry.row.id) && alive(entry)) entry.view.setVisible(visible(entry));
      tellStandIns();
    });
  }
  function tellStandIns() {
    const list = [...entries.values()]
      .filter((entry) => covered(entry) && entry.shot)
      .sort((a, b) => a.row.z - b.row.z)
      .map((entry) => ({ id: entry.row.id, ...cssRect(entry.view.getBounds()), url: entry.shot }));
    const key = JSON.stringify(list);
    if (key === standIns) return;
    standIns = key;
    send('post-its:stand-ins', { projectId, cards: list });
  }

  function announceTrash() {
    if (!database || projectId == null) return;
    const id = projectId, db = database;
    db.trashed().then((rows) => { if (projectId === id) send('post-its:trash', { projectId: id, count: rows.length }); }, report);
  }

  function layout() {
    for (const entry of entries.values()) {
      if (gesture?.entry === entry) continue;
      entry.view.webContents.setZoomFactor(zoom());
      entry.view.setBounds(cardBounds(entry.row, viewport(), zoom()));
      stale(entry);
    }
    refresh();
  }

  function focus(entry) {
    entry.row.z = Math.max(now(), ...[...entries.values()].map((e) => e.row.z + 1));
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
    wc.on('render-process-gone', () => { entry.crashed = true; cancelGesture(); report(new Error('A sticky stopped responding. Reopen the project to restore it.')); });
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
    clearTimeout(entry.shotTimer);
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
      tellStandIns();
      if (id == null) return;
      const project = findProject(await getContext(), id);
      const db = (await openNotesDb(project.dir)).postIts;
      await db.purge(now() - TRASH_DAYS * DAY);
      const rows = await db.list();
      database = db; projectId = id;
      for (const row of rows) attach(row);
      raise();
      announceTrash();
    });
  }

  function create(id) {
    return exclusive(async () => {
      if (projectId !== id || !database) throw new Error('Open this project before adding a sticky');
      unhide();
      const offset = entries.size % 8;
      const row = await database.create({ id: randomUUID(), text: '', nx: .22 + offset * .045, ny: .16 + offset * .045, width: SIDE, height: SIDE, z: now() });
      attach(row, true);
      raise();
      return row.id;
    });
  }

  // Show/hide only changes what is drawn: no row is written, created or deleted.
  function setHidden(value) {
    hidden = !!value;
    if (hidden) {
      cancelGesture();
      if ([...entries.values()].some((entry) => alive(entry) && entry.view.webContents.isFocused())) windowNow()?.webContents.focus();
    }
    refresh();
    return hidden;
  }
  // A card made or brought back out of the trash while they are hidden would be invisible: they all show again.
  function unhide() {
    if (!hidden) return;
    hidden = false;
    refresh();
    send('post-its:hidden', false);
  }

  function setBlocking(rects) {
    blocking = blockingRects(rects);
    if (gesture && !visible(gesture.entry)) cancelGesture();
    refresh();
    return true;
  }

  function forEvent(event) {
    assertTrustedRenderer(event, CARD_URL);
    const entry = [...entries.values()].find((e) => e.view.webContents === event.sender);
    if (!entry) throw new Error('IPC rejected: unknown sticky');
    return entry;
  }

  async function ready(entry) {
    entry.ready = true;
    refresh();
    stale(entry, 250);
    if (entry.fresh && entry.view.getVisible()) entry.view.webContents.focus();
    let build = null;
    try { build = await briefBuild(await buildFor(projectId, entry.row.id)); } catch { build = null; }
    return { id: entry.row.id, text: entry.row.text, fresh: entry.fresh, build };
  }

  // A post-it's quick task (2026-09-25; design B23): the card asks the window for its Build popup, shows where its latest
  // quick task stands, and a click on that opens the task beside the card. Since 2026-09-27 (Claude Design "Post-it Quick
  // Task") both hang from the button that was pressed: `rect` is where it is on the card, and the window is told where it
  // is on the window (CSS px), with the card's own rect. A task the card was added to a workspace as carries that
  // workspace's name, which the card shows in place of a state.
  async function briefBuild(task) {
    if (!task) return null;
    let workspace = null;
    if (task.kind === 'build' && task.workspaceId) {
      try { workspace = findWorkspace(await getContext(), task.projectId, task.workspaceId).workspace.name; } catch { workspace = null; }
    }
    return { id: task.id, status: task.status, final: !!task.final, kind: task.kind, workspace };
  }
  function anchorOf(entry, rect) {
    const card = cssRect(entry.view.getBounds());
    const at = rect == null ? null : trashRect(rect); // four finite numbers, or it throws
    const button = at ? { x: card.x + at.x, y: card.y + at.y, width: at.width, height: at.height } : card;
    return { card, button };
  }
  async function askBuild(entry, rect) {
    const where = anchorOf(entry, rect);
    await entry.pending.catch(() => {});
    windowNow()?.webContents.focus();
    send('engelbart:build-quick', { projectId, postItId: entry.row.id, text: entry.row.text, ...where });
    return true;
  }
  function openBuild(entry, id, rect) {
    if (typeof id !== 'string' || !/^[0-9a-f]{10}$/.test(id)) throw new TypeError('build id is invalid');
    const where = anchorOf(entry, rect);
    windowNow()?.webContents.focus();
    send('engelbart:build-quick-open', { projectId, id, postItId: entry.row.id, ...where });
    return true;
  }
  /** A Build changed: the card it came from (if it is open) shows its state. */
  function buildState(task) {
    if (!task || !task.postItId || task.projectId !== projectId) return;
    const entry = entries.get(task.postItId);
    if (!entry || !entry.ready || !alive(entry)) return;
    void briefBuild(task).then((brief) => {
      if (!alive(entry)) return;
      entry.view.webContents.send('post-it:build-state', brief);
      // Its picture changes with it. A covered card is shown for a moment to be pictured again, else its stand-in
      // would go on showing the old state under the panel.
      if (covered(entry)) {
        entry.view.setVisible(true);
        setTimeout(() => { entry.shotStale = true; refresh(); }, 60);
      } else stale(entry, 200);
    });
  }

  // "Delete task" (2026-09-27): once its task went to a workspace, the post-it can go. Into the trash, as a drag there does.
  function throwOut(id, cardId) {
    return exclusive(async () => {
      if (projectId !== id) throw new Error('Open this project first');
      const entry = entries.get(String(cardId));
      if (!entry) return false;
      await throwAway(entry);
      return true;
    });
  }

  function edit(entry, text) {
    if (typeof text !== 'string' || text.length > 400000) throw new TypeError('Sticky text must be at most 400000 characters');
    entry.row.text = text;
    stale(entry);
    return save(entry).then(() => true);
  }

  // Text that no longer fits: the card grows downwards, as far as the window lets it (the card shrinks its type after that).
  function grow(entry, height) {
    if (!Number.isFinite(height) || height < 0 || height > 100000) throw new TypeError('Invalid sticky height');
    const scale = zoom(), vp = viewport();
    if (gesture?.entry !== entry && height > entry.row.height) {
      Object.assign(entry.row, grown(entry.row, height, vp, scale));
      entry.view.setBounds(cardBounds(entry.row, vp, scale));
      stale(entry);
      refresh();
      void save(entry).catch(() => {});
    }
    return cardBounds(entry.row, vp, scale).height / scale;
  }

  async function throwAway(entry) {
    await entry.pending.catch(() => {});
    await entry.db.trash(entry.row.id);
    const focused = entry.view.webContents.isFocused();
    detach(entry);
    if (focused) windowNow()?.webContents.focus();
    announceTrash();
    return true;
  }

  function trashed(id) {
    return exclusive(async () => {
      if (projectId !== id || !database) return [];
      await database.purge(now() - TRASH_DAYS * DAY);
      return (await database.trashed()).map((row) => ({
        id: row.id, text: row.text.slice(0, 4000), deleted: row.deleted,
        expires: new Date(Date.parse(row.deleted) + TRASH_DAYS * DAY).toISOString(),
      }));
    });
  }

  function restore(id, cardId) {
    return exclusive(async () => {
      if (projectId !== id || !database) throw new Error('Open this project before restoring a sticky');
      const row = await database.restore(String(cardId));
      if (!row) return false;
      unhide();
      row.z = Math.max(now(), ...[...entries.values()].map((e) => e.row.z + 1));
      await database.update(row.id, row);
      attach(row);
      raise();
      announceTrash();
      return true;
    });
  }

  // +Note (2026-09-22): the card's text becomes a note of its own, in no workspace, opened as a tab; the card stays.
  async function toNote(entry) {
    await entry.pending.catch(() => {});
    const id = projectId, text = entry.row.text;
    const ctx = await getContext();
    const project = findProject(ctx, id);
    let name = noteName(text);
    if (!name) { let n = 1; while (fs.existsSync(path.join(project.dir, `Untitled Note ${n}.md`))) n += 1; name = `Untitled Note ${n}`; }
    const note = await createNote(ctx, id, { name, text });
    send('post-its:open-note', { projectId: id, id: note.id, name: note.name });
    return { id: note.id, name: note.name };
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
    refresh();
  }

  function move(entry, input) {
    if (!input || !['begin', 'move', 'end', 'cancel'].includes(input.phase)) throw new TypeError('Invalid post-it gesture');
    if (input.phase === 'cancel') { if (gesture?.entry === entry) cancelGesture(); return; }
    if (![input.x, input.y].every((n) => Number.isFinite(n) && Math.abs(n) < 100000)) throw new TypeError('Invalid pointer coordinates');
    const vp = viewport(), scale = zoom();
    if (input.phase === 'begin') {
      if (!visible(entry) || !['drag', 'resize'].includes(input.kind)) return;
      cancelGesture();
      focus(entry);
      const bounds = entry.view.getBounds();
      const px = input.x - vp.x, py = input.y - vp.y;
      const grab = { x: Math.max(0, Math.min(1, (px - bounds.x) / bounds.width)), y: Math.max(0, Math.min(1, (py - bounds.y) / bounds.height)) };
      gesture = { entry, kind: input.kind, x: input.x, y: input.y, bounds, grab, moved: false, scale: 1 };
      return;
    }
    if (gesture?.entry !== entry) return;
    const g = gesture, dx = input.x - g.x, dy = input.y - g.y;
    if (Math.hypot(dx, dy) >= 4) g.moved = true;
    const point = { x: input.x - vp.x, y: input.y - vp.y };
    const over = g.kind === 'drag' && inTrash(point, trash, scale);
    let b;
    if (g.kind === 'drag') {
      const size = { width: g.bounds.width, height: g.bounds.height };
      const t = g.moved && input.phase !== 'end' ? crumpleAmount(point, trash, scale) : 0;
      const placed = draggedBounds({ point, grab: g.grab, size, t, rect: trash, zoom: scale });
      b = placed.bounds;
      if (placed.scale !== g.scale && !(input.phase === 'end' && over)) {
        g.scale = placed.scale;
        entry.view.webContents.send('post-it:crumple', { scale: placed.scale, width: size.width / scale, height: size.height / scale });
      }
    } else {
      b = { ...g.bounds };
      b.width = Math.max(180 * scale, Math.min(2400 * scale, b.width + dx));
      b.height = Math.max(140 * scale, Math.min(2400 * scale, b.height + dy));
    }
    if (g.moved) {
      entry.view.setBounds(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])));
      if (g.kind === 'drag') {
        send('post-its:drag', { active: true, over });
        entry.view.webContents.send('post-it:trash', over);
      }
    }
    if (input.phase !== 'end') return;
    gesture = null;
    send('post-its:drag', { active: false, over: false, thrown: !!(over && g.moved) });
    entry.view.webContents.send('post-it:trash', false);
    if (!g.moved) return;
    if (over) { void exclusive(() => throwAway(entry)).catch(report); return; }
    const preferred = layoutFromBounds(b, vp, scale);
    // Moving a temporarily clamped card does not shrink its preferred size.
    if (g.kind === 'drag') { preferred.width = entry.row.width; preferred.height = entry.row.height; }
    Object.assign(entry.row, preferred);
    entry.view.setBounds(cardBounds(entry.row, vp, scale));
    stale(entry);
    refresh();
    void save(entry).catch(() => {});
  }

  function register({ ipcMain, trustedHandler }) {
    ipcMain.handle('post-its:activate', trustedHandler(activate));
    ipcMain.handle('post-its:create', trustedHandler(create));
    ipcMain.handle('post-its:block', trustedHandler(setBlocking));
    ipcMain.handle('post-its:hide', trustedHandler(setHidden));
    ipcMain.handle('post-its:layout', trustedHandler(layout));
    ipcMain.handle('post-its:trash-rect', trustedHandler((rect) => { trash = trashRect(rect); return true; }));
    ipcMain.handle('post-its:trashed', trustedHandler(trashed));
    ipcMain.handle('post-its:restore', trustedHandler(restore));
    ipcMain.handle('post-it:ready', (event) => ready(forEvent(event)));
    ipcMain.handle('post-it:edit', (event, text) => edit(forEvent(event), text));
    ipcMain.handle('post-it:grow', (event, height) => grow(forEvent(event), height));
    ipcMain.handle('post-it:to-note', (event) => toNote(forEvent(event)));
    ipcMain.handle('post-its:throw-out', trustedHandler(throwOut));
    ipcMain.handle('post-it:build', (event, rect) => askBuild(forEvent(event), rect));
    ipcMain.handle('post-it:build-open', (event, id, rect) => openBuild(forEvent(event), id, rect));
    ipcMain.handle('post-it:copy', (event, text) => {
      forEvent(event);
      if (typeof text !== 'string' || text.length > 400000) throw new TypeError('Invalid text');
      clipboard.writeText(text);
    });
    // A link on a sticky opens on the Stage, as every website does (2026-09-29): the window is told, not the default browser.
    ipcMain.handle('post-it:open-link', (event, url) => { forEvent(event); send('post-its:open-link', { projectId, url: parseExternalUrl(url).href }); return true; });
    ipcMain.on('post-it:gesture', (event, input) => { try { move(forEvent(event), input); } catch (error) { report(error); } });
  }

  return { activate, create, register, raise, layout, setBlocking, setHidden, flush, cancelGesture, buildState };
}

module.exports = { createPostItViews, CARD_URL, noteName, TRASH_DAYS };
