'use strict';

// A task built from its own line (MATH-106, 2026-10-25): the `- [ ]` line holds its Build's id in a marker
// (src/shared/task-marker.cjs) that the editor never shows and no reader of a workspace's text passes on; its request is
// the task and the tasks under it; the row shows the Build's state; an accepted Build ticks the task, once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const archive = require('../src/main/store/archive.cjs');
const library = require('../src/main/store/library.cjs');
const { expandDoc } = require('../src/main/context/expand-mentions.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { defaultReadText, checkCitations } = require('../src/main/bart/cite.cjs');
const { stripTaskMarkers, readTaskMark, taskMark } = require('../src/shared/task-marker.cjs');

const ID = '0123456789', OTHER = 'abcdef0123';
const MARKED = `- [ ] ${taskMark(ID)}Add the export`;

let doc, markdown;
test.before(async () => {
  doc = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  markdown = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/markdown.js')).href);
});

/* --------------------------------------------------------------------- the marker in the document model */

test('the marker: one grammar, read and written back as it was', () => {
  assert.equal(MARKED, '- [ ] <!--build:0123456789--> Add the export');
  assert.deepEqual(readTaskMark('<!--build:0123456789 ticked--> Ship it'), { text: 'Ship it', build: ID, ticked: true });
  assert.deepEqual(readTaskMark('Ship it'), { text: 'Ship it' });
  assert.equal(stripTaskMarkers(`a\n${MARKED}\n  - [x] ${taskMark(OTHER, true)}b`), 'a\n- [ ] Add the export\n  - [x] b');
  assert.equal(stripTaskMarkers('<!-- a comment of the person\'s -->'), '<!-- a comment of the person\'s -->', 'other comments stay');
});

test('a task with and without a marker parses, round-trips through sameLine and todoLine, and shows the same text', () => {
  for (const [line, mark] of [['- [ ] Add the export', null], [MARKED, { build: ID, ticked: false }], [`    - [x] ${taskMark(ID, true)}Add the export`, { build: ID, ticked: true }]]) {
    const p = doc.parseLine(line);
    assert.equal(p.type, 'todo', line);
    assert.equal(p.text, 'Add the export', `${line}: the text has no marker`);
    assert.equal(doc.lineText(p, line), 'Add the export', `${line}: the caret moves through the text alone`);
    if (mark) assert.deepEqual([p.build, p.ticked], [mark.build, mark.ticked]); else assert.equal(p.build, undefined);
    assert.equal(doc.sameLine(p, p.text), line, `${line}: sameLine`);
    assert.equal(doc.todoLine(p.depth, p.done, p.text, p), line, `${line}: todoLine`);
    assert.equal(doc.sameLine(p, 'Renamed'), line.replace('Add the export', 'Renamed'), 'an edit keeps it');
  }
  assert.equal(doc.todoLine(0, false, 'x'), '- [ ] x', 'no mark, as before');
  const typed = doc.retypedRow(doc.parseLine(MARKED), '- [x] Add the export');
  assert.equal(typed.line, `- [x] ${taskMark(ID)}Add the export`, 'a box retyped keeps its Build');
});

test('the request: the task, then the deeper rows under it as its steps, not its siblings', () => {
  const ls = [
    '# Plan',
    '- [ ] Ship the export',
    '  - [ ] Write the CSV',
    `    - [ ] ${taskMark(OTHER)}Quote commas`,
    '  - [x] Add the button',
    '- [ ] A sibling',
    '  - [ ] Not its step',
  ];
  const own = doc.taskRequest(ls, 1);
  assert.equal(own.text, 'Ship the export\n\nSteps:\n- [ ] Write the CSV\n  - [ ] Quote commas\n- [x] Add the button');
  assert.equal(doc.taskRequest(ls, 5).text, 'A sibling\n\nSteps:\n- [ ] Not its step');
  assert.equal(doc.taskRequest(ls, 2).text, 'Write the CSV\n\nSteps:\n- [ ] Quote commas', 'a step is a task of its own, with its own steps');
  assert.equal(doc.taskRequest(ls, 4).text, 'Add the button', 'none under it');
  assert.equal(doc.taskRequest(ls, 0).text, '', 'not a task');
  assert.equal(doc.taskRequest(['- [ ] Top', 'Plain text', '  - [ ] after a break'], 0).text, 'Top', 'stops at the first line that is not deeper');
});

test('the Agent Viewer finds a task\'s Build by the task that holds it, after the marker was written into the line it was started from', async () => {
  const { findBuildLine } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/askLine.js')).href);
  assert.equal(findBuildLine(['# Plan', `  - [x] ${taskMark(ID, true)}Add the export`], ID), 1);
  assert.equal(findBuildLine([MARKED], OTHER), -1);
  assert.equal(findBuildLine([`Text about <!--build:${ID}--> in prose`], ID), -1, 'a task line only');
});

test('copied text has no marker; the editor\'s own copy keeps it', () => {
  const ls = ['Intro', MARKED, 'After'];
  const all = { line: 0, offset: 0 }, end = { line: 2, offset: 5 };
  assert.equal(doc.selectionMarkdown(ls, all, end), 'Intro\n- [ ] Add the export\nAfter');
  assert.equal(doc.selectionMarkdown(ls, all, end, { marks: true }), `Intro\n${MARKED}\nAfter`);
  assert.equal(doc.selectionMarkdown(ls, { line: 1, offset: 0 }, { line: 1, offset: 3 }), 'Add');
  assert.doesNotMatch(doc.selectionHtml(doc.selectionMarkdown(ls, all, end)), /build:/);
});

test('the Stage and a framed markdown file draw no marker', () => {
  const blocks = JSON.stringify(markdown.markdownBlocks(`# Plan\n${MARKED}\n- [x] ${taskMark(OTHER, true)}Done one`));
  assert.doesNotMatch(blocks, /build:|0123456789|<!--/);
  assert.match(blocks, /Add the export/);
});

/* --------------------------------------------------------------------- every reader of a workspace's text */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-task-build-'));
const layout = ensureHome(homeDir);
let ctx, project, workspace, other;
const wsRef = () => ({ kind: 'workspace', workspaceId: workspace.id });
const DOC = `Plan for the export.\n${MARKED}\n  - [x] ${taskMark(OTHER, true)}Done before\n@bart what next?\nbart~> a1\n`;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
  project = await projects.createProject(ctx, 'Tasks');
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Export' });
  other = await projects.createWorkspace(ctx, project.id, { name: 'Elsewhere' });
  await projects.writeDoc(ctx, project.id, wsRef(), DOC);
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }, `See @[Export](ws:${workspace.id}).`);
});
test.after(async () => { await db.closeAll(); });

