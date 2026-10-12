'use strict';

// Onboarding's backend (src/main/store/onboarding.cjs): custom instructions and where agents see them, the folder
// "Create a folder for me" makes, the project the last two screens describe, and unticking a repository again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const onboarding = require('../src/main/store/onboarding.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-home-')));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('custom instructions: written, read, trimmed, and removed when emptied', () => {
  assert.equal(onboarding.readInstructions(ctx), '');
  assert.equal(onboarding.instructionsBlock(ctx.dataRoot), '');
  onboarding.writeInstructions(ctx, '  I study help-seeking.\n\n');
  assert.equal(onboarding.readInstructions(ctx), 'I study help-seeking.');
  assert.match(onboarding.instructionsBlock(ctx.dataRoot), /^<custom_instructions [^>]*>\nI study help-seeking\.\n<\/custom_instructions>$/);
  onboarding.writeInstructions(ctx, '   ');
  assert.equal(fs.existsSync(path.join(ctx.dataRoot, 'instructions.md')), false);
});

test('a folder made for the project sits in the home directory and never takes one that exists', () => {
  const first = onboarding.freeFolder(ctx, 'Teachable Agents!');
  assert.deepEqual(first, { path: path.join(homeDir, 'teachable-agents'), shown: '~/teachable-agents' });
  fs.mkdirSync(first.path);
  assert.equal(onboarding.freeFolder(ctx, 'Teachable Agents!').shown, '~/teachable-agents-2');
  assert.throws(() => onboarding.existingFolder(ctx, 'relative/path'), /starts with/);
  assert.throws(() => onboarding.existingFolder(ctx, '~/not-there'), /Nothing is at/);
  assert.equal(onboarding.existingFolder(ctx, '~/teachable-agents'), first.path);
});

