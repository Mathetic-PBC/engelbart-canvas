import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createFolderSource } from '../src/sources/folder.ts';
import { readDocument, documentMarkdown } from '../src/document.ts';
import { documentToPdf } from '../src/export/pdf.ts';
import { hasHandwriting, readHandwriting, type HandwrittenLine, type RawLine } from '../src/ocr/handwriting.ts';

const XOCHITL = path.join(import.meta.dirname, 'fixtures', 'xochitl');
const notebook = async () => {
  const source = createFolderSource(XOCHITL);
  const [entry] = await source.list();
  return readDocument(await source.open(entry!.id));
};
/** A recognizer that reads one line on every page, and counts the PDFs it was given. */
function fakeReader() {
  const calls: number[] = [];
  const recognize = async (pdf: Uint8Array): Promise<RawLine[][]> => {
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    calls.push(pages);
    return Array.from({ length: pages }, (_, i) => [{ text: `line on ${i}`, confidence: 0.9, box: [0.1, 0.8, 0.5, 0.1] }]);
  };
  return { recognize, calls };
}

test('handwriting is read once per page: the cache keeps it while the page is unchanged', async () => {
  const doc = await notebook();
  const written = doc.pages.filter(({ page }) => hasHandwriting(page));
  assert.ok(written.length > 0, 'the fixture notebook is handwritten');
  const kept = new Map<string, HandwrittenLine[]>();
  const cache = { get: (d: string) => kept.get(d), set: (d: string, lines: HandwrittenLine[]) => { kept.set(d, lines); } };
  const { recognize, calls } = fakeReader();
  const first = await readHandwriting(doc, { recognize, cache });
  assert.deepEqual([first.pages, first.unread, first.supported], [written.length, 0, true]);
  assert.deepEqual(calls, [written.length], 'every handwritten page in one pass');
  const line = first.handwriting.get(written[0]!.ref.id)![0]!;
  assert.equal(line.text, 'line on 0');
  assert.ok(line.w > 0 && line.h > 0 && Number.isFinite(line.x) && Number.isFinite(line.y), 'a box in page units');
  const again = await readHandwriting(doc, { recognize, cache });
  assert.equal(calls.length, 1, 'nothing read again');
  assert.equal(again.handwriting.size, written.length);
});

test("mode 'cached' reads nothing and says what is left; without a reader nothing is pending", async () => {
  const doc = await notebook();
  const { recognize, calls } = fakeReader();
  const cached = await readHandwriting(doc, { recognize, mode: 'cached' });
  assert.equal(calls.length, 0);
  assert.equal(cached.unread, cached.pages);
  const none = await readHandwriting(doc, { recognize: undefined as never, mode: 'cached' });
  assert.ok(none.supported || process.platform === 'darwin');
});

test('read handwriting goes into the Markdown, marked as machine-read, and into the PDF', async () => {
  const doc = await notebook();
  const { recognize } = fakeReader();
  const { handwriting } = await readHandwriting(doc, { recognize });
  const md = documentMarkdown(doc, { handwriting });
  assert.match(md, /\*Handwriting, as read by machine \(it can be wrong\):\*\n\nline on 0 {2}/);
  const plain = await documentToPdf(doc);
  const withText = await documentToPdf(doc, { handwriting });
  assert.ok(withText.length > plain.length, 'the invisible text is in it');
});

test('a line read as Markdown syntax stays text', async () => {
  const doc = await notebook();
  const id = doc.pages.find(({ page }) => hasHandwriting(page))!.ref.id;
  const md = documentMarkdown(doc, { handwriting: new Map([[id, [{ text: '# not a heading *or bold*', confidence: 1, x: 0, y: 0, w: 1, h: 1 }]]]) });
  assert.match(md, /\\# not a heading \\\*or bold\\\*/);
});

test('the Mac reads the fixture notebook\'s handwriting', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const doc = await notebook();
  const first = doc.pages.find(({ page }) => hasHandwriting(page))!;
  const one = { ...doc, pages: [first] };
  const { handwriting, supported } = await readHandwriting(one);
  assert.equal(supported, true);
  const lines = handwriting.get(first.ref.id) ?? [];
  assert.ok(lines.length > 0, 'something read');
  assert.ok(lines.every((l) => l.text && l.confidence >= 0 && l.confidence <= 1));
});

test('what handwriting is read as never becomes Markdown structure or HTML', async () => {
  const doc = await notebook();
  const id = doc.pages.find(({ page }) => hasHandwriting(page))!.ref.id;
  const lines = ['Meeting', '---', '===', '| a | b |', '<img src=x onerror=alert(1)>', '12. item', '# not a heading *or bold*'];
  const md = documentMarkdown(doc, { handwriting: new Map([[id, lines.map((text) => ({ text, confidence: 1, x: 0, y: 0, w: 1, h: 1 }))]]) });
  for (const expected of ['Meeting  ', '\\---  ', '\\===  ', '\\| a \\| b \\|  ', '\\<img src=x onerror=alert(1)\\>  ', '12\\. item  ', '\\# not a heading \\*or bold\\*  ']) {
    assert.ok(md.includes(`\n${expected}`), `${JSON.stringify(expected)} in ${md}`);
  }
});

test('a long notebook is read a batch at a time: stopped part way, what was read is kept', async () => {
  const doc = await notebook();
  const written = doc.pages.filter(({ page }) => hasHandwriting(page));
  // Twenty copies of the handwritten pages: more than one batch.
  const many = { ...doc, pages: Array.from({ length: 20 }, (_, i) => written.map((p) => ({ ...p, ref: { ...p.ref, id: `${p.ref.id}-${i}` }, digest: `${p.digest}${i}` }))).flat() };
  const kept = new Map<string, HandwrittenLine[]>();
  const cache = { get: (d: string) => kept.get(d), set: (d: string, l: HandwrittenLine[]) => { kept.set(d, l); } };
  const controller = new AbortController();
  let batches = 0;
  const recognize = async (pdf: Uint8Array) => {
    batches += 1;
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    if (batches === 2) controller.abort(); // stopped while the second batch is read
    return Array.from({ length: pages }, () => [{ text: 'x', confidence: 1, box: [0, 0, 1, 1] as [number, number, number, number] }]);
  };
  await assert.rejects(readHandwriting(many, { recognize, cache, signal: controller.signal }), /abort/i);
  assert.equal(batches, 2);
  assert.equal(kept.size, Math.min(32, many.pages.length), 'two batches of 16 kept');
});
