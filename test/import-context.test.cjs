'use strict';

// "Import Context" (2026-10-12): whether this library's context has been imported (src/main/connect/imported.cjs), when
// the offer over the workspace is shown (ipc guided-offer), its wording (src/renderer/ui/GuidedSetup.jsx
// ImportContextOffer), and its Import, which opens Connect your library's tick-and-import screen over the workspace
// (src/renderer/App.jsx importContext) and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { contextImported, importOfferDue } = require('../src/main/connect/imported.cjs');
const gettingStarted = require('../src/main/store/getting-started.cjs');

const emptyRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-import-context-'));
function saveSession(root, fields) {
  const dir = path.join(root, '.connect', randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: path.basename(dir), chat: [], ...fields }));
}

test('context-imported: false on an empty data root; true with MEMORY.md or a finished session; false with only an unfinished one', () => {
  const empty = emptyRoot();
  assert.equal(contextImported(empty), false, 'an empty data root');
  assert.equal(contextImported(path.join(empty, 'not-there')), false, 'no data root at all');
  assert.equal(contextImported(''), false);

  const memory = emptyRoot();
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), '# Memory\n');
  assert.equal(contextImported(memory), true, 'MEMORY.md');

  const finished = emptyRoot();
  saveSession(finished, { done: false, finished: true });
  assert.equal(contextImported(finished), true, 'Import pressed (finished)');
  const done = emptyRoot();
  saveSession(done, { done: true, finished: false });
  assert.equal(contextImported(done), true, 'the librarian said it was done (done)');

  const unfinished = emptyRoot();
  saveSession(unfinished, { done: false, finished: false });
  fs.writeFileSync(path.join(unfinished, '.connect', 'offer.json'), JSON.stringify({ seen: true, how: 'started', finished: true }));
  fs.mkdirSync(path.join(unfinished, '.connect', 'memory-history'));
  const broken = path.join(unfinished, '.connect', randomUUID());
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'session.json'), '{ not json');
  assert.equal(contextImported(unfinished), false, 'only an unfinished session (and what else .connect holds)');
  saveSession(unfinished, { finished: true });
  assert.equal(contextImported(unfinished), true, 'one finished among them is enough');

  // Main answers { imported } for the data root in use; the window reaches it through the bridge.
  const ipc = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(ipc, /handle\('context-imported', withCtx\(\(ctx\) => \(\{ imported: contextImported\(ctx\.dataRoot\) \}\)\)\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), /contextImported: invoke\('context-imported'\)/);
});

test('guided-offer: shown while not imported and not dismissed, still after shown or started; hidden once dismissed, once imported, and with ENGELBART_CONNECT_OFFER=off', () => {
  const env = {};
  const root = emptyRoot();
  const here = { dataRoot: root };
  assert.equal(importOfferDue(here, env), true, 'not imported, never answered');
  gettingStarted.markGuidedOffer(here, 'shown');
  assert.equal(importOfferDue(here, env), true, 'shown alone: it comes back on a later launch');
  gettingStarted.markGuidedOffer(here, 'started');
  assert.equal(importOfferDue(here, env), true, 'Import pressed, the popup closed before an import began');
  gettingStarted.markGuidedOffer(here, 'onboarded');
  assert.equal(importOfferDue(here, env), true, 'onboarding without an import');
  assert.equal(importOfferDue(here, { ENGELBART_CONNECT_OFFER: 'off' }), false, 'the smokes\' switch');
  gettingStarted.markGuidedOffer(here, 'dismissed');
  assert.equal(importOfferDue(here, env), false, 'Not now');

  const imported = emptyRoot();
  const there = { dataRoot: imported };
  saveSession(imported, { finished: true });
  assert.equal(importOfferDue(there, env), false, 'a finished import: never');
  gettingStarted.markGuidedOffer(there, 'shown');
  assert.equal(importOfferDue(there, env), false);
  const memory = emptyRoot();
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), 'x');
  assert.equal(importOfferDue({ dataRoot: memory }, env), false, 'MEMORY.md: never');

  // Off by default in process.env only when set.
  const was = process.env.ENGELBART_CONNECT_OFFER;
  process.env.ENGELBART_CONNECT_OFFER = 'off';
  try { assert.equal(importOfferDue({ dataRoot: emptyRoot() }), false); } finally { if (was === undefined) delete process.env.ENGELBART_CONNECT_OFFER; else process.env.ENGELBART_CONNECT_OFFER = was; }
});

