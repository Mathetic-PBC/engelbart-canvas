'use strict';

// @create (2026-10-13; src/main/bart/create.cjs, ask.cjs): an agent that makes a new thing as files in a draft folder of
// its own, <dataRoot>/.create/<askId>/, the only place it may write. The line's syntax, the CLIs' arguments, the files
// kept (and not), and the answer that stands for them. The router's pick (asked at once since 2026-10-15) is in
// route.test.cjs. Since 2026-10-14 the files are kept with the project (<project>/.created/<askId>/), not in the library:
// the answer has one `@[name](made:<askId>/<path>)` line per file, and Save (saveCreated) adds one to the library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { createBart, createFakeBart, CLAUDE_TOOLS, CREATE_TOOLS, CREATE_CODEX, createRules, AGENTS } = require('../src/main/bart/ask.cjs');
const { CREATE_DIR, CREATE_TIMEOUT_MS, MAX_CREATED, SAVED_FILE, draftPath, openDraft, createdDir, createdFile, keepCreated, createdBody, createdSentence, requestSentence, readCreated, saveCreated, saveAllCreated } = require('../src/main/bart/create.cjs');
const { CREATE_SYSTEM_PROMPT } = require('../src/main/bart/create-system-prompt.cjs');
const { stripAgentReplies, OMITTED } = require('../src/main/bart/strip.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');
const { createMaking, cleanMaking, createdLine, MAKING_PROMPT, MAX_DOCUMENTS } = require('../src/main/bart/making.cjs');
const { claudeReader } = require('../src/main/bart/activity.cjs');

const DEFAULTS = normalizeModels(null); // Claude Code, Sonnet high first
const CODEX = { ...DEFAULTS, provider: 'openai' };
const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-create-'));
const layout = ensureHome(homeDir);
let ctx;
let project;
let workspace;
const ref = () => ({ kind: 'workspace', workspaceId: workspace.id });
const linked = () => projects.findWorkspace(ctx, project.id, workspace.id).workspace.context;
const rowsNow = async () => ctx.libraryDb.list();
const draftsLeft = () => { try { return fs.readdirSync(path.join(ctx.dataRoot, CREATE_DIR)); } catch { return []; } };

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-create-code-'));
  project = await projects.createProject(ctx, { name: 'Making', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Charts' });
});
test.after(async () => { await db.closeAll(); });

/* ------------------------------------------------------------------- the line */

