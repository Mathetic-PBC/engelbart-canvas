'use strict';

// MATH-79 (2026-10-26): Claude Code and Codex started in Engelbart's terminal get open_on_stage, an `engelbart-stage`
// MCP server with one bridge per session (src/main/terminal/stage-bridges.cjs), which opens a web page, a file or a
// library item on the Stage of the window that owns the session (src/main/terminal/stage-tools.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { STAGE_TOOLS, STAGE_NOTE, validateStageTool, resolveTarget, searchLibrary, stageToolFor } = require('../src/main/terminal/stage-tools.cjs');
const { createStageBridges, codexInstructions, codexNote, SERVER_NAME } = require('../src/main/terminal/stage-bridges.cjs');
const { SessionManager } = require('../src/main/terminal/session-manager.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const src = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');

function temporaryDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-stage-tool-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, name, extra = {}) => ({ id: id(n), name, type: 'html', url: `https://example.com/${n}`, tags: [], ...extra });

/* ------------------------------------------------------------------ the tool and its arguments */

// The Stage tool reaches an agent through a POSIX terminal only (MATH-79): a Windows terminal opens PowerShell,
// which has no `claude` / `codex` functions, so these are not run there.
const STAGE_POSIX = process.platform === 'win32' && 'POSIX terminals only: the Stage tool is not offered in a Windows terminal yet';

test('two tools, open_on_stage { target } and search_library { query }, said for the agent; the line names Engelbart and both', () => {
  assert.deepEqual(STAGE_TOOLS.map((tool) => tool.name), ['open_on_stage', 'search_library']);
  const [tool, search] = STAGE_TOOLS;
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.match(search.description, /part of their name or file name/);
  assert.match(STAGE_NOTE, /search_library/);
  assert.deepEqual(tool.inputSchema.required, ['target']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /Stage/);
  assert.match(tool.description, /does not add anything to their library/);
  assert.match(STAGE_NOTE, /inside Engelbart/);
  assert.match(STAGE_NOTE, /open_on_stage/);
  assert.equal(SERVER_NAME, 'engelbart-stage');
});

test('arguments: a target string and nothing else', () => {
  assert.deepEqual(validateStageTool('open_on_stage', { target: '  http://localhost:3000 ' }), { target: 'http://localhost:3000' });
  assert.throws(() => validateStageTool('open', { target: 'x' }), /Unknown tool/);
  assert.throws(() => validateStageTool('open_on_stage', null), /takes \{ target \}/);
  assert.throws(() => validateStageTool('open_on_stage', []), /takes \{ target \}/);
  assert.throws(() => validateStageTool('open_on_stage', {}), /target must be/);
  assert.throws(() => validateStageTool('open_on_stage', { target: '   ' }), /target must be/);
  assert.throws(() => validateStageTool('open_on_stage', { target: 3 }), /target must be/);
  assert.throws(() => validateStageTool('open_on_stage', { target: 'a\0b' }), /not a valid/);
  assert.throws(() => validateStageTool('open_on_stage', { target: 'x'.repeat(4097) }), /not a valid/);
  assert.throws(() => validateStageTool('open_on_stage', { target: 'x', newTab: true }), /does not take newTab/);
  assert.deepEqual(validateStageTool('search_library', { query: ' tutor trace ' }), { query: 'tutor trace' });
  assert.throws(() => validateStageTool('search_library', { target: 'x' }), /does not take target/);
  assert.throws(() => validateStageTool('search_library', { query: ' ' }), /query must be/);
  assert.throws(() => validateStageTool('search_library', { query: 'x'.repeat(513) }), /too long/);
});

/* ------------------------------------------------------------------ search_library */

test('search: every word, in any case and order, in the name or file name; this project first, an exact name first, the newest first', () => {
  const at = (day) => `2026-08-${String(day).padStart(2, '0')}T12:00:00Z`;
  const a = row(1, 'TutorTrace: Tracing Student Thinking', { type: 'pdf', url: null, path: '/d/uist26-238.pdf', created: at(24) });
  const b = row(2, 'TutorTrace: Tracing Student Thinking', { type: 'pdf', url: null, path: '/d/Copy_.pdf', created: at(6) });
  const c = row(3, 'Tutor trace', { created: at(1) });
  const d = row(4, 'Trace of a tutor', { created: at(2) });
  const e = row(5, 'Attention', { type: 'pdf', url: null, path: '/d/tutor-trace-notes.pdf', created: at(3) });
  const all = [b, c, d, a, e, row(6, 'Tutoring')];
  const found = searchLibrary('tutor trace', { all, here: [b, a] });
  assert.deepEqual(found.rows.map((r) => r.id), [a.id, b.id, c.id, e.id, d.id]);
  assert.equal(found.total, 5);
  assert.deepEqual(searchLibrary('tutor  TRACE', { all, here: [] }).rows.map((r) => r.id), [c.id, a.id, b.id, e.id, d.id], 'with no project: an exact name, then the newest');
  assert.deepEqual(searchLibrary('uist26', { all, here: [] }).rows.map((r) => r.id), [a.id], 'by file name');
  assert.equal(searchLibrary('...', { all, here: [] }).total, 0);
  const many = Array.from({ length: 30 }, (_, i) => row(100 + i, `Paper ${i}`));
  const capped = searchLibrary('paper', { all: many, here: [] });
  assert.equal(capped.rows.length, 20);
  assert.equal(capped.total, 30);
});

