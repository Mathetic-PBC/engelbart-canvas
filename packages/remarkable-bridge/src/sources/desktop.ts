import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentBundle, Entry } from '../doc/bundle.ts';
import { createFolderSource, type FolderSource, type FolderSourceOptions } from './folder.ts';
import { checkAborted, isMissing, isRefused, permissionMessage } from './internal.ts';
import { SourceError, type DocumentSource } from './source.ts';

/** Where to look; every field defaults to this machine's own. Injected so tests can point at a fake home folder. */
export interface DesktopLibraryOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export interface DesktopSourceOptions extends DesktopLibraryOptions, FolderSourceOptions {}

/** A read-only DocumentSource over the reMarkable desktop app's library. */
export interface DesktopSource extends DocumentSource {
  readonly kind: 'desktop';
  watch(onChange: (ids: string[]) => void, onError?: (error: unknown) => void): () => void;
}

/**
 * The folders the reMarkable desktop app may keep its library in on this platform, most likely first. The library
 * is a plain xochitl-layout mirror of the account's documents, kept fresh while the app runs.
 */
export function desktopLibraryCandidates(options: DesktopLibraryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  if (platform === 'darwin') {
    return [
      // The current app is sandboxed, so its library sits in its container.
      path.posix.join(home, 'Library/Containers/com.remarkable.desktop/Data/Library/Application Support/remarkable/desktop'),
      // Older, unsandboxed versions of the app.
      path.posix.join(home, 'Library/Application Support/remarkable/desktop'),
    ];
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return [path.win32.join(appData, 'remarkable', 'desktop')];
  }
  const candidates = [path.posix.join(home, '.local/share/remarkable/desktop')];
  if (env.XDG_DATA_HOME) candidates.unshift(path.posix.join(env.XDG_DATA_HOME, 'remarkable/desktop'));
  return [...new Set(candidates)];
}

/**
 * The reMarkable desktop app's library folder. The first candidate that exists decides, so a library left behind by
 * an older version of the app never shadows the current one; an empty library is passed over for one that has
 * documents.
 *
 * Rejects with SourceError `permission` when the folder exists but the OS will not let this process read it (on
 * macOS, reading another app's container needs the App Data or Full Disk Access permission), and `unavailable` when
 * the app is not installed or has never synced.
 */
export async function findDesktopLibrary(options: DesktopLibraryOptions = {}): Promise<string> {
  const candidates = desktopLibraryCandidates(options);
  let empty: string | undefined;
  for (const candidate of candidates) {
    let names: string[];
    try {
      names = await fsp.readdir(candidate);
    } catch (error) {
      if (isMissing(error)) continue;
      if (isRefused(error)) throw new SourceError(permissionMessage(candidate), 'permission', { cause: error });
      throw new SourceError(`Could not read the reMarkable desktop app's library at ${candidate}: ${String(error)}`, 'unavailable', { cause: error });
    }
    if (names.some((name) => name.endsWith('.metadata'))) return candidate;
    empty ??= candidate;
  }
  if (empty !== undefined) return empty;
  throw new SourceError(
    `The reMarkable desktop app's library was not found. Install the reMarkable desktop app, sign in, and let it sync, ` +
      `then try again. Looked in: ${candidates.join('; ')}.`,
    'unavailable',
  );
}

/**
 * A read-only source over the reMarkable desktop app's library. The folder is found on first use and again after
 * each failure, so a person who installs the app or grants the permission can retry without starting over.
 *
 * Never writes to the library: the app treats it as its private sync cache, and a stray file there could be synced
 * to the account or corrupt the app's state.
 */
export function createDesktopSource(options: DesktopSourceOptions = {}): DesktopSource {
  // Only a success is kept. Until then every call looks again for itself, so none is handed a failure from a search
  // that began before the app was installed or the permission granted.
  let found: FolderSource | undefined;
  const folder = async (): Promise<FolderSource> => {
    if (found) return found;
    const source = createFolderSource(await findDesktopLibrary(options), options);
    found ??= source;
    return found;
  };

  return {
    kind: 'desktop',
    async list(listOptions: { signal?: AbortSignal } = {}): Promise<Entry[]> {
      checkAborted(listOptions.signal);
      return (await folder()).list(listOptions);
    },
    async open(id: string, openOptions: { signal?: AbortSignal } = {}): Promise<DocumentBundle> {
      checkAborted(openOptions.signal);
      return (await folder()).open(id, openOptions);
    },
    watch(onChange: (ids: string[]) => void, onError?: (error: unknown) => void): () => void {
      let stop: (() => void) | undefined;
      let stopped = false;
      // Finding the folder is asynchronous and watch is not; when it cannot be found there is nothing to watch, and
      // the next `list` says why.
      folder().then(
        (source) => {
          if (stopped) return;
          try {
            stop = source.watch(onChange, onError);
          } catch (error) {
            onError?.(error); // gone or refused since it was found
          }
        },
        (error: unknown) => {
          if (!stopped) onError?.(error);
        },
      );
      return () => {
        stopped = true;
        stop?.();
      };
    },
  };
}
