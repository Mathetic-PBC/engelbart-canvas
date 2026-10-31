import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { openBundle, UUID_RE, type DocumentBundle, type Entry, type FileReader } from '../doc/bundle.ts';
import { parseContent, type FileType } from '../doc/content.ts';
import { RmFormatError } from '../doc/json.ts';
import { isTrashed, parseMetadata, type Metadata } from '../doc/metadata.ts';
import { checkName } from '../zip.ts';
import { bundleSourceError, checkAborted, createLimiter, errnoCode, fsSourceError, isMissing } from './internal.ts';
import { SourceError, type DocumentSource } from './source.ts';

export interface FolderSourceOptions {
  /** How long `watch` waits for changes to settle before reporting them, in ms. Default 500. */
  debounceMs?: number;
  /** How many file system operations `list` keeps in flight at once. Default 32. */
  concurrency?: number;
}

/** A DocumentSource over a folder in the tablet's xochitl layout. */
export interface FolderSource extends DocumentSource {
  readonly kind: 'folder' | 'desktop';
  /** The folder, as an absolute path. */
  readonly dir: string;
  watch(onChange: (ids: string[]) => void, onError?: (error: unknown) => void): () => void;
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const METADATA_RE = new RegExp(`^(${ID})\\.metadata$`, 'i');
/** A changed path that belongs to a document: one of its sidecars, its page folder, or anything in that folder. */
const CHANGE_RE = new RegExp(`^(${ID})(?:\\.(?:metadata|content|pagedata|pdf|epub)$|/|$)`, 'i');
/** The files beside `<id>/` that make up a document. `.local` and `.thumbnails/` are the app's own state, not content. */
const SIDECARS = ['.metadata', '.content', '.pagedata', '.pdf', '.epub'] as const;

interface FileStamp {
  name: string;
  size: number;
  mtimeMs: number;
  /** For the parse cache only: also changes when a file is replaced by a rename that kept its mtime. */
  ctimeMs: number;
  ino: number;
}

interface Parsed {
  key: string;
  /** null when `.metadata` is not JSON (often a sync caught halfway); the entry is left out until it changes. */
  metadata: Metadata | null;
  fileType: FileType | null;
}

/**
 * A source over a folder in the tablet's xochitl layout: the desktop app's library, a folder copied off the tablet
 * over SSH, or an unpacked `.rmdoc`. Read-only: it never writes to the folder.
 *
 * `list` reads every `<id>.metadata` once and afterwards only stats files, re-reading a document's `.metadata` and
 * `.content` when they change. Errors are SourceErrors: `unavailable` when the folder is missing, `permission` when
 * the OS refuses access (on macOS, another app's container without the App Data or Full Disk Access permission).
 */
export function createFolderSource(dir: string, options: FolderSourceOptions = {}): FolderSource {
  const root = path.resolve(dir);
  const debounceMs = options.debounceMs ?? 500;
  const limit = createLimiter(Math.max(1, options.concurrency ?? 32));
  const cache = new Map<string, Parsed>();

  const stamp = (name: string): Promise<FileStamp | null> =>
    limit(() => fsp.stat(path.join(root, name))).then(
      (stats) => (stats.isFile() ? { name, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino } : null),
      (error: unknown) => {
        if (isMissing(error)) return null; // deleted between readdir and stat: a sync in progress
        throw fsSourceError(error, root);
      },
    );

  /** Every file under `rel`, at any depth. A page folder is flat in practice, but nothing guarantees it. */
  async function stampsUnder(rel: string): Promise<FileStamp[]> {
    let dirents: fs.Dirent[];
    try {
      dirents = await limit(() => fsp.readdir(path.join(root, rel), { withFileTypes: true }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw fsSourceError(error, root);
    }
    const nested = await Promise.all(
      dirents.map(async (dirent) => {
        const name = `${rel}/${dirent.name}`;
        if (dirent.isDirectory()) return stampsUnder(name);
        const found = await stamp(name);
        return found ? [found] : [];
      }),
    );
    return nested.flat();
  }

  async function readOrNull(name: string): Promise<Uint8Array | null> {
    try {
      return await limit(() => fsp.readFile(path.join(root, name)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw fsSourceError(error, root);
    }
  }

  async function parse(id: string, key: string, hasContent: boolean): Promise<Parsed | null> {
    const [metaBytes, contentBytes] = await Promise.all([readOrNull(`${id}.metadata`), hasContent ? readOrNull(`${id}.content`) : null]);
    if (!metaBytes) return null;
    let metadata: Metadata | null = null;
    try {
      metadata = parseMetadata(metaBytes);
    } catch {
      return { key, metadata: null, fileType: null };
    }
    let fileType: FileType | null = null;
    if (metadata.kind !== 'folder' && contentBytes) {
      try {
        fileType = parseContent(contentBytes).fileType;
      } catch {
        fileType = null;
      }
    }
    return { key, metadata, fileType };
  }

  async function entryOf(id: string, names: Set<string>): Promise<Entry | null> {
    const sidecars = SIDECARS.map((ext) => id + ext).filter((name) => names.has(name));
    const [stamps, pages] = await Promise.all([Promise.all(sidecars.map(stamp)), names.has(id) ? stampsUnder(id) : []]);
    const files = [...stamps.filter((s) => s !== null), ...pages];
    const meta = files.find((file) => file.name === `${id}.metadata`);
    if (!meta) return null;
    const content = files.find((file) => file.name === `${id}.content`);
    const key = `${signature(meta)}|${content ? signature(content) : '-'}`;

    let parsed = cache.get(id);
    if (parsed?.key !== key) {
      const fresh = await parse(id, key, content !== undefined);
      if (!fresh) return null;
      // A .metadata caught halfway through a rewrite keeps the document listed as it was: a sync that compares lists
      // must not take a torn read for a deletion. Its version still moves, so it is looked at again.
      if (!fresh.metadata && parsed?.metadata) fresh.metadata = parsed.metadata;
      cache.set(id, fresh);
      parsed = fresh;
    }
    const metadata = parsed.metadata;
    if (!metadata) return null;
    return {
      id,
      name: metadata.name,
      parent: metadata.parent,
      kind: metadata.kind,
      fileType: parsed.fileType,
      lastModified: metadata.lastModified,
      pinned: metadata.pinned,
      trashed: isTrashed(metadata),
      version: versionOf(files),
    };
  }

  async function list(listOptions: { signal?: AbortSignal } = {}): Promise<Entry[]> {
    const { signal } = listOptions;
    checkAborted(signal);
    let names: Set<string>;
    try {
      names = new Set(await fsp.readdir(root));
    } catch (error) {
      throw fsSourceError(error, root);
    }
    const ids = [...names].flatMap((name) => METADATA_RE.exec(name)?.[1] ?? []);
    const entries = await Promise.all(ids.map((id) => entryOf(id, names)));
    checkAborted(signal);
    const present = new Set(ids);
    for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
    return entries.filter((entry) => entry !== null);
  }

  async function open(id: string, openOptions: { signal?: AbortSignal } = {}): Promise<DocumentBundle> {
    checkAborted(openOptions.signal);
    if (!UUID_RE.test(id)) throw new SourceError(`"${id}" is not a reMarkable document id.`, 'not-found');
    const read: FileReader = async (name) => {
      confine(name, id);
      try {
        return await fsp.readFile(path.join(root, name));
      } catch (error) {
        const code = errnoCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
        throw fsSourceError(error, root);
      }
    };
    try {
      return await openBundle(id, read);
    } catch (error) {
      if (error instanceof RmFormatError && error.code === 'not-found') {
        // Tell "no such document" from "no library at all".
        await fsp.access(root).catch((accessError: unknown) => {
          throw fsSourceError(accessError, root);
        });
      }
      throw bundleSourceError(error, `Document ${id} in ${root}`);
    }
  }

  function watch(onChange: (ids: string[]) => void, onError?: (error: unknown) => void): () => void {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true });
    } catch (error) {
      throw fsSourceError(error, root);
    }
    const pending = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let firstAt = 0;
    let closed = false;
    // A sync rewrites files for as long as it runs; report at least this often rather than wait for it to end.
    const maxWaitMs = debounceMs * 10;

    const flush = () => {
      timer = undefined;
      if (closed || pending.size === 0) return;
      const ids = [...pending];
      pending.clear();
      try {
        onChange(ids);
      } catch {
        // The listener's own failure must not take down the process hosting the watcher (Electron's main process).
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    };

    watcher.on('change', (_event, filename) => {
      if (closed || filename === null) return;
      const id = CHANGE_RE.exec(String(filename).replaceAll('\\', '/'))?.[1];
      if (!id) return;
      pending.add(id);
      const now = Date.now();
      if (timer === undefined) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now)));
    });
    // The folder went away or became unreadable: stop (an unhandled 'error' event would throw), and say so once, so the
    // caller can watch again later. The next `list` says what is wrong.
    watcher.on('error', (error) => {
      if (closed) return;
      close();
      try {
        onError?.(error);
      } catch {
        // The listener's own failure must not take down the process hosting the watcher.
      }
    });
    return close;
  }

  return { kind: 'folder', dir: root, list, open, watch };
}

/** Throws unless `name` is one of document `id`'s own files, by a path that cannot leave the folder. */
function confine(name: string, id: string): void {
  let safe = name.startsWith(`${id}.`) || name.startsWith(`${id}/`);
  if (safe) {
    try {
      checkName(name);
    } catch {
      safe = false;
    }
  }
  if (!safe) throw new SourceError(`Refusing to read ${JSON.stringify(name)}: it is not one of document ${id}'s files.`, 'not-found');
}

const signature = (file: FileStamp) => `${file.size}:${file.mtimeMs}:${file.ctimeMs}:${file.ino}`;

/**
 * A short hash of every file's name, size and modification time. Pages are rewritten in place, so the page folder's
 * own mtime does not change when one of them does; every file has to be counted.
 */
function versionOf(files: FileStamp[]): string {
  const lines = files.map((file) => `${file.name}\0${file.size}\0${file.mtimeMs}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('base64url').slice(0, 16);
}
