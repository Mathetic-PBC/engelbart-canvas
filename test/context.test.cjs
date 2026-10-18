'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveShell } = require('../src/main/terminal/launch.cjs');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const { createSweeper } = require('../src/main/context/sweeper.cjs');
const { buildRequest, fitSummary, loadSystemPrompt, createCliSummarizer, SummaryError } = require('../src/main/context/summarizer.cjs');
const { findAbstract, extractAbstract } = require('../src/main/context/pdf-text.cjs');
const { SUMMARY_SYSTEM_PROMPT } = require('../src/main/context/summary-prompt.cjs');

const MINUTE = 60_000;
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-context-'));
const layout = ensureHome(homeDir);
let ctx;
let project;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, 'Context');
});
test.after(async () => { await db.closeAll(); });

const long = (seed, n = 1500) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();
const row = (id) => ctx.libraryDb.get(id);
async function note(name, text, editedMinutesAgo) {
  const created = await projects.createNote(ctx, project.id, { name, text });
  await ctx.libraryDb.query('update library set last_edited = $2 where id = $1', [created.id, ago(editedMinutesAgo)]);
  return created;
}
function recorder(reply = ({ name }) => `Summary of ${name}.`) {
  const calls = [];
  const summarize = async (input) => { calls.push(input); const summary = await reply(input); return { summary, meta: { provider: 'test', model: 'none', durationMs: 1, costUsd: 0.01 } }; };
  return { calls, summarize };
}
const sweeperWith = (summarize, extra = {}) => createSweeper({ getContext: async () => ctx, summarize, ...extra });

