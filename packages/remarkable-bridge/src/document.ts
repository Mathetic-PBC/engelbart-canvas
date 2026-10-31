// A whole document: its bundle opened, every page read. Pages are independent, so one unreadable page leaves the rest.

import { createHash } from 'node:crypto';
import type { DocumentBundle } from './doc/bundle.ts';
import type { PageRef } from './doc/content.ts';
import { escapeMarkdown, pageMarkdown } from './extract/markdown.ts';
import { MACHINE_READ, type Handwriting } from './ocr/handwriting.ts';
import { readPage, type Page } from './rm/page.ts';

export interface DocumentPage {
  ref: PageRef;
  /** null for a page with no ink (it has no file), and for one that could not be read (`error`). */
  page: Page | null;
  error: string | null;
  /** sha256 of the page's file: the same while the page is unchanged (what readings of its handwriting are kept by). */
  digest: string | null;
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
    let digest: string | null = null;
    try {
      const bytes = await bundle.page(ref.id);
      if (bytes) digest = createHash('sha256').update(bytes).digest('hex');
      return { ref, page: bytes ? readPage(bytes) : null, error: null, digest };
    } catch (error) {
      return { ref, page: null, error: error instanceof Error ? error.message : String(error), digest };
    }
  }));
  return { bundle, pages };
}

/**
 * A document as Markdown: its name as the title, then each page that has typed text, highlights or handwriting read
 * (`handwriting`, ./ocr/handwriting.ts), under its page number (the PDF's page number for a PDF, so a reader can find
 * the passage). Handwriting is marked as read by machine: it can be wrong.
 */
export function documentMarkdown(doc: ReadDocument, options: { handwriting?: Handwriting } = {}): string {
  const out = [`# ${doc.bundle.metadata.name}`];
  for (const { ref, page } of doc.pages) {
    if (!page) continue;
    const written = options.handwriting?.get(ref.id) ?? [];
    const parts = [pageMarkdown(page)];
    if (written.length) parts.push(`*${MACHINE_READ}*\n\n${written.map((l) => escapeLine(l.text)).join('\n')}`);
    const body = parts.filter(Boolean).join('\n\n');
    if (!body) continue;
    const label = ref.sourcePage !== null ? `Page ${ref.sourcePage + 1}` : `Page ${ref.index + 1}`;
    out.push(`## ${label}\n\n${body}`);
  }
  return out.join('\n\n');
}

/** A line read from handwriting, as Markdown that says only that (escapeMarkdown), ending in a hard line break. */
const escapeLine = (text: string) => `${escapeMarkdown(text)}  `;