const clean = (text, where) => { assert.doesNotMatch(String(text), /build:|0123456789|abcdef0123/, where); assert.match(String(text), /Add the export/, `${where}: the task is there`); };

test('expandDoc (Copy, and @bart\'s context) and a mention from another workspace show no marker', async () => {
  clean((await expandDoc(ctx, project.id, wsRef())).text, 'expandDoc');
  clean((await expandDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id })).text, 'the workspace mentioned from another');
  const context = await buildContext(ctx, project.id, { ref: wsRef(), workspaceId: workspace.id, askId: 'a1' });
  clean(context.documents, 'bart/context');
  assert.doesNotMatch(context.contextJson, /0123456789/, 'the catalog');
});

test('search finds the task by its words, never by its Build\'s id', async () => {
  const { workspaces } = await library.bodiesForProject(ctx, project.id);
  clean(workspaces[workspace.id], 'library search');
  assert.ok(!Object.values(workspaces).some((text) => text.includes(ID)), 'searching for the id finds nothing');
});

test('the all-projects screen, the archived version\'s title and the citation check read no marker', async () => {
  const listed = (await projects.listProjects(ctx)).find((p) => p.id === project.id);
  clean(listed.recent.find((w) => w.id === workspace.id).text, 'recent workspaces');
  assert.equal(archive.titleOf(`- [ ] ${taskMark(ID)}Add the export`), 'Add the export');
  const file = path.join(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir, 'workspace.md');
  clean(await defaultReadText(file), 'bart/cite');
  const checked = await checkCitations(`It says "Add the export" [1].\n\n[1]: ${file}`, { dataRoot: ctx.dataRoot, projectId: project.id, projectDir: projects.findProject(ctx, project.id).dir, readText: defaultReadText });
  assert.doesNotMatch(JSON.stringify(checked), /build:0123456789/, 'a quote is checked against the words');
});

