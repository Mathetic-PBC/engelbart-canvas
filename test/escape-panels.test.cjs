'use strict';

// Escape in a sidebar section's + panel (MATH-44, 2026-10-06). The panel took every Escape, but while it is adding it
// cannot close, so the key was lost to the terminal and the editor until the add finished.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');

test('a section\'s + panel lets Escape through to a terminal or an editor while it is adding', () => {
  const rail = read('workspace/Rail.jsx');
  assert.match(rail, /const own = \(panelRef\.current && panelRef\.current\.contains\(event\.target\)\) \|\| event\.target === document\.body \|\| event\.target === document\.documentElement;/);
  assert.match(rail, /if \(live\.current && !own\) return;\s*event\.preventDefault\(\); event\.stopPropagation\(\); close\(\);/);
});
