'use strict';

// What is dragged onto the library or a workspace (MATH-19, 2026-10-05; src/renderer/model/drop.js): readDrop reads a
// drop's DataTransfer inside its event, addDropped makes each thing a library row, in order. The DataTransfers here are
// stand-ins with what Finder, Chrome and Safari put on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/drop.js')).href);

/** A DataTransfer as a drop event has it: its files, and its strings by type. */
function transfer({ files = [], data = {} } = {}) {
  return {
    files,
    types: [...(files.length ? ['Files'] : []), ...Object.keys(data)],
    getData: (type) => data[type] || '',
  };
}
const file = (name, type, text = 'bytes') => new File([text], name, { type });
// preload's pathForFile: where Finder said a file is, null for one that came without a path
const onDisk = new Map();
const pathForFile = (f) => onDisk.get(f) || null;

test('readDrop: a file from Finder is its path', async () => {
  const { readDrop } = await load();
  const png = file('figure.png', 'image/png');
  const pdf = file('paper.pdf', 'application/pdf');
  onDisk.set(png, '/Users/h/Desktop/figure.png');
  onDisk.set(pdf, '/Users/h/Desktop/paper.pdf');
  assert.deepEqual(readDrop(transfer({ files: [png, pdf] }), pathForFile), [{ kind: 'path', path: '/Users/h/Desktop/figure.png' }, { kind: 'path', path: '/Users/h/Desktop/paper.pdf' }]);
});

test('readDrop: a file with no path is its bytes', async () => {
  const { readDrop } = await load();
  const picture = file('image.png', 'image/png');
  const items = readDrop(transfer({ files: [picture] }), pathForFile);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'bytes');
  assert.equal(items[0].file, picture);
  // a pathForFile that throws is a file without a path
  assert.equal(readDrop(transfer({ files: [picture] }), () => { throw new Error('no'); })[0].kind, 'bytes');
});

test('readDrop: a link alone is the first http(s) line of text/uri-list', async () => {
  const { readDrop } = await load();
  const uris = '# a comment\r\nfile:///Users/h/secret.txt\r\nhttps://example.org/post\r\nhttps://example.org/second';
  assert.deepEqual(readDrop(transfer({ data: { 'text/uri-list': uris } }), pathForFile), [{ kind: 'url', url: 'https://example.org/post' }]);
  // Google Images' link to a result is the picture it leads to
  const imgres = 'https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.example.org%2Fcat.jpg&imgrefurl=https%3A%2F%2Fexample.org%2Fcats&h=600&w=800';
  assert.deepEqual(readDrop(transfer({ data: { 'text/uri-list': imgres } }), pathForFile), [{ kind: 'url', url: 'https://cdn.example.org/cat.jpg' }]);
});

