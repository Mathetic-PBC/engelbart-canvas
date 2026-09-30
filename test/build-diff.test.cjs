'use strict';

// The Build card's diff (src/renderer/model/build-diff.js, 2026-09-29): git's patch as rows, file headers first.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/build-diff.js')).href);

const PATCH = [
  'diff --git a/src/a.cjs b/src/a.cjs',
  'index 1111111..2222222 100644',
  '--- a/src/a.cjs',
  '+++ b/src/a.cjs',
  '@@ -1,3 +1,3 @@ function a()',
  ' keep',
  '-old',
  '+new',
  '\\ No newline at end of file',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..3333333',
  'Binary files /dev/null and b/logo.png differ',
  '',
].join('\n');
const FILES = [{ path: 'src/a.cjs', was: null, status: 'M', adds: 1, dels: 1, binary: false }, { path: 'logo.png', was: null, status: 'A', adds: 0, dels: 0, binary: true }];

test('a patch becomes a header per file and its lines; git\'s bookkeeping lines are left out', async () => {
  const { diffRows, diffTotals } = await load();
  const { rows, cut, truncated } = diffRows({ files: FILES, patch: PATCH });
  assert.deepEqual(rows.map((row) => [row.kind, row.path || row.text]), [
    ['file', 'src/a.cjs'], ['hunk', '@@ -1,3 +1,3 @@ function a()'], ['ctx', ' keep'], ['del', '-old'], ['add', '+new'], ['note', 'No newline at end of file'],
    ['file', 'logo.png'], ['note', 'Binary file'],
  ]);
  assert.equal(rows[6].binary, true);
  assert.deepEqual([cut, truncated], [0, false]);
  assert.deepEqual(diffTotals(FILES), { files: 2, adds: 1, dels: 1 });
});

test('a long diff is cut to its first lines, and a file the patch never reached keeps its header', async () => {
  const { diffRows } = await load();
  const { rows, cut } = diffRows({ files: [...FILES, { path: 'late.txt', adds: 3, dels: 0 }], patch: PATCH, truncated: true }, { maxLines: 2 });
  assert.equal(cut, 3);
  assert.deepEqual(rows.filter((row) => row.kind === 'file').map((row) => row.path), ['src/a.cjs', 'logo.png', 'late.txt']);
});

test('a reply\'s next [Attachment n] follows every image the Build was sent and the draft holds', async () => {
  const { nextAttachment } = await load();
  assert.equal(nextAttachment([], []), 1);
  assert.equal(nextAttachment([{ role: 'you', images: [{ n: 1, id: 'a' }, { n: 2, id: 'b' }] }, { role: 'agent' }], [{ n: 3, id: null }]), 4);
});
