'use strict';

// The Stage's history (MATH-127, 2026-10-25): every page a Stage tab arrives at, kept in <project>/.context/history.json
// beside catalog.json as { version: 1, entries: [{ url, title, time, tab }] }, newest last. Everything is kept: about:
// pages, a popup's pages (under the tab that opened it), a #section jump. A visit to the address a tab's last entry has,
// within 5 seconds of it, is not kept again (a reload); that last entry is remembered here, not read back from the file.
// A title that arrives after the page (`update`) is written into the newest entry for that tab and address, never its
// time. The newest 5,000 entries are kept. Writes go one at a time per project, and a failure is logged, never thrown
// into browsing; a file that cannot be read starts an empty list. Nothing reads the file yet.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const { readJson } = require('./home.cjs');

const FILE = 'history.json';
const MAX_ENTRIES = 5000;
const REPEAT_MS = 5000;
const MAX_URL = 2048;
const MAX_TITLE = 200;
const MAX_TAB = 128;

const last = new Map(); // `${projectId}\0${tab}` → { url, at }: the tab's last entry
const queues = new Map(); // projectId → the write under way

const text = (value, max) => (typeof value === 'string' ? value : '').slice(0, max);

function readEntries(file) {
  const value = readJson(file);
  if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return [];
  return value.entries.filter((entry) => entry && typeof entry === 'object');
}

/**
 * A Stage tab arrived at a page: `visit` { id: the tab, url, title, update }. → a promise that settles when the file
 * is written, and never rejects.
 */
function record(ctx, projectId, visit, { now = () => new Date(), log = (...args) => console.warn(...args) } = {}) {
  try {
    const tab = text(visit && visit.id, MAX_TAB);
    const url = text(visit && visit.url, MAX_URL);
    const title = text(visit && visit.title, MAX_TITLE);
    const update = !!(visit && visit.update);
    if (!tab || !url) return Promise.resolve();
    const file = path.join(projects.findProject(ctx, projectId).dir, '.context', FILE);
    const at = now();
    const key = `${projectId}\0${tab}`;
    if (!update) {
      const previous = last.get(key);
      if (previous && previous.url === url && at - previous.at < REPEAT_MS) return Promise.resolve();
      last.set(key, { url, at });
    }
    const write = () => {
      const entries = readEntries(file);
      if (update) {
        const index = entries.findLastIndex((entry) => entry.tab === tab && entry.url === url);
        if (index < 0 || entries[index].title === title) return;
        entries[index] = { ...entries[index], title };
      } else {
        entries.push({ url, title, time: at.toISOString(), tab });
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      projects.writeTextAtomic(file, `${JSON.stringify({ version: 1, entries: entries.slice(-MAX_ENTRIES) }, null, 2)}\n`);
    };
    const turn = (queues.get(projectId) || Promise.resolve()).then(write).catch((error) => { log('history: could not write', file, String((error && error.message) || error)); });
    queues.set(projectId, turn);
    turn.then(() => { if (queues.get(projectId) === turn) queues.delete(projectId); });
    return turn;
  } catch (error) {
    try { log('history: could not record a visit', String((error && error.message) || error)); } catch { /* logging is best effort */ }
    return Promise.resolve();
  }
}

/** Forgets the tabs' last entries (the tests). */
function forget() { last.clear(); }

module.exports = { record, forget, FILE, MAX_ENTRIES, REPEAT_MS, MAX_URL, MAX_TITLE };