test('the character count follows every save of a note; a save that changes nothing is not an edit; other documents are not counted', async () => {
  const created = await projects.createNote(ctx, project.id, { name: 'Counter', text: 'abc' });
  assert.equal((await row(created.id)).char_count, 3);
  await ctx.libraryDb.query('update library set last_edited = $2 where id = $1', [created.id, ago(90)]);
  const before = (await row(created.id)).last_edited;

  assert.equal((await projects.writeDoc(ctx, project.id, { kind: 'note', id: created.id }, 'abc')).lastEdited, null);
  assert.equal((await row(created.id)).last_edited, before, 'an identical save leaves last_edited alone');

  await projects.writeDoc(ctx, project.id, { kind: 'note', id: created.id }, 'abcdef');
  const after = await row(created.id);
  assert.equal(after.char_count, 6);
  assert.ok(after.last_edited > before);

  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'W' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'not a library row');
  const image = await projects.saveImage(ctx, project.id, { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' });
  assert.equal((await row(image.id)).char_count, null);
});

test('case 1: no summary, quiet for 30 minutes, longer than 1000 characters → file + system prompt in, summary and summary_edited out', async () => {
  const settled = await note('Settled', long('alpha'), 31);
  const recent = await note('Recent', long('beta'), 5);
  const short = await note('Short', long('gamma', 800), 45);
  const image = await projects.saveImage(ctx, project.id, { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mime: 'image/png' });
  await ctx.libraryDb.query('update library set last_edited = $2 where id = $1', [image.id, ago(120)]);

  const { calls, summarize } = recorder();
  const lastEdited = (await row(settled.id)).last_edited;
  const report = await sweeperWith(summarize).sweep();

  assert.deepEqual(calls.map((call) => [call.name, call.currentSummary]), [['Settled', null]]);
  assert.equal(calls[0].text, long('alpha'));
  assert.equal(calls[0].systemPrompt, SUMMARY_SYSTEM_PROMPT);
  const after = await row(settled.id);
  assert.equal(after.summary, 'Summary of Settled.');
  assert.ok(after.summary_edited >= lastEdited, 'summary_edited is when the text was read');
  assert.equal(after.last_edited, lastEdited, 'writing a summary is not an edit');
  assert.deepEqual([(await row(recent.id)).summary, (await row(short.id)).summary, (await row(image.id)).summary], [null, null, null]);
  assert.equal(report.dispatched, 1, 'the short note is never dispatched: its recorded length rules it out before the file is read');

  // A note whose length was never recorded (it predates the column) is measured from its file first.
  await ctx.libraryDb.query('update library set char_count = null where id = $1', [short.id]);
  const measured = await sweeperWith(recorder().summarize).sweep();
  assert.equal((await row(short.id)).char_count, 800);
  assert.equal(measured.dispatched, 0);

  const again = recorder();
  await sweeperWith(again.summarize).sweep();
  assert.equal(again.calls.length, 0, 'a fresh summary is left alone, and a short note is not read again');
});

test('case 2: a summary older than the last edit, quiet for 30 minutes → the current summary goes in too; a note that shrank loses its summary', async () => {
  const edited = await note('Edited', long('one'), 200);
  const shrunk = await note('Shrunk', long('two'), 200);
  await sweeperWith(recorder().summarize).sweep();
  assert.equal((await row(edited.id)).summary, 'Summary of Edited.');

  await projects.writeDoc(ctx, project.id, { kind: 'note', id: edited.id }, long('one, rewritten'));
  await projects.writeDoc(ctx, project.id, { kind: 'note', id: shrunk.id }, 'now tiny');
  const waiting = recorder();
  await sweeperWith(waiting.summarize).sweep();
  assert.equal(waiting.calls.length, 0, 'edited a moment ago: not yet');

  // Age both clocks together: summarized 100 minutes ago, edited 31 minutes ago.
  for (const id of [edited.id, shrunk.id]) await ctx.libraryDb.query('update library set last_edited = $2, summary_edited = $3 where id = $1', [id, ago(31), ago(100)]);
  const { calls, summarize } = recorder(({ name }) => `New summary of ${name}. Changed: rewritten.`);
  const report = await sweeperWith(summarize).sweep();
  assert.deepEqual(calls.map((call) => [call.name, call.currentSummary]), [['Edited', 'Summary of Edited.']]);
  assert.equal(calls[0].text, long('one, rewritten'));
  assert.equal((await row(edited.id)).summary, 'New summary of Edited. Changed: rewritten.');
  assert.deepEqual([(await row(shrunk.id)).summary, (await row(shrunk.id)).summary_edited], [null, null]);
  assert.deepEqual(report.cleared, ['Shrunk']);
});

test('an edit made while the summary is being written discards it; failures back off; an unavailable provider pauses every dispatch', async () => {
  const racing = await note('Racing', long('race'), 40);
  const during = recorder(async () => { await projects.writeDoc(ctx, project.id, { kind: 'note', id: racing.id }, long('race, edited mid-flight')); return 'stale'; });
  const report = await sweeperWith(during.summarize).sweep();
  assert.deepEqual(report.discarded, ['Racing']);
  assert.equal((await row(racing.id)).summary, null);
  await ctx.libraryDb.query('update library set last_edited = $2 where id = $1', [racing.id, ago(400)]);

  let clock = Date.now();
  let attempts = 0;
  const failing = sweeperWith(async () => { attempts += 1; throw new SummaryError('failed', 'boom'); }, { now: () => clock });
  assert.equal((await failing.sweep()).failed[0].message, 'boom');
  await failing.sweep();
  assert.equal(attempts, 1, 'not retried on the next beat');
  clock += 6 * MINUTE;
  await failing.sweep();
  assert.equal(attempts, 2, 'retried after the back-off');

  const other = await note('Other', long('other'), 40);
  let asked = 0;
  clock = Date.now();
  const offline = sweeperWith(async () => { asked += 1; throw new SummaryError('unavailable', 'Claude Code was not found'); }, { now: () => clock });
  const first = await offline.sweep();
  assert.equal(asked, 1, 'the first failure shows the provider is missing; nothing else is sent');
  assert.ok(first.pending.length >= 1);
  await ctx.libraryDb.setSummary(other.id, 'done', new Date());
  await ctx.libraryDb.setSummary(racing.id, 'done', new Date());
});

test('a burst is bounded per sweep, and status plus each project catalog land in hidden .context folders', async () => {
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Inline chat agent', parentId: workspace.id });
  const many = [];
  for (let i = 0; i < 4; i += 1) many.push(await note(`Burst ${i}`, long(`burst ${i}`), 60 + i));
  await projects.setWorkspaceContext(ctx, project.id, child.id, [many[3].id]);

  const { calls, summarize } = recorder();
  const sweeper = sweeperWith(summarize, { perSweep: 3 });
  const report = await sweeper.sweep();
  assert.deepEqual(calls.map((call) => call.name), ['Burst 3', 'Burst 2', 'Burst 1'], 'longest-settled first');
  assert.deepEqual(report.pending, ['Burst 0']);

  const file = path.join(project.dir, '.context', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(catalog.project.root, project.dir);
  assert.ok(catalog.workspaces.some((entry) => entry.path === 'Agents/Inline chat agent' && entry.document === 'Agents/Inline chat agent/workspace.md'));
  const first = catalog.entries.find((entry) => entry.id === many[3].id);
  assert.deepEqual([first.type, first.tags, first.path, first.workspaces, first.chars, first.summaryStale], ['md', ['note'], 'Burst 3.md', ['Agents/Inline chat agent'], 1500, false]);
  assert.ok(first.summary.startsWith('Summary of Burst'));
  assert.ok(catalog.entries.some((entry) => entry.type === 'image' && entry.summary === null && /^assets\//.test(entry.path)));
  assert.ok(JSON.parse(fs.readFileSync(path.join(layout.root, '.context', 'status.json'), 'utf8')).summarized.length === 3);
  assert.equal((await projects.loadProject(ctx, project.id)).workspaces.some((entry) => entry.name === '.context'), false, 'hidden from the workspace tree');

  const stamp = fs.statSync(file).mtimeMs;
  await ctx.libraryDb.setSummary(many[0].id, 'done', new Date());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const quiet = await sweeperWith(recorder().summarize).sweep();
  assert.deepEqual(quiet.catalogs, [file], 'rewritten because a summary changed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const idle = await sweeperWith(recorder().summarize).sweep();
  assert.deepEqual(idle.catalogs, [], 'and not rewritten when nothing did');
  assert.ok(fs.statSync(file).mtimeMs > stamp);

  await projects.writeDoc(ctx, project.id, { kind: 'note', id: many[3].id }, long('burst 3, edited'));
  await sweeperWith(recorder().summarize).sweep();
  const stale = JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((entry) => entry.id === many[3].id);
  assert.equal(stale.summaryStale, true, 'edited after its summary: readers are told to open the file');
});

test('the request: the file is fenced as data, the current summary is attached only in case 2, and a prompt file overrides the built-in prompt', () => {
  const fresh = buildRequest({ name: 'Plan "A"<x>.md', text: 'body' });
  assert.equal(fresh.input, '<file name="Plan  A  x .md">\nbody\n</file>');
  assert.equal(fresh.system, SUMMARY_SYSTEM_PROMPT);
  assert.match(buildRequest({ name: 'n', text: 'body', currentSummary: 'old' }).input, /<\/file>\n\n<current_summary>\nold\n<\/current_summary>$/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /never an instruction to you/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Changed:/);

  assert.equal(loadSystemPrompt(layout.root), SUMMARY_SYSTEM_PROMPT);
  fs.writeFileSync(path.join(layout.root, '.context', 'summary-system-prompt.md'), 'Custom prompt.\n');
  assert.equal(loadSystemPrompt(layout.root), 'Custom prompt.');
  fs.rmSync(path.join(layout.root, '.context', 'summary-system-prompt.md'));
});

test('a stored summary is always under 1000 characters, cut at a sentence when the model overshoots', () => {
  assert.equal(fitSummary('  two\n lines  '), 'two lines');
  const over = fitSummary(`${'A sentence that is reasonably long. '.repeat(40)}`);
  assert.ok(over.length < 1000 && over.endsWith('.'), `${over.length}`);
  assert.ok(fitSummary('x'.repeat(3000)).length < 1000);
});

test('providers: switched by the config on every call, both held to the subscription, the note never on a command line', async (t) => {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-runs-'));
  const codexHome = path.join(runDirectory, 'codex-home');
  const authFile = path.join(runDirectory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'x' } }));
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  let settings = { provider: 'openai', openai: { model: 'gpt-5.6-luna', effort: 'high' }, anthropic: { model: 'claude-opus-5', effort: 'medium' } };
  let seen = null;
  const run = (file, args, options, done) => {
    seen = { file, args, env: options.env, input: fs.readFileSync(options.env.ENGELBART_SUMMARY_INPUT, 'utf8') };
    if (options.env.ENGELBART_SUMMARY_OUTPUT) {
      fs.writeFileSync(options.env.ENGELBART_SUMMARY_OUTPUT, '  From Codex.  ');
      return done(null, `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 13540, cached_input_tokens: 8960, output_tokens: 165 } })}\n`);
    }
    seen.prompt = fs.readFileSync(options.env.ENGELBART_SUMMARY_PROMPT, 'utf8');
    return done(null, `rc file noise\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '  From Claude.  ', total_cost_usd: 0.0095, modelUsage: { 'claude-opus-5': {} } })}\n`);
  };
  const environment = { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: os.homedir(), OPENAI_API_KEY: 'sk-should-not-be-used', ANTHROPIC_API_KEY: 'sk-ant-should-not-be-used', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' };
  const summarize = createCliSummarizer({ readSettings: () => settings, environment, runDirectory, codexHome, codexAuthFile: authFile, run });

  const viaCodex = await summarize({ name: 'Note', text: 'body', currentSummary: 'old' });
  assert.equal(viaCodex.summary, 'From Codex.');
  assert.deepEqual([viaCodex.meta.provider, viaCodex.meta.model, viaCodex.meta.effort, viaCodex.meta.usage.cached_input_tokens], ['openai', 'gpt-5.6-luna', 'high', 8960]);
  assert.deepEqual([seen.file, seen.args[0]], [process.platform === 'win32' ? resolveShell(environment) : '/bin/zsh', '-ilc']); // Windows: Git for Windows' bash
  for (const flag of ['codex exec', '--skip-git-repo-check', '--ephemeral', '-s read-only', `model_reasoning_effort="high"`, 'project_doc_max_bytes=0', '--json']) assert.ok(seen.args[1].includes(flag), flag);
  assert.ok(!seen.args[1].includes('body'), 'the note never appears on a command line');
  assert.equal(seen.env.CODEX_HOME, codexHome, 'a private CODEX_HOME: none of your MCP servers, hooks or AGENTS.md');
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), SUMMARY_SYSTEM_PROMPT, 'the system prompt is that home\'s AGENTS.md');
  if (process.platform === 'win32') assert.equal(fs.statSync(path.join(codexHome, 'auth.json')).ino, fs.statSync(authFile).ino, 'your sign-in is hard-linked, not copied'); // Windows: no symlink without admin rights
  else assert.equal(fs.readlinkSync(path.join(codexHome, 'auth.json')), authFile, 'your sign-in is linked, not copied');
  assert.deepEqual([seen.env.OPENAI_API_KEY, seen.env.ANTHROPIC_API_KEY, seen.env.CLAUDECODE], [undefined, undefined, undefined], 'no API key, no outer agent session');
  assert.match(seen.input, /<current_summary>\nold/);

  settings = { ...settings, provider: 'claude' }; // the next call picks it up, no restart
  const viaClaude = await summarize({ name: 'Note', text: 'body' });
  assert.deepEqual([viaClaude.summary, viaClaude.meta.provider, viaClaude.meta.model, viaClaude.meta.effort, viaClaude.meta.costUsd], ['From Claude.', 'anthropic', 'claude-opus-5', 'medium', 0.0095]);
  for (const flag of ['claude -p', '--output-format json', '--no-session-persistence', '--setting-sources ""', '--strict-mcp-config', '--tools ""', '--effort medium', '--system-prompt-file']) assert.ok(seen.args[1].includes(flag), flag);
  assert.equal(seen.prompt, SUMMARY_SYSTEM_PROMPT);
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(fs.readdirSync(runDirectory).filter((name) => name.startsWith('summary-')), [], 'temp files are removed');

  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }));
  settings = { ...settings, provider: 'openai' };
  await assert.rejects(summarize({ name: 'n', text: 'body' }), (error) => error.kind === 'unavailable' && /ChatGPT account/.test(error.message), 'an API-key login is refused rather than billed');

  const missing = createCliSummarizer({ readSettings: () => ({ provider: 'anthropic' }), environment: { SHELL: '/bin/zsh' }, runDirectory, run: (f, a, o, done) => done(Object.assign(new Error('Command failed'), { code: 127 }), '') });
  await assert.rejects(missing({ name: 'n', text: 'body' }), (error) => error.kind === 'unavailable');
  const refused = createCliSummarizer({ readSettings: () => ({ provider: 'anthropic' }), environment: { SHELL: '/bin/zsh' }, runDirectory, run: (f, a, o, done) => done(null, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'nope' })) });
  await assert.rejects(refused({ name: 'n', text: 'body' }), (error) => error.kind === 'failed' && error.message === 'nope');
  await assert.rejects(summarize({ name: 'huge', text: 'x'.repeat(1_500_001) }), (error) => error.kind === 'too-long');
});

