'use strict';

// A mention in the document is one thing (src/renderer/workspace/DocEditor.jsx, MATH-56 and MATH-57, 2026-10-06). It shows
// its raw text only with the caret strictly inside it, so one just picked from the @ menu shows finished; Backspace right
// after it, or Delete right before it, takes the whole token, and ⌘Z brings it back. An item the @ menu linked leaves the
// workspace with the document's last mention of it, and comes back with the undo (model/rail.js pickedChanges). There is
// no document here: the editor and its elements are stand-ins, as in doc-editor-edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-mention-keys-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const DocEditor = load('DocEditor.jsx').default;
const rail = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);

const LIBRARY = [{ id: 'p1', name: 'Paper', type: 'pdf' }, { id: 's1', name: 'Side', type: 'md' }];

function mounted(lines) {
  const picked = [];
  const props = { docKey: 'k', text: lines.join('\n'), mentionable: LIBRARY, onChange: (next) => { props.text = next; }, onMentionPicked: (r) => picked.push(r.id) };
  const editor = new DocEditor(props);
  editor.props = props;
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.scrollRef = { current: null };
  editor.caretInfo = () => null; // no page: the caret is what caretAt says
  const caretAt = (line, offset) => { editor.caretInfo = () => ({ anchor: { line, offset }, focus: { line, offset } }); };
  const key = (k, extra = {}) => {
    const e = { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    editor.editorKey(e);
    return e;
  };
  return { editor, props, picked, caretAt, key, lines: () => editor.lines() };
}
// The active line as drawn: each token's source and whether it shows it.
const drawn = (editor) => [...editor.editorHtml().matchAll(/data-src="([^"]*)" data-open="(\d)"/g)].map(([, src, open]) => [src, open === '1']);

test('a mention picked from the @ menu shows finished with the caret right after it; strictly inside, it opens (MATH-56)', () => {
  const m = mounted(['See @Pa']);
  m.editor.state.mention = { i: 0, start: 4, caret: 7, query: 'Pa' };
  m.editor.pickMention(LIBRARY[0]);
  assert.equal(m.lines()[0], 'See @[Paper]', 'no space after it (MATH-11)');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 12 });
  assert.deepEqual(m.picked, ['p1']);
  assert.deepEqual(drawn(m.editor), [['See ', true], ['@[Paper]', false]], 'drawn, not its source');

  const at = (offset) => { m.editor.caret = { line: 0, offset }; return drawn(m.editor).find(([src]) => src.startsWith('@['))[1]; };
  assert.equal(at(4), false, 'at its start: drawn');
  assert.equal(at(5), true, 'inside: its source');
  assert.equal(at(11), true);
  assert.equal(at(12), false, 'at its end: drawn');
  // Other markup still opens when the caret touches it.
  assert.deepEqual(m.editor.openIdx(['a ', '**b**'], 2, 2), [1]);
  assert.deepEqual(m.editor.openIdx(['a ', '@[b]', ' c'], 6, 6), []);
});

test('a caret read back from the end of a drawn mention is after it, so the mention stays drawn (MATH-56)', () => {
  const m = mounted(['See @[Paper]']);
  const span = { nodeName: 'SPAN', nodeType: 1, dataset: { src: '@[Paper]', open: '0' }, textContent: '@Paper' };
  const line = { childNodes: [{ nodeName: '#text', nodeType: 3, textContent: 'See ' }, span] };
  assert.equal(m.editor.displayToRaw(line, 10), 12, 'after the `]`, not before it');
  assert.equal(m.editor.displayToRaw(line, 7), 8, 'inside it ("@P|aper"): inside its name ("@[P|aper]")');
  m.editor.state.activeLine = 0;
  m.editor.caret = { line: 0, offset: m.editor.displayToRaw(line, 10) };
  assert.deepEqual(drawn(m.editor), [['See ', true], ['@[Paper]', false]]);
});

test('what is typed at a drawn mention\'s edge, inside its span, is the line\'s text beside it (MATH-56)', () => {
  const m = mounted(['See @[Paper](lib:p1)']);
  const span = (text) => ({ nodeName: 'SPAN', nodeType: 1, dataset: { src: '@[Paper](lib:p1)', open: '0' }, textContent: text });
  const plain = (text) => ({ nodeName: '#text', nodeType: 3, textContent: text });
  const after = { childNodes: [plain('See '), span('@Paper!')] };
  assert.equal(m.editor.activeRaw(after), 'See @[Paper](lib:p1)!');
  assert.equal(m.editor.displayToRaw(after, 11), 'See @[Paper](lib:p1)!'.length, 'the caret after what was typed');
  const before = { childNodes: [span('x@Paper')] };
  assert.equal(m.editor.activeRaw(before), 'x@[Paper](lib:p1)');
  assert.equal(m.editor.displayToRaw(before, 1), 1);
  assert.equal(m.editor.activeRaw({ childNodes: [plain('See '), span('@Paper')] }), 'See @[Paper](lib:p1)', 'untouched, its source');
});

