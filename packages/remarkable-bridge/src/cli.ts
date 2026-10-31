#!/usr/bin/env node
// `remarkable`: your reMarkable notebooks from the reMarkable app on this computer. Plain words, no options to learn:
//
//   remarkable                    what it found, and what to type next
//   remarkable list               every notebook and PDF, by folder
//   remarkable read <name>        a notebook's typed text, highlights and handwriting (read by the Mac)
//   remarkable save <name>        a PDF of it (ink included) and its text, in Downloads, shown in Finder
//   remarkable watch              notebooks as they change
//
// A name is matched loosely: any part of it, any case. It reads the library the official reMarkable app keeps on this
// computer, so that app must be installed and signed in; it never writes there and never goes online.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Entry } from './doc/bundle.ts';
import { documentMarkdown, readDocument } from './document.ts';
import { hasHandwriting, readHandwriting } from './ocr/handwriting.ts';
import { createDesktopSource } from './sources/desktop.ts';
import { createFolderSource } from './sources/folder.ts';
import { SourceError, type DocumentSource } from './sources/source.ts';

const HELP = `remarkable: your reMarkable notebooks, from the reMarkable app on this computer

  remarkable list            every notebook and PDF, by folder
  remarkable read <name>     a notebook's text: typed, highlighted, and handwriting
  remarkable save <name>     save it as a PDF (with your ink) and its text, into Downloads
  remarkable watch           show notebooks as you change them

<name> can be any part of a notebook's name, e.g.  remarkable save meeting
`;

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = '') => process.stdout.write(`${s}\n`);

async function main(argv: string[]): Promise<void> {
  // REMARKABLE_LIBRARY points at another copy of the tablet's files (one taken over SSH, a test folder).
  const source: DocumentSource = process.env.REMARKABLE_LIBRARY ? createFolderSource(process.env.REMARKABLE_LIBRARY) : createDesktopSource();
  const [command = '', ...words] = argv;
  const name = words.join(' ').trim();
  switch (command.toLowerCase()) {
    case '': return overview(source);
    case 'list': case 'ls': return list(source);
    case 'read': case 'show': case 'text': return read(source, name);
    case 'save': case 'export': return save(source, name);
    case 'watch': return watch(source);
    case 'help': case '-h': case '--help': say(HELP); return;
    default: say(`"${command}" is not something remarkable knows.\n`); say(HELP); process.exitCode = 1;
  }
}

async function documents(source: DocumentSource): Promise<Entry[]> {
  return (await source.list()).filter((e) => !e.trashed);
}

async function overview(source: DocumentSource): Promise<void> {
  const entries = await documents(source);
  const docs = entries.filter((e) => e.kind === 'document');
  const notebooks = docs.filter((e) => e.fileType === 'notebook').length;
  const pdfs = docs.filter((e) => e.fileType === 'pdf').length;
  const books = docs.filter((e) => e.fileType === 'epub').length;
  const latest = [...docs].sort((a, b) => b.lastModified - a.lastModified)[0];
  say(`Found your reMarkable library: ${plural(notebooks, 'notebook')}, ${plural(pdfs, 'PDF')}, ${plural(books, 'ebook')}.`);
  if (latest) say(`Last changed: ${bold(latest.name)}, ${when(latest.lastModified)}.`);
  say();
  say(HELP);
}

async function list(source: DocumentSource): Promise<void> {
  const entries = await documents(source);
  const byParent = new Map<string, Entry[]>();
  for (const e of entries) {
    const parent = entries.some((p) => p.id === e.parent) ? e.parent : '';
    byParent.set(parent, [...(byParent.get(parent) ?? []), e]);
  }
  const print = (parent: string, depth: number) => {
    const here = (byParent.get(parent) ?? []).sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name));
    for (const e of here) {
      const pad = '  '.repeat(depth);
      if (e.kind === 'folder') {
        say(`${pad}${bold(`${e.name}/`)}`);
        print(e.id, depth + 1);
      } else {
        const kind = e.fileType === 'pdf' ? 'PDF' : e.fileType === 'epub' ? 'ebook' : 'notebook';
        say(`${pad}${e.name}  ${dim(`${kind}, ${when(e.lastModified)}`)}`);
      }
    }
  };
  print('', 0);
}

