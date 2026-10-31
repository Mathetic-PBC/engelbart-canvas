import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ZipInput } from '../../src/zip.ts';

export const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
/** A real xochitl folder holding one 12-page notebook (from the notable project, Apache-2.0). */
export const XOCHITL = path.join(FIXTURES, 'xochitl');
export const DOC_ID = 'f63a4691-25eb-43c5-95b0-a20c2dbeb80b';
export const RM_HEADER = 'reMarkable .lines file, version=6';

/** An empty temporary folder, by its real path (macOS's tmpdir is behind a symlink, which confuses file watching). */
export function tempDir(prefix = 'rmbridge-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A private copy of the xochitl fixture, for tests that modify files. */
export function copyXochitl(): string {
  const dir = tempDir();
  fs.cpSync(XOCHITL, dir, { recursive: true });
  return dir;
}

/** The fixture document's files as they go into an `.rmdoc`: metadata, content and every page. */
export function fixtureRmdocFiles(): ZipInput[] {
  const files: ZipInput[] = [
    { name: `${DOC_ID}.metadata`, bytes: fs.readFileSync(path.join(XOCHITL, `${DOC_ID}.metadata`)) },
    { name: `${DOC_ID}.content`, bytes: fs.readFileSync(path.join(XOCHITL, `${DOC_ID}.content`)) },
  ];
  for (const page of fs.readdirSync(path.join(XOCHITL, DOC_ID)).sort()) {
    files.push({ name: `${DOC_ID}/${page}`, bytes: fs.readFileSync(path.join(XOCHITL, DOC_ID, page)) });
  }
  return files;
}

export const decode = (bytes: Uint8Array | null): string => new TextDecoder().decode(bytes ?? new Uint8Array());

/** Resolves with `promise`, or rejects after `ms` so a test can never hang. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
