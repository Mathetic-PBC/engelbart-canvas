import { openBundle, UUID_RE, type DocumentBundle } from '../doc/bundle.ts';
import { RmFormatError } from '../doc/json.ts';
import { readZip, type ZipReadOptions } from '../zip.ts';

const METADATA_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.metadata$/i;

export interface OpenRmdocOptions extends ZipReadOptions {
  /**
   * Which document to open. Needed only when the archive holds several (a folder exported whole arrives as one
   * archive of many documents); otherwise the one `<id>.metadata` at the top of the archive decides.
   */
  id?: string;
}

/** The ids of the documents an `.rmdoc` holds: one per `<uuid>.metadata` at the top of the archive. */
export function rmdocIds(bytes: Uint8Array, options: ZipReadOptions = {}): string[] {
  return idsIn(readZip(bytes, options).names);
}

const idsIn = (names: readonly string[]) => names.flatMap((name) => METADATA_RE.exec(name)?.[1] ?? []);

/**
 * Opens an `.rmdoc` (a zip of one document's xochitl files: `<id>.metadata`, `<id>.content`, `<id>/<page>.rm`, and
 * `<id>.pdf` or `<id>.epub` when there is one) as a bundle. Only the archive's directory, `.metadata`, `.content` and
 * `.pagedata` are read now; pages and the PDF are inflated when asked for.
 *
 * Throws RmFormatError when the zip is damaged or unsafe, when it holds no document, or when it holds several and
 * `options.id` does not say which.
 */
export async function openRmdoc(bytes: Uint8Array, options: OpenRmdocOptions = {}): Promise<DocumentBundle> {
  const zip = readZip(bytes, options);
  const ids = idsIn(zip.names);
  let id: string;
  if (options.id !== undefined) {
    if (!UUID_RE.test(options.id) || !ids.some((found) => found.toLowerCase() === options.id!.toLowerCase())) {
      throw new RmFormatError(`The .rmdoc does not contain document ${options.id}.`, 'not-found');
    }
    id = ids.find((found) => found.toLowerCase() === options.id!.toLowerCase())!;
  } else if (ids.length === 1) {
    id = ids[0]!;
  } else if (ids.length === 0) {
    throw new RmFormatError('The .rmdoc holds no document: there is no <id>.metadata at its top level.', 'not-found');
  } else {
    throw new RmFormatError(`The .rmdoc holds ${ids.length} documents; say which one to open.`);
  }
  return openBundle(id, async (name) => zip.read(name));
}
