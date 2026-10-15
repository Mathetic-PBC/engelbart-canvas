'use strict';

// The Welcome walkthrough (2026-10-09): its steps and rows (src/renderer/model/getting-started.js) and its state and
// step 2's workspace (src/main/store/getting-started.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const onboarding = require('../src/main/store/onboarding.cjs');
const gettingStarted = require('../src/main/store/getting-started.cjs');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/getting-started.js')).href);

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-getting-started-'));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('the Welcome workspace shows the three steps (the Library, @brainstorm, @discover), a hidden walkthrough none', async () => {
  const { STEPS, stepsHere, firstOpen } = await load();
  assert.deepEqual(STEPS.map((step) => step.title), ['See what came in', 'Brainstorm what to do next', 'Find prior work']);
  const state = { workspaceId: 'w', ticked: [1], hidden: false };
  assert.deepEqual(stepsHere(state, 'w').map((step) => [step.n, step.shown]), [[1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(stepsHere(state, 'other'), []);
  assert.deepEqual(stepsHere({ ...state, hidden: true }, 'w'), []);
  assert.deepEqual(stepsHere(null, 'w'), []);
  assert.equal(firstOpen(stepsHere(state, 'w'), [1]), 2);
  assert.equal(firstOpen(stepsHere(state, 'w'), [1, 2, 3]), null);
});

test('step 1 lists the Library\'s tabs that hold something, with their counts; the right of a row', async () => {
  const { libraryTabs, stepMeta } = await load();
  const rows = [
    { id: 'a', type: 'md', tags: ['note'], name: 'A note' },
    { id: 'b', type: 'md', tags: ['note'], name: 'Another' },
    { id: 'c', type: 'pdf', tags: [], name: 'A paper' },
    { id: 'd', type: 'website', tags: [], name: 'A page', address: 'https://example.com' },
  ];
  const { tabs, total } = libraryTabs(rows);
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.label, tab.count]), [['notes', 'Notes', 2], ['papers', 'Papers', 1], ['web', 'Web', 1]]);
  assert.equal(total, 4);
  assert.deepEqual(libraryTabs([]), { tabs: [], total: 0 });
  assert.equal(stepMeta(1, { items: 4 }), '4 items');
  assert.equal(stepMeta(1, { items: 0 }), 'Library');
  assert.equal(stepMeta(3, { papers: 1 }), '1 paper');
  assert.equal(stepMeta(3, {}), '');
  assert.equal(stepMeta(2, {}), '');
});

test('step 3: the papers @discover\'s guides in the document found, each once, opened at their passage', async () => {
  const { discoverPapers } = await load();
  const doc = [
    '@discover how transfer was measured',
    'bart> ## Start here',
    'bart> **[Productive failure](https://doi.org/10.1/kapur)** · Kapur et al. · 2008',
    'bart> **Read:** [Method](https://doi.org/10.1/kapur#find=tested%20on%20new&to=problems)',
    'bart> **Why:** Struggle first, then tested on new problems.',
    'bart>',
    'bart> **[Generative AI can harm learning](https://arxiv.org/abs/2501.1)** · Bastani · 2025',
    'bart> **Read:** abstract only',
    'bart> **Why:** Practice with AI, then an exam without it.',
    '',
    'bart> **[Productive failure](https://doi.org/10.1/kapur#find=again)** · Kapur et al. · 2008',
    'A line of mine: **[Not a guide](https://example.org)** · Me · 2026',
  ].join('\n');
  assert.deepEqual(discoverPapers(doc), [
    { key: 'https://doi.org/10.1/kapur', title: 'Productive failure', why: 'Struggle first, then tested on new problems.', address: 'https://doi.org/10.1/kapur#find=tested%20on%20new&to=problems', byline: 'Kapur · 2008 · Method' },
    { key: 'https://arxiv.org/abs/2501.1', title: 'Generative AI can harm learning', why: 'Practice with AI, then an exam without it.', address: 'https://arxiv.org/abs/2501.1', byline: 'Bastani · 2025' },
  ]);
  assert.deepEqual(discoverPapers(''), []);
  assert.equal(discoverPapers(doc, 1).length, 1);
});