test('search answers each one\'s name, kind, project, day added, id, and file or address; none says so; the open error points to it', async () => {
  const pdf = row(1, 'TutorTrace', { type: 'pdf', url: null, path: '/d/uist26-238.pdf', created: '2026-08-24T12:00:00Z', project_id: 'P2' });
  const page = row(2, 'TutorTrace site', { url: 'https://tutortrace.org', project_id: 'P2' });
  const note = row(3, 'TutorTrace ideas', { type: 'md', url: null, path: '/n/ideas.md', tags: ['note'] });
  const sent = [];
  const call = stageToolFor({
    session: () => ({ id: 'S1', cwd: '/tmp' }),
    owner: () => ({ id: 1, place: { projectId: PROJECT }, stageListeners: 1 }),
    context: async () => ({ homeDir: os.tmpdir(), libraryDb: { list: async () => [pdf, page, note] } }),
    projectItems: async () => [page],
    projectName: (ctx, projectId) => (projectId === 'P2' ? 'Thesis' : null),
    deliver: (win, payload) => { sent.push(payload); return true; },
  });
  const answer = textOf(await call('search_library', { query: 'tutortrace' }));
  assert.deepEqual(answer.split('\n'), [
    '3 in the library match "tutortrace":',
    `- "TutorTrace site" (html, this project) id ${page.id}; address https://tutortrace.org`,
    `- "TutorTrace" (pdf, project "Thesis", added 2026-08-24) id ${pdf.id}; file /d/uist26-238.pdf`,
    `- "TutorTrace ideas" (note, the library, in no project of this window) id ${note.id}; file /n/ideas.md`,
  ]);
  assert.equal(sent.length, 0, 'search opens nothing');
  assert.equal(textOf(await call('search_library', { query: 'zebra' })), 'Nothing in the library has "zebra" in its name or file name.');
  await assert.rejects(call('open_on_stage', { target: 'tutor trace' }), /use search_library/);
  await call('open_on_stage', { target: pdf.id });
  assert.equal(sent[0].row.id, pdf.id, 'then opened by its id');
});

/* ------------------------------------------------------------------ what a target is */

test('the order: id, then an exact name in this project, then in the rest of the library, then a path, then an address', (t) => {
  const home = temporaryDirectory(t);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'Notes'), 'a file named like an item');
  const mine = row(1, 'Notes');
  const theirs = row(2, 'Paper');
  const all = [mine, theirs];
  const options = { cwd, homeDir: home, all, here: [mine] };
  assert.equal(resolveTarget(id(2), options).row, theirs, 'by id, wherever it is');
  assert.equal(resolveTarget(id(2).toUpperCase(), options).row, theirs);
  assert.equal(resolveTarget('Notes', options).row, mine, 'a name before a path of the same spelling');
  assert.equal(resolveTarget('Paper', options).row, theirs, 'the rest of the library when this project has none');
  assert.throws(() => resolveTarget('paper', options), /Nothing is at .*paper, and "paper" is not a web address/, 'names match exactly');
  fs.mkdirSync(path.join(cwd, 'example.com'));
  assert.deepEqual(resolveTarget('example.com', options), { kind: 'file', path: path.join(cwd, 'example.com') }, 'a path that exists before an address');
  assert.deepEqual(resolveTarget('example.org', options), { kind: 'address', address: 'https://example.org' });
});

test('an unknown id falls through; an id-shaped name that is no row is no file either', (t) => {
  const home = temporaryDirectory(t);
  assert.throws(() => resolveTarget(id(9), { cwd: home, homeDir: home, all: [], here: [] }), /Nothing is at/);
});

