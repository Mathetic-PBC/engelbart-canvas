'use strict';

// The workspace's shortcuts off the Mac (2026-10-18, from windows-beta-deployment's 6c5710e): Linux's keyboard has Ctrl
// where a Mac has ⌘, as Windows' does (src/renderer/ui/keys.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const keysModule = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/ui/keys.js')).href);

test('the workspace\'s shortcuts off the Mac: Ctrl where a Mac has ⌘ (next agent, a doc\'s tabs and find), and their labels say so', async () => {
  const { modDown, keyLabels } = await keysModule();
  const press = (fields) => ({ metaKey: false, ctrlKey: false, ...fields });
  assert.equal(modDown(press({ metaKey: true }), true), true);
  assert.equal(modDown(press({ ctrlKey: true }), true), false, 'on a Mac Ctrl is another key');
  assert.equal(modDown(press({ ctrlKey: true }), false), true);
  assert.equal(modDown(press({ metaKey: true }), false), false, 'the Super key is not it');
  assert.equal(modDown(press({ ctrlKey: true, metaKey: true }), false), false);
  assert.deepEqual(keyLabels(true), { mod: '⌘', ctrl: '⌃', alt: '⌥' });
  assert.deepEqual(keyLabels(false), { mod: 'Ctrl+', ctrl: 'Ctrl+', alt: 'Alt' });
});
