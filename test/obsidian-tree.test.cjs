'use strict';

// Choose files under Obsidian (2026-10-14): the vaults as Obsidian's file explorer shows them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { obsidianTree } = require('../src/main/onboarding/obsidian-tree.cjs');

function home() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-tree-')));
  const write = (rel, text = '') => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write('Vault/.obsidian/app.json', '{}');
  write('Vault/.trash/old.md');
  write('Vault/zeta.md');
  write('Vault/Alpha.md');
  write('Vault/Memex/Note 10.md');
  write('Vault/Memex/Note 2.md');
  write('Vault/Memex/paper.pdf');
  write('Vault/Memex/script.js');
  write('Vault/Attachments/figure.png');
  write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { a: { path: path.join(root, 'Vault'), ts: 1 }, gone: { path: path.join(root, 'Missing'), ts: 2 } } }));
  return root;
}

test('folders first, then notes without .md, by name as Obsidian sorts; hidden folders and unreadable files left out', async () => {
  const root = home();
  const out = await obsidianTree(root, { platform: 'darwin' }); // the fixture is a Mac's: ~/Library/Application Support/obsidian
  assert.equal(out.vaults.length, 1, 'a vault that is gone is left out');
  const [vault] = out.vaults;
  assert.equal(vault.name, 'Vault');
  assert.deepEqual(vault.tree.map((node) => node.name), ['Attachments', 'Memex', 'Alpha', 'zeta']);
  const memex = vault.tree.find((node) => node.name === 'Memex');
  assert.equal(memex.dir, true);
  assert.deepEqual(memex.children.map((node) => node.name), ['Note 2', 'Note 10', 'paper.pdf']);
  assert.equal(memex.children[0].path, path.join(root, 'Vault/Memex/Note 2.md'));
  assert.equal(out.truncated, false);
});

test('capped, and says so', async () => {
  const out = await obsidianTree(home(), { maxEntries: 3, platform: 'darwin' });
  const count = (nodes) => nodes.reduce((n, node) => n + 1 + (node.children ? count(node.children) : 0), 0);
  assert.ok(count(out.vaults[0].tree) <= 3);
  assert.equal(out.truncated, true);
});

test('no Obsidian: no vaults', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-none-')));
  assert.deepEqual(await obsidianTree(root), { vaults: [], truncated: false });
});
