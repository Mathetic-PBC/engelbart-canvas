'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { DEFAULT_MODELS, PAST_DEFAULT_MODELS, MODELS_FILE, normalizeModels, onlyProviders, preferUsable, loadModels, effortOf, modelOf, readFlags, readQuestion, withChoice } = require('../src/main/bart/models.cjs');
const { climb, levelBlock, createBart, createFakeBart, createThreads, threadKey, cleanTurns, THREAD_IDLE_MS } = require('../src/main/bart/ask.cjs');
const { PENDING_RE, replyLines, answerText, failureLines, attribution } = require('../src/main/bart/reply.cjs');
const { buildContext, markPlace, conversationBlock, HERE } = require('../src/main/bart/context.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const MODELS = normalizeModels(null);
const ladder = (text) => readQuestion(text, MODELS).steps.map((step) => `${step.name} ${step.effort}`);

test('the ladders are the ones asked for: Sol medium, Sol high, Astra xhigh; Sonnet medium, Opus high, Fable xhigh', () => {
  assert.deepEqual(ladder('why?'), ['Sol medium', 'Sol high', 'Astra xhigh']);
  assert.deepEqual(readQuestion('why?', { ...MODELS, provider: 'anthropic' }).steps.map((step) => `${step.model} ${step.effort}`), ['sonnet medium', 'opus high', 'fable xhigh']);
  assert.equal(readQuestion('why?', MODELS).pinned, false);
});

test('flags are matched loosely, from either end, and pin one step', () => {
  for (const [text, question, step] of [
    ['--fable why', 'why', 'Fable xhigh'],
    ['--Opus --Extra-High prove it', 'prove it', 'Opus xhigh'],
    ['--extra high how', 'how', 'Astra xhigh'],
    ['why --sonnet', 'why', 'Sonnet medium'],
    ['--high hm', 'hm', 'Sol high'],
    ['--fable5.1 --XHIGH q', 'q', 'Fable xhigh'],
    ['--gpt-5.6-sol --med q', 'q', 'Sol medium'],
    ['--claude-opus-5 q --max', 'q', 'Opus max'], // Claude Code's top effort (2026-09-21)
    ['--sol --ultra q', 'q', 'Sol ultra'], // Codex's top effort
    ['--astra --max q', 'q', 'Astra ultra'], // max is not in Codex's list: of the two equally near, the higher
    ['--opus --ultra q', 'q', 'Opus max'], // ultra is not in Claude Code's list: the nearest that is
    ['--luna --low q', 'q', 'Luna medium'],
  ]) {
    const read = readQuestion(text, MODELS);
    assert.deepEqual([read.question, read.pinned, read.steps.map((s) => `${s.name} ${s.effort}`)], [question, true, [step]], text);
  }
  const kept = readQuestion('--nope what does --verbose do', MODELS);
  assert.deepEqual([kept.question, kept.pinned], ['--nope what does --verbose do', false]);
  assert.equal(effortOf(' X-High '), 'xhigh');
  assert.deepEqual(modelOf('Fable 5.1', MODELS), { provider: 'anthropic', model: 'fable' });
  assert.equal(modelOf('gemini', MODELS), null);
});

test('flags are found where they stand, so the editor can mark them, and a choice from the selector rewrites them', () => {
  const at = (text) => readFlags(text, MODELS).spans.map(([from, to]) => text.slice(from, to));
  assert.deepEqual(at('--Opus  --Extra-High prove --it'), ['--Opus', '--Extra-High']);
  assert.deepEqual(at('--extra high how --sonnet'), ['--extra', 'high', '--sonnet']);
  assert.deepEqual(at('--nope what does --verbose do'), []);
  assert.deepEqual(at('why --gemini --high'), ['--high'], 'a word that names nothing ends the taking');
  assert.equal(withChoice('--fable why --max', MODELS, { model: 'luna', effort: 'medium' }), '--luna --medium why');
  assert.equal(withChoice('', MODELS, { model: 'opus', effort: 'high' }), '--opus --high');
  const read = readQuestion(withChoice('why', MODELS, { model: 'opus', effort: 'xhigh' }), MODELS);
  assert.deepEqual([read.question, read.pinned, read.provider, read.steps.map((s) => `${s.name} ${s.effort}`)], ['why', true, 'anthropic', ['Opus xhigh']]);
});

test('only the providers config.json lists are offered: the rest have no models, no flags and cannot be the default', () => {
  const claude = onlyProviders(MODELS, ['anthropic']);
  assert.deepEqual([Object.keys(claude.providers), claude.provider], [['anthropic'], 'anthropic']);
  assert.deepEqual(readQuestion('why?', claude).steps.map((s) => `${s.name} ${s.effort}`), ['Sonnet medium', 'Opus high', 'Fable xhigh']);
  const kept = readQuestion('--sol why?', claude);
  assert.deepEqual([kept.question, kept.pinned], ['--sol why?', false], 'a model of a provider that is not offered is not a flag');
  assert.equal(onlyProviders(MODELS, ['openai', 'anthropic']).provider, 'openai');
  assert.deepEqual(Object.keys(onlyProviders(MODELS, []).providers), ['openai', 'anthropic'], 'a list that leaves nothing is ignored: a question can always run');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-only-'));
  assert.deepEqual(Object.keys(loadModels(root, { only: ['openai'] }).providers), ['openai']);
});

test('@bart starts on a CLI that can run: the saved default when it can, else the other; nothing is written (2026-09-23)', () => {
  const start = (usable, models = MODELS) => readQuestion('why?', preferUsable(models, usable)).steps[0].name;
  assert.equal(start(null), 'Sol', 'before the first check: the saved default');
  assert.equal(start(['codex', 'claude']), 'Sol', 'both: the saved default');
  assert.equal(start(['claude']), 'Sonnet', 'only Claude Code');
  assert.equal(start(['codex']), 'Sol', 'only Codex');
  assert.equal(start([]), 'Sol', 'neither: the saved default, which reports what is missing');
  assert.equal(start(['codex'], { ...MODELS, provider: 'anthropic' }), 'Sol', 'a saved Claude default moves to Codex while Claude Code cannot run');
  const picked = readQuestion('--opus why?', preferUsable(MODELS, ['codex']));
  assert.deepEqual([picked.provider, picked.pinned], ['anthropic', true], 'a model picked by flag is never moved');
  assert.equal(preferUsable(onlyProviders(MODELS, ['openai']), ['claude']).provider, 'openai', 'a provider config.json does not offer is never chosen');
});

test('the models file is written with the defaults, read again each time, keeps what the person edited, and a broken one falls back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-'));
  assert.deepEqual(loadModels(root), normalizeModels(DEFAULT_MODELS));
  const file = path.join(root, MODELS_FILE);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).about.length > 100);
  fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', providers: { anthropic: { models: { opus: { id: 'opus' }, bad: { id: 'rm -rf $HOME' } }, ladder: [{ model: 'opus', effort: 'Extra High' }, { model: 'gone', effort: 'high' }] } } }));
  const edited = loadModels(root);
  assert.equal(edited.provider, 'anthropic');
  assert.deepEqual(Object.keys(edited.providers.anthropic.models), ['opus']);
  assert.deepEqual(edited.providers.anthropic.ladder, [{ model: 'opus', effort: 'xhigh' }]);
  assert.deepEqual(edited.providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder);
  fs.writeFileSync(file, '{ not json');
  assert.equal(loadModels(root).provider, 'openai');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'a file being edited is never overwritten');
});