/* ------------------------------------------------------------------ PDFs */

// A one-page PDF with the given lines of text, enough for pdf.js to read back.
function makePdf(lines) {
  const escape = (text) => text.replace(/([\\()])/g, '\\$1');
  const content = `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${lines.map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const at = (text, extra = {}) => ({ page: 1, x: 54, y: 0, h: 9, text, ...extra });

test('findAbstract: a heading alone or run in, across a column break mid-sentence, up to the next section; null without one', () => {
  const twoColumns = [
    at('Title of the paper', { h: 14, y: 700 }),
    at('ABSTRACT', { h: 10.9, y: 181 }),
    at('With the prevalence of imperfect tools, it becomes impor-', { y: 167 }),
    at('tant to form hypotheses, by designing a theoretically motivated,', { y: 156 }),
    at('LLM-augmented tutor. It brings a learning gain of 13%.', { x: 318, y: 181 }),
    at('Ma, et al.', { page: 2, x: 531, y: 726, h: 7 }),
    at('CCS CONCEPTS', { page: 2, y: 698, h: 10.9 }),
    at('Human-centered computing', { page: 2, y: 685 }),
  ];
  assert.equal(findAbstract(twoColumns), 'With the prevalence of imperfect tools, it becomes important to form hypotheses, by designing a theoretically motivated, LLM-augmented tutor. It brings a learning gain of 13%.');
  assert.equal(findAbstract([at('Abstract—We study things.', { y: 600 }), at('They matter.', { y: 588 }), at('I. INTRODUCTION', { y: 560 }), at('Body', { y: 548 })]), 'We study things. They matter.');
  assert.equal(findAbstract([at('Abstract', { y: 600 }), at('One paragraph only.', { y: 588 }), at('Keywords: a, b', { y: 570 })]), 'One paragraph only.');
  assert.equal(findAbstract([at('Introduction', { y: 600 }), at('This abstract idea is discussed.', { y: 588 })]), null, 'the word inside a sentence is not a section header');
});

test('a real paper: the HypoCompass PDF yields its printed abstract, across both columns and without the arXiv stamp', async () => {
  const abstract = await extractAbstract(path.join(__dirname, '..', 'fixtures', 'hypocompass.pdf'));
  assert.ok(abstract.startsWith('With the prevalence of imperfect but capable LLMs in software development'), abstract.slice(0, 80));
  assert.ok(abstract.endsWith('with a reduced completion time of 13%.'), abstract.slice(-60));
  assert.ok(abstract.includes('theoretically motivated, LLM-augmented tutor'), 'continues into the second column');
  assert.ok(abstract.includes('learning principles') && !/arXiv|CCS CONCEPTS/.test(abstract));
});

test('PDFs in the sweep: an Abstract is the summary and no model runs; a changed file is re-read after 30 minutes; without an abstract the model runs; without text nothing does', async () => {
  const file = path.join(layout.root, 'paper.pdf');
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'hypocompass.pdf'), file);
  const old = new Date(Date.now() - 45 * MINUTE);
  fs.utimesSync(file, old, old);
  const paper = await ctx.libraryDb.insert({ id: '99999999-9999-4999-8999-999999999999', name: 'HypoCompass', type: 'pdf', path: file });

  const first = recorder();
  const report = await sweeperWith(first.summarize).sweep();
  assert.equal(first.calls.length, 0, 'no model call for a paper with an abstract');
  assert.deepEqual(report.abstracts, ['HypoCompass']);
  const stored = (await row(paper.id)).summary;
  assert.ok(stored.startsWith('With the prevalence of imperfect but capable LLMs') && stored.length > 1000, 'the abstract, whole, whatever its length');
  assert.deepEqual((await sweeperWith(recorder().summarize).sweep()).abstracts, [], 'not read again while the file is unchanged');

  // The file is replaced by one without an abstract; 31 minutes later the model summarizes its text.
  const body = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a report with no abstract section, long enough to be worth a summary.`);
  fs.writeFileSync(file, makePdf(body));
  const justNow = await sweeperWith(recorder().summarize).sweep();
  assert.deepEqual([justNow.abstracts, justNow.dispatched], [[], 0], 'changed a moment ago: not yet');
  const settled = new Date(Date.now() - 31 * MINUTE);
  fs.utimesSync(file, settled, settled);
  await ctx.libraryDb.query('update library set summary_edited = $2 where id = $1', [paper.id, ago(100)]);
  const second = recorder(() => 'A report in 24 lines. Changed: the abstract is gone.');
  await sweeperWith(second.summarize).sweep();
  assert.equal(second.calls.length, 1);
  assert.ok(second.calls[0].text.includes('Line 24 of a report') && second.calls[0].currentSummary.startsWith('With the prevalence'));
  assert.equal((await row(paper.id)).summary, 'A report in 24 lines. Changed: the abstract is gone.');

  // A PDF with almost no text: nothing to extract, nothing to summarize, and it is not parsed again.
  fs.writeFileSync(file, makePdf(['scan']));
  fs.utimesSync(file, settled, settled);
  await ctx.libraryDb.query('update library set summary_edited = $2 where id = $1', [paper.id, ago(100)]);
  const third = recorder();
  const sweeper = sweeperWith(third.summarize);
  assert.deepEqual((await sweeper.sweep()).cleared, ['HypoCompass']);
  assert.equal((await sweeper.sweep()).extracted, 0);
  assert.equal(third.calls.length, 0);
  await ctx.libraryDb.remove(paper.id);
});

