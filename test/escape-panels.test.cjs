'use strict';

// Escape in two panels on the workspace (2026-10-06). The "Import sign-ins…" picker (MATH-18) closed on Escape without
// taking the key, so the workspace's own Escape went on to leave the workspace; and with focus on the page (a browser
// row it unmounts) the picker never saw the key at all. A sidebar section's + panel (MATH-44) took every Escape, but
// while it is adding it cannot close, so the key was lost to the terminal and the editor until the add finished.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');

test('the Import sign-ins picker takes Escape before the workspace, wherever the keyboard is', () => {
  const picker = read('workspace/ImportSignins.jsx');
  assert.match(picker, /const onKey = \(event\) => \{ if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); onClose\(\); \} \};/);
  assert.match(picker, /window\.addEventListener\('keydown', onKey, true\);/);
  assert.match(picker, /return \(\) => window\.removeEventListener\('keydown', onKey, true\);/);
  assert.doesNotMatch(picker, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Escape'\) onClose\(\); \}\}/, 'no Escape left to bubble on to the workspace');
});

test('the sidebar\'s panels take Escape before the workspace, the newest one first, and Add sources stays open while it is adding (2026-10-07)', () => {
  const panels = read('workspace/SidebarPanels.jsx');
  assert.match(panels, /if \(event\.key !== 'Escape' \|\| layers\[layers\.length - 1\] !== layer\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*live\.current\(\);/);
  assert.match(panels, /window\.addEventListener\('keydown', key, true\);/, 'in the capture phase, before an editor or the workspace');
  const rail = read('workspace/Rail.jsx');
  assert.match(rail, /const closeAdd = React\.useCallback\(\(\) => \{ if \(!addBusy\.current\) setPanel\(null\); \}, \[\]\);/);
  assert.match(rail, /label="Add sources" onClose=\{closeAdd\}/);
  const trash = read('post-its/TrashPanel.jsx');
  assert.match(trash, /if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); onClose\(\); \}/, 'the trash marks the key used, so the workspace stays');
});
