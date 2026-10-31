import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createDesktopSource, desktopLibraryCandidates, findDesktopLibrary } from '../src/sources/desktop.ts';
import { SourceError } from '../src/sources/source.ts';
import { DOC_ID, tempDir, XOCHITL } from './helpers/fixture.ts';

const SANDBOXED = 'Library/Containers/com.remarkable.desktop/Data/Library/Application Support/remarkable/desktop';
const LEGACY = 'Library/Application Support/remarkable/desktop';
const isRoot = process.getuid?.() === 0;
const hasCode = (code: string) => (error: unknown) => error instanceof SourceError && error.code === code;

const homes: string[] = [];
after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

/** A fake home folder with a library at each of `libraries` (relative paths); `withDocs` puts the fixture in them. */
function fakeHome(libraries: string[], withDocs = true): string {
  const home = tempDir('rmbridge-home-');
  homes.push(home);
  for (const library of libraries) {
    const dir = path.join(home, library);
    fs.mkdirSync(dir, { recursive: true });
    if (withDocs) fs.cpSync(XOCHITL, dir, { recursive: true });
  }
  return home;
}

const mac = (home: string) => ({ home, platform: 'darwin' as const, env: {} });

describe('findDesktopLibrary', () => {
  it('prefers the sandboxed app over the legacy one', async () => {
    const home = fakeHome([SANDBOXED, LEGACY]);
    assert.equal(await findDesktopLibrary(mac(home)), path.join(home, SANDBOXED));
  });

  it('falls back to the legacy app', async () => {
    const home = fakeHome([LEGACY]);
    assert.equal(await findDesktopLibrary(mac(home)), path.join(home, LEGACY));
  });

  it('passes over an empty library for one with documents, and accepts an empty one alone', async () => {
    const home = fakeHome([LEGACY]);
    fs.mkdirSync(path.join(home, SANDBOXED), { recursive: true });
    assert.equal(await findDesktopLibrary(mac(home)), path.join(home, LEGACY));
    const emptyOnly = fakeHome([SANDBOXED], false);
    assert.equal(await findDesktopLibrary(mac(emptyOnly)), path.join(emptyOnly, SANDBOXED));
  });

  it('says unavailable when the app is not installed, naming where it looked', async () => {
    const home = fakeHome([]);
    await assert.rejects(findDesktopLibrary(mac(home)), (error: unknown) => {
      assert.ok(hasCode('unavailable')(error));
      assert.match((error as Error).message, /Install the reMarkable desktop app/);
      assert.ok((error as Error).message.includes(path.join(home, SANDBOXED)));
      return true;
    });
  });

  it('says permission when the library exists but cannot be read', { skip: isRoot && 'root reads everything' }, async () => {
    const home = fakeHome([SANDBOXED, LEGACY]);
    const library = path.join(home, SANDBOXED);
    fs.chmodSync(library, 0o000);
    try {
      // The sandboxed library is the current one: a readable legacy library must not hide the refusal.
      await assert.rejects(findDesktopLibrary(mac(home)), (error: unknown) => {
        assert.ok(hasCode('permission')(error));
        assert.match((error as Error).message, /Privacy & Security/);
        return true;
      });
    } finally {
      fs.chmodSync(library, 0o755);
    }
  });

  it('knows the Linux and Windows locations', async () => {
    const home = fakeHome(['.local/share/remarkable/desktop']);
    assert.equal(await findDesktopLibrary({ home, platform: 'linux', env: {} }), path.join(home, '.local/share/remarkable/desktop'));
    assert.deepEqual(desktopLibraryCandidates({ home: '/h', platform: 'linux', env: { XDG_DATA_HOME: '/data' } }), [
      '/data/remarkable/desktop',
      '/h/.local/share/remarkable/desktop',
    ]);
    assert.deepEqual(desktopLibraryCandidates({ home: 'C:\\Users\\a', platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } }), [
      'C:\\Users\\a\\AppData\\Roaming\\remarkable\\desktop',
    ]);
  });
});

describe('createDesktopSource', () => {
  it('lists and opens the library read-only, as kind desktop', async () => {
    const home = fakeHome([SANDBOXED]);
    const library = path.join(home, SANDBOXED);
    const snapshot = () =>
      fs
        .readdirSync(library, { recursive: true })
        .map(String)
        .sort()
        .map((name) => `${name} ${fs.statSync(path.join(library, name)).mtimeMs}`);
    const before = snapshot();

    const source = createDesktopSource(mac(home));
    assert.equal(source.kind, 'desktop');
    const entries = await source.list();
    assert.deepEqual(entries.map((entry) => entry.id), [DOC_ID]);
    const bundle = await source.open(DOC_ID);
    assert.equal(bundle.content.pages.length, 12);
    const stop = source.watch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    assert.deepEqual(snapshot(), before, 'nothing in the library changed');
  });

  it('reports a missing app on use, and finds it once installed', async () => {
    const home = fakeHome([]);
    const source = createDesktopSource(mac(home));
    await assert.rejects(source.list(), hasCode('unavailable'));
    source.watch(() => {})();
    fs.mkdirSync(path.join(home, SANDBOXED), { recursive: true });
    fs.cpSync(XOCHITL, path.join(home, SANDBOXED), { recursive: true });
    assert.equal((await source.list()).length, 1);
  });
});