test('names: several in this project is ambiguous; one here beats any elsewhere; several elsewhere with none here is ambiguous', (t) => {
  const home = temporaryDirectory(t);
  const a = row(1, 'Draft'), b = row(2, 'Draft'), c = row(3, 'Draft'), d = row(4, 'Report'), e = row(5, 'Report');
  const all = [a, b, c, d, e];
  assert.throws(() => resolveTarget('Draft', { cwd: home, homeDir: home, all, here: [a, b] }), (error) => {
    assert.match(error.message, /Several library items in this project are named "Draft"/);
    assert.ok(error.message.includes(a.id) && error.message.includes(b.id) && !error.message.includes(c.id), error.message);
    return true;
  });
  assert.equal(resolveTarget('Draft', { cwd: home, homeDir: home, all, here: [c] }).row, c, 'one here wins over two elsewhere');
  assert.throws(() => resolveTarget('Report', { cwd: home, homeDir: home, all, here: [a] }), /Several library items in the library are named "Report"/);
});

test('paths: relative from the session\'s working directory, ~/, file://, absolute; one that is not there says so', { skip: STAGE_POSIX }, (t) => {
  const home = temporaryDirectory(t);
  const cwd = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(cwd, 'out'), { recursive: true });
  const report = path.join(cwd, 'out', 'report.html');
  fs.writeFileSync(report, '<p>hi');
  const options = { cwd, homeDir: home, all: [], here: [] };
  assert.deepEqual(resolveTarget('out/report.html', options), { kind: 'file', path: report });
  assert.deepEqual(resolveTarget('./out/report.html', options), { kind: 'file', path: report });
  assert.deepEqual(resolveTarget('../app/out/report.html', options), { kind: 'file', path: report });
  assert.deepEqual(resolveTarget('~/work/app/out/report.html', options), { kind: 'file', path: report });
  assert.deepEqual(resolveTarget(pathToFileURL(report).href, options), { kind: 'file', path: report });
  assert.deepEqual(resolveTarget(report, options), { kind: 'file', path: report });
  assert.throws(() => resolveTarget('out/missing.pdf', options), new RegExp(`Nothing is at ${path.join(cwd, 'out', 'missing.pdf').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.throws(() => resolveTarget('./missing.pdf', options), /Nothing is at .*missing\.pdf\.$/);
  assert.throws(() => resolveTarget('/nowhere/at/all.pdf', options), /Nothing is at \/nowhere\/at\/all\.pdf\./);
});

test('a file the Stage cannot draw says what it does show; one outside the home directory is refused', { skip: STAGE_POSIX }, (t) => {
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, 'blob.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(home, 'paper.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'plain text');
  const options = { cwd: home, homeDir: home, all: [], here: [] };
  assert.throws(() => resolveTarget('blob.bin', options), /The Stage does not show \.bin files\. It shows PDFs, web pages \(\.html\), pictures/);
  assert.equal(resolveTarget('paper.pdf', options).kind, 'file');
  assert.equal(resolveTarget('notes.txt', options).kind, 'file');
  assert.equal(resolveTarget('.', options).kind, 'file', 'a folder shows too');
  const elsewhere = temporaryDirectory(t);
  fs.writeFileSync(path.join(elsewhere, 'x.pdf'), '%PDF');
  assert.throws(() => resolveTarget(path.join(elsewhere, 'x.pdf'), { ...options, homeDir: path.join(home, 'sub-home-that-is-not-it') }), /inside the home directory only/);
});

test('a library row\'s own file opens as the row', (t) => {
  const home = temporaryDirectory(t);
  const file = path.join(home, 'Downloads', 'paper.pdf');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '%PDF-1.4');
  const saved = row(7, 'A paper', { type: 'pdf', url: null, path: file });
  assert.deepEqual(resolveTarget('~/Downloads/paper.pdf', { cwd: home, homeDir: home, all: [saved], here: [] }), { kind: 'item', row: saved });
});

test('addresses: http(s) as given, a local dev server, a bare site; other schemes are refused', (t) => {
  const home = temporaryDirectory(t);
  const options = { cwd: home, homeDir: home, all: [], here: [] };
  assert.deepEqual(resolveTarget('http://localhost:3000', options), { kind: 'address', address: 'http://localhost:3000' });
  assert.deepEqual(resolveTarget('https://arxiv.org/abs/1706.03762', options), { kind: 'address', address: 'https://arxiv.org/abs/1706.03762' });
  assert.deepEqual(resolveTarget('localhost:5173/docs', options), { kind: 'address', address: 'http://localhost:5173/docs' });
  assert.deepEqual(resolveTarget('127.0.0.1:8000', options), { kind: 'address', address: 'http://127.0.0.1:8000' });
  assert.deepEqual(resolveTarget('0.0.0.0:3000', options), { kind: 'address', address: 'http://0.0.0.0:3000' });
  assert.deepEqual(resolveTarget('example.com/a', options), { kind: 'address', address: 'https://example.com/a' });
  assert.throws(() => resolveTarget('mailto:a@b.c', options), /mailto: addresses do not open on the Stage/);
  assert.throws(() => resolveTarget('javascript:alert(1)', options), /do not open on the Stage/);
});

/* ------------------------------------------------------------------ the window it goes to */

function harness({ owner, all = [], here = [], cwd = '/tmp', homeDir = os.tmpdir(), deliver = () => true, session = { id: 'S1', cwd } } = {}) {
  const sent = [];
  const owners = [];
  const call = stageToolFor({
    session: () => session,
    owner: (sessionId) => { owners.push(sessionId); return owner; },
    context: async () => ({ homeDir, libraryDb: { list: async () => all } }),
    projectItems: async () => here,
    deliver: (win, payload) => { sent.push({ win, payload }); return deliver(win, payload); },
  });
  return { call, sent, owners };
}

const PROJECT = id(100);
const textOf = (answer) => answer.__mcpContent[0].text;

test('it goes to the window that owns the session, with what opened said back', async () => {
  const win = { id: 2, place: { projectId: PROJECT, workspaceId: null }, stageListeners: 1 };
  const paper = row(1, 'Attention');
  const { call, sent, owners } = harness({ owner: win, all: [paper], here: [paper] });
  assert.equal(textOf(await call('open_on_stage', { target: 'Attention' })), 'Opened the library item "Attention" on Engelbart\'s Stage.');
  assert.deepEqual(owners, ['S1'], 'asked by the session\'s id');
  assert.deepEqual(sent, [{ win, payload: { projectId: PROJECT, kind: 'item', row: paper } }]);
  assert.equal(textOf(await call('open_on_stage', { target: 'http://localhost:3000' })), 'Opened the page http://localhost:3000 on Engelbart\'s Stage.');
  assert.deepEqual(sent[1].payload, { projectId: PROJECT, kind: 'address', address: 'http://localhost:3000' });
});

test('a relative path is from where the agent\'s server runs, when it says; else from the session\'s directory', async (t) => {
  const home = temporaryDirectory(t);
  fs.mkdirSync(path.join(home, 'sub'));
  fs.writeFileSync(path.join(home, 'sub', 'page.html'), '<p>x');
  const win = { id: 2, place: { projectId: PROJECT }, stageListeners: 1 };
  const { call, sent } = harness({ owner: win, homeDir: home, session: { id: 'S1', cwd: home } });
  await call('open_on_stage', { target: './page.html' }, { cwd: path.join(home, 'sub') }); // a shell tab cd'd into sub, then claude
  assert.equal(sent[0].payload.path, path.join(home, 'sub', 'page.html'));
  await assert.rejects(call('open_on_stage', { target: './page.html' }), /Nothing is at/, 'from the tab\'s own directory');
  await assert.rejects(call('open_on_stage', { target: './page.html' }, { cwd: 'sub' }), /Nothing is at/, 'a relative one is not taken');
});

test('a file opens as one from the computer, not added to the library', async (t) => {
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, 'page.html'), '<p>x');
  const win = { id: 2, place: { projectId: PROJECT }, stageListeners: 1 };
  const { call, sent } = harness({ owner: win, cwd: home, homeDir: home, session: { id: 'S1', cwd: home } });
  assert.equal(textOf(await call('open_on_stage', { target: 'page.html' })), `Opened the file ${path.join(home, 'page.html')} on Engelbart's Stage. It was not added to the library.`);
  assert.deepEqual(sent[0].payload, { projectId: PROJECT, kind: 'file', path: path.join(home, 'page.html') });
});

test('a note opens where the sidebar opens it, and is said so; a row with nothing to show is refused', async () => {
  const win = { id: 2, place: { projectId: PROJECT }, stageListeners: 1 };
  const note = row(1, 'Ideas', { type: 'md', url: null, path: '/x/Ideas.md', tags: ['note'] });
  const empty = row(2, 'Nothing', { url: null });
  const { call, sent } = harness({ owner: win, all: [note, empty], here: [note, empty] });
  assert.match(textOf(await call('open_on_stage', { target: 'Ideas' })), /Opened the note "Ideas" in Engelbart, beside the person's document/);
  await assert.rejects(call('open_on_stage', { target: 'Nothing' }), /has no page or file the Stage can show/);
  assert.equal(sent.length, 1);
});

test('no window, a window on All projects, one with no Stage, or one that does not take it: a plain reason, nothing sent', async () => {
  await assert.rejects(harness({ owner: null }).call('open_on_stage', { target: 'http://localhost:3000' }), /window this terminal belongs to is closed/);
  const home = harness({ owner: { id: 1, place: { projectId: null, workspaceId: null }, stageListeners: 0 } });
  await assert.rejects(home.call('open_on_stage', { target: 'http://localhost:3000' }), /showing All projects, not a project/);
  assert.equal(home.sent.length, 0);
  await assert.rejects(harness({ owner: { id: 1, place: null, stageListeners: 0 } }).call('open_on_stage', { target: 'http://localhost:3000' }), /showing All projects/);
  const noStage = harness({ owner: { id: 1, place: { projectId: PROJECT }, stageListeners: 0 } });
  await assert.rejects(noStage.call('open_on_stage', { target: 'http://localhost:3000' }), /not showing a Stage right now/);
  assert.equal(noStage.sent.length, 0);
  const refused = harness({ owner: { id: 1, place: { projectId: PROJECT }, stageListeners: 1 }, deliver: () => false });
  await assert.rejects(refused.call('open_on_stage', { target: 'http://localhost:3000' }), /not showing its Stage right now/);
  await assert.rejects(harness({ owner: {}, session: null }).call('open_on_stage', { target: 'x' }), /has not started yet/);
});

test('through a real bridge, an error reaches the agent as the tool\'s own error, in one line', async () => {
  const { call } = harness({ owner: null });
  const bridge = await openToolBridge(call);
  try {
    const answer = await (await fetch(bridge.connection.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'open_on_stage', args: { target: 'http://localhost:3000' } }) })).json();
    assert.equal(answer.isError, true);
    assert.equal(answer.content[0].text, 'The Engelbart window this terminal belongs to is closed, so there is no Stage to open it on.');
  } finally {
    await bridge.close();
  }
});

