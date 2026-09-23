'use strict';

// What the Stage is given for a path (src/main/stage/files.cjs, 2026-09-23).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { readStageFile } = require('../src/main/stage/files.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-stage-'));
const cacheDir = path.join(dir, '.cache', 'stage');
const at = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
// a 1×1 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('by format: folder, pdf bytes, html page, markdown, csv and tsv, picture, other text, binary', async () => {
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.deepEqual(await readStageFile(path.join(dir, 'sub'), { cacheDir }), { kind: 'folder', path: path.join(dir, 'sub'), name: 'sub' });
  const pdf = await readStageFile(at('Paper.pdf', '%PDF-1.4 x'), { cacheDir });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.name, 'Paper');
  assert.equal(Buffer.from(pdf.bytes).toString(), '%PDF-1.4 x');
  assert.equal(fileURLToPath(pdf.url), path.join(dir, 'Paper.pdf'));
  const page = await readStageFile(at('r.html', '<p>x'), { cacheDir });
  assert.equal(page.kind, 'page');
  assert.equal(fileURLToPath(page.url), path.join(dir, 'r.html'));
  assert.deepEqual(await readStageFile(at('a.md', '# A'), { cacheDir }), { kind: 'md', path: path.join(dir, 'a.md'), name: 'a.md', text: '# A', truncated: false });
  assert.equal((await readStageFile(at('t.csv', 'a,b'), { cacheDir })).delimiter, ',');
  assert.equal((await readStageFile(at('t.tsv', 'a\tb'), { cacheDir })).delimiter, '\t');
  const png = await readStageFile(at('p.png', PNG), { cacheDir });
  assert.equal(png.mime, 'image/png');
  assert.equal(png.bytes.byteLength, PNG.length);
  const json = await readStageFile(at('d.json', '{"a":1}'), { cacheDir });
  assert.deepEqual([json.kind, json.ext, json.text], ['text', 'json', '{"a":1}']);
  const blob = await readStageFile(at('b.bin', Buffer.from([1, 0, 2])), { cacheDir });
  assert.deepEqual([blob.kind, blob.ext], ['unsupported', 'bin']);
});

test('long text is cut at 500 000 characters and says so; a missing path throws', async () => {
  const long = await readStageFile(at('long.txt', 'x'.repeat(500001)), { cacheDir });
  assert.equal(long.text.length, 500000);
  assert.equal(long.truncated, true);
  await assert.rejects(() => readStageFile(path.join(dir, 'nothing.md'), { cacheDir }), /Nothing is at that path/);
});

test('conversions run once per version of the file and land in the cache', async () => {
  const calls = [];
  const runTool = async (tool, args) => { calls.push(path.basename(tool)); fs.writeFileSync(tool.endsWith('textutil') ? args[3] : args[args.length - 1], tool.endsWith('textutil') ? '<p>hi</p>' : PNG); };
  const docx = at('w.docx', 'not really');
  const first = await readStageFile(docx, { cacheDir, runTool });
  assert.equal(first.kind, 'doc');
  assert.equal(first.path, docx);
  assert.ok(fileURLToPath(first.url).startsWith(cacheDir));
  await readStageFile(docx, { cacheDir, runTool });
  assert.deepEqual(calls, ['textutil']);
  const heic = await readStageFile(at('i.heic', 'x'), { cacheDir, runTool });
  assert.deepEqual([heic.kind, heic.mime, heic.path], ['image', 'image/jpeg', path.join(dir, 'i.heic')]);
  await assert.rejects(() => readStageFile(at('bad.rtf', 'x'), { cacheDir, runTool: async () => { throw new Error('no'); } }), /no/);
  assert.equal(fs.readdirSync(cacheDir).filter((name) => name.includes('.tmp')).length, 0);
});

test('macOS: a real docx through textutil, a real heic through sips', { skip: process.platform !== 'darwin' }, async () => {
  const txt = at('real.txt', 'Hello from a document');
  execFileSync('/usr/bin/textutil', ['-convert', 'docx', txt, '-output', path.join(dir, 'real.docx')]);
  const doc = await readStageFile(path.join(dir, 'real.docx'), { cacheDir });
  assert.match(fs.readFileSync(fileURLToPath(doc.url), 'utf8'), /Hello from a document/);
  const png = at('real.png', PNG);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', path.join(dir, 'real.heic')], { stdio: 'ignore' });
  const heic = await readStageFile(path.join(dir, 'real.heic'), { cacheDir });
  assert.deepEqual([...heic.bytes.slice(0, 2)], [0xff, 0xd8]);
});