test('an @create line parses with agent create, in either case; its token is create; strip takes its replies out', async () => {
  const { parseLine, agentOf, tokenOf, titleLine, titleMeta } = await loadDoc();
  for (const line of ['@create make a chart of CHI submissions by year', '@Create make a chart of CHI submissions by year']) {
    const p = parseLine(line);
    assert.deepEqual([p.type, agentOf(p), p.text], ['bart', 'create', 'make a chart of CHI submissions by year'], line);
  }
  assert.equal(tokenOf('create'), 'create');
  assert.equal(parseLine('@created a thing').type === 'bart', false, 'only the whole word');
  assert.deepEqual(titleMeta(titleLine('Chart', false, { agent: 'create', at: '2026-10-13T09:00:00Z' }).replace(/^bart# /, '')), { text: 'Chart', agent: 'create', at: '2026-10-13T09:00:00Z', build: false });
  assert.ok(AGENTS.includes('create'));
  const doc = ['Mine.', '@create make a chart', 'bart> I made a chart: chart.html.', 'bart> @[chart](lib:0123456789abcdef)', 'bart> *Create · Sonnet · high · 40 s*', 'Mine again.'].join('\n');
  assert.equal(stripAgentReplies(doc), ['Mine.', '@create make a chart', OMITTED, 'Mine again.'].join('\n'));
});

test('the @ menu lists Create after Discover; Create runs on @chat\'s models (its Settings label)', async () => {
  const { mentionRows, isVerbRow, CREATE_VERB } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);
  const names = mentionRows({ query: '', library: [], page: null, pageRow: null }).filter((row) => row.kind === 'verb').map((row) => row.name);
  assert.deepEqual(names, ['Bart', 'Chat', 'Brainstorm', 'Discover', 'Create', 'Note']);
  assert.equal(CREATE_VERB.token, '@Create ');
  assert.ok(isVerbRow({ id: 'create' }));
  const { AGENT_ROWS } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/intelligence.js')).href);
  assert.ok(!AGENT_ROWS.some((row) => row.id === 'create'), 'no row of its own');
  assert.equal(AGENT_ROWS.find((row) => row.id === 'bart').label, '@chat and @create');
});

/* ------------------------------------------------------------- the CLIs' arguments */

// A stand-in for the login shell: records each command and writes, in the run's working directory, what the agent would.
function cli(calls, write = (dir) => { fs.writeFileSync(path.join(dir, 'chi-by-year.html'), '<!doctype html><p>chart</p>'); }) {
  return (shell, args, options, callback) => {
    const command = args[args.length - 1];
    const prompt = options.env.ENGELBART_BART_PROMPT ? fs.readFileSync(options.env.ENGELBART_BART_PROMPT, 'utf8') : null;
    calls.push({ command, env: options.env, cwd: options.cwd, timeout: options.timeout, prompt });
    write(options.cwd);
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, 'I made a chart page: chi-by-year.html.'); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcf"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I made a chart page: chi-by-year.html.' })}\n`);
  };
}
const realBart = (models, run, extra = {}) => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  // The line on what it is making (../src/main/bart/making.cjs) is its own quick run, tested on its own below.
  const makeLine = async () => ({ line: 'A chart of CHI submissions by year, one bar a year.', named: true, ms: 1 });
  return createBart({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs'), codexHome: path.join(homeDir, 'codex-home'), createCodexHome: path.join(homeDir, 'codex-home-create'), codexAuthFile: authFile, run, makeLine, ...extra });
};

test('Claude Code: Write and Edit on the draft folder alone (dontAsk refuses any other write), no Bash, the draft as cwd, 10 minutes', async () => {
  const calls = [], added = [];
  const bart = realBart(DEFAULTS, cli(calls), { onAdded: (row) => added.push(row.id) });
  const out = await bart.ask(ctx, project.id, { askId: 'cc1', ref: ref(), workspaceId: workspace.id, text: 'make a chart of CHI submissions by year', agent: 'create' });
  const [call] = calls;
  const draft = fs.realpathSync(path.dirname(draftPath(ctx.dataRoot, 'cc1')));
  assert.equal(call.cwd, path.join(draft, 'cc1'), 'the draft folder is its working directory');
  assert.match(call.command, new RegExp(`--tools "${CREATE_TOOLS}"`));
  assert.ok(!/Bash/.test(call.command) && !/Bash/.test(call.env.ENGELBART_BART_RULES), 'no Bash');
  assert.match(call.command, /--restricted --setting-sources "" /);
  assert.match(call.command, /--allowedTools "\$ENGELBART_BART_RULES" --permission-mode dontAsk /);
  assert.equal(call.env.ENGELBART_BART_RULES, `${CLAUDE_TOOLS},Edit(/${call.cwd}/**),Write(/${call.cwd}/**)`, 'writes allowed under the draft alone, an absolute path written //…');
  assert.equal(createRules('/a/b', 'darwin'), `${CLAUDE_TOOLS},Edit(//a/b/**),Write(//a/b/**)`);
  for (let n = 0; call.env[`ENGELBART_BART_DIR${n}`]; n++) assert.ok(!call.env.ENGELBART_BART_RULES.includes(`(/${call.env[`ENGELBART_BART_DIR${n}`]}/**)`), 'the folders it reads (the data root holds the draft) get no write rule');
  assert.equal(call.timeout, CREATE_TIMEOUT_MS);
  assert.equal(CREATE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(call.prompt, CREATE_SYSTEM_PROMPT);
  assert.deepEqual(out.meta.created, [{ name: 'chi-by-year.html', type: 'html', path: 'chi-by-year.html' }]);
  assert.equal(added.length, 1, 'saved into the library as the run ends (2026-10-15)');
  assert.ok((await readCreated(ctx, project.id, 'cc1', 'chi-by-year.html')).saved, 'its row reads Saved');
  assert.ok(fs.existsSync(path.join(createdDir(ctx, project.id, 'cc1'), 'chi-by-year.html')), 'kept with the project');
  assert.ok(out.lines.includes('bart> @[chi-by-year.html](made:cc1/chi-by-year.html)'), 'its row\'s line');
  assert.equal(out.lines[0], 'bart> Created a chart of CHI submissions by year, one bar a year.', 'the line it was shown while it worked, said done ("Created"), then its own last message');
  assert.ok(!fs.existsSync(call.cwd), 'the draft folder is gone');
  assert.match(out.lines[out.lines.length - 1], /^bart> \*Create · Sonnet · high · \d+ s\*$/, 'the foot: Create · model · effort · time');
});

test('Codex: a workspace-write sandbox rooted at the draft folder, no other writable root, no /tmp, no network, no --add-dir; its own CODEX_HOME', async () => {
  const calls = [];
  const bart = realBart(CODEX, cli(calls));
  const out = await bart.ask(ctx, project.id, { askId: 'cx1', ref: ref(), workspaceId: workspace.id, text: 'make a chart of CHI submissions by year', agent: 'create' });
  const [call] = calls;
  assert.match(call.command, /codex exec --color never -C "\$ENGELBART_BART_CWD" /, '-C is exec\'s, before the prompt options');
  assert.equal(call.env.ENGELBART_BART_CWD, call.cwd);
  for (const setting of CREATE_CODEX) assert.ok(call.command.includes(`-c '${setting}'`), setting);
  assert.deepEqual(CREATE_CODEX.slice(0, 5), ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.network_access=false']);
  assert.ok(!/read-only|--add-dir|danger/.test(call.command), 'the folders it reads stay read-only: none is added as writable');
  assert.equal(call.env.CODEX_HOME, path.join(homeDir, 'codex-home-create'));
  assert.equal(fs.readFileSync(path.join(homeDir, 'codex-home-create', 'AGENTS.md'), 'utf8').trim(), CREATE_SYSTEM_PROMPT.trim());
  assert.equal(call.timeout, CREATE_TIMEOUT_MS);
  assert.deepEqual(out.meta.created.map((file) => file.name), ['chi-by-year.html']);
  assert.ok(!fs.existsSync(call.cwd));
  // An @chat line keeps its read-only sandbox.
  await bart.ask(ctx, project.id, { askId: 'cx2', ref: ref(), workspaceId: workspace.id, text: 'why?', agent: 'bart' });
  assert.match(calls[1].command, /-c 'sandbox_mode="read-only"'/);
  assert.ok(!/-C |workspace-write/.test(calls[1].command));
});

/* ------------------------------------------------------------------ what is kept */

test('a fake run writing report.md, chart.html and data.csv: kept with the project and saved into the library; its first sentence, then one row line each', async () => {
  const runLog = createRunLog({ file: path.join(homeDir, 'runs-fake', 'agent-runs.jsonl') });
  const added = [], progress = [];
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2, runLog, onAdded: (row) => added.push(row.id) });
  const before = (await rowsNow()).length;
  const out = await bart.ask(ctx, project.id, { askId: 'fk1', ref: ref(), workspaceId: workspace.id, text: 'make an html page summarizing the papers in my library on AI-assisted programming', agent: 'create' }, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(out.meta.created, [['chart.html', 'html'], ['data.csv', 'csv'], ['report.md', 'md']].map(([name, type]) => ({ name, type, path: name })));
  assert.equal((await rowsNow()).length, before + 3, 'each saved into the library as the run ends (2026-10-15)');
  assert.equal(added.length, 3);
  assert.deepEqual(draftsLeft(), [], 'the draft folder is gone');
  const kept = createdDir(ctx, project.id, 'fk1');
  assert.equal(kept, path.join(projects.findProject(ctx, project.id).dir, '.created', 'fk1'));
  assert.deepEqual(fs.readdirSync(kept).sort(), [SAVED_FILE, 'chart.html', 'data.csv', 'report.md'], 'the files, and which row each was saved as');
  // While it works, the window is told what it is making, once, before it reads or writes anything.
  const said = progress.findIndex((p) => p.making), wrote = progress.findIndex((p) => /^Writing /.test(p.activity || ''));
  assert.deepEqual(progress.filter((p) => p.making).map((p) => p.making), ['A fake report, a chart page and its data, from made-up numbers.']);
  assert.ok(said >= 0 && said < wrote, 'said before the first file is written');
  // The answer: that sentence ("Done." is not said), then one line per file, then the foot.
  assert.deepEqual(out.lines.slice(0, 5), ['bart> Created a fake report, a chart page and its data, from made-up numbers.', 'bart>', 'bart> @[chart.html](made:fk1/chart.html)', 'bart> @[data.csv](made:fk1/data.csv)', 'bart> @[report.md](made:fk1/report.md)']);
  assert.match(out.lines[out.lines.length - 1], /^bart> \*Create · Sonnet · high · \d+ s\*$/);
  assert.ok(!out.lines.some((line) => /Not kept|Done\./.test(line)));
  // A row's file as the editor reads it: its text, saved.
  const page = await readCreated(ctx, project.id, 'fk1', 'chart.html');
  assert.deepEqual([page.name, page.type, page.ext, !!page.saved, page.missing], ['chart.html', 'html', 'html', true, false]);
  assert.match(page.text, /^<!doctype html>/);
  assert.equal(page.path, path.join(kept, 'chart.html'));
  assert.equal((await readCreated(ctx, project.id, 'fk1', 'gone.svg')).missing, true);
  // The Stage opens it as it opens any file: the page as a page, the table, the document.
  const shown = await Promise.all(['chart.html', 'data.csv', 'report.md'].map((rel) => projects.readStageFile(ctx, project.id, path.join(kept, rel))));
  assert.deepEqual(shown.map((one) => one.kind), ['page', 'table', 'md']);
  // Its record lists them, as the Agent Viewer shows a Create run's output.
  await runLog.flush();
  const record = runLog.list().find((run) => run.agent === 'create');
  assert.deepEqual(record.created.map((file) => file.name), ['chart.html', 'data.csv', 'report.md']);
  const { createdLines } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/agent-map/runText.js')).href);
  assert.match(createdLines(record), /^chart\.html · html · chart\.html\ndata\.csv · csv · data\.csv\nreport\.md · md · report\.md$/);
});

test('Save: a kept file into the library once, its source create, linked to the workspace and announced; Saved after a restart; a file outside the run refused', async () => {
  const draft = openDraft(ctx.dataRoot, 'sv1');
  fs.writeFileSync(path.join(draft, 'agent-prompts.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  fs.writeFileSync(path.join(draft, 'notes.md'), '# Notes\n');
  await keepCreated(ctx, project.id, 'sv1', draft);
  const added = [], before = (await rowsNow()).length;
  const row = await saveCreated(ctx, project.id, workspace.id, 'sv1', 'agent-prompts.svg', { onAdded: (one) => added.push(one.id) });
  assert.deepEqual([row.name, row.type, row.source], ['agent-prompts', 'image', 'create']);
  assert.equal((await rowsNow()).length, before + 1);
  assert.ok(linked().includes(row.id), 'linked to the workspace');
  assert.deepEqual(added, [row.id], 'announced');
  assert.notEqual(row.path, path.join(createdDir(ctx, project.id, 'sv1'), 'agent-prompts.svg'), 'the library keeps a copy of its own');
  assert.equal((await saveCreated(ctx, project.id, workspace.id, 'sv1', 'agent-prompts.svg')).id, row.id, 'saved again: the same row');
  assert.equal((await rowsNow()).length, before + 1);
  // What was saved is kept beside the files: read again (as after a restart), it says Saved, by the row's name now.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(createdDir(ctx, project.id, 'sv1'), SAVED_FILE), 'utf8')), { 'agent-prompts.svg': row.id });
  assert.deepEqual((await readCreated(ctx, project.id, 'sv1', 'agent-prompts.svg')).saved, { id: row.id, name: 'agent-prompts' });
  assert.equal((await readCreated(ctx, project.id, 'sv1', 'notes.md')).saved, null);
  const note = await saveCreated(ctx, project.id, workspace.id, 'sv1', 'notes.md');
  assert.deepEqual([note.type, note.source], ['md', 'create']);
  // A row taken out of the library is no longer Saved, and Save adds it again.
  await ctx.libraryDb.remove(row.id);
  assert.equal((await readCreated(ctx, project.id, 'sv1', 'agent-prompts.svg')).saved, null);
  assert.notEqual((await saveCreated(ctx, project.id, workspace.id, 'sv1', 'agent-prompts.svg')).id, row.id);
  for (const rel of ['../sv1/notes.md', '/etc/hosts', SAVED_FILE, '', 'a/../../x']) assert.throws(() => createdFile(ctx, project.id, 'sv1', rel), /file is invalid/, rel);
  assert.throws(() => createdDir(ctx, project.id, '../x'), /ask id is invalid/);
  await assert.rejects(saveCreated(ctx, project.id, workspace.id, 'sv1', 'nothing.svg'), /ENOENT|gone/);
});

test('saved as the run ends (2026-10-15): every kept file into the library, each on its own, so one that cannot be saved leaves the others saved', async () => {
  const draft = openDraft(ctx.dataRoot, 'as1');
  fs.writeFileSync(path.join(draft, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  fs.writeFileSync(path.join(draft, 'notes.md'), '# Notes\n');
  const made = await keepCreated(ctx, project.id, 'as1', draft);
  const added = [], before = (await rowsNow()).length;
  await saveAllCreated(ctx, project.id, workspace.id, 'as1', [{ rel: 'gone.svg' }, ...made.files], { onAdded: (one) => added.push(one.id) });
  assert.equal((await rowsNow()).length, before + 2, 'the two kept files, past the one that is not there');
  assert.equal(added.length, 2);
  for (const rel of ['chart.svg', 'notes.md']) assert.ok((await readCreated(ctx, project.id, 'as1', rel)).saved, `${rel} reads Saved`);
  for (const id of added) assert.ok(linked().includes(id), 'linked to the workspace');
  // Once: the same run's files saved again add nothing; a row taken out later is not brought back by anything but its Save.
  await saveAllCreated(ctx, project.id, workspace.id, 'as1', made.files, { onAdded: (one) => added.push(one.id) });
  assert.equal((await rowsNow()).length, before + 2, 'saved once');
  assert.equal(added.length, 2);
});

test('a run asked from a note (2026-10-16): its files saved and linked to the workspace the note was open in, without a click', async () => {
  const note = await projects.createNote(ctx, project.id, { name: 'Asked here', workspaceId: workspace.id, text: '' });
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const before = (await rowsNow()).length;
  const out = await bart.ask(ctx, project.id, { askId: 'fkn1', ref: { kind: 'note', id: note.id }, workspaceId: workspace.id, text: 'make an html page summarizing the papers', agent: 'create' });
  assert.equal(out.meta.created.length, 3);
  assert.equal((await rowsNow()).length, before + 3);
  for (const file of out.meta.created) {
    const read = await readCreated(ctx, project.id, 'fkn1', file.path);
    assert.ok(read.saved, `${file.name} reads Saved`);
    assert.ok(linked().includes(read.saved.id), `${file.name} linked to the workspace`);
  }
});

test('the sentence above the rows: the line on what it is making, the last message too unless it is "Done.", else the request as a sentence', () => {
  assert.equal(createdSentence('A chart.', 'Done.', 'x'), 'A chart.');
  assert.equal(createdSentence('A chart.', 'A chart.', 'x'), 'A chart.');
  assert.equal(createdSentence('A chart.', 'The 2019 numbers were not on the page, so that bar is missing.', 'x'), 'A chart.\n\nThe 2019 numbers were not on the page, so that bar is missing.');
  assert.equal(createdSentence('', 'This is a Build: it changes something you already have.', 'x'), 'This is a Build: it changes something you already have.');
  assert.equal(createdSentence('', 'Done.', 'make an SVG diagram of the agent prompts'), 'An SVG diagram of the agent prompts.');
  assert.equal(requestSentence('can you create a diagram showing all the agent prompts?'), 'A diagram showing all the agent prompts.');
});

test('a fake run answering "this is a Build" keeps nothing; a stopped run keeps nothing and its draft is gone', async () => {
  const before = (await rowsNow()).length;
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const out = await bart.ask(ctx, project.id, { askId: 'fk2', ref: ref(), workspaceId: workspace.id, text: 'make the file icons different', agent: 'create' });
  assert.match(out.lines[0], /^bart> This is a Build/);
  assert.deepEqual(out.meta.created, []);
  assert.ok(!out.lines.some((line) => /made:|lib:/.test(line)));
  assert.equal((await rowsNow()).length, before);

  const slow = createFakeBart({ readModels: () => DEFAULTS, delayMs: 5000 });
  const waiting = slow.ask(ctx, project.id, { askId: 'fk3', ref: ref(), workspaceId: workspace.id, text: 'make a chart of anything', agent: 'create' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(fs.existsSync(draftPath(ctx.dataRoot, 'fk3')), 'it is writing in its draft');
  slow.stop('fk3');
  await assert.rejects(waiting, (error) => error.kind === 'stopped');
  assert.equal((await rowsNow()).length, before, 'nothing kept');
  assert.ok(!fs.existsSync(draftPath(ctx.dataRoot, 'fk3')), 'the draft is gone');
  await assert.rejects(slow.ask(ctx, project.id, { askId: 'fk4', ref: ref(), workspaceId: workspace.id, text: '   ', agent: 'create' }), /nothing on the line to make/);
});

test('keepCreated: only the library\'s formats, at most five, each at most 20 MB; a link is skipped; what is skipped is said; nothing in the library', async () => {
  const dir = openDraft(ctx.dataRoot, 'kc1');
  for (const name of ['a.md', 'b.csv', 'c.json', 'd.svg', 'e.tsv', 'f.jsonl']) fs.writeFileSync(path.join(dir, name), name.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : name.endsWith('.md') ? '# A\n' : 'x\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi\n');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts.txt'));
  fs.mkdirSync(path.join(dir, 'sub dir'));
  fs.writeFileSync(path.join(dir, 'sub dir', 'z (1).md'), '# Z\n');
  const before = (await rowsNow()).length;
  const made = await keepCreated(ctx, project.id, 'kc1', dir);
  assert.equal((await rowsNow()).length, before, 'no row');
  assert.equal(made.files.length, MAX_CREATED);
  assert.deepEqual(made.files.map((file) => file.rel), ['a.md', 'b.csv', 'c.json', 'd.svg', 'e.tsv']);
  assert.deepEqual(made.files[3], { name: 'd.svg', rel: 'd.svg', type: 'image', size: 41 });
  assert.ok(made.skipped.some((why) => /^run\.sh: \.sh is not a format/.test(why)));
  assert.ok(made.skipped.some((why) => /^hosts\.txt: not a plain file/.test(why)));
  assert.ok(made.skipped.some((why) => /past the 5 files/.test(why)));
  assert.match(createdBody('Made.', made, 'kc1'), /^Made\.\n\n@\[a\.md\]\(made:kc1\/a\.md\)\n@\[b\.csv\]\(made:kc1\/b\.csv\)/);
  assert.match(createdBody('Made.', made, 'kc1'), /\n\nNot kept: .*run\.sh/);
  // A file in a folder keeps its path, each part encoded as the editor reads it.
  const nested = openDraft(ctx.dataRoot, 'kc3');
  fs.mkdirSync(path.join(nested, 'sub dir'));
  fs.writeFileSync(path.join(nested, 'sub dir', 'z (1).md'), '# Z\n');
  const deep = await keepCreated(ctx, project.id, 'kc3', nested);
  assert.deepEqual(deep.files.map((file) => file.rel), ['sub dir/z (1).md']);
  assert.equal(createdBody('', deep, 'kc3'), '@[z (1).md](made:kc3/sub%20dir/z%20%281%29.md)');
  assert.ok(fs.existsSync(path.join(createdDir(ctx, project.id, 'kc3'), 'sub dir', 'z (1).md')));
  const { madeMentionOf } = await loadDoc();
  assert.deepEqual(madeMentionOf('@[z (1).md](made:kc3/sub%20dir/z%20%281%29.md)'), { name: 'z (1).md', askId: 'kc3', rel: 'sub dir/z (1).md' });
  const big = openDraft(ctx.dataRoot, 'kc2');
  fs.writeFileSync(path.join(big, 'huge.csv'), Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.deepEqual((await keepCreated(ctx, project.id, 'kc2', big)).skipped, ['huge.csv: larger than 20 MB']);
  assert.throws(() => draftPath(ctx.dataRoot, '../x'), /ask id is invalid/);
});

/* ------------------------------------------------------- what it is making, as it works (2026-10-15) */

test('the line on what it is making: one quick run on the lowest model at low effort, given the request and the end of the documents; the request as a sentence when it fails', async () => {
  const calls = [];
  const run = (reply) => (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, input: fs.readFileSync(options.env.ENGELBART_NAME_INPUT, 'utf8'), prompt: fs.readFileSync(options.env.ENGELBART_NAME_PROMPT, 'utf8') });
    callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply })}\n`);
  };
  const making = (reply) => createMaking({ readModels: () => DEFAULTS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'making-runs'), run: run(reply) });
  const documents = `${'x'.repeat(MAX_DOCUMENTS)}<workspace>We talked about the five pillars.</workspace>`;
  const said = await making('"A diagram of this conversation: the five pillars and what is still open"')({ request: 'make a digram going over everything we talked about', documents, provider: 'anthropic' });
  assert.deepEqual([said.line, said.named], ['A diagram of this conversation: the five pillars and what is still open.', true]);
  const [call] = calls;
  assert.equal(call.env.ENGELBART_NAME_MODEL, Object.values(DEFAULTS.providers.anthropic.models)[0].id, 'the lowest model');
  assert.match(call.command, /--tools "" .*--effort low /);
  assert.equal(call.prompt, MAKING_PROMPT);
  assert.ok(call.input.includes('We talked about the five pillars.') && call.input.length < MAX_DOCUMENTS + 2000, 'the end of the documents');
  assert.match(call.input, /<request>\nmake a digram going over everything we talked about\n<\/request>/);
  assert.deepEqual(fs.readdirSync(path.join(homeDir, 'making-runs')), [], 'its files are gone');
  // Nothing usable: the request as a sentence.
  for (const reply of ['', 'ESCALATE: no', `${'word '.repeat(60)}`]) {
    const fallback = await making(reply)({ request: 'make a chart of CHI submissions by year', documents: '', provider: 'anthropic' });
    assert.deepEqual([fallback.line, fallback.named], ['A chart of CHI submissions by year.', false], JSON.stringify(reply));
  }
  assert.equal(cleanMaking('**An HTML page on tutors**'), 'An HTML page on tutors.');
  assert.equal(cleanMaking('Line: a chart of x!'), 'A chart of x!');
  assert.equal(createdLine('A diagram of the highlighting, Stage, and browser-window problems.'), 'Created a diagram of the highlighting, Stage, and browser-window problems.');
  assert.equal(createdLine('An HTML page on tutors.'), 'Created an HTML page on tutors.');
  assert.equal(createdLine('Creating a page on tutors…'), 'Created a page on tutors.');
  assert.equal(createdLine(''), '');
});

test('a Create run: its line told as it starts, before it reads or writes, and the answer\'s text once done; the prompt asks no first sentence of the model', async () => {
  const progress = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const run = (shell, args, options, callback) => {
    fs.writeFileSync(path.join(options.cwd, 'conversation.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    // The run goes on only once its line has been told.
    held.then(() => callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' })}\n`));
  };
  const line = 'A diagram of this conversation: other agents, the five pillars and what is still open.';
  const bart = realBart(DEFAULTS, run, { makeLine: async (asked) => { assert.equal(asked.request, 'make a diagram of this conversation'); assert.equal(typeof asked.documents, 'string'); return { line, named: true }; } });
  const asking = bart.ask(ctx, project.id, { askId: 'ml1', ref: ref(), workspaceId: workspace.id, text: 'make a diagram of this conversation', agent: 'create' }, { onProgress: (p) => { progress.push(p); if (p.making) release(); } });
  const out = await asking;
  assert.deepEqual(progress.filter((p) => p.making).map((p) => p.making), [line], 'told once');
  assert.deepEqual(out.lines.slice(0, 3), ['bart> Created a diagram of this conversation: other agents, the five pillars and what is still open.', 'bart>', 'bart> @[conversation.svg](made:ml1/conversation.svg)'], 'the same words, done (2026-10-15, David: "Created a diagram …"); "Done." not said');
  assert.ok(!/first message|first sentence/.test(CREATE_SYSTEM_PROMPT), 'no sentence of its own first');
  assert.match(CREATE_SYSTEM_PROMPT, /Reply with "Done\." and nothing else: Engelbart says what you made/);
  // Nothing kept (a Build's request, refused): the line is not said, its last message is.
  const refused = realBart(DEFAULTS, (shell, args, options, callback) => callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'This is a Build: it changes something you already have.' })}\n`), { makeLine: async () => ({ line, named: true }) });
  const no = await refused.ask(ctx, project.id, { askId: 'ml2', ref: ref(), workspaceId: workspace.id, text: 'make the icons different', agent: 'create' });
  assert.equal(no.lines[0], 'bart> This is a Build: it changes something you already have.');
});

test('a Write told as it is written: named once its path has come, then its size each whole KB; logged once, whole; what it holds never shown', () => {
  const read = claudeReader((file) => path.basename(file));
  const stream = (event) => read({ type: 'stream_event', event });
  const part = (partial_json, index = 2) => stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
  assert.equal(stream({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Write', input: {} } }), null);
  assert.equal(part('{"file_pa'), null, 'no path yet');
  assert.deepEqual(part('th": "/d/conversation-diagram.svg", "content": "<svg'), { activity: 'Writing conversation-diagram.svg' });
  assert.equal(part('<g>'.repeat(100)), null, 'under a KB');
  assert.deepEqual(part('<g>'.repeat(300)), { activity: 'Writing conversation-diagram.svg · 1 KB' });
  assert.equal(part('x'), null, 'the same KB');
  assert.deepEqual(part('x'.repeat(1024)), { activity: 'Writing conversation-diagram.svg · 2 KB' });
  // Another tool's input is not read as it comes; a Write's block ends and the whole call is logged as before.
  assert.equal(stream({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', name: 'Read', input: {} } }), null);
  assert.equal(part('{"file_path": "/d/x.md"}', 3), null);
  assert.equal(stream({ type: 'content_block_stop', index: 2 }), null);
  assert.equal(part('more', 2), null, 'ended: nothing more counted');
  assert.deepEqual(read({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/d/conversation-diagram.svg', content: '<svg/>' } }] } }), { activity: 'Writing conversation-diagram.svg', log: true });
  assert.deepEqual(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }), { activity: 'Thinking' });
});