test('a default changed in a later build reaches installs that already have the file; what the person changed stays (2026-09-23)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-carry-'));
  const file = path.join(root, MODELS_FILE);
  loadModels(root);
  // this install's file was given an older set of defaults, and its owner changed Claude Code's ladder
  const given = JSON.parse(JSON.stringify(DEFAULT_MODELS));
  given.provider = 'anthropic';
  given.providers.openai.ladder = [{ model: 'luna', effort: 'medium' }];
  fs.writeFileSync(path.join(root, '.defaults', MODELS_FILE), JSON.stringify(given));
  const theirs = JSON.parse(JSON.stringify(given));
  theirs.providers.anthropic.ladder = [{ model: 'opus', effort: 'high' }];
  fs.writeFileSync(file, JSON.stringify(theirs));
  const loaded = loadModels(root);
  assert.equal(loaded.provider, 'openai', 'the default provider they never touched follows the new default');
  assert.deepEqual(loaded.providers.openai.ladder, DEFAULT_MODELS.providers.openai.ladder, 'so does the ladder they never touched');
  assert.deepEqual(loaded.providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }], 'the ladder they changed is theirs');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.defaults', MODELS_FILE), 'utf8')), DEFAULT_MODELS);
});

test('a file written before defaults were carried (Hudson\'s: 09-20 wording, 09-21 efforts added by hand) comes up to date and is backed up', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-models-legacy-'));
  const file = path.join(root, MODELS_FILE);
  const legacy = JSON.parse(JSON.stringify(PAST_DEFAULT_MODELS[0]));
  legacy.providers.openai.efforts = [...DEFAULT_MODELS.providers.openai.efforts];
  legacy.providers.anthropic.efforts = [...DEFAULT_MODELS.providers.anthropic.efforts];
  legacy.providers.anthropic.models.sonnet.use = 'My own words.';
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  loadModels(root);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(now.about, DEFAULT_MODELS.about);
  assert.deepEqual(now.providers.openai.efforts, ['medium', 'high', 'xhigh', 'ultra']);
  assert.equal(now.providers.anthropic.models.sonnet.use, 'My own words.');
  const copies = fs.readdirSync(path.join(root, '.backups'));
  assert.equal(copies.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.backups', copies[0]), 'utf8')).about, PAST_DEFAULT_MODELS[0].about);
});

