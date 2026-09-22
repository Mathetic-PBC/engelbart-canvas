'use strict';

// Is this pdf a paper? The signals, the rule over them, and the real fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { paperSignals, isPaper, inspectPdf } = require('../src/main/context/pdf-kind.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-pdf-kind-'));

// A PDF with one page per list of lines, enough for pdf.js to read back.
function makePdf(pages, info = null) {
  const escape = (text) => text.replace(/([\\()])/g, '\\$1');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const content = `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${lines.map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  if (info) objects.push(`<< ${Object.entries(info).map(([key, value]) => `/${key} (${escape(value)})`).join(' ')} >>`);
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info ? ` /Info ${objects.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const write = (name, pages, info) => { const file = path.join(dir, name); fs.writeFileSync(file, makePdf(pages, info)); return file; };
const filler = (n) => Array.from({ length: n }, (_, i) => `Body sentence number ${i} of the text.`);

test('the rule: an arXiv stamp alone, or any two of doi / abstract / keywords / references', () => {
  const none = { arxiv: false, doi: false, abstract: false, keywords: false, references: false };
  assert.equal(isPaper(none), false);
  assert.equal(isPaper({ ...none, arxiv: true }), true);
  for (const one of ['doi', 'abstract', 'keywords', 'references']) assert.equal(isPaper({ ...none, [one]: true }), false, `${one} alone is not enough`);
  assert.equal(isPaper({ ...none, abstract: true, references: true }), true);
  assert.equal(isPaper({ ...none, doi: true, keywords: true }), true);
});

test('a real paper: HypoCompass carries an arXiv stamp down its margin, an abstract and a reference list', async () => {
  const file = path.join(__dirname, '..', 'fixtures', 'hypocompass.pdf');
  const signals = await paperSignals(file);
  assert.deepEqual([signals.arxiv, signals.abstract], [true, true], JSON.stringify(signals));
  assert.deepEqual(await inspectPdf(file), ['paper']);
});

test('pdfs that are not papers: an invoice, slides with a summary, a report that only has an abstract', async () => {
  assert.deepEqual(await inspectPdf(write('invoice.pdf', [['Invoice 1042', 'Bill to: Hudson', 'Total due: $40.00', 'Thank you for your business.']])), []);
  assert.deepEqual(await inspectPdf(write('slides.pdf', [['Context engineering', 'A talk'], ['Summary', 'Three points.'], ['Questions?']])), []);
  const report = write('report.pdf', [['Quarterly report', 'Abstract', 'We did things this quarter. They went well.', '1 Introduction', ...filler(8)], filler(10)]);
  assert.deepEqual([(await paperSignals(report)).abstract, await inspectPdf(report)], [true, []], 'an abstract alone does not make a paper');
});

test('papers without an arXiv stamp: an abstract and a reference list pages later; a doi in the file\'s own metadata', async () => {
  const late = write('late-references.pdf', [
    ['A Study of Things', 'Ada Lovelace', 'Abstract', 'We study things. They matter.', '1 Introduction', ...filler(6)],
    filler(12), filler(12), filler(12),
    [...filler(3), 'References', '[1] A. Turing. 1936. On computable numbers.'],
    ['A Appendix', ...filler(5)],
  ]);
  const signals = await paperSignals(late);
  assert.deepEqual([signals.abstract, signals.references, signals.arxiv, signals.doi], [true, true, false, false]);
  assert.deepEqual(await inspectPdf(late), ['paper']);

  const published = write('published.pdf', [['A Published Thing', 'Keywords: tutoring, testing', ...filler(6)]], { Subject: 'Proc. CHI 2023. https://doi.org/10.1145/3544548.3580919' });
  assert.deepEqual([(await paperSignals(published)).doi, await inspectPdf(published)], [true, ['paper']]);
  const printed = write('printed-doi.pdf', [['Title', 'https://doi.org/10.1145/3544548.3580919', 'ABSTRACT', 'One paragraph of it.', 'CCS CONCEPTS', ...filler(3)]]);
  assert.deepEqual(await inspectPdf(printed), ['paper']);
  const inPassing = await paperSignals(write('in-passing.pdf', [['Notes', 'Abstract', 'A short one.', '1 Introduction', 'See the references in chapter 2.', 'Keywords are what you search by.', ...filler(4)]]));
  assert.deepEqual([inPassing.abstract, inPassing.keywords, inPassing.references], [true, false, false], 'the words inside a sentence are not headings');
  assert.equal((await paperSignals(write('nothing.pdf', [filler(5)]))).references, null, 'with no other signal the later pages are not read');
});

test('a file that is not a pdf at all is refused, not guessed at', async () => {
  const file = path.join(dir, 'broken.pdf');
  fs.writeFileSync(file, 'not a pdf');
  await assert.rejects(inspectPdf(file));
});