function load(file) {
  const filename = path.join(__dirname, '__import-context-unit.cjs');
  const build = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs',
    jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/server'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
  const compiled = new Module(filename, module); compiled.paths = module.paths;
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(build.outputFiles[0].text, filename); }
  finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}

test('the offer reads "Import Context" with its line, Not now and Import (2026-10-12)', () => {
  const { ImportContextOffer, GuidedSetupOffer } = load('ui/GuidedSetup.jsx');
  assert.equal(GuidedSetupOffer, undefined, 'renamed');
  const html = renderToStaticMarkup(React.createElement(ImportContextOffer, { onImport: () => {}, onDismiss: () => {} }));
  assert.match(html, /data-import-offer="1"/);
  assert.match(html, /<div id="import-offer-title"[^>]*>Import Context<\/div>/);
  assert.ok(html.includes('>Import your AI chats, papers, notes, and local files into Engelbart</p>'));
  assert.match(html, /data-import-offer-dismiss="1">.*>Not now<\/button>/);
  assert.match(html, /data-import-offer-import="1"><button[^>]*>Import<span/);
  for (const gone of ['guided setup', 'Walk through it', '>Start<']) assert.ok(!html.includes(gone), gone);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/GuidedSetup.jsx'), 'utf8');
  assert.match(source, /if \(event\.key === 'Escape'\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); onDismiss\(\); \}/, 'Escape is Not now');
  assert.match(source, /onMouseDown=\{\(event\) => \{ if \(event\.target === event\.currentTarget\) onDismiss\(\); \}\}/, 'a click outside is Not now');
});

test('Import opens Connect your library over the workspace for the project and workspace open; no onboarding, no phase change; Not now dismisses (2026-10-12)', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/App.jsx'), 'utf8');
  const start = app.indexOf('const importContext = React.useCallback(');
  const body = app.slice(start, app.indexOf('}, []);', start));
  assert.ok(start > 0 && body.length > 0);
  assert.match(body, /api\.guidedOfferSeen\('started'\)/, 'marked started');
  assert.match(body, /const projectId = now\.phase === 'workspace' && now\.tree \? now\.tree\.project\.id : null;/, 'the project open');
  assert.match(body, /const workspaceId = visited\.current && visited\.current\.projectId === projectId \? visited\.current\.workspaceId : \(now\.entry && now\.entry\.workspaceId\) \|\| null;/, 'the workspace open, as startGuided finds it');
  assert.match(body, /setConnectPopup\(\{ projectId, workspaceId \}\);/);
  for (const not of ['startGuided', 'setPhase', 'setTree', 'setEntry', 'setGuided(', 'setRun', 'welcomeWorkspace']) assert.ok(!body.includes(not), `Import does not ${not}`);
  assert.match(app, /<ImportContextOffer onImport=\{importContext\} onDismiss=\{\(\) => \{ setGuidedOffer\(false\); api\.guidedOfferSeen\('dismissed'\)\.catch\(\(\) => \{\}\); \}\} \/>/);
  assert.doesNotMatch(app, /GuidedSetupOffer/);
  // Asked once a launch (per data root): shown, closed or put away, it is not offered again until Engelbart opens again.
  assert.match(app, /if \(!openProjectId \|\| offeredIn\.current === dataRoot\) return undefined;/);
  assert.match(app, /offeredIn\.current = dataRoot;\n        setGuidedOffer\(true\);/);
  // The popup the Import opens has no "Shown once" line: closing it is not a dismissal.
  const dock = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/ConnectDock.jsx'), 'utf8');
  assert.ok(!dock.includes('Shown once. Close it to dismiss.'));
  assert.match(dock, /<ConnectLibrary\n\s+mode="popup"\n\s+sessionId=\{request\.sessionId \|\| null\}\n\s+projectId=\{request\.projectId \|\| null\}\n\s+workspaceId=\{request\.workspaceId \|\| null\}/);
  // In popup mode without a session, Connect your library starts at its tick-and-import screen.
  const screen = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');
  assert.match(screen, /const \[view, setView\] = React\.useState\(sessionId \? 'loading' : 'choose'\);/);
});