test('re-categorizing an installed library is not an edit: the sweep that follows summarizes nothing and extracts nothing', async () => {
  const library = require('../src/main/store/library.cjs');
  const { inspectPdf } = require('../src/main/context/pdf-kind.cjs');
  const file = path.join(layout.root, 'installed-paper.pdf');
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'hypocompass.pdf'), file);
  const old = new Date(Date.now() - 45 * MINUTE);
  fs.utimesSync(file, old, old);
  // as the conversion leaves them: a pdf with no tag yet, a long note, both carrying summaries written before the upgrade
  const paper = await ctx.libraryDb.insert({ id: '88888888-8888-4888-8888-888888888888', name: 'Installed paper', type: 'pdf', path: file });
  await ctx.libraryDb.setSummary(paper.id, 'The summary it had before the upgrade.', new Date(Date.now() - 10 * MINUTE));
  const kept = await note('Installed note', long('installed'), 120);
  await ctx.libraryDb.setSummary(kept.id, 'The note summary it had.', new Date(Date.now() - 60 * MINUTE));
  await ctx.libraryDb.query('update library set categorized = null where id = any($1)', [[paper.id, kept.id]]);
  const fields = async () => Promise.all([paper.id, kept.id].map(async (id) => { const r = await row(id); return [r.summary, r.summary_edited, r.last_edited, r.char_count]; }));
  const before = await fields();

  const report = await library.recategorize(ctx, { inspectPdf }); // the real reader, on a real paper
  assert.deepEqual(report.changed.filter((r) => r.id === paper.id).map((r) => [r.type, r.tags]), [['pdf', ['paper']]]);
  const after = recorder();
  const swept = await sweeperWith(after.summarize).sweep();
  assert.deepEqual([after.calls.length, swept.dispatched, swept.extracted, swept.abstracts, swept.cleared], [0, 0, 0, [], []]);
  assert.deepEqual(await fields(), before);
  await ctx.libraryDb.remove(paper.id);
});

