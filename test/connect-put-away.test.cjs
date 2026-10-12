'use strict';

// Connect your library's progress view (2026-10-12): its footer button says "Run in background" while an import is still
// going or MEMORY.md is not yet written, and "Done" once everything is in or the session was stopped; the header's minus
// says "Close" then. Both keep putting it away. src/renderer/model/connect.js stillBringingIn, putAwayLabel;
// src/renderer/screens/ConnectLibrary.jsx.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
const screen = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');

const session = (jobs, memory, extra = {}) => ({ id: 's1', jobs, memory, ...extra });

test('the footer says Run in background while an import is going', async () => {
  const m = await model();
  const going = session([{ id: 'a', kind: 'import', status: 'done' }, { id: 'b', kind: 'import', status: 'running' }], { status: 'waiting' });
  assert.equal(m.stillBringingIn(going), true);
  assert.equal(m.putAwayLabel(going), 'Run in background');
  // Queued and waiting on the person are still going too.
  assert.equal(m.putAwayLabel(session([{ id: 'a', kind: 'import', status: 'queued' }], { status: 'waiting' })), 'Run in background');
  assert.equal(m.putAwayLabel(session([{ id: 'a', kind: 'survey', status: 'waiting' }], null)), 'Run in background');
});

test('the footer says Run in background while MEMORY.md is still being written', async () => {
  const m = await model();
  const writing = session([{ id: 'a', kind: 'import', status: 'done' }, { id: 'm', kind: 'memory', status: 'running' }], { status: 'writing' });
  assert.equal(m.putAwayLabel(writing), 'Run in background');
});

test('the footer says Done once every job and MEMORY.md are done', async () => {
  const m = await model();
  const finished = session([{ id: 'a', kind: 'import', status: 'done' }, { id: 'b', kind: 'import', status: 'failed' }, { id: 'c', kind: 'import', skipped: true }], { status: 'saved', path: '/x/MEMORY.md' });
  assert.equal(m.stillBringingIn(finished), false);
  assert.equal(m.putAwayLabel(finished), 'Done');
  assert.equal(m.putAwayLabel(session([{ id: 'a', kind: 'import', status: 'done' }], { status: 'failed' })), 'Done');
});

test('the footer says Done when the session is stopped', async () => {
  const m = await model();
  const stopped = session([{ id: 'a', kind: 'import', status: 'running' }], { status: 'waiting' }, { stopped: true });
  assert.equal(m.stillBringingIn(stopped), false);
  assert.equal(m.putAwayLabel(stopped), 'Done');
  assert.equal(m.putAwayLabel(null), 'Done');
});

test('the screen uses one test for the header, Stop all, the footer and the minus, and both labels put it away', () => {
  assert.match(screen, /const bringingIn = stillBringingIn\(session\);/);
  assert.match(screen, /header\(session\.stopped \? 'Stopped' : bringingIn \? 'Bringing everything in'/);
  assert.match(screen, /\{bringingIn && <button type="button" className="cx-ghost" data-connect-stop-all="1"/);
  assert.match(screen, /data-connect-done="1" onClick=\{putAway\}[^>]*>\{putAwayLabel\(session\)\}<\/button>/);
  assert.match(screen, /data-connect-minimize="1" onClick=\{putAway\} aria-label=\{bringingIn \? 'Run in the background' : 'Close'\} title=\{bringingIn \? 'Run in the background' : 'Close'\}/);
  assert.doesNotMatch(screen, />Run in background<\/button>/);
  // The onboarding page's own Continue is unchanged.
  assert.match(screen, /data-connect-done="1" onClick=\{putAway\} style=\{FOOT_BUTTON\}>Continue/);
});