/* ------------------------------------------------------------------ one bridge per session */

function fakeBridges(t, { fail = false } = {}) {
  const directory = path.join(temporaryDirectory(t), 'terminal-stage');
  const opened = [];
  const reported = [];
  const tools = [];
  const bridges = createStageBridges({
    directory,
    execPath: '/Applications/Engelbart.app/Contents/MacOS/Engelbart',
    codexHome: () => path.join(directory, '..', 'no-codex-home'),
    toolFor: (session) => { tools.push(session); return async () => session(); },
    openBridge: async (callTool) => {
      if (fail) throw new Error('no port');
      const bridge = { callTool, closed: 0, connection: { url: 'http://127.0.0.1:4567/tools', token: 'a'.repeat(64) }, close: async () => { bridge.closed += 1; } };
      opened.push(bridge);
      return bridge;
    },
    report: (error) => reported.push(error.message),
  });
  return { bridges, directory, opened, reported, tools };
}

const mode = (file) => fs.statSync(file).mode & 0o777;

test('Claude Code: a bridge, its 0600 connection file and an --mcp-config naming engelbart-stage; bound to the session once it has an id', { skip: STAGE_POSIX }, async (t) => {
  const { bridges, opened } = fakeBridges(t);
  const prepared = await bridges.prepare('claude');
  assert.equal(opened.length, 1);
  const { ENGELBART_TERMINAL_MCP: config, ENGELBART_TERMINAL_NOTE: note } = prepared.stage;
  assert.equal(note, STAGE_NOTE);
  assert.equal(mode(config), 0o600);
  const servers = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['engelbart-stage']);
  const server = servers['engelbart-stage'];
  assert.equal(server.command, '/Applications/Engelbart.app/Contents/MacOS/Engelbart');
  assert.equal(server.args[0], path.join(__dirname, '../src/main/terminal/stage-mcp.cjs'));
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1' });
  const connection = server.args[1];
  assert.equal(mode(connection), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(connection, 'utf8')), { url: 'http://127.0.0.1:4567/tools', token: 'a'.repeat(64) });
  assert.equal(await opened[0].callTool('open_on_stage', {}), null, 'no session until bound');
  prepared.bind({ id: 'S1', cwd: '/w' });
  assert.deepEqual(await opened[0].callTool('open_on_stage', {}), { id: 'S1', cwd: '/w' });
  assert.ok(bridges.has('S1'));
});