/* --------------------------------------------------------------------- the editor's row */

const elements = [];
function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-task-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
let DocEditor;
test.before(() => { DocEditor = load('DocEditor.jsx').default; });
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; elements.length = 0; });

/** An editor on `lines` with no page: props.text follows what it writes, as the parent hands it back. */
function mounted(lines, { builds = {}, buildProgress = {}, buildDiffs = {}, onBuildTask = () => {}, onBuildAction = null, readOnly = false, extra = {} } = {}) {
  const changes = [], started = [];
  const props = { docKey: 'k', text: lines.join('\n'), builds, buildProgress, buildDiffs, readOnly, onBuildAction, ...extra, onChange: (next) => { changes.push(next); props.text = next; }, onBuildTask: onBuildTask && ((input) => { started.push(input); return onBuildTask(input); }) };
  const editor = new DocEditor(props);
  editor.props = props;
  editor.edRef = { current: { closest: () => null, querySelector: () => null, querySelectorAll: () => [], contains: () => false } };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const end = (i) => { const ls = editor.lines(); return editor.taskBuildHtml(i, ls[i], doc.parseLine(ls[i]), false); };
  const words = (i) => end(i).replace(/<[^>]+>/g, '').trim();
  return { editor, props, changes, started, end, words, lines: () => editor.lines(), html: () => editor.editorHtml() };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the row ends with a faint "Build" on an open task with words; not on an empty one, a ticked one with no Build, or where nothing can be built', () => {
  const { end, words, html } = mounted(['- [ ] Add the export', '- [ ] ', '- [x] Done', 'Plain']);
  assert.match(end(0), /data-act="taskbuild"[^>]*data-task-state="idle"/);
  assert.equal(words(0), 'Build');
  assert.match(end(1), /hidden/); assert.match(end(2), /hidden/);
  assert.doesNotMatch(html(), /<!--build|0123456789/, 'the editor shows no marker');
  assert.match(mounted(['- [ ] Add'], { readOnly: true }).end(0), /hidden/, 'read-only');
  assert.match(mounted(['- [ ] Add'], { onBuildTask: null }).end(0), /hidden/, 'no workspace to build in');
});

