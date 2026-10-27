'use strict';

// The panes beside the document (model/panes.js, MATH-23, MATH-103): a note's or a workspace's mention clicked opens its
// document to the right of the document in front, Andy Matuschak's working notes style. As many panes as the middle
// column fits at PANE_MIN each (2026-10-25): pane 0 is the document in front; the list holds the ones beside it, left to
// right, those the column has no room for kept out of sight at the right.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/panes.js')).href);

const note = (id) => ({ kind: 'note', id, title: id.toUpperCase() });
const space = (id) => ({ kind: 'workspace', id, title: id.toUpperCase() });
const pane = (id, link = id, kind = 'note', from = '') => ({ kind, id, title: id.toUpperCase(), link, from });
const ids = (panes) => panes.map((p) => p.id);
const FRONT = { kind: 'workspace', id: 'w1' }; // the Workspace tab in front
const ROOMY = 9; // a column that fits nine panes

// The middle column at 1440px (Workspace.jsx's layout): the sidebar 300px and its edge 1px; the Stage half of what is left
// (569px) and its edge 1px. Without the Stage (the document's full screen) the column has all but the sidebar.
const WITH_STAGE = 1440 - 301 - 569 - 1; // 569
const WITHOUT_STAGE = 1440 - 301; // 1139

test('PANE_MIN is the column\'s least width, 280px; the column fits as many panes as are that wide, at least one', async () => {
  const { PANE_MIN, paneRoom } = await load();
  assert.equal(PANE_MIN, 280);
  assert.equal(paneRoom(WITH_STAGE), 2, '1440px with the Stage open: the document and one beside it');
  assert.equal(paneRoom(WITHOUT_STAGE), 4, '1440px without the Stage: four');
  assert.equal(paneRoom(1440), 5, 'the whole window, the sidebar folded too');
  assert.equal(paneRoom(559), 1);
  assert.equal(paneRoom(560), 2);
  assert.equal(paneRoom(0), 1, 'not measured yet');
  assert.equal(paneRoom(NaN), 1);
  assert.equal(paneRoom(-5), 1);
});

test('a note clicked in the document opens beside it; another opens in a new pane while there is room', async () => {
  const { openBeside } = await load();
  const one = openBeside([], FRONT, note('a'), 'A', ROOMY, 'ws:w1');
  assert.deepEqual(one, { panes: [{ kind: 'note', id: 'a', title: 'A', link: 'A', from: 'ws:w1' }], at: 1 });
  const two = openBeside(one.panes, FRONT, note('b'), 'B', ROOMY);
  assert.deepEqual(ids(two.panes), ['a', 'b'], 'a second pane at the right');
  assert.equal(two.at, 2);
  assert.deepEqual(openBeside([], FRONT, { id: 'a' }, null).panes, [{ kind: 'note', id: 'a', title: '', link: '', from: '' }], 'no kind, title, link or from: a note, empty, never undefined');
});

test('N panes: each mention opens one more until the column is full, then takes the rightmost one\'s place', async () => {
  const { openBeside } = await load();
  let panes = [];
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    const out = openBeside(panes, FRONT, note(id), id, 4);
    assert.equal(out.at, i + 1, `${id} in pane ${i + 1}`);
    panes = out.panes;
  }
  assert.deepEqual(ids(panes), ['a', 'b', 'c'], 'four panes: the document and three');
  const full = openBeside(panes, FRONT, note('d'), 'd', 4);
  assert.deepEqual(ids(full.panes), ['a', 'b', 'd'], 'full: the rightmost is replaced, never a fifth');
  assert.equal(full.at, 3);
  // At 1440px with the Stage: the document and one pane, the second mention replacing the first.
  const narrow = openBeside([pane('a')], FRONT, note('b'), 'b', 2);
  assert.deepEqual(ids(narrow.panes), ['b']);
  assert.equal(narrow.at, 1);
  assert.deepEqual(ids(openBeside([pane('a')], FRONT, note('b'), 'b').panes), ['b'], 'no room given: two panes, as before');
  const given = [pane('a')];
  openBeside(given, FRONT, note('x'), 'x', ROOMY);
  assert.deepEqual(given, [pane('a')], 'the list given is never changed');
});

test('a column too narrow for two still shows one beside the document; it is replaced in turn', async () => {
  const { openBeside, besideShown } = await load();
  const out = openBeside([], FRONT, note('a'), 'a', 1);
  assert.deepEqual(ids(out.panes), ['a']);
  assert.equal(out.at, 1);
  assert.deepEqual(ids(openBeside(out.panes, FRONT, note('b'), 'b', 1).panes), ['b']);
  assert.equal(besideShown(1, 1), 1);
  assert.equal(besideShown(1, 0), 0);
});