test('climb: an answer ends it; ESCALATE resumes the same session one step up; the top step is told to answer', async () => {
  const steps = readQuestion('q', MODELS).steps;
  const seen = [];
  const progress = [];
  const replies = ['ESCALATE: needs a proof', 'ESCALATE: still hard', 'ESCALATE: no', 'the answer'];
  const out = await climb({ steps, pinned: false, first: (level) => `FIRST ${level}`, onProgress: (p) => progress.push(`${p.step}/${p.of} ${p.name} ${p.effort} up${p.movedUp}`), turn: async ({ level, message, session }) => { seen.push({ level: `${level.name} ${level.effort}`, session, message }); return { text: replies.shift(), session: 's1' }; } });
  assert.equal(out.text, 'the answer');
  assert.deepEqual(seen.map((call) => [call.level, call.session]), [['Sol medium', null], ['Sol high', 's1'], ['Astra xhigh', 's1'], ['Astra xhigh', 's1']]);
  assert.match(seen[0].message, /^FIRST <level>You are running as Sol at medium effort, step 1 of 3\. A higher step exists: Sol at high effort\.<\/level>$/);
  assert.match(seen[2].message, /step 3 of 3\. No higher step exists\./);
  assert.match(seen[3].message, /Answer the question now, as well as you can/);
  assert.deepEqual(out.trail.map((step) => [step.name, step.effort, step.why]), [['Sol', 'medium', 'needs a proof'], ['Sol', 'high', 'still hard']]);
  assert.deepEqual(progress, ['1/3 Sol medium up0', '2/3 Sol high up1', '3/3 Astra xhigh up2', '3/3 Astra xhigh up2']);
  assert.match(levelBlock(readQuestion('--opus q', MODELS).steps, 0, true), /chose this model and effort by hand: no higher step exists/);
});

test('climb: a long reply that merely starts with the word is an answer, and a model that never answers is reported', async () => {
  const steps = readQuestion('--sonnet q', MODELS).steps;
  const long = `ESCALATE: ${'x'.repeat(600)}`;
  assert.equal((await climb({ steps, pinned: true, first: () => 'm', turn: async () => ({ text: long, session: 's' }) })).text, long);
  const stuck = await climb({ steps, pinned: true, first: () => 'm', turn: async () => ({ text: 'ESCALATE: cannot', session: 's' }) });
  assert.equal(stuck.text, 'I could not answer this at the highest step available. cannot');
});

test('an answer becomes kept lines that say which model gave it; quotes are flattened, code blocks kept as written', async () => {
  const meta = { level: { name: 'Sol', effort: 'high' }, trail: [{ name: 'Sol', effort: 'medium' }], ms: 41_400 };
  assert.equal(attribution(meta), '*Sol · high · 41 s · moved up from Sol medium*');
  const written = replyLines('One.\n\n\n\n## Two  \n> quoted\n- item\r\n', meta);
  assert.deepEqual(written, ['bart> One.', 'bart>', 'bart> ## Two', 'bart> quoted', 'bart> - item', 'bart>', 'bart> *Sol · high · 41 s · moved up from Sol medium*']);
  // 2026-09-22: a fenced block is kept line for line, indent, blank lines and all; one left open is closed.
  assert.deepEqual(replyLines('Use:\n```json\n{\n  "a": 1,\n\n\n\n> not a quote\n}\n```\nDone.', null), ['bart> Use:', 'bart> ```json', 'bart> {', 'bart>   "a": 1,', 'bart>', 'bart>', 'bart>', 'bart> > not a quote', 'bart> }', 'bart> ```', 'bart> Done.']);
  assert.deepEqual(replyLines('Cut off:\n~~~~sh\nls -la\n\n', null), ['bart> Cut off:', 'bart> ~~~~sh', 'bart> ls -la', 'bart> ~~~~']);
  assert.deepEqual(replyLines('', null), ['bart> No answer came back.']);
  assert.deepEqual(failureLines('Codex was\nnot found'), ['bart> **No answer.** Codex was not found']);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.equal(PENDING_RE.source, model.PENDING_RE.source);
  assert.deepEqual(model.parseLine('bart?> ## Two'), { type: 'reply', text: '## Two', folded: false }, 'a draft of the 09-19 build reads as an answer');
  assert.deepEqual(model.parseLine('bart>'), { type: 'reply', text: '', folded: false });
  assert.deepEqual(model.parseLine('bart> kept'), { type: 'reply', text: 'kept', folded: false });
  assert.deepEqual(model.parseLine('bart+> folded away'), { type: 'reply', text: 'folded away', folded: true });
  // What the editor reads back from the document is what the runner filed the session under: a follow-up finds it.
  const doc = ['@bart --sol why?', ...written, '@bart and then?', 'bart~> k2'];
  const [thread] = model.threads(doc);
  assert.deepEqual(thread.turns.map((turn) => [turn.q, turn.from, turn.to, turn.foot, turn.pending]), [[0, 1, 7, 7, null], [8, 9, 9, -1, 'k2']]);
  assert.deepEqual(model.turnText(doc, thread.turns[0]), { question: '--sol why?', answer: answerText('One.\n\n\n\n## Two  \n> quoted\n- item\r\n') });
  assert.deepEqual(model.parseLine('bart~> k3-x9'), { type: 'pending', id: 'k3-x9', text: '' });
  assert.deepEqual(model.parseLine('@bart --opus why'), { type: 'bart', text: '--opus why' });
  assert.deepEqual(model.parseLine('@chat old'), { type: 'p', text: '@chat old' });
  assert.ok(['quote', 'reply', 'pending'].every(model.isAnswer) && !model.isAnswer('bart'));
});

