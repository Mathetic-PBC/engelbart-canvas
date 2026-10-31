// Helpers shared by the sources. Not part of the package's public API.

import { RmFormatError } from '../doc/json.ts';
import { SourceError } from './source.ts';

/** The `code` of a Node system error (ENOENT, EACCES, …), or undefined. */
export const errnoCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

export const isMissing = (error: unknown): boolean => {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export const isRefused = (error: unknown): boolean => {
  const code = errnoCode(error);
  return code === 'EPERM' || code === 'EACCES';
};

/** The permission message, in words a person can act on whichever OS refused. */
export const permissionMessage = (dir: string): string =>
  `This app is not allowed to read ${dir}. On macOS, allow it under System Settings → Privacy & Security → App Data ` +
  `(or Full Disk Access) and try again; elsewhere, check that your user can read that folder.`;

/** A file system error reaching `dir` as a SourceError: missing → unavailable, refused → permission. */
export function fsSourceError(error: unknown, dir: string, missing = `There is no reMarkable library at ${dir}.`): SourceError {
  if (error instanceof SourceError) return error;
  if (isMissing(error)) return new SourceError(missing, 'unavailable', { cause: error });
  if (isRefused(error)) return new SourceError(permissionMessage(dir), 'permission', { cause: error });
  const detail = error instanceof Error ? error.message : String(error);
  return new SourceError(`Could not read ${dir}: ${detail}`, 'unavailable', { cause: error });
}

/** An RmFormatError from opening a bundle as a SourceError (not-found stays not-found, the rest is format). */
export function bundleSourceError(error: unknown, what: string): unknown {
  if (!(error instanceof RmFormatError)) return error;
  if (error.code === 'not-found') return new SourceError(`${what} was not found.`, 'not-found', { cause: error });
  return new SourceError(`${what} could not be read: ${error.message}`, 'format', { cause: error });
}

export const abortedError = (cause?: unknown): SourceError => new SourceError('Cancelled.', 'aborted', { cause });

/** Throws SourceError('aborted') when `signal` has fired. */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal.reason);
}

/** Runs at most `limit` of the functions given to it at once; the rest wait their turn, first come first served. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    // A woken waiter inherits the slot of the task that finished, so `active` is not incremented again.
    try {
      return await task();
    } finally {
      if (waiting.length > 0) waiting.shift()!();
      else active--;
    }
  };
}