test('a document already open beside is not opened again: its pane shows it, taking the new link', async () => {
  const { openBeside } = await load();
  const held = [pane('a', 'old', 'note', 'ws:w1'), pane('b')];
  const same = openBeside(held, FRONT, note('a'), 'new', ROOMY, 'note:b');
  assert.deepEqual(same.panes, [{ kind: 'note', id: 'a', title: 'A', link: 'new', from: 'note:b' }, pane('b')], 'in its own place, marked from where it was clicked now');
  assert.equal(same.at, 1);
  const again = openBeside(held, FRONT, note('b'), 'b', ROOMY);
  assert.equal(again.panes, held, 'the same link from the same pane: the same list');
  assert.equal(again.at, 2, 'pane 2 shows it');
  const full = openBeside(held, FRONT, note('a'), 'old', 3, 'ws:w1');
  assert.equal(full.panes, held, 'the column full: still not opened twice, nothing replaced');
  assert.equal(full.at, 1);
});

test('one kept out of sight, mentioned again, leaves its place for the rightmost pane in sight', async () => {
  const { openBeside } = await load();
  const held = [pane('a'), pane('b'), pane('c'), pane('d')]; // room 3: a and b in sight
  const out = openBeside(held, FRONT, note('d'), 'D', 3);
  assert.deepEqual(ids(out.panes), ['a', 'd', 'c'], 'd in b\'s place; never twice in the list');
  assert.equal(out.at, 2);
  assert.equal(out.panes[1].link, 'D');
  assert.deepEqual(ids(openBeside(held, FRONT, note('x'), 'x', 3).panes), ['a', 'x', 'c', 'd'], 'a new one takes the rightmost in sight; those out of sight stay');
});

test('the note already open on the left is not opened again beside it: the pane in front shows it', async () => {
  const { openBeside, sameDoc } = await load();
  const front = { kind: 'note', id: 'a' }; // note A's tab in front
  const held = [pane('b')];
  const out = openBeside(held, front, note('a'), 'A', ROOMY);
  assert.equal(out.at, 0, 'the left pane');
  assert.equal(out.panes, held, 'the panes beside stay as they were');
  assert.equal(openBeside([], front, note('a'), 'A').panes.length, 0, 'nothing beside: still nothing');
  assert.equal(openBeside(held, FRONT, space('w1'), 'W1').at, 0, 'the workspace in front, mentioned: the same');
  assert.equal(openBeside(held, null, note('a'), 'A', ROOMY).at, 2, 'an archived version in front is neither: the note opens beside');
  assert.equal(sameDoc({ kind: 'note', id: 'x' }, { kind: 'workspace', id: 'x' }), false, 'a note and a workspace never match by id alone');
  assert.equal(sameDoc({ id: 'x' }, { kind: 'note', id: 'x' }), true, 'no kind is a note');
  assert.equal(sameDoc(null, null), false);
});

test('a workspace\'s mention opens its document beside; a note that has its id is another document', async () => {
  const { openBeside } = await load();
  const out = openBeside([pane('a')], FRONT, space('w2'), 'Elsewhere', ROOMY);
  assert.deepEqual(out, { panes: [pane('a'), { kind: 'workspace', id: 'w2', title: 'W2', link: 'Elsewhere', from: '' }], at: 2 });
  assert.deepEqual(openBeside(out.panes, FRONT, note('w2'), 'w2', ROOMY).panes.map((p) => p.kind), ['note', 'workspace', 'note']);
  assert.equal(openBeside(out.panes, FRONT, space('w2'), 'Elsewhere', ROOMY).panes, out.panes, 'the same workspace again: nothing changed');
  assert.deepEqual(openBeside([pane('a')], FRONT, space('w2'), 'Elsewhere', 2).panes.map((p) => p.kind), ['workspace'], 'full: in place of the note');
});

test('nothing to open: the list as it was, and no pane', async () => {
  const { openBeside } = await load();
  const held = [pane('a')];
  assert.deepEqual(openBeside(held, FRONT, null, 'x'), { panes: held, at: null });
  assert.deepEqual(openBeside(held, FRONT, { kind: 'note' }, 'x'), { panes: held, at: null });
  assert.deepEqual(openBeside(undefined, FRONT, note('a'), 'A').panes, [pane('a', 'A')]);
});

