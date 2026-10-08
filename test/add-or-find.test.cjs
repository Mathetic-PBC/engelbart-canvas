'use strict';

// MATH-67 (2026-10-06): adding to a workspace something the library already holds links the library's row instead of
// failing (src/renderer/model/add-or-find.js). Main still refuses the second row (library.addItem throws EXISTS); the
// sidebar's Add context and its + beside Files take the refusal as "it is already there".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/add-or-find.js')).href);
const refused = (name) => new Error(`Error invoking remote method 'engelbart:add-library-item': Error: Already in the library as “${name}”`);

test('addOrFind: a new thing is the row main made', async () => {
  const { addOrFind } = await load();
  const calls = [];
  const api = { addLibraryItem: async (...args) => { calls.push(args); return { id: 'new' }; }, lookupLibraryItem: async () => { throw new Error('not asked'); } };
  assert.deepEqual(await addOrFind(api, 'https://example.org/a', { name: 'A' }), { id: 'new' });
  assert.deepEqual(calls, [['https://example.org/a', { name: 'A' }]]);
});

test('addOrFind: what the library holds comes back as its row, not an error', async () => {
  const { addOrFind } = await load();
  const asked = [];
  const api = {
    addLibraryItem: async () => { throw refused('Attention'); },
    lookupLibraryItem: async (input) => { asked.push(input); return { row: { id: 'held', name: 'Attention' }, found: {}, error: null }; },
  };
  assert.deepEqual(await addOrFind(api, '~/files/Attention.pdf'), { id: 'held', name: 'Attention' });
  assert.deepEqual(asked, ['~/files/Attention.pdf']);
});

test('addOrFind: another refusal stays one, and so does an "already" the library cannot find', async () => {
  const { addOrFind } = await load();
  const nothing = { addLibraryItem: async () => { throw new Error('Nothing at that path'); }, lookupLibraryItem: async () => { throw new Error('not asked'); } };
  await assert.rejects(addOrFind(nothing, '/nowhere'), /Nothing at that path/);
  const lost = { addLibraryItem: async () => { throw refused('Gone'); }, lookupLibraryItem: async () => ({ row: null, found: {}, error: null }) };
  await assert.rejects(addOrFind(lost, '/gone'), /Already in the library as “Gone”/);
  const broken = { addLibraryItem: async () => { throw refused('Gone'); }, lookupLibraryItem: async () => { throw new Error('ipc down'); } };
  await assert.rejects(addOrFind(broken, '/gone'), /Already in the library as “Gone”/);
});