test('Backspace right after a mention takes all of it, Delete right before it too; ⌘Z brings it back whole (MATH-57)', () => {
  const line = 'Read @[Paper](lib:p1) and @[Other](ws:w1) then @[Side].';
  const m = mounted([line, '']);

  m.caretAt(0, line.indexOf(' and'));
  assert.equal(m.key('Backspace').prevented, true);
  assert.equal(m.lines()[0], 'Read  and @[Other](ws:w1) then @[Side].', 'with its (lib:…)');
  assert.deepEqual(m.editor.caret, { line: 0, offset: 5 });
  m.key('z', { metaKey: true });
  assert.equal(m.lines()[0], line, 'one ⌘Z, the whole mention');

  m.caretAt(0, line.indexOf('@[Other]'));
  assert.equal(m.key('Delete').prevented, true);
  assert.equal(m.lines()[0], 'Read @[Paper](lib:p1) and  then @[Side].', 'with its (ws:…)');
  m.key('z', { metaKey: true });
  assert.equal(m.lines()[0], line);

  m.caretAt(0, line.length - 1);
  m.key('Backspace');
  assert.equal(m.lines()[0], 'Read @[Paper](lib:p1) and @[Other](ws:w1) then .', 'a mention by name');
  m.key('z', { metaKey: true });

  // Anywhere else Backspace and Delete are the browser's: inside a mention, beside a space, with ⌥ or ⌘.
  for (const [k, offset, extra] of [['Backspace', 8, {}], ['Backspace', 4, {}], ['Delete', line.indexOf('@[Paper]') - 1, {}], ['Backspace', line.indexOf(' and'), { altKey: true }], ['Backspace', line.indexOf(' and'), { metaKey: true }]]) {
    m.caretAt(0, offset);
    assert.equal(m.key(k, extra).prevented, false, `${k} at ${offset} ${JSON.stringify(extra)}`);
  }
  assert.equal(m.lines()[0], line);
  // A mention inside bold is the bold's: not taken alone.
  const bold = mounted(['**@[Paper]** x']);
  bold.caretAt(0, 10);
  assert.equal(bold.key('Backspace').prevented, false);
  // In a list item too, and the mention just picked from the menu.
  const list = mounted(['- See @Pa']);
  list.editor.state.mention = { i: 0, start: 4, caret: 7, query: 'Pa' };
  list.editor.pickMention(LIBRARY[0]);
  list.caretAt(0, 12);
  list.key('Backspace');
  assert.equal(list.lines()[0], '- See ');
});

test('the only mention of a menu-picked item removed unlinks it and ⌘Z relinks it; a sidebar-added or twice-mentioned item stays (MATH-57)', async () => {
  const { mentionedIds, pickedChanges } = await rail();
  const line = 'See @[Paper] and @[Side](lib:s1).';
  const m = mounted([line]);
  const ids = () => mentionedIds(m.props.text, LIBRARY);
  const dropped = new Set();
  const edit = (fn) => {
    const before = ids(); fn(); const out = pickedChanges({ before, after: ids(), picked: ['p1'], dropped });
    for (const id of out.unlink) dropped.add(id);
    for (const id of out.relink) dropped.delete(id);
    return out;
  };
  assert.deepEqual([...ids()].sort(), ['p1', 's1']);

  // The only mention of the picked paper goes: unlinked. ⌘Z: linked again.
  assert.deepEqual(edit(() => { m.caretAt(0, line.indexOf(' and')); m.key('Backspace'); }), { unlink: ['p1'], relink: [] });
  assert.deepEqual(edit(() => m.key('z', { metaKey: true })), { unlink: [], relink: ['p1'] });
  assert.equal(m.lines()[0], line);
  // The sidebar-added one's only mention goes: it stays linked.
  assert.deepEqual(edit(() => { m.caretAt(0, line.length - 1); m.key('Backspace'); }), { unlink: [], relink: [] });

  // Mentioned twice: one goes, the item stays; the second goes too, and it leaves.
  const twice = mounted(['@[Paper] and @[paper]']);
  const twiceIds = () => mentionedIds(twice.props.text, LIBRARY);
  let before = twiceIds();
  twice.caretAt(0, 8); twice.key('Backspace');
  assert.deepEqual(pickedChanges({ before, after: twiceIds(), picked: ['p1'] }), { unlink: [], relink: [] });
  before = twiceIds();
  twice.caretAt(0, twice.lines()[0].length); twice.key('Backspace');
  assert.deepEqual(pickedChanges({ before, after: twiceIds(), picked: ['p1'] }), { unlink: ['p1'], relink: [] });
  // Workspace mentions are no library rows; a mention typed back that this window did not unlink links nothing.
  assert.deepEqual([...mentionedIds('@[W](ws:p1) @[Gone](lib:zz)', LIBRARY)], ['zz']);
  assert.deepEqual(pickedChanges({ before: new Set(), after: new Set(['p1']), picked: [], dropped: new Set() }), { unlink: [], relink: [] });
});

test('Workspace.jsx links what the @ menu picks as picked, and watches its own document for the last mention going (MATH-57)', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(src, /addInput\(item\.input, item\.name, \{ picked: true \}\)/);
  assert.match(src, /linkIds\(\[item\.row\.id\], \{ picked: true \}\)/);
  assert.match(src, /unlinkFromWorkspace\(project\.id, topic\.id, id, \{ unmentioned: true \}\)/);
  assert.match(src, /linkIds\(relink, \{ picked: true \}\)/);
});