/* ------------------------------------------------------------------ PDF text, kept for search (library_text) */

const keptText = async (id) => (await ctx.libraryDb.query('select text, file_mtime, extracted_at from library_text where library_id = $1', [id]))[0] || null;
async function pdfRow(id, name, lines, modified = new Date()) {
  const file = path.join(layout.root, `${name}.pdf`);
  fs.writeFileSync(file, Array.isArray(lines) ? makePdf(lines) : lines);
  fs.utimesSync(file, modified, modified);
  return ctx.libraryDb.insert({ id, name, type: 'pdf', path: file });
}

test('the text pass: a PDF\'s text is kept on the first sweep, with no quiet period and no model; not read again until its file changes; the library rows are as they were', async () => {
  const paper = await pdfRow('aaaaaaaa-0000-4000-8000-000000000001', 'Fresh', ['Fresh findings on search.', 'A second line.']);
  const first = recorder();
  const report = await sweeperWith(first.summarize).sweep();
  assert.equal(report.texts, 1);
  assert.equal(first.calls.length, 0, 'no model call, and no waiting for the file to settle');
  const kept = await keptText(paper.id);
  assert.equal(kept.text, 'Fresh findings on search.\nA second line.');
  assert.equal(kept.file_mtime, fs.statSync(paper.path).mtimeMs);
  assert.equal((await sweeperWith(recorder().summarize).sweep()).texts, 0, 'unchanged: not read again');
  assert.equal((await keptText(paper.id)).extracted_at, kept.extracted_at);

  const listed = (await library.listLibrary(ctx)).find((entry) => entry.id === paper.id);
  for (const field of ['text', 'file_mtime', 'extracted_at', 'library_id']) assert.equal(field in listed, false, `the renderer's rows carry no ${field}`);
  assert.deepEqual(Object.keys(await ctx.libraryDb.get(paper.id)), Object.keys(listed));

  // The file changes: its text is read again, whatever the clock says about quiet.
  fs.writeFileSync(paper.path, makePdf(['Rewritten since.']));
  const changed = new Date(Date.now() - 2 * MINUTE);
  fs.utimesSync(paper.path, changed, changed);
  assert.equal((await sweeperWith(recorder().summarize).sweep()).texts, 1);
  const again = await keptText(paper.id);
  assert.deepEqual([again.text, again.file_mtime], ['Rewritten since.', fs.statSync(paper.path).mtimeMs]);
  assert.equal((await sweeperWith(recorder().summarize).sweep()).texts, 0);
  await ctx.libraryDb.remove(paper.id);
});