test('closing a pane closes only that one: the panes after it move left; the document never closes', async () => {
  const { closePane } = await load();
  const three = [pane('a'), pane('b'), pane('c')];
  assert.deepEqual(ids(closePane(three, 2)), ['a', 'c'], 'the middle one alone');
  assert.deepEqual(ids(closePane(three, 1)), ['b', 'c']);
  assert.deepEqual(ids(closePane(three, 3)), ['a', 'b']);
  assert.deepEqual(closePane([pane('a')], 1), []);
  assert.equal(closePane(three, 0), three, 'pane 0 is the document');
  assert.equal(closePane(three, 4), three, 'no such pane');
  assert.equal(closePane(three, 'x'), three);
  assert.deepEqual(closePane(undefined, 1), []);
  assert.deepEqual(ids(three), ['a', 'b', 'c'], 'the list given is never changed');
});

test('a narrower column hides the rightmost panes and keeps them; widening shows them again, as they were', async () => {
  const { openBeside, besideShown, paneRoom } = await load();
  let panes = [];
  for (const id of ['a', 'b', 'c']) panes = openBeside(panes, FRONT, note(id), id, paneRoom(WITHOUT_STAGE)).panes;
  assert.deepEqual(ids(panes), ['a', 'b', 'c'], 'full screen at 1440px: the document and three');
  const shown = (width) => ids(panes.slice(0, besideShown(paneRoom(width), panes.length)));
  assert.deepEqual(shown(WITHOUT_STAGE), ['a', 'b', 'c']);
  assert.deepEqual(shown(WITH_STAGE), ['a'], 'the Stage back: one in sight');
  assert.deepEqual(ids(panes), ['a', 'b', 'c'], 'the others kept');
  assert.deepEqual(shown(840), ['a', 'b']);
  assert.deepEqual(shown(WITHOUT_STAGE), ['a', 'b', 'c'], 'the Stage gone again: all three, in their places');
  assert.deepEqual(shown(5000), ['a', 'b', 'c'], 'never more than there are');
});

test('the split icon has room only while another pane fits beside those there, kept out of sight included', async () => {
  const { roomForAnother, paneRoom } = await load();
  assert.equal(roomForAnother(paneRoom(WITH_STAGE), 0), true, '1440px with the Stage, the document alone: one more fits');
  assert.equal(roomForAnother(paneRoom(WITH_STAGE), 1), false, 'one beside: no room, the icon greyed out');
  assert.equal(roomForAnother(paneRoom(WITHOUT_STAGE), 2), true);
  assert.equal(roomForAnother(paneRoom(WITHOUT_STAGE), 3), false);
  assert.equal(roomForAnother(paneRoom(400), 0), false, 'a column too narrow for two');
  assert.equal(roomForAnother(paneRoom(WITH_STAGE), 3), false, 'panes kept out of sight: no room either');
});

test('each tab keeps its own panes: a view holds them by tab, switching away and back gives the same list', async () => {
  const { openBeside, restorePanes } = await load();
  // Workspace.jsx keeps a workspace's view as { panes: { [tabId]: list } }; this is its round trip.
  const view = { panes: {} };
  const keep = (tab, list) => { view.panes[tab] = list; };
  const names = { a: 'A', b: 'B', c: 'C' };
  const back = (tab) => restorePanes(view.panes[tab], (p) => names[p.id] || null);
  keep('ws', openBeside(openBeside([], FRONT, note('a'), 'a', ROOMY).panes, FRONT, note('b'), 'b', ROOMY).panes);
  keep('n1', openBeside([], { kind: 'note', id: 'n1' }, note('c'), 'c', ROOMY).panes);
  assert.deepEqual(ids(back('ws')), ['a', 'b'], 'the Workspace tab\'s');
  assert.deepEqual(ids(back('n1')), ['c'], 'the note tab\'s, its own');
  assert.equal(back('ws'), view.panes.ws, 'nothing gone: the very list');
  assert.deepEqual(back('n2'), [], 'a tab with none');
});

test('restoring a tab\'s panes drops the documents that are gone and any one twice, and takes the current names', async () => {
  const { restorePanes } = await load();
  const held = [pane('a'), pane('gone'), pane('w', 'W', 'workspace'), pane('a'), null, { kind: 'note' }, pane('b')];
  const now = { 'note:a': 'A', 'workspace:w': 'Renamed', 'note:b': 'B' };
  const out = restorePanes(held, (p) => now[`${p.kind}:${p.id}`] ?? null);
  assert.deepEqual(out.map((p) => [p.kind, p.id, p.title]), [['note', 'a', 'A'], ['workspace', 'w', 'Renamed'], ['note', 'b', 'B']]);
  assert.equal(out[0], held[0], 'one unchanged is the same pane');
  assert.equal(out[1].link, 'W', 'its link kept');
  assert.deepEqual(restorePanes(undefined, () => 'x'), []);
  assert.deepEqual(restorePanes('nope', () => 'x'), []);
});
