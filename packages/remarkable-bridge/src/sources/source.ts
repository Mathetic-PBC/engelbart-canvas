import type { DocumentBundle, Entry } from '../doc/bundle.ts';

export type SourceErrorCode =
  /** The source cannot be reached: the reMarkable app is not installed, or the folder is not there. */
  | 'unavailable'
  /** macOS refused access (the desktop app's library is in another app's container). */
  | 'permission'
  /** No such document. */
  | 'not-found'
  /** The source answered with something this package cannot read. */
  | 'format'
  | 'aborted';

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  constructor(message: string, code: SourceErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceError';
    this.code = code;
  }
}

/**
 * Somewhere reMarkable documents can be read from. Every source lists entries and opens bundles of the same shape
 * (../doc/bundle.ts), so parsing and rendering never depend on where a document came from. Read-only.
 */
export interface DocumentSource {
  readonly kind: 'folder' | 'desktop';
  /** Every document and folder, the trash included (Entry.trashed). */
  list(options?: { signal?: AbortSignal }): Promise<Entry[]>;
  open(id: string, options?: { signal?: AbortSignal }): Promise<DocumentBundle>;
  /**
   * Calls `onChange` with the ids of documents whose files changed, as they change (debounced). Absent when the
   * source cannot tell. `onError` is told once if watching stops by itself (the folder gone, access withdrawn).
   * → a function that stops watching.
   */
  watch?(onChange: (ids: string[]) => void, onError?: (error: unknown) => void): () => void;
}