test('onboarding names the first workspace Welcome; + Project keeps Getting started', async () => {
  const made = await onboarding.startProject(ctx, { name: 'Walk one', workspaceName: 'Welcome' });
  assert.equal((await projects.loadProject(ctx, made.project.id)).workspaces[0].name, 'Welcome');
  const other = await onboarding.startProject(ctx, { name: 'Walk two' });
  assert.equal((await projects.loadProject(ctx, other.project.id)).workspaces[0].name, 'Getting started');
});

test('the state: kept in .context, ticks added and taken off, hidden for good', async () => {
  const made = await projects.createProjectWithWelcome(ctx, { name: 'Walk state' }, { workspaceName: 'Welcome' });
  assert.equal(gettingStarted.readGettingStarted(ctx, made.project.id), null, '+ Project: no walkthrough');
  const started = gettingStarted.startGettingStarted(ctx, made.project.id, { workspaceId: made.workspaceId });
  assert.deepEqual([started.workspaceId, started.ticked, started.hidden, started.steps], [made.workspaceId, [], false, 3]);
  assert.ok(fs.existsSync(path.join(made.project.dir, '.context', 'getting-started.json')));
  assert.equal((await projects.loadProject(ctx, made.project.id)).workspaces.length, 1, 'the .context folder is no workspace');
  let state = gettingStarted.setGettingStarted(ctx, made.project.id, { tick: [3, 1, 9, 3] });
  assert.deepEqual(state.ticked, [1, 3]);
  state = gettingStarted.setGettingStarted(ctx, made.project.id, { untick: [3] });
  assert.deepEqual(gettingStarted.readGettingStarted(ctx, made.project.id).ticked, [1]);
  assert.equal(gettingStarted.setGettingStarted(ctx, made.project.id, { hidden: true }).hidden, true);
  assert.equal(gettingStarted.setGettingStarted(ctx, made.project.id, { tick: [2] }).hidden, true, 'hidden stays hidden');
});

test('the guided setup is offered once in a data root: shown, started or dismissed, and never to someone whose onboarding made their first project (2026-10-10)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-guided-offer-'));
  const here = { dataRoot: root };
  assert.equal(gettingStarted.guidedOfferDue(here), true, 'never answered: due');
  const at = new Date('2026-10-10T12:00:00Z');
  assert.deepEqual(gettingStarted.markGuidedOffer(here, 'shown', at), { seen: true, how: 'shown', at: '2026-10-10T12:00:00.000Z' });
  assert.equal(gettingStarted.guidedOfferDue(here), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, gettingStarted.OFFER_FILE), 'utf8')).how, 'shown');
  assert.equal(gettingStarted.markGuidedOffer(here, 'started').how, 'started');
  assert.equal(gettingStarted.markGuidedOffer(here, 'anything').how, 'dismissed', 'an unknown answer is a dismissal');
  fs.writeFileSync(path.join(root, gettingStarted.OFFER_FILE), 'not json');
  assert.equal(gettingStarted.guidedOfferDue(here), true, 'a file that cannot be read: due');
  // Main: a new user's onboarding marks it; the smokes' switch never shows it.
  const ipc = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  assert.match(ipc, /if \(welcome\) \{ try \{ gettingStarted\.markGuidedOffer\(ctx, 'onboarded'\); \}/);
  assert.match(ipc, /handle\('guided-offer', withCtx\(\(ctx\) => \(\{ show: process\.env\.ENGELBART_CONNECT_OFFER !== 'off' && gettingStarted\.guidedOfferDue\(ctx\) \}\)\)\);/);
});

