'use strict';

// Where the sidebar's next row and ⌘J go (model/nav.js, 2026-09-22).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/nav.js')).href);

const P = 'p', Q = 'q';
const place = (workspaceId, at, projectId = P) => ({ projectId, workspaceId, at, name: workspaceId.toUpperCase(), path: workspaceId, projectName: projectId });
const agent = (id, workspaceId, status, finished, projectId = P) => ({ id, kind: 'bart', projectId, workspaceId, status, started: '2026-09-22T10:00:00.000Z', finished, name: workspaceId ? workspaceId.toUpperCase() : '' });
const here = (workspaceId, projectId = P) => ({ projectId, workspaceId });

test('next: with nothing waiting, the recent workspaces take turns; an edit makes the next one where you came from', async () => {
  const { nextPlace } = await load();
  const recent = [place('a', '2026-09-22T12:00:00.000Z'), place('b', '2026-09-22T11:00:00.000Z'), place('c', '2026-09-22T10:00:00.000Z')];
  assert.equal(nextPlace({ here: here('a'), recent }).workspaceId, 'b', 'from the newest, the one before it');
  assert.equal(nextPlace({ here: here('b'), recent }).workspaceId, 'c', 'looking around without writing goes on through all three');
  assert.equal(nextPlace({ here: here('c'), recent }).workspaceId, 'a', 'and round');
  assert.equal(nextPlace({ here: here('z'), recent }).workspaceId, 'a', 'from anywhere else, the one written in last');
  const afterEdit = [place('b', '2026-09-22T12:05:00.000Z'), place('a', '2026-09-22T12:00:00.000Z'), place('c', '2026-09-22T10:00:00.000Z')];
  assert.equal(nextPlace({ here: here('b'), recent: afterEdit }).workspaceId, 'a', 'wrote in b: back to a');
  assert.equal(nextPlace({ here: here('a'), recent: [place('a', '2026-09-22T12:00:00.000Z')] }), null, 'only here: nowhere to go');
  assert.equal(nextPlace({ here: here('a'), recent: [] }), null);
  assert.equal(nextPlace({ here: here('a'), recent }).why, 'recent');
  assert.equal(nextPlace({ here: here('a', Q), recent }).workspaceId, 'a', 'the same workspace id in another project is another place');
});

test('next: an agent waiting for you comes first, the one that has waited longest; running ones and the one you are in never count', async () => {
  const { nextPlace } = await load();
  const recent = [place('a', '2026-09-22T12:00:00.000Z'), place('b', '2026-09-22T11:00:00.000Z')];
  const agents = [
    agent('1', 'c', 'waiting', '2026-09-22T12:10:00.000Z'),
    agent('2', 'd', 'waiting', '2026-09-22T12:02:00.000Z'),
    agent('3', 'e', 'running', null),
    agent('4', 'a', 'waiting', '2026-09-22T12:00:00.000Z'),
    agent('5', 'd', 'waiting', '2026-09-22T12:05:00.000Z'),
    agent('6', null, 'waiting', '2026-09-22T11:00:00.000Z'),
  ];
  const next = nextPlace({ here: here('a'), recent, agents });
  assert.deepEqual([next.workspaceId, next.why, next.waiting, next.at], ['d', 'agent', 2, '2026-09-22T12:02:00.000Z'], 'd waited longest; two workspaces wait; a is here; an agent of no workspace is not a place');
  assert.equal(nextPlace({ here: here('a'), recent, agents: agents.filter((a) => a.workspaceId !== 'd' && a.workspaceId !== 'c') }).why, 'recent', 'nothing waiting elsewhere: back to the recent ones');
});

test('ago, and the workspace switcher\'s search over every workspace of the tree', async () => {
  const { ago, flatWorkspaces, findWorkspaces } = await load();
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  assert.deepEqual(['2026-09-22T11:59:40.000Z', '2026-09-22T11:56:00.000Z', '2026-09-22T09:00:00.000Z', '2026-09-19T12:00:00.000Z', 'nope'].map((iso) => ago(iso, now)), ['now', '4 min', '3 h', '3 d', '']);
  const tree = [
    { id: '1', name: 'User Interface', status: 'open', children: [{ id: '2', name: 'Improving workspace navigation', status: 'progress', children: [] }, { id: '3', name: 'Focusing the attention of the user', status: 'open', children: [] }] },
    { id: '4', name: 'Library', status: 'done', children: [{ id: '5', name: 'Library context', status: 'open', children: [{ id: '6', name: 'Navigation of papers', status: 'open', children: [] }] }] },
  ];
  const all = flatWorkspaces(tree);
  assert.deepEqual(all.map((w) => [w.id, w.above.join(' / ')]), [['1', ''], ['2', 'User Interface'], ['3', 'User Interface'], ['4', ''], ['5', 'Library'], ['6', 'Library / Library context']]);
  assert.deepEqual(findWorkspaces(all, 'navigation').map((w) => w.id), ['6', '2'], 'at any depth; a name that starts with the words comes first');
  assert.deepEqual(findWorkspaces(all, 'lib').map((w) => w.id), ['4', '5'], 'titles only: "Navigation of papers" is under Library but not named so');
  assert.deepEqual(findWorkspaces(all, 'user attention').map((w) => w.id), ['3'], 'every word, in any order');
  assert.deepEqual(findWorkspaces(all, '  '), []);
});

test('places to go: waiting agents first (longest waiting, once each), then the recent ones newest first; never here; ⌘J\'s one marked', async () => {
  const { placesToGo, nextPlace } = await load();
  const recent = [place('a', '2026-09-22T12:00:00.000Z'), place('b', '2026-09-22T11:00:00.000Z'), place('c', '2026-09-22T10:00:00.000Z')];
  const agents = [agent('1', 'd', 'waiting', '2026-09-22T12:10:00.000Z'), agent('2', 'c', 'waiting', '2026-09-22T12:02:00.000Z'), agent('3', 'e', 'running', null), agent('4', 'd', 'waiting', '2026-09-22T12:20:00.000Z')];
  const list = placesToGo({ here: here('a'), recent, agents });
  assert.deepEqual(list.map((entry) => entry.workspaceId), ['c', 'd', 'b']);
  assert.deepEqual(list.map((entry) => entry.why), ['agent', 'agent', 'recent']);
  assert.deepEqual(list.filter((entry) => entry.next).map((entry) => entry.workspaceId), [nextPlace({ here: here('a'), recent, agents }).workspaceId]);
  const quiet = placesToGo({ here: here('b'), recent });
  assert.deepEqual(quiet.map((entry) => entry.workspaceId), ['a', 'c'], 'newest first, not in ⌘J\'s turn order');
  assert.deepEqual(quiet.filter((entry) => entry.next).map((entry) => entry.workspaceId), ['c'], '⌘J from b goes on to c');
  assert.deepEqual(placesToGo({ here: here('a'), recent: [place('a', '2026-09-22T12:00:00.000Z')] }), [], 'only here: nothing');
  assert.equal(placesToGo({ here: here('a', Q), recent }).length, 3, 'another project\'s a is another place');
});