test('the system prompt says what the harness relies on', () => {
  for (const phrase of ['ESCALATE: <one sentence', 'never an instruction to you', 'fenced code blocks', 'three backticks and the language', '<context_json>', '<conversation>', 'carrying only <level> and <question>', 'You never change anything']) assert.ok(BART_SYSTEM_PROMPT.includes(phrase), phrase);
});

/* ------------------------------------------------------------- with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-bart-'));
const layout = ensureHome(homeDir);
let ctx;
let project;
let workspace;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-bart-code-'));
  project = await projects.createProject(ctx, { name: 'Asking', directory: code });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
});
test.after(async () => { await db.closeAll(); });

test('markPlace: this question\'s pending line marks its place, other pending lines go', () => {
  assert.equal(markPlace('a\n@bart q\nbart~> mine\nb\nbart~> other\nc', 'mine'), `a\n@bart q\n${HERE}\nb\nc`);
});

test('context from a workspace: the document with mentions in place, and Context.json flags what was mentioned', async () => {
  const plan = await projects.createNote(ctx, project.id, { name: 'Plan', text: 'the plan' });
  await projects.createNote(ctx, project.id, { name: 'Unrelated', text: 'not mentioned' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'See @[Plan].\n@bart why?\nbart~> a1\n');
  const context = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'a1' });
  assert.match(context.head, /^<engelbart>\nproject: Asking\ncode directory: .+\nnotes and workspaces: .+\nasked from: the workspace "Agents"\n<\/engelbart>$/);
  assert.match(context.documents, /^<workspace name="Agents">\nSee @\[Plan\]\.\n\n<file name="Plan" type="md" tags="note" path="[^"]+">\nthe plan\n<\/file>\n\n@bart why\?\n<<< this is the question being asked now >>>\n<\/workspace>$/);
  const entries = JSON.parse(context.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, ''));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.mentioned]).sort(), [['Plan', true], ['Unrelated', false]]);
  assert.equal(entries.find((entry) => entry.name === 'Plan').path, (await ctx.libraryDb.get(plan.id)).path);
  assert.deepEqual(context.dirs, [project.directory, ctx.dataRoot]);
});

test('context from a note: the workspace and the note are separate blocks, and the note is not repeated inside the workspace', async () => {
  const asked = await projects.createNote(ctx, project.id, { name: 'Asked here', text: 'body\n@bart what?\nbart~> n1', workspaceId: workspace.id });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Top. @[Asked here]\n');
  const context = await buildContext(ctx, project.id, { ref: { kind: 'note', id: asked.id }, workspaceId: workspace.id, askId: 'n1' });
  assert.match(context.head, /asked from: the note "Asked here", opened from the workspace "Agents"/);
  assert.equal(context.documents, `<workspace name="Agents">\nTop. @[Asked here]\n</workspace>\n\n<note name="Asked here">\nbody\n@bart what?\n${HERE}\n</note>`);
});

test('the fake agent (scripted runs) answers through the same loop, moves up on "hard", and stops', async () => {
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5 });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const progress = [];
  const out = await bart.ask(ctx, project.id, { askId: 'f1', ref, workspaceId: workspace.id, text: 'a hard one' }, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(progress.filter((p) => p.step).map((p) => p.step), [1, 2]);
  assert.deepEqual(progress.filter((p) => p.log).map((p) => p.activity).slice(0, 2), ['Reading notes.md', 'Searching the web for “fake”']);
  const previews = progress.filter((p) => p.lines).map((p) => p.lines.join('\n'));
  assert.ok(previews.length > 1 && previews[previews.length - 1].startsWith('FAKE ANSWER to "a hard one".'), 'the answer arrives in pieces');
  assert.ok(previews.every((text) => !/ESCALATE/.test(text)), 'a request to move up is never shown as an answer');
  assert.equal(out.lines[0], 'bart> FAKE ANSWER to "a hard one".');
  assert.equal(out.lines[out.lines.length - 1].startsWith('bart> *Sol · high · '), true);
  assert.match(out.lines[out.lines.length - 1], /moved up from Sol medium\*$/);
  const slow = createFakeBart({ readModels: () => MODELS, delayMs: 5000 });
  const waiting = slow.ask(ctx, project.id, { askId: 'f2', ref, workspaceId: workspace.id, text: 'q' });
  setTimeout(() => slow.stop('f2'), 20);
  await assert.rejects(waiting, (error) => error.kind === 'stopped');
});

test('with the tool check: a question holds its CLI\'s lock, and a CLI the login PATH misses runs by its full path (2026-09-23)', async () => {
  const authFile = path.join(homeDir, 'auth-tools.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const events = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env });
    events.push('run');
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, 'answer');
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n');
  };
  const tools = {
    binaryFor: (name) => (name === 'codex' ? '/Users/someone/.local/bin/codex' : null),
    ensure: async (name) => { events.push(`ensure ${name}`); },
    use: async (name, fn) => { events.push(`lock ${name}`); try { return await fn(); } finally { events.push(`unlock ${name}`); } },
    check: async () => {},
  };
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-tools'), codexHome: path.join(homeDir, 'codex-home-tools'), codexAuthFile: authFile, run, tools });
  const out = await bart.ask(ctx, project.id, { askId: 't1', ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, text: 'why?' });
  assert.equal(out.lines[0], 'bart> answer');
  assert.deepEqual(events, ['ensure codex', 'lock codex', 'run', 'unlock codex']);
  assert.match(calls[0].command, /^exec "\$ENGELBART_CODEX_BIN" exec --color never /);
  assert.equal(calls[0].env.ENGELBART_CODEX_BIN, '/Users/someone/.local/bin/codex');
});

test('the real runner: command lines, private folders, the subscription, and a resumed session (the CLI itself is stubbed)', async () => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const replies = ['ESCALATE: deeper', 'done'];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, cwd: options.cwd, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    const text = replies.shift();
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n'); }
    else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`);
  };
  const runDirectory = path.join(homeDir, 'runs');
  const codexHome = path.join(homeDir, 'codex-home-bart');
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir, OPENAI_API_KEY: 'sk-never', ANTHROPIC_API_KEY: 'sk-never' }, runDirectory, codexHome, codexAuthFile: authFile, run });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 'r1', ref, workspaceId: workspace.id, text: 'why?' });
  assert.equal(out.lines[0], 'bart> done');
  assert.deepEqual([out.meta.level.name, out.meta.level.effort, out.meta.trail.length, out.meta.pinned], ['Sol', 'high', 1, false]);
  assert.match(calls[0].command, /^exec codex exec --color never --skip-git-repo-check -m "\$ENGELBART_BART_MODEL" -c 'model_reasoning_effort="medium"' -c 'sandbox_mode="read-only"' -c 'tools\.web_search=true'/);
  assert.match(calls[1].command, /^exec codex exec resume "\$ENGELBART_BART_SESSION" .*model_reasoning_effort="high"/);
  assert.equal(calls[1].env.ENGELBART_BART_SESSION, '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc');
  assert.equal(calls[0].env.CODEX_HOME, codexHome);
  assert.equal(calls[0].cwd, path.join(runDirectory, project.id));
  assert.ok(!('OPENAI_API_KEY' in calls[0].env) && !('ANTHROPIC_API_KEY' in calls[0].env));
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), BART_SYSTEM_PROMPT);
  assert.match(calls[0].input, /<question>\nwhy\?\n<\/question>$/);
  assert.match(calls[1].input, /You asked to move up, and you have\./);
  assert.ok(!fs.existsSync(calls[0].env.ENGELBART_BART_INPUT), 'the question does not stay on disk');

  replies.push('from claude');
  const claude = await bart.ask(ctx, project.id, { askId: 'r2', ref, workspaceId: workspace.id, text: '--opus why?' });
  assert.equal(claude.lines[0], 'bart> from claude');
  const last = calls[calls.length - 1];
  assert.match(last.command, /^exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id "\$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,WebSearch,WebFetch" --allowedTools "Read,Grep,Glob,WebSearch,WebFetch" --add-dir "\$ENGELBART_BART_DIR0" --add-dir "\$ENGELBART_BART_DIR1" --model "\$ENGELBART_BART_MODEL" --effort high /);
  assert.deepEqual([last.env.ENGELBART_BART_MODEL, last.env.ENGELBART_BART_DIR0, last.env.ENGELBART_BART_DIR1], ['opus', project.directory, ctx.dataRoot]);
  assert.match(last.input, /chose this model and effort by hand/);
});

test('activity: each CLI\'s events become short labels and the text so far; nothing else gets through', () => {
  const { pathLabeller, claudeUpdate, codexUpdate, commandLabel, eventReader } = require('../src/main/bart/activity.cjs');
  const short = pathLabeller(['/code/app', '/home/me/.engelbart']);
  assert.equal(short('/code/app/src/main/ipc.cjs'), 'src/main/ipc.cjs');
  assert.equal(short('/etc/secret/passwd'), 'passwd');
  assert.equal(short('./src/a.js'), 'src/a.js');
  // Claude Code 2.1.278, --output-format stream-json --verbose --include-partial-messages
  const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
  assert.deepEqual(claudeUpdate(tool('Read', { file_path: '/code/app/src/a.js' }), short), { activity: 'Reading src/a.js', log: true });
  assert.deepEqual(claudeUpdate(tool('Grep', { pattern: 'onProgress' }), short), { activity: 'Searching code for “onProgress”', log: true });
  assert.deepEqual(claudeUpdate(tool('WebSearch', { query: 'engelbart 1968' }), short), { activity: 'Searching the web for “engelbart 1968”', log: true });
  assert.deepEqual(claudeUpdate(tool('WebFetch', { url: 'https://www.dougengelbart.org/x?y=1' }), short), { activity: 'Reading dougengelbart.org', log: true });
  const stream = (event) => ({ type: 'stream_event', event });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }), short), { activity: 'Thinking' });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), short), { textStart: true });
  assert.deepEqual(claudeUpdate(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The secret' } }), short), { delta: 'The secret' });
  assert.equal(claudeUpdate(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } }), short), null);
  assert.equal(claudeUpdate({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }] } }, short), null);
  assert.equal(claudeUpdate({ type: 'result', result: 'x' }, short), null);
  // codex-cli 0.155.0, exec --json
  assert.deepEqual(codexUpdate({ type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", status: 'in_progress' } }, short), { activity: 'Reading note.txt', log: true });
  assert.equal(codexUpdate({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'", aggregated_output: 'the secret word' } }, short), null);
  assert.deepEqual(codexUpdate({ type: 'item.started', item: { type: 'web_search', query: '', action: { type: 'other' } } }, short), { activity: 'Searching the web' });
  assert.deepEqual(codexUpdate({ type: 'item.completed', item: { type: 'web_search', query: 'Douglas Engelbart birth year', action: { type: 'search' } } }, short), { activity: 'Searching the web for “Douglas Engelbart birth year”', log: true });
  assert.deepEqual(codexUpdate({ type: 'item.completed', item: { type: 'agent_message', text: 'It is **1925**.' } }, short), { text: 'It is **1925**.' });
  assert.equal(codexUpdate({ type: 'item.completed', item: { type: 'error', message: 'Skill descriptions were shortened' } }, short), null);
  assert.equal(commandLabel("/bin/zsh -lc \"rg -n 'execFile' /code/app/src | head\"", short), 'Searching code for “execFile”');
  assert.equal(commandLabel("/bin/zsh -lc \"sed -n '1,80p' /code/app/src/main/bart/ask.cjs\"", short), 'Reading src/main/bart/ask.cjs');
  assert.equal(commandLabel('python3 -c "import os; os.system(\'x\')"', short), 'Running python3');
  // Lines split across chunks, and lines that are not events.
  const seen = [];
  const read = eventReader((event) => seen.push(event.n));
  read('Restored session\n{"n":1}\n{"n"'); read(':2}\n{broken\n'); read('{"n":3}\n');
  assert.deepEqual(seen, [1, 2, 3]);
});

test('the real runner streams while the CLI is still running: labels, then the text so far, then the answer', async () => {
  const { EventEmitter } = require('node:events');
  const progress = [];
  const run = (shell, args, options, callback) => {
    const child = { stdout: new EventEmitter() };
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(project.directory, 'src', 'a.js') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET FILE BODY' }] } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Half an ' } } },
    ];
    setTimeout(() => child.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n'), 5);
    setTimeout(() => callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Half an answer, finished.' })}\n`), 200);
    return child;
  };
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-stream'), run });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const out = await bart.ask(ctx, project.id, { askId: 's1', ref, workspaceId: workspace.id, text: '--opus why?' }, { onProgress: (p) => progress.push(p) });
  assert.equal(out.lines[0], 'bart> Half an answer, finished.');
  assert.deepEqual(progress.map((p) => (p.step ? 'step' : p.activity || p.lines.join('\n'))), ['step', path.join('Reading src', 'a.js'), 'Writing', 'Half an']);
  assert.ok(!JSON.stringify(progress).includes('SECRET'), 'what a tool returned is never sent on');
});

/* ------------------------------------------------------------- follow-ups (2026-09-21) */

