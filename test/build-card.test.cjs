'use strict';

// A Build's card (src/renderer/workspace/DocEditor.jsx buildParts) and its Review (BuildReview.jsx) around the run step
// (2026-09-29): Review and Accept wait while it gets the Build running; Review lists what runs first, the code under
// Changes; an accepted Build that kept its copy offers Stop for each runnable and for all of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const jsx = require('react/jsx-runtime');
const reactDom = require('react-dom');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

// Every element made, to find a button and press it; a portal is drawn in place (there is no document here).
const elements = [];
const runtime = { ...jsx };
for (const method of ['jsx', 'jsxs']) runtime[method] = (...args) => { const element = jsx[method](...args); elements.push(element); return element; };
const dom = { ...reactDom, createPortal: (node) => node };

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = function (id) { return id === 'react/jsx-runtime' ? runtime : id === 'react-dom' ? dom : Module.prototype.require.call(this, id); };
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
/** The card's parts as { part: text } (tags out), and the acts its buttons carry. */
function card(task) {
  const editor = Object.create(DocEditor.prototype);
  Object.assign(editor, { props: {}, buildOpen: new Set(), buildSteps: new Set() });
  const parts = Object.fromEntries(editor.buildParts(task.id, { id: task.id, title: 'Add a page', messages: [], modelName: 'Opus', effort: 'high', ...task }));
  const text = Object.fromEntries(Object.entries(parts).map(([key, html]) => [key, html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]));
  const acts = [...Object.values(parts).join('').matchAll(/<button[^>]*>/g)].map(([tag]) => [/data-act="([^"]+)"/.exec(tag), /data-run-name="([^"]+)"/.exec(tag)]).filter(([act]) => act).map(([act, run]) => (run ? `${act[1]}:${run[1]}` : act[1]));
  return { parts, text, acts };
}

test('while the run step gets it running, the card says so with its phase: no Review, no Accept until it is done, failed or stopped', () => {
  const working = card({ id: 'b1', status: 'review', runStep: { status: 'running', phase: 'Starting web', runnables: [{ name: 'web', type: 'ui', status: 'checking' }] } });
  assert.match(working.text.head, /Getting it running…$/);
  assert.match(working.text.run, /^Getting it running… Starting web/);
  assert.ok(!working.acts.includes('buildreview') && !working.acts.includes('buildaccept'), `offered: ${working.acts}`);
  assert.ok(working.acts.includes('buildrunstop') && working.acts.includes('builddiscard'));
  assert.match(working.parts.reply, /data-build-input/, 'a reply still goes (it halts the run step)');
  for (const status of ['done', 'failed', 'stopped']) {
    const after = card({ id: 'b1', status: 'review', runStep: { status, runnables: [] } });
    assert.match(after.text.head, /Ready to review$/, status);
    assert.ok(after.acts.includes('buildreview') && after.acts.includes('buildaccept'), `${status}: ${after.acts}`);
  }
  const plain = card({ id: 'b2', status: 'review' });
  assert.ok(plain.acts.includes('buildreview') && plain.acts.includes('buildaccept'), 'no run step: as before');
});