test('Codex: -c overrides for mcp_servers.engelbart-stage and developer_instructions', { skip: STAGE_POSIX }, async (t) => {
  const { bridges } = fakeBridges(t);
  const { stage } = await bridges.prepare('codex');
  assert.match(stage.ENGELBART_TERMINAL_CODEX_COMMAND, /^mcp_servers\.engelbart-stage\.command="\/Applications\/Engelbart\.app\/Contents\/MacOS\/Engelbart"$/);
  const args = JSON.parse(stage.ENGELBART_TERMINAL_CODEX_ARGS.replace(/^mcp_servers\.engelbart-stage\.args=/, ''));
  assert.equal(args[0], path.join(__dirname, '../src/main/terminal/stage-mcp.cjs'));
  assert.equal(mode(args[1]), 0o600);
  assert.equal(stage.ENGELBART_TERMINAL_CODEX_ENV, 'mcp_servers.engelbart-stage.env={ ELECTRON_RUN_AS_NODE = "1" }');
  assert.equal(stage.ENGELBART_TERMINAL_CODEX_NOTE, `developer_instructions=${JSON.stringify(STAGE_NOTE)}`);
});

test('a shell session gets one bridge with both sets, for the claude or codex typed in it; another kind gets none', async (t) => {
  const { bridges, opened } = fakeBridges(t);
  const { stage } = await bridges.prepare('shell');
  assert.equal(opened.length, 1);
  assert.deepEqual(Object.keys(stage).sort(), ['ENGELBART_TERMINAL_CODEX_ARGS', 'ENGELBART_TERMINAL_CODEX_COMMAND', 'ENGELBART_TERMINAL_CODEX_ENV', 'ENGELBART_TERMINAL_CODEX_NOTE', 'ENGELBART_TERMINAL_MCP', 'ENGELBART_TERMINAL_NOTE']);
  const claudeConnection = JSON.parse(fs.readFileSync(stage.ENGELBART_TERMINAL_MCP, 'utf8')).mcpServers['engelbart-stage'].args[1];
  assert.equal(JSON.parse(stage.ENGELBART_TERMINAL_CODEX_ARGS.replace(/^mcp_servers\.engelbart-stage\.args=/, ''))[1], claudeConnection, 'the same bridge');
  assert.equal(await bridges.prepare('sandbox'), null);
  assert.equal(opened.length, 1);
});