test('sessions are held for 30 idle minutes, handed out once, and only to the provider that made them', () => {
  assert.equal(THREAD_IDLE_MS, 30 * 60_000);
  const timers = [];
  const threads = createThreads({ setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; }, clearTimer: (timer) => { timer.live = false; } });
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  assert.equal(timers[0].ms, THREAD_IDLE_MS);
  assert.equal(threads.take('k', 'anthropic'), null, 'another provider cannot resume it');
  assert.equal(threads.size(), 0, 'and a session that was reached for is gone either way');
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  assert.equal(threads.take('k', 'openai').session, 's1');
  assert.equal(threads.take('k', 'openai'), null, 'handed out once: a turn that fails leaves nothing to resume');
  threads.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  threads.keep('k', { provider: 'openai', session: 's2', projectId: 'p', workspaceId: 'w' });
  assert.deepEqual(timers.map((timer) => timer.live), [false, false, false, true], 'keeping again starts the clock again');
  timers[3].fn();
  assert.equal(threads.take('k', 'openai'), null, 'idle for 30 minutes: gone');
  threads.keep('a', { provider: 'openai', session: 's', projectId: 'p', workspaceId: 'w1' });
  threads.keep('b', { provider: 'openai', session: 's', projectId: 'p', workspaceId: 'w2' });
  threads.forget((entry) => entry.workspaceId === 'w1');
  assert.deepEqual([threads.take('a', 'openai'), threads.take('b', 'openai').session], [null, 's']);
});