/** The one document `name` points at, or a helpful message and null. */
async function find(source: DocumentSource, name: string): Promise<Entry | null> {
  if (!name) { say('Which notebook? For example:  remarkable read meeting'); process.exitCode = 1; return null; }
  const docs = (await documents(source)).filter((e) => e.kind === 'document');
  const wanted = name.toLowerCase();
  const exact = docs.filter((e) => e.name.toLowerCase() === wanted || e.id === name);
  const partial = exact.length ? exact : docs.filter((e) => e.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0]!;
  process.exitCode = 1;
  if (partial.length === 0) {
    say(`No notebook has "${name}" in its name. Type  remarkable list  to see them all.`);
    return null;
  }
  say(`${partial.length} notebooks match "${name}". Which one?`);
  for (const e of partial.slice(0, 15)) say(`  ${e.name}  ${dim(when(e.lastModified))}`);
  if (partial.length > 15) say(`  … and ${partial.length - 15} more`);
  return null;
}

async function read(source: DocumentSource, name: string): Promise<void> {
  const entry = await find(source, name);
  if (!entry) return;
  const doc = await readDocument(await source.open(entry.id));
  const { handwriting } = await readWriting(doc);
  const text = documentMarkdown(doc, { handwriting });
  const body = text.split('\n').slice(1).join('\n').trim();
  say(text);
  if (!body) say(dim('\n(Nothing on it could be read as text.)'));
}

async function save(source: DocumentSource, name: string): Promise<void> {
  const entry = await find(source, name);
  if (!entry) return;
  const bundle = await source.open(entry.id);
  const doc = await readDocument(bundle);
  const { documentToPdf } = await import('./export/pdf.ts');
  console.warn = () => {}; // pdf-lib's notes on oddities in the PDF it reads mean nothing to the person
  const { handwriting } = await readWriting(doc);
  const pdf = await documentToPdf(doc, { source: await bundle.source(), handwriting });
  const dir = path.join(os.homedir(), 'Downloads');
  const base = uniqueBase(dir, entry.name.replace(/[/\\:]/g, '-'));
  const pdfPath = path.join(dir, `${base}.pdf`);
  fs.writeFileSync(pdfPath, pdf);
  const text = documentMarkdown(doc, { handwriting });
  const hasText = text.split('\n').length > 1;
  if (hasText) fs.writeFileSync(path.join(dir, `${base}.md`), `${text}\n`);
  say(`Saved ${bold(`${base}.pdf`)}${hasText ? ` and ${bold(`${base}.md`)}` : ''} in Downloads.`);
  if (process.platform === 'darwin') execFile('open', ['-R', pdfPath], () => {});
}

async function watch(source: DocumentSource): Promise<void> {
  const names = new Map((await documents(source)).map((e) => [e.id, e.name]));
  say(`Watching ${plural(names.size, 'notebook')}. Write on your reMarkable and changes show here once the reMarkable app has synced. Press Ctrl-C to stop.`);
  source.watch?.(async (ids) => {
    const fresh = new Map((await documents(source)).map((e) => [e.id, e.name]));
    for (const id of ids) say(`${new Date().toLocaleTimeString()}  ${fresh.get(id) ?? names.get(id) ?? 'A notebook'} changed`);
  });
  await new Promise(() => {});
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The document's handwriting, read by the Mac (nothing elsewhere), with a word while it reads. */
async function readWriting(doc: Awaited<ReturnType<typeof readDocument>>) {
  const pages = doc.pages.filter(({ page }) => hasHandwriting(page)).length;
  if (pages && process.platform === 'darwin') process.stderr.write(dim(`Reading the handwriting on ${plural(pages, 'page')}…\n`));
  return readHandwriting(doc);
}

function when(ms: number): string {
  if (!ms) return 'date unknown';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** `name`, or `name 2`, `name 3`… so nothing in Downloads is overwritten. */
function uniqueBase(dir: string, name: string): string {
  for (let n = 1; ; n++) {
    const base = n === 1 ? name : `${name} ${n}`;
    if (!fs.existsSync(path.join(dir, `${base}.pdf`)) && !fs.existsSync(path.join(dir, `${base}.md`))) return base;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof SourceError) {
    if (error.code === 'unavailable') say('The reMarkable app is not on this computer yet. Install it from https://downloads.remarkable.com, sign in, and let it sync your notebooks, then try again.');
    else if (error.code === 'permission') say('This Mac needs your permission for Terminal to read the reMarkable app\'s files: System Settings → Privacy & Security → App Data (or Full Disk Access), turn on Terminal, then try again.');
    else say(error.message);
  } else {
    say(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
