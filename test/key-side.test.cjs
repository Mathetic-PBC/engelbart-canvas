'use strict';

// Where ⌘T, ⌘W and ⌘F go (model/key-side.js, 2026-10-16): the middle canvas, the Stage or the terminal, whichever was
// clicked last; and what ⌘W closes in the middle canvas. The elements here are stand-ins that answer closest() by the
// attributes they and their ancestors carry.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/key-side.js')).href);

// An element under `parent` with `attrs` ({ 'data-doc-pane': '1' }): closest() matches a comma list of [attr] selectors.
function el(attrs = {}, parent = null) {
  const node = {
    attrs, parent,
    dataset: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/^data-/, '').replace(/-(\w)/g, (_m, c) => c.toUpperCase()), v])),
    closest(selector) {
      const wanted = selector.split(',').map((s) => s.trim().replace(/^\[|\]$/g, ''));
      for (let at = node; at; at = at.parent) if (wanted.some((name) => name in at.attrs)) return at;
      return null;
    },
  };
  return node;
}

const stage = el({ 'data-stage': '1' });
const address = el({}, stage);
const terminal = el({ 'data-terminal': '1' });
const prompt = el({}, terminal);
const strip = el({ 'data-doc-strip': '1' });
const tab = el({}, strip);
const front = el({ 'data-doc-pane': '0' });
const frontText = el({}, front);
const beside = el({ 'data-doc-pane': '1' });
const besideText = el({}, beside);
const sidebar = el({ 'data-rail': '1' });

test('sideOf: the Stage, the terminal, the document\'s panes and its tab strip; nothing elsewhere', async () => {
  const { sideOf } = await load();
  assert.equal(sideOf(address), 'stage');
  assert.equal(sideOf(prompt), 'terminal');
  assert.equal(sideOf(tab), 'doc');
  assert.equal(sideOf(frontText), 'doc');
  assert.equal(sideOf(besideText), 'doc');
  assert.equal(sideOf(el({ 'data-doc-find': '1' })), 'doc', 'the document\'s find bar');
  assert.equal(sideOf(sidebar), null);
  assert.equal(sideOf(null), null);
  assert.equal(sideOf({}), null, 'a text node or the window');
});

test('paneOf: the pane an element is in; the tab strip is the document in front\'s', async () => {
  const { paneOf } = await load();
  assert.equal(paneOf(frontText), 0);
  assert.equal(paneOf(besideText), 1);
  assert.equal(paneOf(tab), 0);
  assert.equal(paneOf(address), null);
});

test('the tracker: starts on the middle canvas; a press or a focus moves it; the sidebar leaves it where it was', async () => {
  const { createSideTracker } = await load();
  const t = createSideTracker();
  assert.equal(t.side(), 'doc', 'as ⌘1–9 always started');
  t.pressed(address);
  assert.equal(t.side(), 'stage');
  t.pressed(sidebar);
  assert.equal(t.side(), 'stage', 'the sidebar is none of the three');
  t.focused(prompt);
  assert.equal(t.side(), 'terminal', 'the keyboard moved into the terminal');
  t.pressed(besideText);
  assert.deepEqual([t.side(), t.pane()], ['doc', 1]);
  t.pressed(tab);
  assert.deepEqual([t.side(), t.pane()], ['doc', 0], 'the tab strip is the document in front\'s');
  t.pressed(address);
  assert.equal(t.pane(), 0, 'the pane is kept for the next time the middle canvas has the keys');
});

test('the tracker: a page on the Stage taking the keyboard is the Stage; the app getting it back is no click on the document', async () => {
  const { createSideTracker } = await load();
  const t = createSideTracker();
  t.pressed(frontText);
  t.left(frontText); // the page on the Stage was clicked: the window's page lost the keyboard, the editor still its active element
  t.page();
  assert.equal(t.side(), 'stage');
  t.focused(frontText); // ⌘T in the page hands the keyboard back to the app (views.cjs focusApp): the editor gets it again
  assert.equal(t.side(), 'stage');
  t.focused(address); // and the new tab's address takes it
  assert.equal(t.side(), 'stage');
  t.left(address);
  t.focused(frontText); // another element than the one that had it: a real move
  assert.equal(t.side(), 'doc');
});

test('the tracker: switching apps and back changes nothing; clicking the editor after a page does', async () => {
  const { createSideTracker } = await load();
  const t = createSideTracker();
  t.pressed(address);
  t.left(address);
  t.focused(address);
  assert.equal(t.side(), 'stage');
  t.page();
  t.left(frontText);
  t.pressed(frontText);
  t.focused(frontText);
  assert.equal(t.side(), 'doc');
});

test('docHasKeys: clicked last and shown, or the document\'s full screen', async () => {
  const { docHasKeys } = await load();
  assert.equal(docHasKeys('doc'), true);
  assert.equal(docHasKeys('stage'), false);
  assert.equal(docHasKeys('terminal'), false);
  assert.equal(docHasKeys('doc', { docShown: false }), false, 'the Stage\'s full screen hides the document');
  assert.equal(docHasKeys('stage', { docFull: true }), true, 'the document\'s full screen hides the right pane');
});

test('docClose: the pane beside when it was clicked last, else the tab in front, never Workspace or the last tab', async () => {
  const { docClose } = await load();
  const tabs = [{ id: 'ws' }, { id: 'n1' }, { id: 'n2' }];
  assert.deepEqual(docClose({ tabs, active: 'n1' }), { tab: 'n1' });
  assert.deepEqual(docClose({ tabs, active: 'n1', pane: 1, beside: 1 }), { pane: 1 });
  assert.deepEqual(docClose({ tabs, active: 'n1', pane: 1, beside: 0 }), { tab: 'n1' }, 'a pane already gone: the tab');
  assert.equal(docClose({ tabs, active: 'ws' }), null, 'Workspace is always there');
  assert.equal(docClose({ tabs: [{ id: 'project' }], active: 'project' }), null, 'the only tab left');
  assert.deepEqual(docClose({ tabs: [{ id: 'project' }, { id: 'n1' }], active: 'project' }), { tab: 'project' });
  assert.equal(docClose({ tabs, active: 'gone' }), null, 'no tab of that id');
  assert.equal(docClose({ tabs: null, active: 'n1' }), null);
});
