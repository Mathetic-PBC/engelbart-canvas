import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createFolderSource } from '../src/sources/folder.ts';
import { SourceError } from '../src/sources/source.ts';
import { copyXochitl, decode, DOC_ID, RM_HEADER, tempDir, within, XOCHITL } from './helpers/fixture.ts';

const PAGE = '7e1fd0e7-0b74-428e-b174-e9efc8a22859';
const isRoot = process.getuid?.() === 0;
const cleanup: string[] = [];
after(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = copyXochitl();
  cleanup.push(dir);
  return dir;
};
const hasCode = (code: string) => (error: unknown) => error instanceof SourceError && error.code === code;

describe('createFolderSource', () => {
  it('lists the fixture with the right fields', async () => {
    const source = createFolderSource(XOCHITL);
    assert.equal(source.kind, 'folder');
    const entries = await source.list();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual({ ...entry!, version: undefined }, {
      id: DOC_ID,
      name: 'Test',
      parent: '',
      kind: 'document',
      fileType: 'notebook',
      lastModified: 1786022558398,
      pinned: false,
      trashed: false,
      version: undefined,
    });
    assert.match(entry!.version, /^[\w-]{16}$/);
  });

  it('lists folders and trashed documents, and ignores files that are not documents', async () => {
    const dir = scratch();
    const folder = '11111111-1111-4111-8111-111111111111';
    const trashed = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(path.join(dir, `${folder}.metadata`), JSON.stringify({ visibleName: 'Papers', type: 'CollectionType', parent: '' }));
    fs.writeFileSync(path.join(dir, `${folder}.content`), '{"tags": []}');
    fs.writeFileSync(path.join(dir, `${trashed}.metadata`), JSON.stringify({ visibleName: 'Old', type: 'DocumentType', parent: 'trash', pinned: true }));
    fs.writeFileSync(path.join(dir, `${trashed}.content`), JSON.stringify({ fileType: 'pdf' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a document');
    fs.writeFileSync(path.join(dir, 'not-a-uuid.metadata'), '{}');
    fs.writeFileSync(path.join(dir, '33333333-3333-4333-8333-333333333333.metadata'), '{"visibleName": "half-wri');

    const byId = new Map((await createFolderSource(dir).list()).map((entry) => [entry.id, entry]));
    assert.deepEqual([...byId.keys()].sort(), [DOC_ID, folder, trashed].sort());
    assert.equal(byId.get(folder)!.kind, 'folder');
    assert.equal(byId.get(folder)!.fileType, null);
    assert.equal(byId.get(trashed)!.trashed, true);
    assert.equal(byId.get(trashed)!.pinned, true);
    assert.equal(byId.get(trashed)!.fileType, 'pdf');
  });

  it('keeps the version stable, and changes it when one page is rewritten with the same size', async () => {
    const dir = scratch();
    const source = createFolderSource(dir);
    const first = (await source.list())[0]!.version;
    assert.equal((await source.list())[0]!.version, first);
    assert.equal((await createFolderSource(dir).list())[0]!.version, first, 'a new instance agrees');

    const page = path.join(dir, DOC_ID, `${PAGE}.rm`);
    const bytes = fs.readFileSync(page);
    bytes[bytes.length - 1]! ^= 0xff;
    fs.writeFileSync(page, bytes);
    // Some file systems keep whole seconds; make sure the rewrite is visible in the mtime.
    const later = new Date(fs.statSync(page).mtimeMs + 2000);
    fs.utimesSync(page, later, later);

    const dirMtime = fs.statSync(path.join(dir, DOC_ID)).mtimeMs;
    const second = (await source.list())[0]!.version;
    assert.notEqual(second, first);
    assert.equal(fs.statSync(path.join(dir, DOC_ID)).mtimeMs, dirMtime, 'the page folder itself did not change');
    assert.equal((await source.list())[0]!.version, second);
  });

  it('re-reads metadata that changed since the last list', async () => {
    const dir = scratch();
    const source = createFolderSource(dir);
    assert.equal((await source.list())[0]!.name, 'Test');
    const file = path.join(dir, `${DOC_ID}.metadata`);
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...metadata, visibleName: 'Renamed', pinned: true }));
    const [entry] = await source.list();
    assert.equal(entry!.name, 'Renamed');
    assert.equal(entry!.pinned, true);
  });

  it('opens the notebook: 12 pages of v6 ink', async () => {
    const bundle = await createFolderSource(XOCHITL).open(DOC_ID);
    assert.equal(bundle.id, DOC_ID);
    assert.equal(bundle.content.pages.length, 12);
    for (const page of bundle.content.pages) assert.ok(decode(await bundle.page(page.id)).startsWith(RM_HEADER), page.id);
    assert.equal(await bundle.source(), null);
    assert.equal(await bundle.file(`${DOC_ID}.pdf`), null);
  });

  it('refuses to read outside the document', async () => {
    const bundle = await createFolderSource(XOCHITL).open(DOC_ID);
    for (const name of ['../package.json', `${DOC_ID}/../../package.json`, '/etc/passwd', 'LICENSE-notable', `${DOC_ID}\\..\\x`, '00000000-0000-4000-8000-000000000000.metadata']) {
      await assert.rejects(bundle.file(name), hasCode('not-found'), name);
    }
  });

  it('says not-found for an unknown or malformed id', async () => {
    const source = createFolderSource(XOCHITL);
    await assert.rejects(source.open('00000000-0000-4000-8000-000000000000'), hasCode('not-found'));
    await assert.rejects(source.open('../../etc/passwd'), hasCode('not-found'));
  });

  it('reports a page rewrite to watch, debounced, and stops when unsubscribed', async () => {
    const dir = scratch();
    // Let the copy's own file events drain before watching.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const source = createFolderSource(dir, { debounceMs: 50 });
    const batches: string[][] = [];
    let notify: () => void = () => {};
    const stop = source.watch((ids) => {
      batches.length = 0;
      batches.push(ids);
      notify();
    });
    try {
      const reported = new Promise<void>((resolve) => {
        notify = resolve;
      });
      fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'ignored');
      const page = path.join(dir, DOC_ID, `${PAGE}.rm`);
      fs.writeFileSync(page, fs.readFileSync(page));
      fs.writeFileSync(page, fs.readFileSync(page));
      await within(reported, 5000, 'the watcher to report the page');
      assert.deepEqual(batches, [[DOC_ID]]);
    } finally {
      stop();
      stop();
    }
  });

  it('keeps watching when the listener throws', async () => {
    const dir = scratch();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const source = createFolderSource(dir, { debounceMs: 20 });
    let calls = 0;
    let notify: () => void = () => {};
    const stop = source.watch(() => {
      calls++;
      notify();
      throw new Error('listener failure');
    });
    try {
      const page = path.join(dir, DOC_ID, `${PAGE}.rm`);
      for (let round = 1; round <= 2; round++) {
        const reported = new Promise<void>((resolve) => {
          notify = resolve;
        });
        fs.appendFileSync(page, 'x');
        await within(reported, 5000, `report ${round}`);
      }
      assert.ok(calls >= 2);
    } finally {
      stop();
    }
  });

  it('says unavailable for a missing folder', async () => {
    const parent = tempDir();
    cleanup.push(parent);
    const source = createFolderSource(path.join(parent, 'missing'));
    await assert.rejects(source.list(), hasCode('unavailable'));
    await assert.rejects(source.open(DOC_ID), hasCode('unavailable'));
    assert.throws(() => source.watch(() => {}), hasCode('unavailable'));
  });

  it('says permission for a folder it may not read', { skip: isRoot && 'root reads everything' }, async () => {
    const dir = scratch();
    fs.chmodSync(dir, 0o000);
    try {
      await assert.rejects(createFolderSource(dir).list(), hasCode('permission'));
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('keeps a document listed while its metadata is caught halfway through a rewrite', async () => {
    const dir = scratch();
    const source = createFolderSource(dir);
    const [before] = await source.list();
    fs.writeFileSync(path.join(dir, `${DOC_ID}.metadata`), '{"visibleName": "Te');
    const [during] = await source.list();
    assert.equal(during?.name, 'Test', 'still listed, as it was');
    assert.notEqual(during?.version, before?.version, 'but its version moved, so it is looked at again');
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createFolderSource(XOCHITL).list({ signal: controller.signal }), hasCode('aborted'));
  });
});