test('the guided setup inside a project: a Welcome workspace added there with what it brought in, no new project, another on each run (2026-10-10)', async () => {
  const made = await projects.createProjectWithWelcome(ctx, { name: 'Already here' });
  const before = (await projects.listProjects(ctx)).length;
  const paper = await ctx.libraryDb.insert({ id: randomUUID(), name: 'A paper', type: 'pdf', tags: ['paper'], path: '/tmp/guided-paper.pdf' });
  const site = await ctx.libraryDb.insert({ id: randomUUID(), name: 'A site', type: 'website', tags: [], url: 'https://example.org/guided' });
  const first = await onboarding.addWelcomeWorkspace(ctx, made.project.id, { context: [paper.id, made.noteId, 'not-an-id', site.id, paper.id] });
  assert.equal(first.project.id, made.project.id);
  assert.equal((await projects.listProjects(ctx)).length, before, 'no project is made');
  let tree = await projects.loadProject(ctx, made.project.id);
  assert.deepEqual(tree.workspaces.map((workspace) => workspace.name), ['Getting started', 'Welcome']);
  const welcome = tree.workspaces.find((workspace) => workspace.id === first.workspaceId);
  assert.deepEqual(welcome.context, [paper.id, site.id], 'what the setup added, notes and unknown ids left out');
  const kept = tree.workspaces.find((workspace) => workspace.id === made.workspaceId);
  assert.deepEqual(kept.context, [made.noteId], 'the workspace already there is untouched');
  // A second run: another Welcome workspace; the first stays as it was.
  const second = await onboarding.addWelcomeWorkspace(ctx, made.project.id, {});
  tree = await projects.loadProject(ctx, made.project.id);
  assert.equal(tree.workspaces.length, 3);
  assert.notEqual(second.workspaceId, first.workspaceId);
  assert.match(tree.workspaces.find((workspace) => workspace.id === second.workspaceId).name, /^Welcome/);
  assert.deepEqual(tree.workspaces.find((workspace) => workspace.id === first.workspaceId).context, [paper.id, site.id]);
  assert.equal((await projects.listProjects(ctx)).length, before);
  await assert.rejects(onboarding.addWelcomeWorkspace(ctx, '00000000-0000-4000-8000-000000000000', {}), /Unknown project/);
  // Main (ipc welcome-workspace) finishes it as start-project does: Connect's session attached, the walkthrough, the offer.
  const ipc = fs.readFileSync(path.join(__dirname, '../src/main/ipc.cjs'), 'utf8');
  const handler = ipc.slice(ipc.indexOf("saving('welcome-workspace'"), ipc.indexOf("}), { project: first, library: true });"));
  assert.ok(handler.length > 0);
  assert.match(handler, /onboarding\.addWelcomeWorkspace\(ctx, str\(pid, 'project id', 64\), \{ context \}\)/);
  assert.match(handler, /connect\.attachProject\(ctx, imported, made\.project\.id, made\.workspaceId\)/);
  assert.match(handler, /gettingStarted\.startGettingStarted\(ctx, made\.project\.id, \{ workspaceId: made\.workspaceId \}\)/);
  assert.match(handler, /gettingStarted\.markGuidedOffer\(ctx, 'onboarded'\)/);
  assert.doesNotMatch(handler, /startProject|createProject/, 'no project is made');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), /welcomeWorkspace: invoke\('welcome-workspace'\)/);
});

