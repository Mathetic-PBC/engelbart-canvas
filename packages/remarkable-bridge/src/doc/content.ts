import { bool, isObject, lww, num, parseObject, str, type Json } from './json.ts';

export type FileType = 'notebook' | 'pdf' | 'epub' | 'unknown';

/** One page of a document as the tablet shows it. */
export interface PageRef {
  /** The page's id: its ink is `<docId>/<id>.rm`, absent when the page has none. */
  id: string;
  /** 0-based position in the document as displayed. */
  index: number;
  /**
   * 0-based page of the PDF (or the tablet's own pagination of the EPUB) drawn under this page; null for a notebook
   * page and for a page inserted into a PDF, which have nothing behind them but their template.
   */
  sourcePage: number | null;
  /** The template's name ('Blank', 'P Grid medium', …), or null when the bundle does not say. */
  template: string | null;
}

/** `<id>.content`: the document's type, its pages in order, and the tablet's view settings. */
export interface Content {
  fileType: FileType;
  /** 1: the legacy `pages` list; 2: `cPages`. */
  formatVersion: number;
  /** Pages displayed, deleted ones left out, in order. */
  pages: PageRef[];
  /** The source PDF's page count, when the bundle records it. */
  originalPageCount: number | null;
  orientation: 'portrait' | 'landscape';
  tags: string[];
  title: string;
  authors: string[];
  raw: Json;
}

const FILE_TYPES: Record<string, FileType> = { notebook: 'notebook', pdf: 'pdf', epub: 'epub', '': 'notebook' };

/**
 * Parses `.content`. `pagedata` (the legacy `<id>.pagedata`, one template name per line) fills in templates the
 * content does not carry. For a folder's content (`{}` or `{"tags": []}`) every list is empty.
 */
export function parseContent(input: string | Uint8Array, pagedata?: string | Uint8Array | null): Content {
  const raw = parseObject(input, '.content');
  const fileType = FILE_TYPES[str(raw.fileType, 'unknown')] ?? 'unknown';
  const legacyTemplates = pagedata == null ? [] : (typeof pagedata === 'string' ? pagedata : new TextDecoder().decode(pagedata)).split('\n').map((line) => line.trim());
  const pages = isObject(raw.cPages) ? cPagesOf(raw.cPages, fileType, num(raw.originalPageCount, null)) : legacyPagesOf(raw, fileType);
  for (const page of pages) if (page.template === null && legacyTemplates[page.index]) page.template = legacyTemplates[page.index] ?? null;
  const documentMetadata = isObject(raw.documentMetadata) ? raw.documentMetadata : {};
  return {
    fileType,
    formatVersion: num(raw.formatVersion, isObject(raw.cPages) ? 2 : 1),
    pages,
    originalPageCount: num(raw.originalPageCount, null),
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => (isObject(tag) ? str(tag.name) : str(tag))).filter(Boolean) : [],
    title: str(documentMetadata.title),
    authors: Array.isArray(documentMetadata.authors) ? documentMetadata.authors.map((a) => str(a)).filter(Boolean) : [],
    raw,
  };
}

const hasSource = (fileType: FileType) => fileType === 'pdf' || fileType === 'epub';

/** A page of the PDF: a whole number from 0, else null (-1 marks an inserted page; anything else is damage). */
const pageIndex = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 0 ? n : null);

/**
 * formatVersion 2. Pages are kept in an array whose order is not the display order once a page has been moved: the
 * order is `idx`, a fractional index compared as a plain string (code units, never locale order). Deleted pages stay
 * in the list with `deleted` set, and keep their `redir`, an absolute index into the PDF: nothing is renumbered.
 */
function cPagesOf(cPages: Json, fileType: FileType, originalPageCount: number | null): PageRef[] {
  const listed = Array.isArray(cPages.pages) ? cPages.pages.filter(isObject) : [];
  const kept = listed
    .map((page, order) => ({ page, order, idx: str(lww(page.idx)) }))
    .filter(({ page }) => typeof page.id === 'string' && page.id && !bool(lww(page.deleted)))
    .sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : a.order - b.order));
  const redirs = kept.map(({ page }) => pageIndex(num(lww(page.redir), null)));
  // Some PDFs (imported before redirection existed) carry no redir at all: their pages are the PDF's, one for one.
  const identity = hasSource(fileType) && redirs.every((r) => r === null) && (originalPageCount === null || originalPageCount === kept.length);
  return kept.map(({ page }, index) => {
    const template = lww(page.template);
    return {
      id: str(page.id),
      index,
      sourcePage: !hasSource(fileType) ? null : identity ? index : redirs[index] ?? null,
      template: typeof template === 'string' && template ? template : null,
    };
  });
}

/** formatVersion 1: `pages` in display order, `redirectionPageMap[i]` the PDF page under page i (-1: inserted). */
function legacyPagesOf(raw: Json, fileType: FileType): PageRef[] {
  const ids = Array.isArray(raw.pages) ? raw.pages.map((id) => str(id)).filter(Boolean) : [];
  const map = Array.isArray(raw.redirectionPageMap) ? raw.redirectionPageMap : null;
  return ids.map((id, index) => {
    let sourcePage: number | null = null;
    if (hasSource(fileType)) {
      sourcePage = map ? pageIndex(num(map[index], -1)) : index;
    }
    return { id, index, sourcePage, template: null };
  });
}
