// A whole document: its bundle opened, every page read. Pages are independent, so one unreadable page leaves the rest.

import type { DocumentBundle } from './doc/bundle.ts';
import type { PageRef } from './doc/content.ts';
import { pageMarkdown } from './extract/markdown.ts';
import { readPage, type Page } from './rm/page.ts';

export interface DocumentPage {
  ref: PageRef;
  /** null for a page with no ink (it has no file), and for one that could not be read (`error`). */
  page: Page | null;
  error: string | null;
}

export interface ReadDocument {
  bundle: DocumentBundle;
  pages: DocumentPage[];
}

/** Reads every page of `bundle` (`pages`: only those ids). */
export async function readDocument(bundle: DocumentBundle, options: { pages?: readonly string[] } = {}): Promise<ReadDocument> {
  const wanted = options.pages ? new Set(options.pages) : null;
  const refs = bundle.content.pages.filter((ref) => !wanted || wanted.has(ref.id));
  const pages = await Promise.all(refs.map(async (ref): Promise<DocumentPage> => {
    try {
      const bytes = await bundle.page(ref.id);
      return { ref, page: bytes ? readPage(bytes) : null, error: null };
    } catch (error) {
      return { ref, page: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { bundle, pages };
}

/**
 * A document as Markdown: its name as the title, then each page that has typed text or highlights, under its page
 * number (the PDF's page number for a PDF, so a reader can find the passage).
 */
export function documentMarkdown(doc: ReadDocument): string {
  const out = [`# ${doc.bundle.metadata.name}`];
  for (const { ref, page } of doc.pages) {
    if (!page) continue;
    const body = pageMarkdown(page);
    if (!body) continue;
    const label = ref.sourcePage !== null ? `Page ${ref.sourcePage + 1}` : `Page ${ref.index + 1}`;
    out.push(`## ${label}\n\n${body}`);
  }
  return out.join('\n\n');
}
