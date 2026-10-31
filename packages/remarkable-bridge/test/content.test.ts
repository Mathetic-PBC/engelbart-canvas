import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseContent } from '../src/doc/content.ts';
import { parseMetadata, isTrashed } from '../src/doc/metadata.ts';
import { openBundle } from '../src/doc/bundle.ts';
import { RmFormatError } from '../src/doc/json.ts';

const lww = (value: unknown) => ({ timestamp: '1:1', value });

test('cPages: display order is idx (not the array), deleted pages dropped, redir absolute', () => {
  // A 3-page PDF with pages inserted after its first and second pages, then its second page moved to the end and an
  // inserted page deleted.
  const content = parseContent(JSON.stringify({
    fileType: 'pdf',
    formatVersion: 2,
    originalPageCount: 3,
    cPages: {
      pages: [
        { id: 'p0', idx: lww('ba'), redir: lww(0) },
        { id: 'p1', idx: lww('bd'), redir: lww(1) },
        { id: 'ins1', idx: lww('bab') },
        { id: 'gone', idx: lww('bb'), deleted: lww(1) },
        { id: 'p2', idx: lww('bc'), redir: lww(2), template: lww('Blank') },
      ],
    },
  }));
  assert.deepEqual(content.pages.map((p) => [p.id, p.index, p.sourcePage]), [['p0', 0, 0], ['ins1', 1, null], ['p2', 2, 2], ['p1', 3, 1]]);
  assert.equal(content.pages[2]!.template, 'Blank');
});

test('cPages without any redir on a PDF: its pages one for one', () => {
  const content = parseContent(JSON.stringify({ fileType: 'pdf', cPages: { pages: [{ id: 'a', idx: lww('ba') }, { id: 'b', idx: lww('bb') }] } }));
  assert.deepEqual(content.pages.map((p) => p.sourcePage), [0, 1]);
});

test('legacy pages and redirectionPageMap (-1: inserted), templates from .pagedata', () => {
  const content = parseContent(JSON.stringify({ fileType: 'pdf', pages: ['a', 'b', 'c'], redirectionPageMap: [0, -1, 1] }), 'Blank\nP Lines small\nBlank\n');
  assert.deepEqual(content.pages.map((p) => [p.id, p.sourcePage, p.template]), [['a', 0, 'Blank'], ['b', null, 'P Lines small'], ['c', 1, 'Blank']]);
  assert.deepEqual(parseContent(JSON.stringify({ fileType: 'pdf', pages: ['a', 'b'], redirectionPageMap: null })).pages.map((p) => p.sourcePage), [0, 1]);
});

test('notebooks have no source page; folders have no pages; odd fields are tolerated', () => {
  const nb = parseContent(JSON.stringify({ fileType: 'notebook', pages: ['a'], tags: [{ name: 'Work' }, 'old'], documentMetadata: { title: 'T', authors: ['X', 3] } }));
  assert.deepEqual([nb.pages[0]!.sourcePage, nb.tags, nb.title, nb.authors], [null, ['Work', 'old'], 'T', ['X']]);
  assert.deepEqual(parseContent('{}').pages, []);
  assert.equal(parseContent(JSON.stringify({ fileType: '' })).fileType, 'notebook');
  assert.throws(() => parseContent('not json'), RmFormatError);
});

test('metadata: kinds, timestamps as strings, trash', () => {
  const m = parseMetadata(JSON.stringify({ visibleName: 'Paper', type: 'CollectionType', parent: 'trash', lastModified: '1786022558398', pinned: true }));
  assert.deepEqual([m.name, m.kind, m.lastModified, m.pinned, isTrashed(m)], ['Paper', 'folder', 1786022558398, true, true]);
  assert.equal(parseMetadata('{}').kind, 'unknown');
});

test('a real notebook bundle (notable fixture): 12 pages in order, with templates and ink', async () => {
  const dir = path.join(import.meta.dirname, 'fixtures', 'xochitl');
  const read = async (name: string) => { try { return new Uint8Array(await fs.promises.readFile(path.join(dir, name))); } catch { return null; } };
  const bundle = await openBundle('f63a4691-25eb-43c5-95b0-a20c2dbeb80b', read);
  assert.equal(bundle.metadata.name, 'Test');
  assert.equal(bundle.content.fileType, 'notebook');
  assert.equal(bundle.content.pages.length, 12);
  assert.ok(bundle.content.pages.every((p) => p.template === 'P Grid medium' && p.sourcePage === null));
  const first = await bundle.page(bundle.content.pages[0]!.id);
  assert.ok(first && new TextDecoder().decode(first.subarray(0, 33)) === 'reMarkable .lines file, version=6');
  assert.equal(await bundle.source(), null);
  await assert.rejects(openBundle('../etc', read), RmFormatError);
});
