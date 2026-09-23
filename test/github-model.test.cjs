'use strict';

// The + menu's GitHub list (src/renderer/model/github.js, 2026-09-22).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/github.js')).href);
const repo = (id, fullName, description = '', priv = false) => ({ id, fullName, url: `https://github.com/${fullName}`, owner: fullName.split('/')[0], private: priv, description });

test('the GitHub list: every word against name and description; a repository the library holds is its row, found by id or address; `here` when on the rail', async () => {
  const { githubRows, heldRow } = await load();
  const repos = [repo('9', 'Mathetic-PBC/engelbart-canvas', 'Engelbart desktop', true), repo('5', 'hudsonmp/hudsonmp.github.io', 'site'), repo('7', 'VectifyAI/PageIndex', 'reasoning-based RAG')];
  const library = [
    { id: 'a', name: 'engelbart-canvas', type: 'folder', tags: ['git'], github_id: '9', url: 'https://github.com/Mathetic-PBC/engelbart-canvas' },
    { id: 'b', name: 'PageIndex', type: 'website', tags: ['git'], github_id: null, url: 'https://github.com/vectifyai/pageindex/' },
  ];
  const inRail = (id) => id === 'a';
  const all = githubRows({ repos, query: '', library, inRail });
  assert.deepEqual(all.map((entry) => [entry.repo.id, entry.row && entry.row.id, entry.here]), [['9', 'a', true], ['5', null, false], ['7', 'b', false]], 'order kept; the address matches whatever its case or trailing slash');
  assert.deepEqual(githubRows({ repos, query: 'rag', library, inRail }).map((entry) => entry.repo.id), ['7'], 'the description counts');
  assert.deepEqual(githubRows({ repos, query: 'mathetic desktop', library, inRail }).map((entry) => entry.repo.id), ['9'], 'every word, anywhere');
  assert.deepEqual(githubRows({ repos, query: 'nothing', library, inRail }), []);
  assert.equal(heldRow(repo('9', 'Mathetic-PBC/renamed-since'), library).id, 'a', 'the GitHub id wins over a changed name');
  assert.equal(heldRow(repo('1', 'someone/else'), library), null);
});
