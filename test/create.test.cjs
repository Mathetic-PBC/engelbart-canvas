'use strict';

// @create (2026-10-13; src/main/bart/create.cjs, ask.cjs): an agent that makes a new thing as files in a draft folder of
// its own, <dataRoot>/.create/<askId>/, the only place it may write, and has them kept in the library after the run. The
// line's syntax, the CLIs' arguments, the files kept (and not), and the answer that mentions them. The router's pick and
// the editor's five-second wait are in route.test.cjs.

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
const { CREATE_DIR, CREATE_TIMEOUT_MS, MAX_CREATED, draftPath, openDraft, keepCreated, createdBody } = require('../src/main/bart/create.cjs');
const { CREATE_SYSTEM_PROMPT } = require('../src/main/bart/create-system-prompt.cjs');
const { stripAgentReplies, OMITTED } = require('../src/main/bart/strip.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');

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
  return createBart({ readModels: () => models, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs'), codexHome: path.join(homeDir, 'codex-home'), createCodexHome: path.join(homeDir, 'codex-home-create'), codexAuthFile: authFile, run, ...extra });
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
  assert.equal(createRules('/a/b'), `${CLAUDE_TOOLS},Edit(//a/b/**),Write(//a/b/**)`);
  for (let n = 0; call.env[`ENGELBART_BART_DIR${n}`]; n++) assert.ok(!call.env.ENGELBART_BART_RULES.includes(`(/${call.env[`ENGELBART_BART_DIR${n}`]}/**)`), 'the folders it reads (the data root holds the draft) get no write rule');
  assert.equal(call.timeout, CREATE_TIMEOUT_MS);
  assert.equal(CREATE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(call.prompt, CREATE_SYSTEM_PROMPT);
  assert.equal(out.meta.created.length, 1);
  assert.deepEqual(added, [out.meta.created[0].id], 'announced');
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
  assert.deepEqual(out.meta.created.map((row) => row.name), ['chi-by-year']);
  assert.ok(!fs.existsSync(call.cwd));
  // An @chat line keeps its read-only sandbox.
  await bart.ask(ctx, project.id, { askId: 'cx2', ref: ref(), workspaceId: workspace.id, text: 'why?', agent: 'bart' });
  assert.match(calls[1].command, /-c 'sandbox_mode="read-only"'/);
  assert.ok(!/-C |workspace-write/.test(calls[1].command));
});

/* ------------------------------------------------------------------ what is kept */

test('a fake run writing report.md, chart.html and data.csv: three rows (assets/md, assets/files twice), linked, announced, the draft gone, one mention each', async () => {
  const runLog = createRunLog({ file: path.join(homeDir, 'runs-fake', 'agent-runs.jsonl') });
  const added = [];
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2, runLog, onAdded: (row) => added.push(row.id) });
  const before = (await rowsNow()).length;
  const out = await bart.ask(ctx, project.id, { askId: 'fk1', ref: ref(), workspaceId: workspace.id, text: 'make an html page summarizing the papers in my library on AI-assisted programming', agent: 'create' });
  const rows = out.meta.created;
  assert.deepEqual(rows.map((row) => [row.name, row.type]), [['chart', 'html'], ['data', 'csv'], ['report', 'md']]);
  assert.equal((await rowsNow()).length, before + 3);
  const held = new Map((await rowsNow()).map((row) => [row.id, row]));
  assert.match(held.get(rows[2].id).path, /(^|\/)assets\/md\//, 'Markdown is a note of the library\'s own');
  for (const row of rows.slice(0, 2)) assert.match(held.get(row.id).path, /(^|\/)assets\/files\/[0-9a-f-]{36}\//, `${row.name}: under assets/files/<uuid>/`);
  assert.ok(rows.every((row) => linked().includes(row.id)), 'linked to the workspace');
  assert.deepEqual(added, rows.map((row) => row.id), 'each announced');
  assert.deepEqual(draftsLeft(), [], 'the draft folder is gone');
  const mentions = out.lines.filter((line) => /^bart> @\[[^\]]+\]\(lib:[^)]+\)$/.test(line));
  assert.deepEqual(mentions, rows.map((row) => `bart> @[${row.name}](lib:${row.id})`), 'one mention per file, after the sentences');
  assert.match(out.lines[0], /^bart> I made a fake report, a chart page and its data/);
  assert.match(out.lines[out.lines.length - 1], /^bart> \*Create · Sonnet · high · \d+ s\*$/);
  assert.ok(!out.lines.some((line) => /Not kept/.test(line)));
  // A mention clicked opens its row in the Stage (Stage.jsx readPath → stage-file): the page as a page, the note, the table.
  const shown = await Promise.all(rows.map((row) => projects.readStageFile(ctx, project.id, held.get(row.id).path)));
  assert.deepEqual(shown.map((one) => one.kind), ['page', 'table', 'md']);
  assert.match(shown[0].url, /^file:\/\/.*\/assets\/files\/[0-9a-f-]{36}\/chart\.html$/);
  // Its record lists them, as the Agent Viewer shows a Create run's output.
  await runLog.flush();
  const record = runLog.list().find((run) => run.agent === 'create');
  assert.deepEqual(record.created.map((row) => row.id), rows.map((row) => row.id));
  const { createdLines } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/agent-map/runText.js')).href);
  assert.match(createdLines(record), /^chart · html · .*\ndata · csv · .*\nreport · md · /);
});

test('a fake run answering "this is a Build" keeps nothing; a stopped run keeps nothing and its draft is gone', async () => {
  const before = (await rowsNow()).length;
  const bart = createFakeBart({ readModels: () => DEFAULTS, delayMs: 2 });
  const out = await bart.ask(ctx, project.id, { askId: 'fk2', ref: ref(), workspaceId: workspace.id, text: 'make the file icons different', agent: 'create' });
  assert.match(out.lines[0], /^bart> This is a Build/);
  assert.deepEqual(out.meta.created, []);
  assert.ok(!out.lines.some((line) => /lib:/.test(line)));
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

test('keepCreated: only the library\'s formats, at most five, each at most 20 MB; a link is skipped; what is skipped is said', async () => {
  const dir = openDraft(ctx.dataRoot, 'kc1');
  for (const name of ['a.md', 'b.csv', 'c.json', 'd.svg', 'e.tsv', 'f.jsonl']) fs.writeFileSync(path.join(dir, name), name.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : name.endsWith('.md') ? '# A\n' : 'x\n');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo hi\n');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts.txt'));
  const made = await keepCreated(ctx, project.id, workspace.id, dir);
  assert.equal(made.rows.length, MAX_CREATED);
  assert.ok(made.skipped.some((why) => /^run\.sh: \.sh is not a format/.test(why)));
  assert.ok(made.skipped.some((why) => /^hosts\.txt: not a plain file/.test(why)));
  assert.ok(made.skipped.some((why) => /past the 5 files/.test(why)));
  assert.match(createdBody('Made.', made), /^Made\.\n\n@\[a\]\(lib:[^)]+\)\n@\[b\]/);
  assert.match(createdBody('Made.', made), /\n\nNot kept: .*run\.sh/);
  const big = openDraft(ctx.dataRoot, 'kc2');
  fs.writeFileSync(path.join(big, 'huge.csv'), Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.deepEqual((await keepCreated(ctx, project.id, workspace.id, big)).skipped, ['huge.csv: larger than 20 MB']);
  assert.throws(() => draftPath(ctx.dataRoot, '../x'), /ask id is invalid/);
});