test('closed, with its files removed, when the session exits or is closed, and at shutdown; twice is harmless', async (t) => {
  const { bridges, opened, directory } = fakeBridges(t);
  const a = await bridges.prepare('claude'); a.bind({ id: 'A', cwd: '/' });
  const b = await bridges.prepare('codex'); b.bind({ id: 'B', cwd: '/' });
  const c = await bridges.prepare('claude'); c.bind({ id: 'C', cwd: '/' });
  assert.equal(fs.readdirSync(directory).length, 5, 'each claude: connection + config; codex: connection');
  await bridges.close('A'); // its exit
  await bridges.close('A');
  assert.equal(opened[0].closed, 1);
  assert.ok(!fs.existsSync(a.stage.ENGELBART_TERMINAL_MCP));
  await bridges.closeAll(); // the app quits
  assert.deepEqual(opened.map((bridge) => bridge.closed), [1, 1, 1]);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.ok(!bridges.has('B') && !bridges.has('C'));
});

test('a session that did not start lets its bridge go; files a crashed run left are cleared at start', async (t) => {
  const { bridges, opened, directory } = fakeBridges(t);
  const prepared = await bridges.prepare('claude');
  await prepared.discard();
  assert.equal(opened[0].closed, 1);
  assert.deepEqual(fs.readdirSync(directory), []);
  fs.writeFileSync(path.join(directory, 'old.connection.json'), '{}');
  fs.writeFileSync(path.join(directory, 'old.mcp.json'), '{}');
  createStageBridges({ directory, toolFor: () => async () => null, openBridge: async () => { throw new Error('unused'); } });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a bridge that does not open starts the agent without the tool', { skip: STAGE_POSIX }, async (t) => {
  const { bridges, reported } = fakeBridges(t, { fail: true });
  assert.equal(await bridges.prepare('claude'), null);
  assert.deepEqual(reported, ['no port']);
  const pty = { made: [], spawn(file, args, options) { const handle = { pid: 1, file, args, options, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {} }; this.made.push(handle); return handle; } };
  const cwd = temporaryDirectory(t);
  const manager = new SessionManager({ pty, environment: { SHELL: '/bin/zsh', HOME: cwd, PATH: '/usr/bin:/bin' } });
  const session = manager.create({ provider: 'claude', cwd, cols: 80, rows: 24 }, { stage: null });
  assert.equal(session.provider, 'claude');
  assert.match(pty.made[0].args[1], /else claude; fi;/, 'today\'s command');
});