test('the row shows its Build\'s state, in the card\'s words and colours', () => {
  const states = [
    [{ status: 'running' }, { [ID]: { activity: 'Editing src/export.js' } }, /^Building · Editing src\/export\.js$/, /<span class=\"task-build-words eb-wave\">[^<]+<\/span><\/button>$/],
    [{ status: 'queued' }, {}, /^Building · Waiting for a slot$/, /<span class=\"task-build-words eb-wave\">[^<]+<\/span><\/button>$/],
    [{ status: 'review' }, {}, /^Review$/, /color:#0070f3/],
    [{ status: 'needs-you' }, {}, /^Needs you$/, /color:#0070f3/],
    [{ status: 'failed' }, {}, /^Failed$/, /color:#e70022/],
    [{ status: 'accepted' }, {}, /^View result$/, /data-act="taskcard"/],
    [{ status: 'stopped' }, {}, /^Stopped$/, /data-task-state="stopped"/],
    [{ status: 'interrupted' }, {}, /^Interrupted$/, /data-task-state="interrupted"/],
    [{ status: 'conflict' }, {}, /^Conflict$/, /data-task-state="conflict"/],
    [{ status: 'review', runStep: { status: 'running' } }, {}, /^Getting it running…$/, /<span class=\"task-build-words eb-wave\">[^<]+<\/span><\/button>$/],
  ];
  for (const [record, progress, said, look] of states) {
    const { end, words } = mounted([MARKED], { builds: { [ID]: { id: ID, ...record } }, buildProgress: progress });
    assert.match(words(0), said, record.status);
    assert.match(end(0), look, record.status);
    assert.match(end(0), new RegExp(`data-task-build="${ID}"`), `${record.status}: opens its card`);
    assert.doesNotMatch(end(0), /task-build-spin/, `${record.status}: no ring`);
    if (!['running', 'queued'].includes(record.status) && !record.runStep) assert.doesNotMatch(end(0), /eb-wave/, `${record.status}: not at work, no wave`);
  }
  const discarded = mounted([MARKED], { builds: { [ID]: { id: ID, status: 'discarded' } } });
  assert.equal(discarded.words(0), 'Build', 'discarded: built again');
  assert.equal(mounted([MARKED]).words(0), 'Build', 'a Build this window does not know: built again');
  assert.equal(mounted([`- [x] ${taskMark(ID, true)}Add the export`], { builds: { [ID]: { id: ID, status: 'accepted' } } }).words(0), 'View result', 'ticked, still opens its card');
});

test('pressing Build hands the parent the task\'s line and its request, and shows it starting', async () => {
  let finish;
  const { editor, started, words, end } = mounted(['- [ ] Ship it', '  - [ ] Step one', '- [ ] Other'], { onBuildTask: () => new Promise((resolve) => { finish = resolve; }) });
  editor.buildTask(0);
  assert.deepEqual(started, [{ line: 0, raw: '- [ ] Ship it', text: 'Ship it\n\nSteps:\n- [ ] Step one' }]);
  assert.equal(words(0), 'Starting…');
  assert.match(end(0), /<span class="task-build-words eb-wave">Starting…<\/span><\/button>$/, 'starting: its words wave, no ring');
  editor.buildTask(0);
  assert.equal(started.length, 1, 'once');
  finish(); await settle();
  assert.equal(words(0), 'Build');
});

test('a working row redrawn as its step changes keeps its words waving, on the page\'s clock', () => {
  const builds = { [ID]: { id: ID, status: 'running' } };
  const { editor, props } = mounted([MARKED], { builds, buildProgress: { [ID]: { activity: 'Reading the code' } } });
  // A page of one task row: patchTaskRows replaces it with what a template makes of its HTML.
  const anims = [];
  const make = (html) => ({ html, dataset: { taskRow: '0' }, replaceWith(next) { row = next; }, querySelectorAll: (sel) => (sel === '.eb-wave' && html.includes('eb-wave') ? [{ getAnimations: () => { const a = { startTime: 1234 }; anims.push(a); return [a]; } }] : []) });
  let row = make(editor.taskBuildHtml(0, MARKED, doc.parseLine(MARKED), false));
  editor.edRef.current.querySelectorAll = (sel) => (sel === '[data-task-row]' ? [row] : []);
  editor.lastKey = editor.key();
  globalThis.document.createElement = () => { const t = { content: {} }; Object.defineProperty(t, 'innerHTML', { set(html) { t.content.firstElementChild = make(html); } }); return t; };
  props.buildProgress = { [ID]: { activity: 'Editing src/export.js' } };
  editor.patchTaskRows();
  assert.match(row.html, /<span class="task-build-words eb-wave">Building · Editing src\/export\.js<\/span><\/button>$/, 'the new step, waving');
  assert.doesNotMatch(row.html, /task-build-spin/, 'no ring');
  assert.equal(anims.length, 1, 'the new row\'s wave was put on the clock');
  assert.equal(anims[0].startTime, 0, 'so it goes on where the last one was');
  props.builds = { [ID]: { id: ID, status: 'review' } };
  editor.patchTaskRows();
  assert.match(row.html, /color:#0070f3[^>]*><span class="task-build-words">Review<\/span>/, 'done: blue, no wave');
});

test('ticking by hand, Enter at its start and an edit keep the task\'s Build', () => {
  const { editor, lines } = mounted([MARKED, 'After'], { builds: { [ID]: { id: ID, status: 'running' } } });
  editor.toggleTodo(0);
  assert.equal(lines()[0], `- [x] ${taskMark(ID)}Add the export`, 'ticked by hand: the Build goes on');
  editor.toggleTodo(0);
  assert.equal(lines()[0], MARKED);
  editor.caretInfo = () => ({ anchor: { line: 0, offset: 0 }, focus: { line: 0, offset: 0 } });
  editor.editorKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, preventDefault() {} });
  assert.deepEqual(lines().slice(0, 2), ['- [ ] ', MARKED], 'Enter at its start: a new task above, the task and its Build below');
  editor.caretInfo = () => ({ anchor: { line: 1, offset: 3 }, focus: { line: 1, offset: 3 } });
  editor.editorKey({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, preventDefault() {} });
  assert.deepEqual(lines().slice(1, 3), [`- [ ] ${taskMark(ID)}Add`, '- [ ]  the export'], 'split in the middle: the Build stays with the first half');
  editor.undo();
  editor.undo();
  assert.equal(lines()[0], MARKED, 'undone');
});

test('an accepted Build ticks its task once; a task unticked by hand afterwards stays unticked', async () => {
  const builds = { [ID]: { id: ID, status: 'running' } };
  const { editor, props, changes, lines } = mounted([MARKED, `- [ ] ${taskMark(OTHER)}Not yet`], { builds });
  await settle();
  assert.equal(changes.length, 0, 'not while it runs');
  props.builds = { ...builds, [ID]: { id: ID, status: 'accepted' } };
  editor.componentDidUpdate({ ...props, builds }, editor.state);
  await settle();
  assert.equal(lines()[0], `- [x] ${taskMark(ID, true)}Add the export`, 'ticked, and the marker says so');
  assert.equal(lines()[1], `- [ ] ${taskMark(OTHER)}Not yet`);
  editor.undo();
  assert.equal(lines()[0], MARKED, 'the tick is an edit: undone');
  editor.toggleTodo(0); editor.toggleTodo(0); // ticked again and unticked by hand, after the Build ticked it once
  editor.setLines(() => [`- [ ] ${taskMark(ID, true)}Add the export`]);
  const before = changes.length;
  editor.componentDidUpdate({ ...props, text: '' }, editor.state);
  await settle();
  assert.equal(changes.length, before, 'unticked by hand after the tick: it stays so');
  assert.equal(lines()[0], `- [ ] ${taskMark(ID, true)}Add the export`);
});

test('a task whose Build was accepted while its document was closed is ticked when it opens', async () => {
  const { lines, changes } = mounted(['Plan', MARKED], { builds: { [ID]: { id: ID, status: 'accepted' } } });
  await settle();
  assert.equal(lines()[1], `- [x] ${taskMark(ID, true)}Add the export`);
  assert.equal(changes.length, 1, 'once');
});

test('a started Build is written into its task\'s line; a discarded Build\'s marker is replaced, a live one\'s kept', () => {
  const at = { line: 0, raw: '- [ ] Ship it' };
  assert.equal(doc.withTaskBuild('- [ ] Ship it\nAfter', at, ID), `- [ ] ${taskMark(ID)}Ship it\nAfter`);
  assert.equal(doc.withTaskBuild('Before\n- [ ] Ship it', at, ID), `Before\n- [ ] ${taskMark(ID)}Ship it`, 'found again where it moved');
  assert.equal(doc.withTaskBuild('- [ ] Ship it now', at, ID), null, 'changed meanwhile');
  const again = { line: 0, raw: `- [ ] ${taskMark(OTHER)}Ship it` };
  assert.equal(doc.withTaskBuild(again.raw, again, ID, { [OTHER]: { id: OTHER, status: 'discarded' } }), `- [ ] ${taskMark(ID)}Ship it`);
  assert.equal(doc.withTaskBuild(again.raw, again, ID, {}), `- [ ] ${taskMark(ID)}Ship it`, 'its Build is gone');
  assert.equal(doc.withTaskBuild(again.raw, again, ID, { [OTHER]: { id: OTHER, status: 'running' } }), null);
});

/* --------------------------------------------------------------------- the row's words, the card under it, ticking (MATH-106 rework) */

const FILES = [{ path: 'a.js', adds: 100, dels: 5 }, { path: 'b.js', adds: 10, dels: 1 }, { path: 'c.js', adds: 6, dels: 2 }, { path: 'd.js', adds: 4, dels: 0 }];
const CODE_DIFF = { files: FILES, patch: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n', truncated: false };
const NO_DIFF = { files: [], patch: '', truncated: false };
const MADE = [{ id: 'item-1', name: 'Workspace overview', type: 'md' }];
const record = (extra) => ({ id: ID, kind: 'build', title: 'Write the overview', model: 'opus', modelName: 'Opus', effort: 'high', messages: [{ role: 'you', text: 'Write the overview' }, { role: 'agent', text: '## Done\nI wrote the overview of the workspace,\nlinked from the plan.\n\nMore detail that is not the summary.' }], made: [], ...extra });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the row\'s words say what there is to do: Review while it waits, View result once done; what it made is in the card', () => {
  const review = mounted([MARKED], { builds: { [ID]: record({ status: 'review' }) }, buildDiffs: { [ID]: CODE_DIFF } });
  assert.equal(review.words(0), 'Review');
  assert.match(review.end(0), /color:#0070f3/);
  assert.equal(mounted([MARKED], { builds: { [ID]: record({ status: 'review', made: MADE }) }, buildDiffs: { [ID]: NO_DIFF } }).words(0), 'Review');
  const built = mounted([MARKED], { builds: { [ID]: record({ status: 'accepted', made: MADE }) } });
  assert.equal(text(built.end(0)), 'View result', 'no name on the row');
  assert.match(built.end(0), /^<button[^>]*data-act="taskcard"/, 'it opens the card');
  assert.doesNotMatch(built.end(0), /taskmade|task-build-made/);
  assert.equal(mounted([MARKED], { builds: { [ID]: record({ status: 'accepted' }) } }).words(0), 'View result', 'nothing made');
  assert.match(mounted([MARKED], { builds: { [ID]: record({ status: 'running' }) }, buildProgress: { [ID]: { activity: 'Writing' } } }).words(0), /^Building · Writing$/);
});

test('the task card: its parts in order for each state, the `build>` card left as it was', () => {
  const { editor } = mounted([MARKED], { buildDiffs: { [ID]: CODE_DIFF } });
  const names = (task) => editor.taskParts(ID, task).map(([name]) => name);
  const part = (task, name) => new Map(editor.taskParts(ID, task)).get(name);
  const ORDER = ['head', 'goal', 'summary', 'made', 'changed', 'needs', 'run', 'live', 'actions', 'convo']; // goal: a goal Build's (MATH-88)
  // review, with code
  const review = record({ status: 'review' });
  assert.deepEqual(names(review), ORDER);
  assert.match(text(part(review, 'head')), /^Build Write the overview Opus · High Ready to review$/);
  assert.equal(text(part(review, 'summary')), 'I wrote the overview of the workspace, linked from the plan. Show more', 'the first paragraph, its heading passed over');
  assert.match(part(review, 'summary'), /-webkit-line-clamp:4/, 'up to four lines');
  assert.match(part(review, 'summary'), /data-act="tasksummary"[^>]*>Show more</, 'the message has more: Show more');
  editor.taskSummaryOpen.add(ID);
  assert.match(text(part(review, 'summary')), /I wrote the overview.*More detail that is not the summary.*Show less$/, 'opened: the whole message');
  editor.taskSummaryOpen.clear();
  const short = record({ status: 'review', messages: [{ role: 'agent', text: 'Done: the overview.' }] });
  assert.doesNotMatch(part(short, 'summary'), /tasksummary/, 'nothing more to show');
  assert.equal(part(review, 'made'), '');
  assert.equal(text(part(review, 'changed')), 'Changed 4 files · +120 −8');
  assert.doesNotMatch(part(review, 'changed'), /data-build-diff/, 'the diff closed');
  assert.equal(part(review, 'needs'), '');
  assert.match(text(part(review, 'actions')), /^Full conversation › Preview Reject Accept$/);
  assert.equal(part(review, 'convo'), '');
  editor.taskDiffOpen.add(ID); editor.taskConvo.add(ID);
  assert.match(part(review, 'changed'), /data-build-diff="0123456789"/, 'opened: the diff view');
  assert.match(part(review, 'convo'), /data-build-input="0123456789"/, 'the conversation, with its reply field');
  assert.match(text(part(review, 'convo')), /More detail that is not the summary/);
  assert.match(text(part(review, 'actions')), /^Full conversation ‹/);
  editor.taskDiffOpen.clear(); editor.taskConvo.clear();
  // review, only made something
  const { editor: madeEd } = mounted([MARKED], { buildDiffs: { [ID]: NO_DIFF } });
  const made = new Map(madeEd.taskParts(ID, record({ status: 'review', made: MADE })));
  assert.equal(text(made.get('made')), 'Made Workspace overview Open ↗');
  assert.match(made.get('made'), /data-act="taskmade"[^>]*data-item-id="item-1"/);
  assert.equal(text(made.get('changed')), 'Changed No code changed');
  // working
  const working = new Map(madeEd.taskParts(ID, record({ status: 'running', messages: [] })));
  assert.equal(working.get('summary'), '');
  assert.match(working.get('live'), /eb-wave/);
  assert.match(text(working.get('actions')), /^Full conversation ›$/);
  // needs you: the question and the reply field, not repeated in the conversation
  const asking = record({ status: 'needs-you', question: 'Which file should it go in?' });
  editor.taskConvo.add(ID);
  assert.match(text(part(asking, 'needs')), /^Needs you: Which file should it go in\?/);
  assert.match(part(asking, 'needs'), /data-build-input="0123456789"[^>]*placeholder="Answer…"/);
  assert.doesNotMatch(part(asking, 'convo'), /Which file should it go in|data-build-input/);
  editor.taskConvo.clear();
  assert.equal(part(record({ status: 'review' }), 'needs'), '', 'only while it asks');
  // discarded: what it made stays in the library
  const gone = new Map(madeEd.taskParts(ID, record({ status: 'discarded', final: true, made: MADE })));
  assert.equal(text(gone.get('made')), 'Made Workspace overview Open ↗ Kept in your library');
  assert.equal(gone.get('changed'), '');
  // the `build>` card: as before, the question in its conversation
  const card = editor.buildParts(ID, asking).map(([name]) => name);
  assert.deepEqual(card, ['head', 'goal', 'prompt', 'body', 'run', 'live', 'diff', 'reply', 'actions']);
  assert.match(new Map(editor.buildParts(ID, asking)).get('body'), /Which file should it go in/);
});

test('the card unfolds under its task and folds again; it is drawn, never a line: the text, the line numbering, copy and the caret pass it by', () => {
  const lines = ['Before', MARKED, 'After'];
  const { editor, html, lines: now } = mounted(lines, { builds: { [ID]: record({ status: 'review' }) }, buildDiffs: { [ID]: CODE_DIFF } });
  assert.doesNotMatch(html(), /data-task-card/, 'folded');
  editor.openTaskCard(ID);
  const page = html();
  const card = page.match(/<div contenteditable="false" data-readonly="1" data-task-card="0123456789"[^>]*>/);
  assert.ok(card, 'unfolded');
  assert.doesNotMatch(card[0], /data-line|data-raw/, 'not a line');
  const rowAt = page.indexOf('data-line="1"'), cardAt = page.indexOf('data-task-card='), nextAt = page.indexOf('data-line="2"');
  assert.ok(rowAt < cardAt && cardAt < nextAt, 'right under the task, above the line after it');
  assert.deepEqual([...page.matchAll(/ data-line="(\d+)"/g)].map((m) => Number(m[1])), [0, 1, 2], 'the lines are numbered as before');
  assert.deepEqual(now(), lines, 'the text is untouched');
  assert.equal(doc.selectionMarkdown(now(), { line: 0, offset: 0 }, { line: 2, offset: 5 }), 'Before\n- [ ] Add the export\nAfter', 'copy is the text alone');
  // what the caret reads a point of the page as: nothing inside the card
  const ed = { contains: () => true };
  editor.edRef.current = ed;
  const inCard = { nodeType: 1, closest: (sel) => (sel === '[data-line]' ? null : null) };
  assert.equal(editor.caretAt(inCard, 0), null, 'a point in the card is no place in the text');
  editor.openTaskCard(ID);
  assert.doesNotMatch(html(), /data-task-card/, 'folded again');
  // a discarded Build's card stays open, showing what it kept
  editor.openTaskCard(ID);
  editor.props.builds = { [ID]: record({ status: 'discarded', final: true, made: MADE }) };
  assert.match(html(), /data-task-card="0123456789"[\s\S]*Kept in your library/);
});

test('ticking a task whose Build waits for review accepts it; a refused Accept unticks the box and says why in red; a working one only ticks', async () => {
  // accepted
  const asked = [];
  let builds = { [ID]: record({ status: 'review' }) };
  const ok = mounted([MARKED], { builds, onBuildAction: (id, action) => { asked.push([id, action]); return Promise.resolve({ accepted: true }); } });
  ok.editor.toggleTodo(0);
  assert.equal(ok.lines()[0], `- [x] ${taskMark(ID, true)}Add the export`, 'ticked at once, the marker saying so');
  assert.deepEqual(asked, [[ID, 'tickaccept']]);
  await settle();
  ok.props.builds = { [ID]: record({ status: 'accepted' }) };
  const before = ok.changes.length;
  ok.editor.componentDidUpdate({ ...ok.props, builds }, ok.editor.state);
  await settle();
  assert.equal(ok.changes.length, before, 'landed: not ticked a second time');
  assert.equal(ok.lines()[0], `- [x] ${taskMark(ID, true)}Add the export`);
  // refused
  const why = 'main and this Build changed the same lines in a.txt.';
  builds = { [ID]: record({ status: 'review' }) };
  const no = mounted([MARKED], { builds, onBuildAction: () => Promise.resolve({ accepted: false, status: 'conflict', error: why }) });
  no.editor.toggleTodo(0);
  await settle(); await settle();
  assert.equal(no.lines()[0], MARKED, 'unticked, marker and all');
  no.props.builds = { [ID]: record({ status: 'conflict', error: why }) };
  assert.equal(no.words(0), why);
  assert.match(no.end(0), /color:#e70022/);
  no.props.builds = { [ID]: record({ status: 'running' }) };
  no.editor.componentDidUpdate({ ...no.props, builds }, no.editor.state);
  no.props.builds = { [ID]: record({ status: 'review' }) };
  assert.equal(no.words(0), 'Review', 'gone once the Build moved on');
  // the call itself failed
  const threw = mounted([MARKED], { builds: { [ID]: record({ status: 'review' }) }, onBuildAction: () => Promise.reject(new Error('Your code folder is not on a branch.')) });
  threw.editor.toggleTodo(0);
  await settle(); await settle();
  assert.equal(threw.lines()[0], MARKED);
  assert.equal(threw.words(0), 'Your code folder is not on a branch.');
  // working: only ticked
  const calls = [];
  const busy = mounted([MARKED], { builds: { [ID]: record({ status: 'running' }) }, onBuildAction: (...a) => { calls.push(a); return Promise.resolve(true); } });
  busy.editor.toggleTodo(0);
  assert.equal(busy.lines()[0], `- [x] ${taskMark(ID)}Add the export`);
  assert.deepEqual(calls, []);
});
