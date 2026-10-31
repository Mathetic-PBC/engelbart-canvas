import { parseContent, type Content, type FileType } from './content.ts';
import { RmFormatError } from './json.ts';
import { parseMetadata, type Metadata } from './metadata.ts';

/**
 * One document or folder as the tablet stores it, whichever way it was reached: the tablet's own files, named as in
 * its xochitl folder (`<id>.metadata`, `<id>.content`, `<id>.pdf`, `<id>/<pageId>.rm`, …). Every source hands over
 * this same shape, so parsing and rendering never depend on where a document came from.
 */
export interface DocumentBundle {
  id: string;
  metadata: Metadata;
  content: Content;
  /** A file of the bundle by its name in the xochitl folder (`<id>.pdf`, `<id>/<pageId>.rm`); null when absent. */
  file(name: string): Promise<Uint8Array | null>;
  /** The page's `.rm`; null for a page with no ink, which has no file. */
  page(pageId: string): Promise<Uint8Array | null>;
  /** The PDF or EPUB the document was made from; null for a notebook (and for a folder). */
  source(): Promise<Uint8Array | null>;
}

/** Reads one file of a bundle by its xochitl name; null when there is no such file. */
export type FileReader = (name: string) => Promise<Uint8Array | null>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A bundle over `read`: reads and parses `.metadata`, `.content` and `.pagedata` now, everything else when asked.
 * Throws RmFormatError when the metadata is missing or not JSON; a missing or unreadable `.content` reads as `{}`
 * (folders and half-synced documents have none).
 */
export async function openBundle(id: string, read: FileReader): Promise<DocumentBundle> {
  if (!UUID_RE.test(id)) throw new RmFormatError(`Not a document id: ${id}`, 'not-found');
  const [metaBytes, contentBytes, pagedata] = await Promise.all([read(`${id}.metadata`), read(`${id}.content`), read(`${id}.pagedata`)]);
  if (!metaBytes) throw new RmFormatError(`No metadata for ${id}`, 'not-found');
  const metadata = parseMetadata(metaBytes);
  let content: Content;
  try {
    content = parseContent(contentBytes ?? '{}', pagedata);
  } catch {
    content = parseContent('{}');
  }
  return {
    id,
    metadata,
    content,
    file: (name) => read(name),
    page: (pageId) => (UUID_RE.test(pageId) ? read(`${id}/${pageId}.rm`) : Promise.resolve(null)),
    source: () => (content.fileType === 'pdf' || content.fileType === 'epub' ? read(`${id}.${content.fileType}`) : Promise.resolve(null)),
  };
}

/** What a source lists for each document and folder, without opening it. */
export interface Entry {
  id: string;
  name: string;
  /** '' for the top level, 'trash', or a folder's id. */
  parent: string;
  kind: Metadata['kind'];
  /** null for a folder, or when the source does not say. */
  fileType: FileType | null;
  /** Epoch ms; 0 when unknown. */
  lastModified: number;
  pinned: boolean;
  /** In the trash or deleted on the tablet. */
  trashed: boolean;
  /**
   * Changes whenever the document's files change. Opaque: compare it with the one seen last to skip documents that
   * have not changed. Sources that can only see a modification time use that; never assume more than equality.
   */
  version: string;
}