test('the guided setup runs a new user\'s onboarding for someone with projects: from the offer over their workspace (in place of Connect your library\'s popup) or from Settings; back goes where it was started (2026-10-10)', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/App.jsx'), 'utf8');
  assert.match(app, /const onboardMode = guidedFrom \? 'guided' : guided \|\| !returning \? 'new' : 'existing';/, 'a new user\'s screens (inside a project without Create), not + Project\'s last two');
  assert.match(app, /const here = now\.phase === 'workspace' && now\.tree \? now\.tree\.project\.id : null;/, 'started inside a project, it remembers which');
  assert.match(app, /setGuided\(from \|\| true\);/, 'from all projects: today\'s guided setup, ending in a new project');
  assert.match(app, /into=\{guidedFrom \? guidedFrom\.projectId : null\}/);
  assert.match(app, /api\.guidedOffer\(\)\.then/);
  assert.doesNotMatch(app, /api\.connectOffer\(\)/, 'Connect your library\'s one-time popup is no longer opened by itself');
  assert.match(app, /window\.addEventListener\(START_GUIDED_SETUP, startGuided\)/, 'Settings asks for it by the event');
  assert.match(app, /onBack=\{returning \? leaveOnboarding : null\}/);
  assert.match(app, /if \(guidedFrom\) openProject\(guidedFrom\.projectId, guidedFrom\.workspaceId \? \{ workspaceId: guidedFrom\.workspaceId \} : null\)\.catch\(\(\) => goHome\(\)\);\n    else goHome\(\);/, '"Engelbart" goes back to the workspace it was started in, else all projects');
  assert.match(app, /phase === 'create' && \(!projects\.length \|\| guided\)/, 'the tool dialog waits until it is over, as for a new user');
  assert.match(app, /onDismiss=\{\(\) => \{ setGuidedOffer\(false\); api\.guidedOfferSeen\('dismissed'\)/);
  const settings = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/Settings.jsx'), 'utf8');
  assert.match(settings, /onClick=\{\(\) => \{ close\(\); startGuidedSetup\(\); \}\}/);
  // 2026-10-13 ("the redo of onboarding shouldn't be called guided setup … a popup modal in front of the workspace"):
  // Import your context, over the workspace, its imports going to the project open.
  assert.ok(settings.includes("title: 'Import context'"), '2026-10-13: "change Guided Setup to Import context"');
  assert.ok(settings.includes('<Row label="Import your context">'), 'with no line under it');
  assert.ok(!settings.includes("title: 'Guided setup'"));
  assert.match(app, /if \(here\) \{ setImportModal\(\{ projectId: here, workspaceId: from\.workspaceId \|\| null \}\); return; \}/, 'in a workspace: the modal over it, nothing left');
  assert.match(app, /<ImportFlow api=\{importApi\} mode="modal" into=\{importModal\.projectId\}/);
  assert.ok(!settings.includes('Discover in a new project. Nothing'), 'no longer always a new project');
  const screen = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Onboarding.jsx'), 'utf8');
  assert.match(screen, /const end = endOf\(flowMode, next\);\n    if \(end === 'project'\) \{ openProject\(added\.filter\(\(item\) => byId\.has\(item\.id\)\)\.map\(\(item\) => item\.id\)\); return; \}\n    if \(end === 'welcome'\) \{ addWelcome\(\); return; \}/, 'past the last screen: the Welcome workspace, not Create; a new user\'s project made there (2026-10-10)');
  // 2026-10-10: the librarian is told the project, the guided setup's own, with no id (its session stays an onboarding one).
  assert.match(screen, /api\.loadProject\(into\)\.then\(\(tree\) => \{ if \(live && tree && tree\.project\) setIntoProject\(\{ name: tree\.project\.name \|\| '', description: tree\.project\.description \|\| '' \}\); \}\)/);
  assert.match(screen, /<ConnectLibrary mode="onboarding" sessionId=\{connectId\} project=\{flowMode === 'guided' \? intoProject : \{ name, description: desc \}\}/);
  assert.doesNotMatch(screen, /<ConnectLibrary[^>]*projectId=/, 'onboarding never sends a project id');
  assert.doesNotMatch(screen, /\.opens\b/, 'Create makes no project');
  assert.match(screen, /api\.welcomeWorkspace\(into, \{ context: added\.filter/);
  const offer = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/GuidedSetup.jsx'), 'utf8');
  for (const words of ['New: import your context', 'Agents bring in the notes, chats and papers of the projects you pick, into your library.', '>Not now<', '>Start<']) assert.ok(offer.includes(words), words);
});