test('an exchange is known by what the document says was said', () => {
  const ref = { kind: 'workspace', workspaceId: 'w' };
  const said = [{ question: 'why?', answer: 'because' }];
  assert.equal(threadKey('p', ref, said), threadKey('p', ref, cleanTurns([{ question: ' why? ', answer: 'because\n' }])));
  assert.notEqual(threadKey('p', ref, said), threadKey('p', ref, [{ question: 'why?', answer: 'because, edited' }]));
  assert.notEqual(threadKey('p', ref, said), threadKey('p', { kind: 'note', id: 'w' }, said));
  assert.deepEqual(cleanTurns([{ question: '' }, null, { question: 'q', answer: 5 }]), [{ question: 'q', answer: '5' }]);
  assert.equal(conversationBlock([]), '');
  assert.equal(conversationBlock(said), '<conversation>\n<turn n="1">\n<asked>\nwhy?\n</asked>\n<answered>\nbecause\n</answered>\n</turn>\n</conversation>');
});

test('a follow-up resumes the session inside the window and is given everything again outside it', async () => {
  const authFile = path.join(homeDir, 'auth-follow.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  let fail = false;
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    if (fail && / resume /.test(command)) { callback(new Error('no rollout found'), ''); return; }
    if (!/codex/.test(command)) { callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `answer ${calls.length}` })}\n`); return; }
    fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, `answer ${calls.length}`);
    callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n');
  };
  const threads = createThreads();
  const bart = createBart({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-follow'), codexHome: path.join(homeDir, 'codex-home-follow'), codexAuthFile: authFile, run, threads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, '@bart why?\nbart> answer 1\n@bart and then?\nbart~> f2\n');
  const ask = (askId, text, turns, choice) => bart.ask(ctx, project.id, { askId, ref, workspaceId: workspace.id, text, turns, choice });

  await ask('f1', 'why?');
  const second = await ask('f2', 'and then?', [{ question: 'why?', answer: 'answer 1' }]);
  assert.equal(second.lines[0], 'bart> answer 2');
  assert.match(calls[1].command, /^exec codex exec resume "\$ENGELBART_BART_SESSION" /);
  assert.equal(calls[1].env.ENGELBART_BART_SESSION, '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc');
  assert.match(calls[1].input, /^<level>[^\n]+<\/level>\n\n<question>\nand then\?\n<\/question>$/, 'inside the window only the new question is sent');

  // The person edited the first answer: the session's memory and the document disagree, so the document wins.
  const edited = [{ question: 'why?', answer: 'answer 1, corrected' }, { question: 'and then?', answer: 'answer 2' }];
  await ask('f2', 'a third', edited);
  assert.match(calls[2].command, /^exec codex exec --color never /);
  assert.match(calls[2].input, /^<engelbart>[\s\S]+<context_json>[\s\S]+<workspace name="Agents">[\s\S]+<<< this is the question being asked now >>>[\s\S]+<conversation>\n<turn n="1">\n<asked>\nwhy\?\n<\/asked>\n<answered>\nanswer 1, corrected\n<\/answered>[\s\S]+<turn n="2">[\s\S]+<\/conversation>\n\n<level>[^\n]+<\/level>\n\n<question>\na third\n<\/question>$/, 'the same context flow as a first question, with the earlier turns added');

  // Idle for 30 minutes (here: let go by hand): nothing to resume.
  const third = [...edited, { question: 'a third', answer: 'answer 3' }];
  threads.forget();
  await ask('f2', 'a fourth', third);
  assert.match(calls[3].command, /^exec codex exec --color never /);

  // A session that will not resume is started again without a word to the person.
  fail = true;
  const fifth = await ask('f2', 'a fifth', [...third, { question: 'a fourth', answer: 'answer 4' }]);
  assert.deepEqual([/ resume /.test(calls[4].command), /^exec codex exec --color never /.test(calls[5].command), fifth.lines[0]], [true, true, 'bart> answer 6']);
  assert.match(calls[5].input, /<conversation>/);
  assert.ok(!/resumed/i.test(fifth.lines.join('\n')), 'which of the two happened is never shown');
  fail = false;

  // Regenerate with a model from its selector: the line keeps its words, the run takes the choice, another provider starts anew.
  const again = await ask('f2', 'a fifth', [...third, { question: 'a fourth', answer: 'answer 4' }], { model: 'opus', effort: 'max' });
  assert.deepEqual([again.meta.provider, again.meta.level.name, again.meta.level.effort, again.meta.pinned], ['anthropic', 'Opus', 'max', true]);
});

test('the fake agent follows up the same way, so a scripted run can show which path was taken', async () => {
  const threads = createThreads();
  const bart = createFakeBart({ readModels: () => MODELS, delayMs: 5, threads });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const first = await bart.ask(ctx, project.id, { askId: 'g1', ref, workspaceId: workspace.id, text: 'why?' });
  const said = [{ question: 'why?', answer: first.lines.slice(0, -2).map((line) => line.replace(/^bart> ?/, '')).join('\n') }];
  const second = await bart.ask(ctx, project.id, { askId: 'g2', ref, workspaceId: workspace.id, text: 'and then?', turns: said });
  assert.ok(second.lines.includes('bart> - the same session, given the question alone'));
  threads.forget();
  const third = await bart.ask(ctx, project.id, { askId: 'g3', ref, workspaceId: workspace.id, text: 'and then?', turns: said });
  assert.ok(third.lines.includes('bart> - a new session, given 1 earlier turn'));
});

test('what can be resumed outlives the app, and another workspace open in between changes nothing', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-threads-')), 'bart-threads.json');
  let clock = 1_000_000;
  const first = createThreads({ file, now: () => clock });
  first.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' });
  first.keep('old', { provider: 'openai', session: 's0', projectId: 'p', workspaceId: 'w' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(([key, entry]) => [key, Object.keys(entry).sort()]), [['k', ['at', 'projectId', 'provider', 'session', 'workspaceId']], ['old', ['at', 'projectId', 'provider', 'session', 'workspaceId']]], 'ids and times only: nothing of what was said');
  clock += 29 * 60_000;
  first.keep('k', { provider: 'openai', session: 's1', projectId: 'p', workspaceId: 'w' }); // a turn at minute 29 starts its clock again
  clock += 2 * 60_000;
  const afterRestart = createThreads({ file, now: () => clock });
  assert.equal(afterRestart.take('old', 'openai'), null, '31 idle minutes: gone, whatever the app did meanwhile');
  assert.equal(afterRestart.take('k', 'openai').session, 's1', '2 idle minutes and a restart: resumed');
  assert.equal(createThreads({ file, now: () => clock }).size(), 0, 'handed out once, on disk too');
  fs.writeFileSync(file, '{ not json');
  assert.equal(createThreads({ file }).size(), 0);
  // No renderer call can let a session go any more: leaving a workspace is not the end of a conversation.
  assert.ok(!/forget/.test(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8')) && !/forget/.test(fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8')));
});