test('the session manager passes a session\'s Stage variables to its launch', { skip: STAGE_POSIX }, async (t) => {
  const { bridges } = fakeBridges(t);
  const prepared = await bridges.prepare('claude');
  const pty = { made: [], spawn(file, args, options) { const handle = { pid: 1, file, args, options, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {} }; this.made.push(handle); return handle; } };
  const cwd = temporaryDirectory(t);
  const manager = new SessionManager({ pty, environment: { SHELL: '/bin/zsh', HOME: cwd, PATH: '/usr/bin:/bin' } });
  manager.create({ provider: 'claude', cwd, cols: 80, rows: 24 }, { stage: prepared.stage });
  assert.equal(pty.made[0].options.env.ENGELBART_TERMINAL_MCP, prepared.stage.ENGELBART_TERMINAL_MCP);
  assert.match(pty.made[0].args[1], /claude --mcp-config "\$ENGELBART_TERMINAL_MCP"/);
  const shell = await bridges.prepare('shell');
  manager.create({ provider: 'shell', cwd, cols: 80, rows: 24 }, { stage: shell.stage });
  assert.deepEqual(pty.made[1].args, ['-il']);
  assert.equal(pty.made[1].options.env.ENGELBART_TERMINAL_MCP, shell.stage.ENGELBART_TERMINAL_MCP, 'a shell gets them for the claude typed in it');
  assert.equal(pty.made[1].options.env.ENGELBART_TERMINAL_CODEX_NOTE, shell.stage.ENGELBART_TERMINAL_CODEX_NOTE);
  assert.throws(() => manager.create({ provider: 'nope', cwd, cols: 80, rows: 24 }), /Unknown provider/, 'validation as before');
});

/* ------------------------------------------------------------------ Codex's own developer_instructions */

test('a developer_instructions the person\'s config.toml sets is kept, the line after it', (t) => {
  assert.equal(codexInstructions(''), null);
  assert.equal(codexInstructions('model = "o3"\n'), null);
  assert.equal(codexInstructions('developer_instructions = "Be brief.\\nUse \\"tabs\\"."\n'), 'Be brief.\nUse "tabs".');
  assert.equal(codexInstructions("developer_instructions = 'C:\\path'\n"), 'C:\\path');
  assert.equal(codexInstructions('developer_instructions = """\nLine one\nLine two \\\n  joined"""\n'), 'Line one\nLine two joined');
  assert.equal(codexInstructions("developer_instructions='''\nraw \\n stays'''\n"), 'raw \\n stays');
  assert.equal(codexInstructions('[profiles.work]\ndeveloper_instructions = "not top level"\n'), null, 'only the top level');
  assert.equal(codexInstructions('# developer_instructions = "commented"\n'), null);

  const home = temporaryDirectory(t);
  assert.equal(codexNote(home), STAGE_NOTE, 'no config.toml: the line alone');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "o3"\ndeveloper_instructions = "Always answer in French."\n\n[mcp_servers.x]\ncommand = "x"\n');
  assert.equal(codexNote(home), `Always answer in French.\n\n${STAGE_NOTE}`);
});

/* ------------------------------------------------------------------ main's wiring */

