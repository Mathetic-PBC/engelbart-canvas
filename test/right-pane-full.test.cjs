'use strict';

// The right pane's full screen (src/renderer/screens/Workspace.jsx, 2026-10-06): the Stage had it and the Terminal did
// not. Either one in front can take the document's place now, from the same arrows at the end of its tab row, and
// switching between them keeps it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');

test('the full screen is the right pane\'s, not only the Stage\'s', () => {
  const workspace = read('screens/Workspace.jsx');
  assert.match(workspace, /const full = stageFull;/);
  assert.doesNotMatch(workspace, /stageFull && rightMode === 'stage'/);
});

test('the Terminal is handed the full screen and draws its button at the end of its tabs, as the Stage does', () => {
  assert.match(read('workspace/RightPane.jsx'), /<TerminalPane [^>]*full=\{full\} onFull=\{onFull\}/);
  const terminal = read('terminal/TerminalPane.jsx');
  assert.match(terminal, /export default function TerminalPane\(\{[^}]*full = false, onFull = null \}\)/);
  assert.match(terminal, /\{onFull && \(\s*<button type="button" className="hov-wash2" onClick=\{\(\) => \{ card\.hide\(\); onFull\(\); \}\} aria-label=\{full \? 'Exit full screen' : 'Full screen'\} title=\{full \? 'Exit full screen' : 'Full screen'\} data-term-full=/);
  assert.match(terminal, /\{full \? <Collapse \/> : <Expand \/>\}/);
});