test('readDrop: with no link, the src of the first <img> in text/html', async () => {
  const { readDrop } = await load();
  const html = '<meta charset="utf-8"><a href="/x"><img alt="cat" src="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc&amp;s=10"></a><img src="https://example.org/second.png">';
  assert.deepEqual(readDrop(transfer({ data: { 'text/html': html } }), pathForFile), [{ kind: 'url', url: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc&s=10' }]);
  // a thumbnail that is only a data: address comes as its bytes
  const png = Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1').toString('base64');
  const [item] = readDrop(transfer({ data: { 'text/html': `<img src='data:image/png;base64,${png}'>` } }), pathForFile);
  assert.equal(item.kind, 'bytes');
  assert.equal(item.file.type, 'image/png');
  assert.equal(Buffer.from(await item.file.arrayBuffer()).toString('latin1'), '\x89PNG\r\n\x1a\nrest');
  // nothing the library could take
  assert.deepEqual(readDrop(transfer({ data: { 'text/html': '<p>words</p>', 'text/plain': 'words' } }), pathForFile), []);
  assert.deepEqual(readDrop(null, pathForFile), []);
});

test('readDrop: mixed — files win over a link, a link over an <img>', async () => {
  const { readDrop } = await load();
  const finder = file('notes.md', 'text/markdown');
  onDisk.set(finder, '/Users/h/notes.md');
  const loose = file('image.gif', 'image/gif');
  const both = transfer({ files: [finder, loose], data: { 'text/uri-list': 'https://example.org/a', 'text/html': '<img src="https://example.org/b.png">' } });
  const items = readDrop(both, pathForFile);
  assert.deepEqual(items.map((item) => item.kind), ['path', 'bytes']);
  assert.equal(items[0].path, '/Users/h/notes.md');
  assert.equal(items[1].file, loose);
  const page = transfer({ data: { 'text/uri-list': 'https://example.org/page', 'text/html': '<img src="https://example.org/b.png">' } });
  assert.deepEqual(readDrop(page, pathForFile), [{ kind: 'url', url: 'https://example.org/page' }]);
});

test('carriesDrop: files or a link; a sidebar row or plain text is not one', async () => {
  const { carriesDrop } = await load();
  assert.equal(carriesDrop({ dataTransfer: { types: ['Files'] } }), true);
  assert.equal(carriesDrop({ dataTransfer: { types: ['text/uri-list', 'text/html'] } }), true);
  assert.equal(carriesDrop({ dataTransfer: { types: ['application/x-engelbart-row'] } }), false);
  assert.equal(carriesDrop({ dataTransfer: { types: ['text/plain'] } }), false);
  assert.equal(carriesDrop({}), false);
});

test('isPastable: the pictures the document takes as pasted ones', async () => {
  const { isPastable } = await load();
  assert.equal(isPastable({ kind: 'bytes', file: file('a.webp', 'image/webp') }), true);
  assert.equal(isPastable({ kind: 'bytes', file: file('a.svg', 'image/svg+xml') }), false);
  assert.equal(isPastable({ kind: 'path', path: '/Users/h/a.JPG' }), true);
  assert.equal(isPastable({ kind: 'path', path: '/Users/h/a.heic' }), false);
  assert.equal(isPastable({ kind: 'url', url: 'https://example.org/a.png' }), false);
});

test('addDropped: one at a time, in order, each by its own call; refusals are said and the rest still added', async () => {
  const { addDropped } = await load();
  const calls = [];
  let open = 0;
  const step = async (name, ...args) => {
    open += 1;
    assert.equal(open, 1, 'never two at once');
    calls.push([name, ...args]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
    if (args[0] === '/Users/h/twice.pdf') throw new Error("Error invoking remote method 'engelbart:add-library-item': Error: Already in the library as “twice”");
    return { id: `row-${calls.length}` };
  };
  const api = {
    addLibraryItem: (input) => step('item', input),
    addLibraryFile: (bytes, options) => step('file', Buffer.from(bytes).toString(), options),
    addLibraryUrl: (url) => step('url', url),
  };
  const errorMessage = (error) => error.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
  const items = [
    { kind: 'path', path: '/Users/h/a.pdf' },
    { kind: 'bytes', file: file('image.png', 'image/png', 'png bytes') },
    { kind: 'path', path: '/Users/h/twice.pdf' },
    { kind: 'url', url: 'https://example.org/cat.jpg' },
  ];
  const { rows, problems } = await addDropped(items, { api, errorMessage });
  assert.deepEqual(calls, [['item', '/Users/h/a.pdf'], ['file', 'png bytes', { mime: 'image/png', name: 'image.png' }], ['item', '/Users/h/twice.pdf'], ['url', 'https://example.org/cat.jpg']]);
  assert.deepEqual(rows.map((row) => row.id), ['row-1', 'row-2', 'row-4']);
  assert.deepEqual(problems, ['Already in the library as “twice”']);
  // a picture with no name of its own (a data: thumbnail) is named by the library
  calls.length = 0;
  await addDropped([{ kind: 'bytes', file: new File(['x'], '', { type: 'image/gif' }) }], { api });
  assert.deepEqual(calls, [['file', 'x', { mime: 'image/gif', name: null }]]);
});