test('the text pass: a PDF with no text (a scan) or that cannot be read is kept as \'\' and not tried again; a file that is gone is skipped', async () => {
  const scan = await pdfRow('aaaaaaaa-0000-4000-8000-000000000002', 'Scan', []);
  const broken = await pdfRow('aaaaaaaa-0000-4000-8000-000000000003', 'Broken', 'not a pdf at all');
  const gone = await ctx.libraryDb.insert({ id: 'aaaaaaaa-0000-4000-8000-000000000004', name: 'Gone', type: 'pdf', path: path.join(layout.root, 'gone.pdf') });
  assert.equal((await sweeperWith(recorder().summarize).sweep()).texts, 2);
  assert.deepEqual([(await keptText(scan.id)).text, (await keptText(broken.id)).text, await keptText(gone.id)], ['', '', null]);
  assert.equal((await sweeperWith(recorder().summarize).sweep()).texts, 0, 'not retried while the files are unchanged');
  for (const row of [scan, broken, gone]) await ctx.libraryDb.remove(row.id);
});

test('the text pass: at most textsPerSweep PDFs are read in one sweep; the rest wait for the next', async () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push(await pdfRow(`aaaaaaaa-0000-4000-8000-00000000001${i}`, `Batch ${i}`, [`Batch paper ${i}.`]));
  const sweeper = sweeperWith(recorder().summarize, { textsPerSweep: 2 });
  assert.equal((await sweeper.sweep()).texts, 2);
  assert.equal((await ctx.libraryDb.textStamps()).size, 2);
  assert.equal((await sweeper.sweep()).texts, 1);
  assert.equal((await sweeper.sweep()).texts, 0);
  assert.deepEqual(await Promise.all(rows.map(async (row) => (await keptText(row.id)).text)), ['Batch paper 0.', 'Batch paper 1.', 'Batch paper 2.']);
  for (const row of rows) await ctx.libraryDb.remove(row.id);
});

