'use strict';

// engelbart:* IPC. Every handler runs behind the trusted-renderer check and validates
// its arguments before touching the store. In test mode the store context is opened
// lazily (library db + seeds); with test mode off, data calls fail with a clear error.

const path = require('node:path');
const home = require('./store/home.cjs');
const db = require('./store/db.cjs');
const projects = require('./store/projects.cjs');
const library = require('./store/library.cjs');

const MAX_NAME = 512;

function str(value, what, max = MAX_NAME) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${what} must be a string of at most ${max} characters`);
  return value;
}

function optStr(value, what, max = MAX_NAME) {
  return value == null ? null : str(value, what, max);
}

function docRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('doc ref must be an object');
  if (value.kind === 'note') return { kind: 'note', id: str(value.id, 'note id', 64) };
  if (value.kind === 'workspace') return { kind: 'workspace', goalId: str(value.goalId, 'goal id', 64), topicId: str(value.topicId, 'topic id', 64) };
  throw new TypeError('Unknown doc kind');
}

function createStore({ homeDir, fixturesDir }) {
  const layout = home.ensureHome(homeDir);
  let ctx = null;
  let opening = null;

  async function context() {
    const config = home.readConfig(layout.root);
    if (!config.testMode) throw new Error('Test mode is off');
    if (ctx) return ctx;
    if (!opening) {
      opening = (async () => {
        const libraryDb = await db.openLibraryDb(layout.testRoot);
        const next = { homeDir, root: layout.root, testRoot: layout.testRoot, libraryDb };
        await library.seedIfEmpty(next, fixturesDir);
        ctx = next;
        return next;
      })().finally(() => {
        opening = null;
      });
    }
    return opening;
  }

  async function setTestMode(value) {
    if (typeof value !== 'boolean') throw new TypeError('testMode must be a boolean');
    const config = home.writeConfig(layout.root, { testMode: value });
    if (!value) {
      ctx = null;
      await db.closeAll();
    }
    return { ...config, home: layout.root, testRoot: layout.testRoot };
  }

  return {
    layout,
    context,
    config: () => ({ ...home.readConfig(layout.root), home: layout.root, testRoot: layout.testRoot }),
    setTestMode,
    close: () => db.closeAll(),
  };
}

function registerEngelbartIpc({ ipcMain, trustedHandler, store, openExternal, revealItem }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  const withCtx = (fn) => async (...args) => fn(await store.context(), ...args);

  handle('config', () => store.config());
  handle('set-test-mode', (value) => store.setTestMode(value));

  handle('list-projects', withCtx((ctx) => projects.listProjects(ctx)));
  handle('create-project', withCtx((ctx, name) => projects.createProject(ctx, str(name, 'name'))));
  handle('rename-project', withCtx((ctx, id, name) => projects.renameProject(ctx, str(id, 'project id', 64), str(name, 'name'))));
  handle('load-project', withCtx((ctx, id) => projects.loadProject(ctx, str(id, 'project id', 64))));

  handle('create-goal', withCtx((ctx, pid, input) => {
    if (!input || typeof input !== 'object') throw new TypeError('goal input must be an object');
    return projects.createGoal(ctx, str(pid, 'project id', 64), { name: optStr(input.name, 'name') || 'Goal', box: str(input.box, 'box', 32) });
  }));
  handle('rename-goal', withCtx((ctx, pid, gid, name) => projects.renameGoal(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), str(name, 'name'))));
  handle('set-future', withCtx((ctx, pid, gid, ideas) => projects.setFuture(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), ideas)));

  handle('create-topic', withCtx((ctx, pid, gid, name) => projects.createTopic(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), optStr(name, 'name') || 'Topic')));
  handle('rename-topic', withCtx((ctx, pid, gid, tid, name) => projects.renameTopic(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), str(tid, 'topic id', 64), str(name, 'name'))));
  handle('set-topic-status', withCtx((ctx, pid, gid, tid, status) => projects.setTopicStatus(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), str(tid, 'topic id', 64), str(status, 'status', 32))));
  handle('set-topic-context', withCtx((ctx, pid, gid, tid, ids) => projects.setTopicContext(ctx, str(pid, 'project id', 64), str(gid, 'goal id', 64), str(tid, 'topic id', 64), ids)));

  handle('create-note', withCtx((ctx, pid, input) => {
    const value = input && typeof input === 'object' ? input : {};
    return projects.createNote(ctx, str(pid, 'project id', 64), { name: optStr(value.name, 'name'), goalId: optStr(value.goalId, 'goal id', 64), topicId: optStr(value.topicId, 'topic id', 64) });
  }));
  handle('rename-note', withCtx((ctx, pid, id, name) => projects.renameNote(ctx, str(pid, 'project id', 64), str(id, 'note id', 64), str(name, 'name'))));
  handle('read-doc', withCtx((ctx, pid, ref) => projects.readDoc(ctx, str(pid, 'project id', 64), docRef(ref))));
  handle('write-doc', withCtx((ctx, pid, ref, text) => projects.writeDoc(ctx, str(pid, 'project id', 64), docRef(ref), text)));

  handle('library', withCtx((ctx) => library.listLibrary(ctx)));
  handle('read-library-file', withCtx((ctx, id) => library.readLibraryFile(ctx, str(id, 'library id', 64))));
  handle('read-annotations', withCtx((ctx, id) => library.readAnnotations(ctx, str(id, 'library id', 64))));
  handle('write-annotations', withCtx((ctx, id, value) => library.writeAnnotations(ctx, str(id, 'library id', 64), value)));

  handle('open-external', (url) => openExternal(url));
  handle('reveal', async (target) => {
    const value = path.resolve(str(target, 'path', 4096));
    if (!value.startsWith(store.layout.root + path.sep) && value !== store.layout.root) throw new Error('Only paths inside ~/.engelbart can be revealed');
    return revealItem(value);
  });
}

module.exports = { createStore, registerEngelbartIpc };