test('main opens a bridge for terminal:create before the session starts and closes it on exit, close and quit', () => {
  const index = src('main/index.cjs');
  assert.match(index, /ipcMain\.handle\('terminal:create', windowHandler\(async \(ctx, request\) => \{\n\s+const provider = request && request\.provider;\n\s+const stage = stageBridges \? await stageBridges\.prepare\(provider\) : null;/);
  assert.match(index, /\}, \{ stage: stage \? stage\.stage : null \}\);\n\s+\} catch \(error\) \{\n\s+if \(stage\) await stage\.discard\(\);\n\s+throw error;\n\s+\}\n\s+if \(stage\) stage\.bind\(session\);\n\s+windows\.own\(session\.id, ctx\);/);
  assert.match(index, /manager\.on\('exit', \(payload\) => \{\n\s+sendToRenderer\('terminal:exit', payload\);\n\s+if \(stageBridges && payload\) void stageBridges\.close\(payload\.id\);/);
  assert.match(index, /if \(closed && stageBridges\) await stageBridges\.close\(id\);/);
  assert.match(index, /if \(manager\) await manager\.shutdown\(\);\n\s+if \(stageBridges\) await stageBridges\.closeAll\(\);/);
  assert.match(index, /owner: \(id\) => \(windows \? windows\.ownerOf\(id\) : null\)/, 'the window that owns the session, not the focused one');
  assert.match(index, /deliver: \(ctx, payload\) => windows\.deliver\(ctx, 'engelbart:stage-open', payload\)/);
  assert.match(index, /path\.join\(app\.getPath\('userData'\), 'terminal-stage'\)/);
  assert.doesNotMatch(index, /BROWSER\s*[:=]/, 'BROWSER stays unset');
  assert.match(src('preload.cjs'), /onStageOpen: \(callback\) => subscribe\('engelbart:stage-open', callback\),/);
});

test('the MCP server is served as engelbart-stage and says something sensible when Engelbart is gone', () => {
  const server = src('main/terminal/stage-mcp.cjs');
  assert.match(server, /main\(STAGE_TOOLS, 'engelbart-stage', \{ unavailable: UNAVAILABLE, cwd: true \}\)/);
  assert.match(src('main/sandbox/local-mcp.cjs'), /\.\.\.\(cwd \? \{ cwd: process\.cwd\(\) \} : \{\}\)/, 'each call says where the server runs');
  const { UNAVAILABLE } = require('../src/main/terminal/stage-mcp.cjs');
  assert.match(UNAVAILABLE, /^Engelbart could not be reached/);
  const local = src('main/sandbox/local-mcp.cjs');
  assert.match(local, /if \(unavailable\) return away\(\);\n\s+throw error;/);
  assert.match(local, /throw new Error\('The sandbox tool connection is unavailable'\);/, 'the Build\'s and the sandbox\'s servers as before');
});

/* ------------------------------------------------------------------ the window it opens in */

const loadStage = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/stage.js')).href);

test('the renderer takes what is for its own project: the window\'s own row for an item, a file by its path, an address', async () => {
  const { stageOpenRequest } = await loadStage();
  const sent = { id: id(1), name: 'Attention', url: 'https://arxiv.org/abs/1706.03762' };
  const mine = { ...sent, ink: true };
  assert.deepEqual(stageOpenRequest({ projectId: PROJECT, kind: 'item', row: sent }, PROJECT, [mine]), { item: mine });
  assert.deepEqual(stageOpenRequest({ projectId: PROJECT, kind: 'item', row: sent }, PROJECT, []), { item: sent });
  assert.deepEqual(stageOpenRequest({ projectId: PROJECT, kind: 'file', path: '/Users/h/Downloads/a.pdf' }, PROJECT), { file: '/Users/h/Downloads/a.pdf' });
  assert.deepEqual(stageOpenRequest({ projectId: PROJECT, kind: 'address', address: 'http://localhost:3000' }, PROJECT), { address: 'http://localhost:3000' });
  assert.equal(stageOpenRequest({ projectId: id(101), kind: 'address', address: 'http://localhost:3000' }, PROJECT), null, 'another project\'s');
  assert.equal(stageOpenRequest({ projectId: PROJECT, kind: 'file', path: 'relative.pdf' }, PROJECT), null);
  assert.equal(stageOpenRequest({ projectId: PROJECT, kind: 'item', row: {} }, PROJECT), null);
  assert.equal(stageOpenRequest({ projectId: PROJECT, kind: 'open' }, PROJECT), null);
  assert.equal(stageOpenRequest(null, PROJECT), null);
});

test('a tab that shows it already comes forward instead of a second one; otherwise a tab of its own', async () => {
  const { placeTab, tabKey, addressKey } = await loadStage();
  const file = '/Users/h/Downloads/a.pdf';
  const tabs = [{ url: 'https://notes.org' }, { url: 'about:blank', file: { path: file } }, { item: id(1), url: 'https://x.org' }, { url: 'http://localhost:3000/' }];
  assert.deepEqual(placeTab(tabs, 0, `l:${addressKey(`file://${file}`)}`), { focus: 1 }, 'the file the Stage\'s openFile claims');
  assert.deepEqual(placeTab(tabs, 0, `i:${id(1)}`), { focus: 2 }, 'the row openRow claims');
  assert.deepEqual(placeTab(tabs, 0, tabKey({ url: 'http://localhost:3000' })), { focus: 3 }, 'the address openInput claims');
  assert.deepEqual(placeTab(tabs, 0, `l:${addressKey('file:///Users/h/other.pdf')}`), { append: true }, 'not the tab in front');
});

test('the Workspace opens it as the sidebar and a clicked link do: an item by openItem, a file without a row, the pane turned to the Stage', () => {
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  const handler = workspace.slice(workspace.indexOf('api.onStageOpen('), workspace.indexOf('[project.id, openItem, showRight]);'));
  assert.ok(handler.length > 0, 'an onStageOpen handler');
  assert.match(handler, /stageOpenRequest\(event, project\.id, libraryNow\.current\)/);
  assert.match(handler, /if \(asked\.item\) \{ openItem\(asked\.item\); return; \}/);
  assert.match(handler, /showRight\('stage'\);\n\s+if \(asked\.file\) stageRef\.current\.openFile\(asked\.file\);\n\s+else stageRef\.current\.openInput\(asked\.address\);/);
  assert.doesNotMatch(handler, /newTab|addToLibrary|saveItem/);
  assert.match(workspace, /const showRight = React\.useCallback\(\(mode\) => \{ setRightMode\(mode\); setDocFull\(false\); \}, \[\]\);/, 'and leaves the document\'s full screen');
  const stage = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.match(stage, /const openFile = \(file, options = \{\}\) => \{\n\s+const id = claim\(`l:\$\{addressKey\(fileUrl\(file\)\)\}`, '', '', options\);\n\s+if \(id\) readPath\(id, file, null\);/, 'a file from the computer, no row');
});