test('the text pass by default: every PDF never read is read by the first sweep; the next reads none', async () => {
  const rows = [];
  for (let i = 0; i < 7; i += 1) rows.push(await pdfRow(`aaaaaaaa-0000-4000-8000-00000000005${i}`, `Unread ${i}`, [`Unread paper ${i}.`]));
  const sweeper = sweeperWith(recorder().summarize);
  assert.equal((await sweeper.sweep()).texts, 7);
  assert.equal((await ctx.libraryDb.textStamps()).size, 7);
  assert.equal((await sweeper.sweep()).texts, 0);
  for (const row of rows) await ctx.libraryDb.remove(row.id);
});

test('the text pass is not held to perSweep: with perSweep 1 every PDF is read, but only one paper is summarized', async () => {
  const settled = new Date(Date.now() - 45 * MINUTE);
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const body = Array.from({ length: 24 }, (_, n) => `Line ${n + 1} of report ${i}, with no abstract section, long enough to be worth a summary.`);
    rows.push(await pdfRow(`aaaaaaaa-0000-4000-8000-00000000006${i}`, `Report ${i}`, body, settled));
  }
  const { calls, summarize } = recorder();
  const report = await sweeperWith(summarize, { perSweep: 1 }).sweep();
  assert.equal(report.texts, 3);
  assert.equal((await ctx.libraryDb.textStamps()).size, 3);
  assert.deepEqual([calls.length, report.summarized.length, report.extracted, report.pending.length], [1, 1, 1, 2]);
  assert.ok(rows.some((row) => row.name === report.summarized[0].name), 'the one summary is one of these papers');
  for (const row of rows) await ctx.libraryDb.remove(row.id);
});

