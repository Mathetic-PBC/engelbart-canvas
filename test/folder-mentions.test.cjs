'use strict';

// MATH-22 (2026-10-06): a file inside a library folder is mentioned as `@[Name](lib:<folderId>:<path>)`, its path
// percent-encoded a segment at a time. It is drawn as a chip with its kind's glyph, counts as a mention of its folder
// (linked on pick, unlinked after the last mention of the folder or a file in it), and the older tokens keep working.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const rail = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);

const AWKWARD = [
  'Smith 2024.pdf', 'Smith (2024).pdf', 'a [draft] ].md', 'notes #3.md', 'Ünïcödé — 論文.pdf', '100% done!.csv',
  "it's * ~ ok.pdf", 'sub dir/(nested) [x]/file #1.pdf', 'a%20literal.pdf', 'emoji 📄.pdf', 'semi;colon,comma=eq&amp+plus.pdf',
];

test('a path round-trips through its encoding, and the token stays one token whatever the name holds', async () => {
  const { encodeRel, decodeRel, fileMention, fileMentionOf, FILE_MENTION_RE, INLINE } = await doc();
  for (const rel of AWKWARD) {
    const enc = encodeRel(rel);
    assert.match(enc, /^[\w.~%/-]+$/, `${rel}: only token characters`);
    assert.equal(decodeRel(enc), rel, `${rel}: round-trips`);
    const name = rel.split('/').pop();
    const token = fileMention(name, 'f-1', rel);
    assert.match(token, FILE_MENTION_RE, rel);
    assert.deepEqual(fileMentionOf(token), { name: name.replace(/[[\]]/g, '').trim(), folderId: 'f-1', rel }, `${rel}: read back`);
    assert.deepEqual(`see ${token}, then **b**`.split(INLINE).filter(Boolean), ['see ', token, ', then ', '**b**'], `${rel}: one token`);
  }
  assert.equal(encodeRel('a//b/./c'), 'a/b/c');
  assert.equal(decodeRel('bad%E0%A4%A.pdf'), 'bad%E0%A4%A.pdf', 'a segment that does not decode is kept');
});

test('the older tokens still parse and draw as before', async () => {
  const { INLINE, LIB_MENTION_RE, WS_MENTION_RE, FILE_MENTION_RE, tokShown, inlineHtml, noteParts } = await doc();
  const line = '@[Plain] @[A](lib:x-1) @[W](ws:y-2) @[F.pdf](lib:x-1:F.pdf)';
  assert.deepEqual(line.split(INLINE).filter(Boolean), ['@[Plain]', ' ', '@[A](lib:x-1)', ' ', '@[W](ws:y-2)', ' ', '@[F.pdf](lib:x-1:F.pdf)']);
  assert.match('@[A](lib:x-1)', LIB_MENTION_RE);
  assert.doesNotMatch('@[A](lib:x-1)', FILE_MENTION_RE);
  assert.doesNotMatch('@[F.pdf](lib:x-1:F.pdf)', LIB_MENTION_RE);
  assert.match('@[W](ws:y-2)', WS_MENTION_RE);
  assert.deepEqual('@[A](lib:x-1:has space)'.split(INLINE).filter(Boolean), ['@[A]', '(lib:x-1:has space)'], 'only an encoded path makes it one');
  assert.deepEqual(tokShown('@[F.pdf](lib:x-1:F.pdf)'), { shown: '@F.pdf', pre: 1 });
  assert.match(inlineHtml('@[A](lib:x-1)'), /data-lib="x-1"/);
  assert.match(inlineHtml('@[Plain]'), /data-mention="Plain"/);
  assert.match(inlineHtml('@[W](ws:y-2)'), /data-ws="y-2"/);
  assert.deepEqual(noteParts('a @[A](lib:x-1) b @[F.pdf](lib:x-1:sub/F.pdf) c'), ['a ', '@[A](lib:x-1)', ' b ', '@[F.pdf](lib:x-1:sub/F.pdf)', ' c']);
});

