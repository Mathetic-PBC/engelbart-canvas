'use strict';

// One reMarkable document made into the files of Engelbart's reMarkable folder (./sync.cjs): `<name>.pdf`, the document
// with its ink drawn in (a notebook's pages, or the PDF's own pages with the ink and highlights over them), and
// `<name>.md`, its typed text and highlights, when it has any. An ebook gets the `.md` alone: its ink follows the
// tablet's own reflow of the book, which cannot be drawn again here.
//
// Read from the reMarkable app's library (`dir`) through packages/remarkable-bridge. Writing a big PDF takes a while
// (a 2 MB, 36-page paper about 70 ms; a textbook seconds), so ./sync.cjs runs this in a worker thread of its own and
// the main process never waits on it; run directly (the tests), it is an ordinary function. Each file is written to a
// temporary name and renamed, so a reader never sees half of one.

const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');

/** Bump when what is written changes: every document is converted again on the next sync. */
const CONVERT_VERSION = 1;

const temporaryFor = (file) => `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
/**
 * The Mac's disk takes "notes.pdf" and "Notes.pdf" for one file, and writing one over the other keeps the old spelling:
 * a document renamed on the tablet only in case has its file renamed first, so the name on disk is the new one.
 */
function matchCase(file) {
  const dir = path.dirname(file), name = path.basename(file);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const key = name.normalize('NFC').toLowerCase();
  const old = names.find((n) => n !== name && n.normalize('NFC').toLowerCase() === key);
  if (old) { try { fs.renameSync(path.join(dir, old), file); } catch { /* left as it is spelled */ } }
}
function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  matchCase(file);
  const temporary = temporaryFor(file);
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}
/** `from` copied to `file`: a clone on APFS (instant, and no more space until one of them changes). */
function cloneAtomic(from, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  matchCase(file);
  const temporary = temporaryFor(file);
  fs.copyFileSync(from, temporary, fs.constants.COPYFILE_FICLONE);
  fs.renameSync(temporary, file);
}

/**
 * `{ dir, id, pdf, md }`: the library folder, the document, and the absolute paths to write (`pdf` null for an
 * ebook). → { pdf: written?, md: written?, pages }. A `.md` with nothing to say is removed rather than left stale.
 */
async function convertDocument({ dir, id, pdf, md }) {
  const bridge = require('remarkable-bridge');
  const source = bridge.createFolderSource(dir);
  const bundle = await source.open(id);
  const doc = await bridge.readDocument(bundle);
  let wrotePdf = false;
  // A PDF nobody wrote on, its pages as they came: the file itself, cloned rather than rewritten (most of a library).
  const original = path.join(dir, `${id}.pdf`);
  const untouched = bundle.content.fileType === 'pdf' && doc.pages.every((p) => !p.page && !p.error && p.ref.sourcePage === p.ref.index)
    && (bundle.content.originalPageCount === null || bundle.content.originalPageCount === doc.pages.length) && fs.existsSync(original);
  if (pdf && untouched) {
    cloneAtomic(original, pdf);
    wrotePdf = true;
  } else if (pdf && bundle.content.fileType !== 'epub') {
    writeAtomic(pdf, await bridge.documentToPdf(doc, { source: await bundle.source() }));
    wrotePdf = true;
  }
  const text = bridge.documentMarkdown(doc);
  const said = text.split('\n').slice(1).join('\n').trim(); // past the title
  if (said) writeAtomic(md, `${text}\n`);
  else fs.rmSync(md, { force: true });
  return { pdf: wrotePdf, md: !!said, pages: doc.pages.length };
}

// As a worker: one conversion per message, answered with { seq, ok, result } or { seq, ok: false, error }. pdf-lib warns
// on the console about oddities in the PDFs it reads; the worker says nothing (as the main process says nothing).
if (!isMainThread && workerData && workerData.remarkableConvert) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
  parentPort.on('message', async ({ seq, job }) => {
    try {
      parentPort.postMessage({ seq, ok: true, result: await convertDocument(job) });
    } catch (error) {
      parentPort.postMessage({ seq, ok: false, error: error && error.message ? error.message : String(error), code: error && error.code ? String(error.code) : '' });
    }
  });
}

module.exports = { convertDocument, CONVERT_VERSION };