test('the text pass with summaries off: text is still kept, and nothing is summarized', async () => {
  const waiting = await note('Would be summarized', long('waiting'), 60);
  const body = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of a report with no abstract section, long enough to be worth a summary.`);
  const paper = await pdfRow('aaaaaaaa-0000-4000-8000-000000000020', 'Settled report', body, new Date(Date.now() - 45 * MINUTE));
  const { calls, summarize } = recorder();
  const report = await sweeperWith(summarize, { summaries: false }).sweep();
  assert.equal(report.texts, 1);
  assert.ok((await keptText(paper.id)).text.includes('Line 24 of a report'));
  assert.deepEqual([calls.length, report.dispatched, report.extracted, report.catalogs], [0, 0, 0, []]);
  assert.deepEqual([(await row(waiting.id)).summary, (await row(paper.id)).summary], [null, null]);
  await ctx.libraryDb.setSummary(waiting.id, 'done', new Date());
  await ctx.libraryDb.remove(paper.id);
});

test('a PDF added while a sweep waits on a summary is read within seconds: sweepSoon runs the text pass by itself', async () => {
  const slow = await note('Slow to summarize', long('slow'), 60);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let began;
  const begun = new Promise((resolve) => { began = resolve; });
  const sweeper = sweeperWith(async () => { began(); await gate; return { summary: 'Slow.', meta: {} }; });
  const sweeping = sweeper.sweep();
  await begun;
  const added = await pdfRow('aaaaaaaa-0000-4000-8000-000000000030', 'Added meanwhile', ['Added while a summary was being written.']);
  sweeper.sweepSoon(0);
  for (let i = 0; i < 100 && !(await keptText(added.id)); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await keptText(added.id)).text, 'Added while a summary was being written.');
  release();
  await sweeping;
  await sweeper.stop();
  assert.equal((await row(slow.id)).summary, 'Slow.');
  await ctx.libraryDb.remove(added.id);
});

test('library_text: setText checks its id and replaces what was kept; deleting the library row deletes its text', async () => {
  const paper = await ctx.libraryDb.insert({ id: 'aaaaaaaa-0000-4000-8000-000000000040', name: 'Doomed', type: 'pdf', path: path.join(layout.root, 'doomed.pdf') });
  await assert.rejects(ctx.libraryDb.setText('', 'x', 1), /id is required/);
  await assert.rejects(ctx.libraryDb.setText(paper.id, 'x', Number.NaN), /mtime/);
  await ctx.libraryDb.setText(paper.id, 'first', 1);
  await ctx.libraryDb.setText(paper.id, 'sec\u0000ond', 2.5);
  assert.deepEqual(await ctx.libraryDb.textStamps(), new Map([[paper.id, 2.5]]));
  assert.equal((await keptText(paper.id)).text, 'second');
  assert.equal(await ctx.libraryDb.remove(paper.id), true);
  assert.deepEqual(await ctx.libraryDb.query('select * from library_text where library_id = $1', [paper.id]), []);
});