test('a file mention is a chip with its kind\'s glyph, "folder / path" on hover, grey when the file is gone', async () => {
  const { inlineHtml, noteHtml, noteOffset, fileMention, fileKindOf } = await doc();
  const token = fileMention('Smith (2024).pdf', 'f-1', 'sub dir/Smith (2024).pdf');
  const libName = (id) => (id === 'f-1' ? 'Papers' : null);
  const live = inlineHtml(`see ${token}`, { libName, fileState: () => ({ dir: false }) });
  assert.match(live, /data-mention="Smith \(2024\)\.pdf" data-folder="f-1" data-file="sub dir\/Smith \(2024\)\.pdf" title="Papers \/ sub dir\/Smith \(2024\)\.pdf"/);
  assert.match(live, /color:#0070f3/);
  assert.match(live, /@<svg[^>]*>.*<\/svg>Smith \(2024\)\.pdf<\/span>$/, 'the glyph after the @');
  const unknown = inlineHtml(token, { libName });
  assert.match(unknown, /color:#0070f3/, 'not known yet: drawn as there');
  const gone = inlineHtml(token, { libName, fileState: () => false });
  assert.match(gone, /data-missing="1" title="Not found: Papers \/ sub dir\/Smith \(2024\)\.pdf"/);
  assert.match(gone, /data-folder="f-1"/, 'still clickable, to be told it is gone');
  const folderGone = inlineHtml(token, { libName: () => null });
  assert.doesNotMatch(folderGone, /data-folder/, 'its folder left the library: grey, nothing to click');
  assert.match(noteHtml(`a ${token}`, { libName, fileState: () => false }), /data-file="sub dir\/Smith \(2024\)\.pdf"/, 'a margin note draws it too');
  assert.equal(noteOffset(`a ${token} b`, 1, 3), 2 + token.length, 'a click on the chip lands after it');
  assert.deepEqual(['x.pdf', 'x.MD', 'x.csv', 'x.png', 'x.html', 'x.docx', 'x.zip', 'x'].map(fileKindOf), ['pdf', 'md', 'data', 'image', 'html', 'md', 'file', 'file']);
});

test('a file mention is a mention of its folder: linked on pick, unlinked only after the last mention of the folder or a file in it', async () => {
  const { mentionedIds, pickedChanges } = await rail();
  const { fileMention } = await doc();
  const library = [{ id: 'f-1', name: 'Papers', type: 'folder', folder_path: '/p' }, { id: 'n-1', name: 'Note', type: 'md', tags: ['note'] }];
  const a = fileMention('A.pdf', 'f-1', 'A.pdf'), b = fileMention('B.pdf', 'f-1', 'sub/B.pdf');
  assert.deepEqual([...mentionedIds(`${a} and ${b}`, library)], ['f-1']);
  assert.deepEqual([...mentionedIds('@[Papers]', library)], ['f-1'], 'the folder by name, as before');
  const picked = ['f-1'];
  const step = (before, after, dropped = new Set()) => pickedChanges({ before: mentionedIds(before, library), after: mentionedIds(after, library), picked, dropped });
  assert.deepEqual(step('', a), { unlink: [], relink: [] }, 'picked: linked by the pick itself (onMentionPicked), nothing to undo');
  assert.deepEqual(step(`${a} ${b}`, b), { unlink: [], relink: [] }, 'another file of the folder is still mentioned');
  assert.deepEqual(step(`${a} @[Papers]`, '@[Papers]'), { unlink: [], relink: [] }, 'the folder itself is still mentioned');
  assert.deepEqual(step(b, ''), { unlink: ['f-1'], relink: [] }, 'the last one gone: unlinked');
  assert.deepEqual(step('', b, new Set(['f-1'])), { unlink: [], relink: ['f-1'] }, '⌘Z brings it back: linked again');
});

test('the @ menu in a folder: back, "Mention this folder", subfolders then files; typed, the matches; cut at ten with how many more', async () => {
  const { folderRows, firstPick, parentRel, isFolderRow, isBrowsable, mentionRows } = await rail();
  const row = { id: 'f-1', name: 'Papers', type: 'folder', tags: [], folder_path: '/p' };
  assert.ok(isBrowsable(row) && isBrowsable({ ...row, tags: ['git'] }));
  assert.ok(!isBrowsable({ id: 'w', type: 'website', tags: ['git'], url: 'https://github.com/a/b' }), 'a repository not on this Mac is mentioned, not opened');
  assert.ok(isFolderRow(mentionRows({ query: 'pap', library: [row] }).find((m) => m.key === 'f-1')));
  const entries = [{ name: 'sub', rel: 'sub', dir: true, type: 'folder' }, ...Array.from({ length: 12 }, (_, i) => ({ name: `paper ${i}.pdf`, rel: `paper ${i}.pdf`, dir: false, type: 'pdf' }))];
  const top = folderRows({ browse: { row, rel: '' }, listing: { entries, total: 13 }, query: '' });
  assert.deepEqual(top.slice(0, 4).map((m) => [m.kind, m.name]), [['back', 'All'], ['self', 'Mention this folder'], ['entry', 'sub'], ['entry', 'paper 0.pdf']]);
  assert.equal(top.filter((m) => m.kind === 'entry').length, 10);
  assert.deepEqual(top[top.length - 1], { kind: 'note', key: 'note:more', name: '3 more: type to narrow' });
  assert.equal(firstPick(top), 2, 'the keyboard starts on the first entry');
  const typed = folderRows({ browse: { row, rel: '' }, listing: { entries, total: 13 }, query: 'PAPER 1' });
  assert.deepEqual(typed.map((m) => m.name), ['paper 1.pdf', 'paper 10.pdf', 'paper 11.pdf'], 'typed: only what holds it, no back or self row');
  const inSub = folderRows({ browse: { row, rel: 'sub/deeper' }, listing: { entries: [], total: 0 }, query: '' });
  assert.deepEqual(inSub.map((m) => [m.kind, m.name]), [['back', 'sub'], ['self', 'Mention this folder'], ['note', 'Nothing here to mention']]);
  assert.deepEqual([inSub[1].rel, inSub[1].entryName], ['sub/deeper', 'deeper'], 'a subfolder is mentioned by its path');
  assert.deepEqual(folderRows({ browse: { row, rel: '' }, listing: { missing: true }, query: '' }).map((m) => [m.kind, m.name]), [['back', 'All'], ['note', 'This folder is not on this Mac any more']]);
  assert.deepEqual(folderRows({ browse: { row, rel: '' }, listing: undefined, query: '' }).map((m) => m.kind), ['back', 'note']);
  assert.deepEqual([parentRel('a/b'), parentRel('a'), parentRel('')], ['a', '', null]);
});
