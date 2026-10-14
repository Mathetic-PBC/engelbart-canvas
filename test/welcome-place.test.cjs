'use strict';

// "Open library" on the import's completion lands on the project's Welcome page (2026-10-14, model/welcome-place.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/welcome-place.js')).href);
const tree = {
  workspaces: [
    { id: 'a', name: 'Getting started', children: [] },
    { id: 'b', name: 'Welcome', children: [{ id: 'b1', name: 'Reading', children: [] }] },
    { id: 'c', name: 'Welcome 2', children: [] },
    { id: 'd', name: 'Welcome back notes', children: [] },
  ],
  notes: [{ id: 'n1', name: 'Welcome!', workspaceId: 'a' }],
};

test('the workspace the run was given wins', async () => {
  const { welcomePlace } = await load();
  assert.deepEqual(welcomePlace(tree, { given: 'b1', current: 'a' }), { workspaceId: 'b1', tab: null });
});

test('else the newest Welcome workspace, on its page', async () => {
  const { welcomePlace } = await load();
  assert.deepEqual(welcomePlace(tree, { current: 'a' }), { workspaceId: 'c', tab: null });
  assert.deepEqual(welcomePlace(tree, { given: 'gone' }), { workspaceId: 'c', tab: null });
});

test('no Welcome workspace: the one open, with its Welcome! note', async () => {
  const { welcomePlace } = await load();
  const older = { workspaces: [{ id: 'a', name: 'Getting started', children: [] }, { id: 'z', name: 'Other', children: [] }], notes: tree.notes };
  assert.deepEqual(welcomePlace(older, { current: 'a' }), { workspaceId: 'a', tab: { id: 'n1', title: 'Welcome!' } });
  assert.deepEqual(welcomePlace(older, { current: 'z' }), { workspaceId: 'z', tab: null });
  assert.deepEqual(welcomePlace({ workspaces: [], notes: [] }), { workspaceId: null, tab: null });
});