test('startProject: folder, Getting started workspace starting with the description, note first, chosen rows in context', async () => {
  const pdf = path.join(homeDir, 'paper.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
  const paper = await library.addItem(ctx, pdf);
  const note = await projects.createNote(ctx, (await projects.createProject(ctx, 'Other')).id, { name: 'Elsewhere', text: 'x' });
  const made = await onboarding.startProject(ctx, { name: 'Spec study', description: 'How learners find what a system should do.', folder: 'new', context: [paper.id, note.id, 'not-an-id', paper.id] });
  assert.equal(made.project.directory, path.join(homeDir, 'spec-study'));
  assert.ok(fs.statSync(made.project.directory).isDirectory());
  assert.equal(made.project.description, 'How learners find what a system should do.');
  const tree = await projects.loadProject(ctx, made.project.id);
  assert.deepEqual(tree.workspaces.map((w) => w.name), ['Getting started']);
  assert.deepEqual(tree.workspaces[0].context, [made.noteId, paper.id]);
  assert.equal(await projects.readDoc(ctx, made.project.id, { kind: 'workspace', workspaceId: made.workspaceId }), 'How learners find what a system should do.\n');

  // @bart sees the description and the instructions.
  onboarding.writeInstructions(ctx, 'Be blunt.');
  const context = await buildContext(ctx, made.project.id, { ref: { kind: 'workspace', workspaceId: made.workspaceId }, workspaceId: made.workspaceId, askId: 'abc' });
  assert.match(context.head, /project description: How learners find what a system should do\./);
  assert.match(context.head, /<custom_instructions[^>]*>\nBe blunt\.\n<\/custom_instructions>/);
  onboarding.writeInstructions(ctx, '');

  // An existing folder, typed with ~.
  const again = await onboarding.startProject(ctx, { name: 'Second', folder: 'existing', directory: '~/spec-study' });
  assert.equal(again.project.directory, made.project.directory);
  assert.equal(again.project.description, '');
  await assert.rejects(onboarding.startProject(ctx, { name: 'Third', folder: 'existing', directory: '~/missing' }), /Nothing is at/);
});

test('discardItem removes a row only while nothing holds it', async () => {
  const dir = path.join(homeDir, 'loose');
  fs.mkdirSync(dir);
  const loose = await library.addItem(ctx, dir);
  assert.equal(await onboarding.discardItem(ctx, loose.id), true);
  assert.equal(await ctx.libraryDb.get(loose.id), null);

  const held = await library.addItem(ctx, path.join(homeDir, 'paper.pdf')).catch((error) => error.row);
  assert.equal(await onboarding.discardItem(ctx, held.id), false); // in the Getting started workspace's context above
  assert.ok(await ctx.libraryDb.get(held.id));
});

test('the order: parts before screens, a new user\'s flow asking about the project before Connect and making it at the end, the guided setup in a project without it, + Project ending on context, the pager only on the flow', async () => {
  const { pathToFileURL } = require('node:url');
  const flow = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  const walk = (mode, from, options) => { const out = []; let at = from; for (let i = 0; i < 20 && at.step !== 'open'; i += 1) { at = flow.forward(mode, at, options); out.push(at.sub ? `${at.step}.${at.sub}` : at.step); } return out; };
  // 2026-10-09: no folder part, and no Project context screen for a new user.
  assert.deepEqual(flow.SUBS.create, ['name', 'desc']);
  // 2026-10-10: Create before Connect, so the librarian is told what the project is; 'open' (the project made) after the last screen.
  assert.deepEqual(flow.FLOWS.new, ['welcome', 'tools', 'create', 'intro', 'connect', 'import', 'instructions']);
  assert.deepEqual(flow.flowOf('new'), ['welcome', 'tools', 'create', 'import', 'instructions']);
  assert.deepEqual(flow.flowOf('new', { connect: true }), ['welcome', 'tools', 'create', 'intro', 'connect']);
  assert.ok(!flow.flowOf('new').includes('intro'), 'the intro (2026-10-11) only with Connect');
  assert.deepEqual(walk('new', { step: 'welcome', sub: 0 }), ['tools', 'create', 'create.1', 'import', 'import.1', 'import.2', 'instructions', 'open']);
  assert.deepEqual(walk('new', { step: 'welcome', sub: 0 }, { connect: true }), ['tools', 'create', 'create.1', 'intro', 'connect', 'open'], 'the intro right before Connect; Connect last: its Continue makes the project');
  assert.ok(flow.flowOf('new', { connect: true }).indexOf('create') < flow.flowOf('new', { connect: true }).indexOf('connect'));
  assert.deepEqual(walk('existing', { step: 'create', sub: 0 }), ['create.1', 'context', 'open'], '+ Project keeps its context screen');
  assert.deepEqual(flow.forward('existing', { step: 'import', sub: 2, detour: true }), { step: 'context', sub: 0 });
  assert.deepEqual(flow.pagerOf('new', 'tools'), { count: 5, index: 1 }, 'the count is as before');
  assert.deepEqual(flow.pagerOf('new', 'create'), { count: 5, index: 2 });
  assert.deepEqual(flow.pagerOf('new', 'instructions'), { count: 5, index: 4 });
  assert.deepEqual(flow.pagerOf('new', 'connect', { connect: true }), { count: 5, index: 4 });
  assert.equal(flow.pagerOf('new', 'context'), null);
  assert.deepEqual(flow.pagerOf('existing', 'context'), { count: 2, index: 1 });
  assert.equal(flow.pagerOf('existing', 'import'), null);

  // The guided setup inside a project (2026-10-10): a new user's screens without Create, 'open' (its Welcome workspace)
  // after the last one, and the pager one fewer.
  assert.deepEqual(flow.flowOf('guided'), ['welcome', 'tools', 'import', 'instructions']);
  assert.deepEqual(flow.flowOf('guided', { connect: true }), ['welcome', 'tools', 'intro', 'connect']);
  assert.ok(!flow.flowOf('guided', { tools: false, connect: true }).includes('create'));
  assert.deepEqual(walk('guided', { step: 'welcome', sub: 0 }), ['tools', 'import', 'import.1', 'import.2', 'instructions', 'open']);
  assert.deepEqual(walk('guided', { step: 'welcome', sub: 0 }, { connect: true }), ['tools', 'intro', 'connect', 'open'], 'Connect last: its Continue opens the project');
  assert.deepEqual(walk('guided', { step: 'welcome', sub: 0 }, { tools: false, connect: true }), ['intro', 'connect', 'open']);
  assert.deepEqual(flow.pagerOf('guided', 'intro', { tools: false, connect: true }), { count: 3, index: 1 }, 'the mockup\'s "2 of 3"');
  assert.deepEqual(flow.forward('guided', { step: 'tools', sub: 0 }, { connect: false }), { step: 'import', sub: 0 }, 'Connect dropped: its screens come back');
  assert.deepEqual(flow.pagerOf('guided', 'welcome', { connect: true }), { count: 4, index: 0 });
  assert.deepEqual(flow.pagerOf('guided', 'connect', { connect: true }), { count: flow.pagerOf('new', 'connect', { connect: true }).count - 1, index: 3 });
  assert.deepEqual(flow.pagerOf('guided', 'instructions'), { count: 4, index: 3 });
  assert.equal(flow.pagerOf('guided', 'create'), null);
  assert.equal(flow.isFresh('guided'), true);
  assert.equal(flow.isFresh('new'), true);
  assert.equal(flow.isFresh('existing'), false);

  // Nothing to install: the tools screen is left out, and one showing when that is found out moves on.
  assert.deepEqual(flow.forward('new', { step: 'welcome', sub: 0 }, { tools: false }), { step: 'create', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'tools', sub: 0 }, { tools: false }), { step: 'create', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'create', sub: 1 }, { tools: false, connect: false }), { step: 'import', sub: 0 }, 'Connect dropped on the tools screen: its screens come back after Create');
  assert.deepEqual(flow.pagerOf('new', 'instructions', { tools: false }), { count: 4, index: 3 });
  assert.equal(flow.pagerOf('new', 'tools', { tools: false }), null);

  // One Continue (no Next, 2026-09-28): live once the part holds something, and Skip while it is empty.
  assert.deepEqual(flow.importButtons(0, 0), { showSkip: true, continueDisabled: true });
  assert.deepEqual(flow.importButtons(0, 0, { signedIn: true }), { showSkip: true, continueDisabled: false }, 'GitHub connected, nothing ticked');
  assert.deepEqual(flow.importButtons(1, 0, { signedIn: true }), { showSkip: true, continueDisabled: true }, 'only the GitHub part');
  assert.deepEqual(flow.importButtons(0, 2), { showSkip: false, continueDisabled: false });
  assert.deepEqual(flow.importButtons(2, 1), { showSkip: false, continueDisabled: false });
  const keep = { showSkip: false, continueDisabled: false, label: 'Continue' };
  assert.deepEqual(flow.createButtons(0, { name: ' ', desc: '' }), { ...keep, continueDisabled: true });
  assert.deepEqual(flow.createButtons(0, { name: 'x', desc: '' }), keep);
  assert.deepEqual(flow.createButtons(1, { name: 'x', desc: '' }), { ...keep, showSkip: true, continueDisabled: true });
  assert.deepEqual(flow.createButtons(1, { name: 'x', desc: 'why' }), keep, '+ Project goes on to context');
  // 2026-10-10: Create no longer makes a new user's project; its last part goes on to Connect like any other.
  assert.deepEqual(flow.createButtons(0, { name: 'x', desc: '' }, { mode: 'new' }), keep, 'the name part goes on to the description');
  assert.deepEqual(flow.createButtons(1, { name: 'x', desc: 'why' }, { mode: 'new' }), keep, 'a new user\'s last part goes on, no `opens`');
  assert.deepEqual(flow.createButtons(1, { name: 'x', desc: '' }, { mode: 'new' }), { showSkip: true, continueDisabled: true, label: 'Continue' }, 'and so does its Skip');
  assert.ok(!('opens' in flow.createButtons(1, { name: 'x', desc: 'why' }, { mode: 'new' })));

  // The project is made only once the flow reaches 'open', with Connect's session; the guided setup's end is its Welcome workspace.
  const ends = (mode, options) => { const out = []; let at = { step: 'welcome', sub: 0 }; for (let i = 0; i < 20 && at.step !== 'open'; i += 1) { at = flow.forward(mode, at, options); out.push(flow.endOf(mode, at)); } return out; };
  assert.deepEqual(ends('new', { connect: true }), [null, null, null, null, null, 'project'], 'nothing is made on Create, nor on the intro');
  assert.deepEqual(ends('new', {}).filter(Boolean), ['project']);
  assert.equal(ends('new', {}).at(-1), 'project', 'after Custom instructions');
  assert.deepEqual(ends('guided', { connect: true }), [null, null, null, 'welcome']);
  assert.equal(flow.endOf('existing', { step: 'open', sub: 0 }), null, '+ Project opens from its context screen');
  assert.deepEqual(flow.projectInput({ name: ' Teachable agents ', desc: ' Debugging with LLMs ', ids: [3], connectId: 'c1' }),
    { name: 'Teachable agents', description: 'Debugging with LLMs', folder: 'new', directory: '', context: [3], connect: 'c1', onboarding: true });
  assert.deepEqual(flow.projectInput({ name: 'x', desc: '', folder: 'existing', folderPath: '~/code', ids: [] }), { name: 'x', description: '', folder: 'existing', directory: '~/code', context: [], onboarding: true }, 'no session: no connect');
  assert.ok(!('onboarding' in flow.projectInput({ name: 'x', desc: '', mode: 'existing' })), '+ Project is not an onboarding');
  // A folder picked with "Use an existing folder…" under the name; the default, ~/<name>, needs nothing.
  assert.equal(flow.createButtons(0, { name: 'x', desc: '', folder: 'new' }).continueDisabled, false);
  assert.equal(flow.createButtons(0, { name: 'x', desc: '', folder: 'existing', folderPath: ' ' }).continueDisabled, true);
  assert.equal(flow.createButtons(0, { name: 'x', desc: '', folder: 'existing', folderPath: '~/code' }).continueDisabled, false);

  assert.equal(flow.rowWhy({ type: 'website', tags: ['git'], url: 'https://github.com/a/b' }), 'git repo · github.com');
  assert.equal(flow.rowWhy({ type: 'pdf', tags: ['paper'], path: '/x.pdf' }), 'paper');
  assert.deepEqual(flow.contextRows([{ id: 1, type: 'md', tags: ['note'] }, { id: 2, type: 'image', tags: [] }, { id: 3, type: 'pdf', tags: [] }]).map((row) => row.id), [3]);
});

test('the tools screen: undecided until the first check, then only when something is to be installed (2026-09-28)', async () => {
  const { pathToFileURL } = require('node:url');
  const flow = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  const tool = (status, more = {}) => ({ status, installed: status !== 'missing', skip: false, busy: null, autoUpdate: false, ...more });
  const snap = (git, claude, codex, checked = true) => ({ checked, tools: { git, claude, codex } });
  assert.equal(flow.toolsWanted(null), null);
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('missing'), tool('missing'), false)), null);
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('missing'), tool('missing'))), true, 'a new Mac');
  assert.equal(flow.toolsWanted(snap(tool('missing'), tool('ready'), tool('missing'))), true, 'Git alone');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('missing'), tool('missing'))), true, 'no agent');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('missing'), tool('ready'))), false, 'one agent is enough');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('signed-out'), tool('missing'))), false, 'signing in waits for the dialog');
  assert.equal(flow.toolsWanted(snap(tool('missing', { busy: { action: 'install' } }), tool('ready'), tool('ready'))), false, 'already installing');
});