const BuildReview = load('BuildReview.jsx').default;
const DIFF = { files: [{ path: 'web/index.html', status: 'A', adds: 3, dels: 0 }], patch: 'diff --git a/web/index.html b/web/index.html\n+<h1>hi</h1>', from: 'main', base: 'abc1234' };
function reviewOf(task, props = {}) {
  elements.length = 0;
  const opened = [];
  globalThis.document = { body: null }; // where the portal would go
  let html;
  try { html = renderToStaticMarkup(React.createElement(BuildReview, { title: 'Add a page', review: DIFF, error: '', task, aside: 571, onOpen: (name) => opened.push(name), onClose() {}, ...props })); } finally { delete globalThis.document; }
  const find = (key, value) => elements.find((element) => element.props && element.props[key] === value);
  return { html, opened, find, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
}
const RUNNABLES = [
  { name: 'web', folder: '.', type: 'ui', status: 'running', passed: true, url: 'http://localhost:5173/' },
  { name: 'cli', folder: 'tools', type: 'terminal', status: 'running', passed: true },
  { name: 'desktop', folder: 'app', type: 'app', status: 'failed', error: 'It exited within 10 seconds (exit code 1).\nError: Cannot find module electron' },
];

test('Review opens on what runs: one entry per runnable with its kind, where it stands and its last error; clicking one opens it; the diff is under Changes', () => {
  const view = reviewOf({ runStep: { status: 'done', runnables: RUNNABLES } });
  assert.match(view.html, /data-review-shown="running"/);
  assert.match(view.html, /right:571px/, 'the right pane (where it opens) is left uncovered');
  assert.match(view.text, /web web UI runs at http:\/\/localhost:5173\/ Open in the Stage/);
  assert.match(view.text, /cli terminal program · tools runs Open in the terminal/);
  assert.match(view.text, /desktop desktop app · app did not run It exited within 10 seconds \(exit code 1\)\. Error: Cannot find module electron/);
  assert.ok(!/data-review-changes/.test(view.html), 'the diff is not drawn until Changes');
  view.find('data-review-runnable', 'web').props.onClick();
  view.find('data-review-runnable', 'cli').props.onClick();
  view.find('data-review-runnable', 'desktop').props.onClick();
  assert.deepEqual(view.opened, ['web', 'cli'], 'what did not run opens nothing');
  assert.equal(view.find('data-review-runnable', 'desktop').props.disabled, true);
  assert.ok(view.find('data-review-view', 'changes'), 'Changes is one click away');
});

test('when nothing runs, Review opens on the diff with what did not run and why; with no run step it is the diff as before', () => {
  const failed = reviewOf({ runStep: { status: 'done', runnables: [RUNNABLES[2]] } });
  assert.match(failed.html, /data-review-shown="changes"/);
  assert.match(failed.html, /right:0/, 'nothing opens beside it: the whole window');
  assert.match(failed.text, /desktop desktop app did not run It exited within 10 seconds/);
  assert.match(failed.text, /web\/index\.html added \+3 −0/);
  assert.ok(failed.find('data-review-view', 'running'), 'Running is still there to look at');
  const none = reviewOf({ runStep: { status: 'done', runnables: [] } });
  assert.match(none.html, /data-review-shown="changes"/);
  assert.ok(!none.find('data-review-view', 'running'), 'nothing ran: no tabs');
  const plain = reviewOf(null);
  assert.match(plain.text, /^Review Add a page since main at abc1234 × web\/index\.html added/);
});

test('before Accept the card lists what runs without opening it (Review does); an accepted Build that kept its copy offers Open and Stop for each, and Stop all, and no Remove until they are stopped', () => {
  const runnables = [
    { name: 'web', folder: '.', type: 'ui', status: 'running', passed: true, url: 'http://localhost:5173/' },
    { name: 'cli', folder: '.', type: 'terminal', status: 'stopped', passed: true },
    { name: 'desk', folder: 'app', type: 'app', status: 'failed', error: 'It exited.' },
  ];
  const open = card({ id: 'b1', status: 'review', runStep: { status: 'done', runnables } });
  assert.match(open.text.run, /^Run step Review opens what runs web web UI runs at http:\/\/localhost:5173\/ cli terminal stopped desk desktop app did not run · It exited\.$/);
  assert.ok(!open.acts.some((act) => act.startsWith('buildrunshow') || act.startsWith('buildrunstopone')), `no Open on the card: ${open.acts}`);

  const kept = card({ id: 'b1', status: 'accepted', final: true, keptCopy: true, accepted: { sha: 'abc' }, runStep: { status: 'done', runnables } });
  assert.match(kept.text.run, /^Running on what landed Stop all web web UI runs at http:\/\/localhost:5173\/ Open Stop cli terminal stopped$/, 'what did not run is not listed');
  assert.deepEqual(kept.acts.filter((act) => act.startsWith('buildrun')), ['buildrunstopall', 'buildrunshow:web', 'buildrunstopone:web']);
  assert.ok(kept.acts.includes('buildreview') && !kept.acts.includes('buildremove'), `stopped first, then removed: ${kept.acts}`);

  const released = card({ id: 'b1', status: 'accepted', final: true, keptCopy: false, accepted: { sha: 'abc' }, runStep: { status: 'done', runnables: runnables.map((item) => ({ ...item, status: item.status === 'running' ? 'stopped' : item.status })) } });
  assert.equal(released.parts.run, '', 'nothing runs: no section');
  assert.ok(released.acts.includes('buildremove'));
});
