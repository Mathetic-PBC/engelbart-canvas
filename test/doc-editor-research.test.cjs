'use strict';

// @discover's research box (src/renderer/workspace/DocEditor.jsx, 2026-10-13; 2026-10-14). An @discover question is
// Discover's alone: it settles with the person what to research, and once it has, its reply ends with a hidden
// <research> line (main's bart/ask.cjs takeResearch) and the window puts a research box under it, a turn of the same
// conversation whose line is `@discover --research <direction>` (src/renderer/model/doc.js isResearch), which the editor
// asks (askBoxed). A Deep search waits five seconds first, with Cancel; a reply Bart sends to Discover stops a search still
// running. There is no document here: the editor and its elements are stand-ins, as in doc-editor-titles.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const ask = require('../src/main/bart/ask.cjs');
const { replyBody } = ask;

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-research-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const DocEditor = load('DocEditor.jsx').default;
const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const MODELS = normalizeModels(null);
const answer = (text, agent = 'discover') => replyLines([text], { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: true, agent });

function mounted(lines, extra = {}) {
  const asks = [], stopped = [], ticks = [];
  const props = { docKey: 'k', text: lines.join('\n'), models: MODELS, onChange: (next) => { props.text = next; }, onAsk: (ask) => asks.push(ask), onStopAsk: (id) => stopped.push(id), ...extra };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.forceUpdate = () => {};
  editor.syncEditor = () => {};
  editor.patchPending = () => true;
  editor.maybeRestoreView = () => {};
  // The countdown's timers, run by hand.
  editor.timer = (fn) => { ticks.push(fn); return ticks.length; };
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  const click = (act, data = {}) => editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...data }, disabled: false } : null) }, preventDefault() {} });
  const tick = () => { const fn = ticks.shift(); if (fn) fn(); };
  return { editor, props, asks, stopped, click, tick, lines: () => editor.lines(), html: () => { editor.lastHtml = null; return editor.editorHtml(); } };
}

function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('an @discover question is Discover\'s alone (2026-10-14): one ask, no box and no Chat reply; the box the window puts under its reply is asked by the editor', async () => {
  const { threads } = await doc();
  const m = mounted(['Notes', '@discover how do tutors notice struggle?', '', 'After']);
  m.editor.askInline(1);
  const ls = m.lines();
  assert.match(ls[1], /^bart# \[discover [\dTZ:-]+\] $/, 'its title line, the conversation Discover\'s');
  assert.equal(ls[2], '@discover how do tutors notice struggle?');
  assert.match(ls[3], /^bart~> /);
  assert.deepEqual(ls.slice(4), ['', 'After']);
  assert.ok(!ls.some((l) => l.includes('--research')), 'no box until Discover settles the direction');
  assert.equal(m.asks.length, 1);
  assert.deepEqual([m.asks[0].agent, m.asks[0].intro, m.asks[0].research, m.asks[0].name, m.asks[0].text], ['discover', undefined, undefined, true, 'how do tutors notice struggle?']);
  // The reply came back with a direction: the window places it, the box line and its pending line in one change.
  assert.equal(m.editor.askBoxed('box-1'), false, 'not in the document yet: the window tries again');
  m.props.text = [...ls.slice(0, 3), ...answer('I will look for how tutors notice a student is stuck. The reading guide will appear below.'), '@discover --research how tutors notice a student is stuck', 'bart~> box-1', '', 'After'].join('\n');
  assert.equal(m.editor.askBoxed('box-1'), true);
  const box = m.lines().indexOf('@discover --research how tutors notice a student is stuck');
  assert.equal(m.asks.length, 2);
  const search = m.asks[1];
  assert.deepEqual([search.agent, search.research, search.askId, search.text, search.place], ['discover', true, 'box-1', '--research how tutors notice a student is stuck', { line: box, text: m.lines()[box] }]);
  assert.deepEqual(search.turns.map((t) => t.question), ['how do tutors notice struggle?'], 'the conversation that reached it');
  const [thread] = threads(m.lines());
  assert.deepEqual(thread.turns.map((t) => t.q), [2, box], 'one conversation: the reply, then the box');
});

test('askBoxed asks only a research box\'s pending line; a bare or flags-only @discover line asks Discover once', () => {
  const flags = mounted(['@discover --deep', '']);
  flags.editor.askInline(0);
  assert.deepEqual([flags.asks.length, flags.asks[0].agent, flags.asks[0].research], [1, 'discover', undefined]);
  assert.ok(!flags.lines().some((l) => l.includes('--research')));
  const bare = mounted(['@discover', '']);
  bare.editor.askInline(0);
  assert.deepEqual([bare.asks.length, bare.asks[0].agent, bare.asks[0].text], [1, 'discover', '']);
  const plain = mounted(['@discover tutors', 'bart~> run-1', '']);
  assert.equal(plain.editor.askBoxed('run-1'), false, 'a pending line under a question is no box');
  assert.equal(plain.editor.askBoxed('gone'), false);
  assert.equal(plain.asks.length, 0);
});

test('drawn: the box stands in the card of the reply that asked for it (2026-10-16, David): "Research · Standard" on top, its own Collapse at its top right (2026-10-16, David: the word, not an icon on its foot)', () => {
  const lines = ['bart# [discover 2026-10-13T10:00:00Z] Tutors', '@discover how do tutors notice struggle?', ...answer('Looking for work on noticing struggle.'),
    '@discover --research how do tutors notice struggle?', 'bart> ## Start here', ...answer('A guide.').slice(0, 1).map(() => 'bart> **A paper**'), 'bart>', 'bart> *Discover · Opus · high · 2 s*', ''];
  const m = mounted(lines);
  const html = m.html(), box = lines.indexOf('@discover --research how do tutors notice struggle?');
  const replyFoot = html.slice(html.indexOf('data-foot="1"'));
  assert.match(replyFoot.slice(0, replyFoot.indexOf('>')), /border-radius:0 0 0 0;margin-bottom:0/, 'the reply\'s card goes on into the box');
  const head = rowOf(html, box);
  assert.match(head, /^<div[^>]*data-research="\d+"[^>]*border-radius:0 0 0 0/, 'the box starts no card of its own');
  assert.match(head, /contenteditable="false"/, 'its line is never edited in place');
  assert.match(head, />Research<\/span><span[^>]*> · <\/span><span data-chip="\d+"[^>]*><span class="bart-level" data-act="pick"[^>]*>Standard<span[^>]*><svg[^]*?<\/svg><\/span><\/span><\/span><span[^>]*margin:-4px -6px -4px auto[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="\d+" aria-expanded="true" aria-label="Collapse" title="Collapse"><svg[^]*?<\/svg><\/button><\/span><\/div>/, 'the box collapses alone, from its top right, a chevron');
  assert.ok(!head.replace(/ data-raw="[^"]*"/, '').includes('how do tutors'), 'the first box does not repeat the question above it');
  assert.match(head, /data-box-status="finished"[^>]*>.*Finished in 2 s · Opus high<\/span><button type="button" class="bart-reply" data-act="restartresearch" data-row="\d+"[^>]*>Run again<\/button>/, 'under it its status row (2026-10-16, David\'s mockup): how long, the model, Run again');
  const foot = html.slice(html.indexOf(`data-foot="${box}"`));
  assert.ok(!foot.slice(0, foot.indexOf('</div>')).includes('data-act="fold"'), 'nothing to collapse on the box\'s foot');
  assert.ok(!replyFoot.slice(0, replyFoot.indexOf('</div>')).includes('data-act="fold"'), 'the reply\'s Collapse is not on its foot (2026-10-15)');
  assert.match(rowOf(html, 1), /data-corner="1"[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse conversation" title="Collapse conversation"><svg/, 'but in its question\'s corner, collapsing the conversation (2026-10-15)');
  // Collapsed, the box keeps its head and foot, on no grey.
  m.click('fold', { turn: String(box) });
  assert.match(rowOf(m.html(), box), /background:none/);
  assert.ok(!rowOf(m.html(), box).includes('data-box-status'), 'folded: no status row');
  assert.match(rowOf(m.html(), box), /data-act="fold"[^>]*aria-expanded="false" aria-label="Expand" title="Expand"><svg[^>]*><path d="m9 18 6-6-6-6"><\/path><\/svg><\/button>/, 'Expand where Collapse was: the chevron points right');
  assert.ok(!m.html().replace(/ data-raw="[^"]*"/g, '').includes('A paper'));
});

test('a research box that is its titled conversation\'s first exchange: its Collapse collapses the conversation, a double chevron named Collapse conversation (2026-10-16, David)', () => {
  const lines = ['bart# [discover 2026-10-13T10:00:00Z] Tutors', '@discover --research how do tutors notice struggle?', 'bart> ## Start here', 'bart> **A paper**', 'bart>', 'bart> *Discover · Opus · high · 2 s*', ''];
  const m = mounted(lines);
  assert.match(rowOf(m.html(), 1), /data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse conversation" title="Collapse conversation"><svg[^>]*><path d="m17 11-5-5-5 5"><\/path><path d="m17 18-5-5-5 5"><\/path><\/svg>/);
  m.click('fold', { turn: '1' });
  assert.match(m.lines()[0], /^bart#\+ /, 'the conversation collapses');
  assert.deepEqual(m.lines().slice(1), lines.slice(1), 'the box\'s lines as they were');
});

test('a Deep box waits five seconds, "Searching in 5 s" with Cancel; Cancel takes the box out and nothing is searched', () => {
  const doc = ['@discover --deep tutors noticing struggle', ...answer('I will look for how tutors notice struggle.'), '@discover --research tutors noticing struggle', 'bart~> box-1', ''];
  const m = mounted(doc);
  assert.equal(m.editor.askBoxed('box-1'), true);
  assert.equal(m.asks.length, 0, 'the search waits: the conversation is --deep');
  const at = m.lines().indexOf('bart~> box-1');
  assert.match(rowOf(m.html(), at), /Searching in 5 s[\s\S]*data-act="cancelwait"/);
  m.tick(); m.tick();
  assert.match(rowOf(m.html(), at), /Searching in 3 s/);
  m.click('cancelwait', { ask: 'box-1' });
  assert.ok(!m.lines().some((l) => l.includes('--research') || l.includes('box-1')), 'the box is gone');
  assert.equal(m.asks.length, 0);
  // Left alone, it is asked when the count runs out.
  const w = mounted(doc);
  w.editor.askBoxed('box-1');
  for (let k = 0; k < 5; k++) w.tick();
  assert.deepEqual([w.asks.length, w.asks[0].agent, w.asks[0].research], [1, 'discover', true]);
  // The person goes to another workspace while it counts (2026-10-16): it is still asked, of the document it is in.
  const gone = [], away = [];
  const o = mounted(doc, { docTextOf: (key) => (key === 'k' ? o.props.text : 'another workspace'), onRouteGone: (id) => gone.push(id) });
  o.editor.askBoxed('box-1');
  o.editor.props = { ...o.props, docKey: 'other', text: 'another workspace', onAsk: (a) => away.push(a) };
  for (let k = 0; k < 5; k++) o.tick();
  assert.deepEqual([o.asks.length, o.asks[0] && o.asks[0].askId, away.length, gone.length], [1, 'box-1', 0, 0]);
  // A standard one is asked at once.
  const now = mounted(['@discover tutors', ...answer('Looking.'), '@discover --research tutors', 'bart~> box-2', '']);
  now.editor.askBoxed('box-2');
  assert.deepEqual([now.asks.length, now.asks[0].research], [1, true]);
});

test('a reply Bart sends to Discover while a search runs stops it, its box saying so, and goes to Discover, which settles the new direction', async () => {
  const head = 'bart# [discover 2026-10-13T10:00:00Z] Tutors';
  const lines = [head, '@discover tutors noticing struggle', ...answer('Looking.'), '@discover --research tutors noticing struggle', 'bart~> run-1', ''];
  const m = mounted(lines, { onRoute: async () => ({ id: 'r', agent: 'discover', sure: 0.9, by: 'model' }) });
  // The box is still running, so its conversation has no follow-up field yet: a reply typed under it asks the same way.
  const at = m.lines().length - 1;
  m.props.text = [...m.lines().slice(0, at), '@bart only K-12'].join('\n');
  m.editor.askInline(at);
  await settled();
  const ls = m.lines();
  assert.deepEqual(m.stopped, ['run-1']);
  assert.equal(ls[ls.indexOf('@discover --research tutors noticing struggle') + 1], 'bart> Stopped: refined below.');
  assert.equal(ls[at], '@bart only K-12');
  assert.match(ls[at + 1], /^bart~> /);
  assert.ok(!ls.slice(at).some((l) => l.includes('--research')), 'no box of its own: Discover settles it');
  assert.deepEqual(m.asks.map((a) => [a.agent, !!a.intro, !!a.research, a.text]), [['discover', false, false, 'only K-12']]);
  const { threads } = await doc();
  assert.equal(threads(ls).length, 1, 'still one conversation');
});

test('a reply streaming in hides Discover\'s <research> line, whole or half-arrived; Chat\'s is drawn as written', () => {
  const m = mounted(['@discover tutors', 'bart~> s1', ''], { asks: { s1: { agent: 'discover', lines: ['I will look for how tutors notice struggle.', '', '<research>how tutors notice'] } } });
  const row = rowOf(m.html(), 1);
  assert.ok(row.includes('how tutors notice struggle.') && !row.includes('&lt;research') && !row.includes('<research'), 'the tag is not drawn');
  const half = mounted(['@discover tutors', 'bart~> s2', ''], { asks: { s2: { agent: 'discover', lines: ['Looking.', '<res'] } } });
  assert.ok(!rowOf(half.html(), 1).includes('&lt;res'));
  const chat = mounted(['@chat x', 'bart~> s3', ''], { asks: { s3: { agent: 'bart', lines: ['<research>is Chat\'s to say</research>'] } } });
  assert.ok(rowOf(chat.html(), 1).includes('&lt;research&gt;'), 'only Discover\'s');
});

test('a question in a paragraph of its own: Discover\'s blank line is drawn as Brainstorm\'s is, a gap between the two rows', () => {
  const said = 'This workspace is about Bart\'s voice.\n\nWhat would you like to research?';
  const rows = (agent, token) => {
    const m = mounted([`@${token}`, ...answer(said, agent), '']);
    return [rowOf(m.html(), 1), rowOf(m.html(), 2), rowOf(m.html(), 3)].map((row) => row.replace(/ data-[a-z-]+="[^"]*"/g, ''));
  };
  const discover = rows('discover', 'discover'), brainstorm = rows('brainstorm', 'brainstorm');
  assert.ok(discover[0].includes('Bart’s voice') || discover[0].includes('Bart&#39;s voice') || discover[0].includes("Bart's voice"), 'the sentence');
  assert.ok(!/What would you like/.test(discover[1]), 'the blank line is a row of its own');
  assert.ok(discover[2].includes('What would you like to research?'), 'the question after it');
  assert.deepEqual(discover, brainstorm, 'drawn alike');
});

test('Discover\'s card (2026-10-14, the mock): bordered rows with a radio, a pick waits for Submit, its own field in the card and none under it', () => {
  const CARD = JSON.stringify({ say: '', card: 'focus', focus: { title: 'What would you like to research?', options: [{ label: 'Concise replies', why: 'front-loaded answers' }, { label: 'Listening', why: 'reacting first' }, { label: 'Judging replies' }] }, ready: false });
  const body = replyLines(replyBody('discover', CARD), { level: { name: 'Opus', effort: 'high' }, trail: [], ms: 1000 }, { model: true, agent: 'discover' });
  const m = mounted(['@discover', ...body, '']);
  let html = m.html();
  assert.equal((html.match(/class="dv-opt"/g) || []).length, 3);
  assert.match(html, /<span class="dv-label">Concise replies<\/span><span class="dv-why">front-loaded answers<\/span>/, 'the reason under the label');
  assert.ok(html.includes('placeholder="Or say it in your own words…"') && html.includes('class="dv-submit"'), 'its own field and Submit');
  assert.ok(!html.includes('data-followup='), 'no @bart field under the card');
  // Its reply opened (the answer just came in, 2026-10-15): still none under it; the field to focus is the card's own.
  m.editor.replyOpen.add(0);
  assert.ok(!m.html().includes('data-followup='), 'none under it with the reply opened');
  m.editor.replyOpen.delete(0);
  m.click('cardopt', { turn: '0', opt: '1' });
  assert.equal(m.asks.length, 0, 'a pick is not sent');
  html = m.html();
  assert.match(html, /class="dv-opt"[^>]*aria-checked="true"><span aria-hidden="true" class="dv-radio"><\/span><span[^>]*><span class="dv-label">Listening/);
  assert.match(html, /class="dv-submit"[^>]*style="background:#0070f3/, 'Submit blue once something is picked');
  m.click('sendfollow', { thread: '0' });
  assert.equal(m.asks.length, 1);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text], ['discover', 'picked "Listening"']);
  // Answered, it is drawn still, the pick in blue, no field: a Discover card never collapses by itself (2026-10-15, David).
  const done = m.html();
  assert.ok(!done.includes('class="dv-submit"'));
  assert.match(done, /<button type="button" class="dv-opt" disabled role="checkbox" aria-checked="true">/);
  assert.ok(!m.lines().some((line) => line.startsWith('bart+>')), 'nothing collapsed');
});

test('a pick sent from Discover\'s card (2026-10-15, David): the question Discover asks back opens its reply field with the keyboard in it; a reply that starts the search opens none', () => {
  const CARD = JSON.stringify({ say: '', card: 'focus', focus: { title: 'What would you like to research?', options: [{ label: 'Concise replies' }, { label: 'Listening' }] }, ready: false });
  const body = replyLines(replyBody('discover', CARD), { level: { name: 'Opus', effort: 'high' }, trail: [], ms: 1000 }, { model: true, agent: 'discover' });
  const run = (reply, box = false) => {
    const m = mounted(['@discover', ...body, '']);
    const input = { focused: 0, focus() { input.focused += 1; } };
    m.editor.edRef.current.querySelector = (sel) => (/data-follow-input/.test(sel) ? input : null);
    m.click('cardopt', { turn: '0', opt: '1' });
    m.click('sendfollow', { thread: '0' });
    const pending = m.lines().findIndex((l) => l.startsWith('bart~> '));
    m.editor.replyArrived();
    assert.ok(m.editor.replyWait, 'waiting while Discover answers');
    const answered = answer(reply).join('\n') + (box ? '\n@discover --research listening\nbart~> run-box' : '');
    m.props.text = m.lines().map((l, j) => (j === pending ? answered : l)).join('\n');
    m.editor.replyArrived();
    return { m, input };
  };
  const asked = run('What do you want the reading to help you decide?');
  assert.equal(asked.input.focused, 1, 'its question: the reply field takes the keyboard');
  assert.match(asked.m.html(), /data-follow-input="\d+"/);
  assert.equal(asked.m.editor.replyWait, null);
  const searching = run('I will look for work on listening. The reading guide will appear below.', true);
  assert.equal(searching.input.focused, 0, 'the search has started: no field');
  // A reply sent from that field waits for the next question the same way.
  const m = asked.m;
  m.editor.followText.set(0, 'pick one for me');
  m.click('sendfollow', { thread: '0' });
  assert.ok(m.editor.replyWait, 'the next answer opens it again');
  assert.ok(!m.lines().some((line) => line.startsWith('bart+>')), 'a reply in a Discover conversation collapses nothing');
});

test('main: a search is a box\'s turn alone; the <research> line is taken out of a reply and handed back, never on a search; --research is never part of a question', () => {
  const context = { head: '<engelbart>', contextJson: '', mentionedFiles: '', documents: '', now: '' };
  assert.equal(ask.DISCOVER_INTRO, undefined);
  assert.ok(!ask.firstMessage({ context, prior: [], question: 'tutors', resumed: false })('').includes('discover_intro'));
  assert.deepEqual([ask.isSearch('--research tutors'), ask.isSearch('--deep --research'), ask.isSearch('research tutors'), ask.isSearch('--researcher')], [true, true, false, false]);
  assert.equal(ask.withoutResearch('--research --deep tutors'), '--deep tutors');
  const plan = ask.turnPlan({ agent: 'discover', text: '--research --deep tutors', turns: [{ question: '--research tutors', answer: 'A guide.' }] }, MODELS);
  assert.deepEqual([plan.question, plan.mode, plan.prior[0].question, plan.search], ['tutors', 'deep', 'tutors', true]);
  assert.ok(plan.extra.startsWith('<mode>deep.') && plan.extra.endsWith('<search>The direction is settled: search on the one in <question> now, and reply with the reading guide.</search>'));
  const talk = ask.turnPlan({ agent: 'discover', text: 'tutors', turns: [] }, MODELS);
  assert.deepEqual([talk.search, talk.extra, ask.turnPlan({ agent: 'discover', text: '', turns: [] }, MODELS).asked], [false, '', 'Start from this workspace.']);
  // The tag: taken out wherever it is, the last one's direction on one line; none, or an empty one, hands back nothing.
  assert.deepEqual(ask.takeResearch('I will look for X and Y. The reading guide will appear below.\n\n<research>X and\n  Y in classrooms</research>\n'), { text: 'I will look for X and Y. The reading guide will appear below.', research: 'X and Y in classrooms' });
  assert.deepEqual(ask.takeResearch('What would you like to research?'), { text: 'What would you like to research?', research: null });
  assert.deepEqual(ask.takeResearch('Ok.\n<research>  </research>'), { text: 'Ok.', research: null });
  assert.deepEqual(ask.takeResearch('<research>a</research> then <research>b</research>'), { text: ' then', research: 'b' });
  assert.equal(ask.takeResearch(null).research, null);
});

test('an @discover run\'s steps, opened, are drawn by part of the trace (2026-10-15): a check on a part done, a ring on the one going, the step waiting darker; its count the lines shown; the row names the step by title', () => {
  const { askProgressed, traceHtml } = load('DocEditor.jsx');
  const trace = { groups: [
    { key: 'start', title: 'Starting papers', lines: [{ text: 'Found “How Do AI Agents Do Human Work?” in your library', now: false }, { text: 'Searched for papers close to your problem', now: false }] },
    { key: 'cited', title: 'Newer papers that cite them', lines: [{ text: 'Finding newer papers that cite “Creating General User Models”', now: true }] },
  ], latest: 'cited', now: 'Finding newer papers that cite “Creating General User Models”', last: 'Finding newer papers that cite “Creating General User Models”' };
  let ask = askProgressed({ agent: 'discover', activity: '', log: [] }, { activity: 'Reading what cites “W4410263957”', log: true });
  ask = askProgressed(ask, { trace });
  const m = mounted(['Notes', '@discover is there anyone else that has done this?', 'bart~> run-1'], { asks: { 'run-1': ask } });
  let row = rowOf(m.html(), 2);
  assert.match(row, /Finding newer papers that cite “Creating General User Models”/, 'the row: the waiting step by its title, not its id');
  assert.ok(!row.includes('W4410263957'));
  assert.match(row, />3 steps</, 'the lines the trace shows');
  assert.ok(!row.includes('data-trace-group'), 'shut until clicked');
  m.editor.openLogs.add('run-1');
  row = rowOf(m.html(), 2);
  assert.deepEqual([...row.matchAll(/data-trace-group="(\w+)" data-going="(\w+)"/g)].map((g) => [g[1], g[2]]), [['start', 'false'], ['cited', 'true']]);
  assert.match(row, /color:#171717">Finding newer papers/, 'the step waiting, darker');
  assert.match(row, /color:#8f8f8f">Searched for papers close to your problem/);
  // Writing: every part done. Between steps, the newest one named; thinking, "Thinking".
  assert.ok(!/data-going="true"/.test(traceHtml(trace, { writing: true })));
  const between = { ...trace, now: null, last: 'Found 9 newer papers that cite “X”' };
  const m2 = mounted(['Notes', '@discover q', 'bart~> run-2'], { asks: { 'run-2': { ...ask, trace: between } } });
  assert.match(rowOf(m2.html(), 2), /Found 9 newer papers that cite “X”/);
  const m3 = mounted(['Notes', '@discover q', 'bart~> run-3'], { asks: { 'run-3': { ...ask, activity: 'Thinking', trace: between } } });
  assert.match(rowOf(m3.html(), 2), /class="t"[^>]*>Thinking/);
  // A new step starts over.
  assert.equal(askProgressed(ask, { step: 2, name: 'Fable', effort: 'xhigh' }).trace, null);
});

/* ---------------------------------------------------------------------------- Refine (2026-10-15, David) */
// The reply that said what Discover will look for has Refine where Reply stands. It opens the conversation's field under
// that reply; what is sent is `@discover --refine <words>`: a running search stops, the runs before stay collapsed, and
// the direction Discover settles from it waits in a research box until Start research or Restart research.
const BRIEF = 'when shorter replies help understanding and when they leave too much out';
const conversation = (box) => [
  '@discover --deep concise replies',
  ...answer('What are you hoping to understand about concise replies?'),
  '@discover when being brief starts hurting understanding',
  ...answer(`I'll look for research on ${BRIEF}.`),
  `@discover --research ${BRIEF}`,
  ...box,
  '',
];
const RUNNING = ['bart~> run1'];
const DONE = answer('## Start here\n\n**[A paper](https://example.org/a)** · A. Author · 2024\n**Read:** abstract only\n**Why:** a measurement.');
const footOf = (html, q) => { const at = html.indexOf(`data-foot="${q}"`); return at < 0 ? '' : html.slice(at, html.indexOf('</div>', html.indexOf('data-act="dropturn"', at))); };

test('no Refine button (2026-10-16, David\'s mockup: the plan is adjusted by replying): running or done, the reply line under the box (running too since 2026-10-16, David)', () => {
  for (const [box, extra] of [[RUNNING, { asks: { run1: { agent: 'discover' } } }], [DONE, {}]]) {
    const m = mounted(conversation(box), extra), html = m.html();
    assert.ok(!html.includes('data-act="refine"'), 'no Refine');
    assert.ok(html.includes('data-followup="0"'), 'its reply line');
    assert.ok(html.indexOf('data-research=') < html.indexOf('data-followup="0"'), 'under the box');
  }
});

test('a reply under a running search adjusts it rather than starting it over (2026-10-16, David): its words go on the box\'s line, drawn under its head, and the run goes on from the stopped one', () => {
  const m = mounted(conversation(RUNNING), { asks: { run1: { agent: 'discover' } } });
  m.editor.followText.set(0, 'only studies with  people');
  m.editor.sendFollow(0);
  const ls = m.lines(), box = ls.indexOf(`@discover --research ${BRIEF} --steer only studies with people`);
  assert.ok(box > 0, 'the words on the box\'s line, on one line');
  assert.match(ls[box + 1], /^bart~> /, 'a pending line goes on under it');
  assert.notEqual(ls[box + 1], 'bart~> run1', 'the run that goes on, not the stopped one');
  assert.equal(m.asks.length, 1, 'asked at once, with no Deep countdown');
  assert.deepEqual([m.asks[0].agent, m.asks[0].research, m.asks[0].steer], ['discover', true, { after: 'run1', words: 'only studies with people' }]);
  assert.equal(m.asks[0].askId, ls[box + 1].slice(7));
  assert.ok(!ls.some((l) => /^@discover --refine/.test(l)), 'no Refine turn: the search is not started over');
  m.props.asks = { [m.asks[0].askId]: { agent: 'discover' } };
  assert.match(rowOf(m.html(), box), /data-steer[^>]*><span[^>]*>Added:<\/span><span[^>]*>only studies with people<\/span>/, 'what was added, under the head');
  assert.ok(!/· [^<]*--steer/.test(rowOf(m.html(), box)), 'not as flags');
});

test('under a box not started, or one the app closed on, the reply line adjusts the plan: it is sent as a Refine (2026-10-16, David\'s mockup)', () => {
  for (const box of [[], ['bart~> gone-1']]) {
    const m = mounted(conversation(box)), html = m.html();
    assert.match(html, /data-followup="0"/, 'the reply line, under the box');
    m.editor.followText.set(0, 'only studies with people');
    m.editor.sendFollow(0);
    const ls = m.lines();
    assert.ok(!ls.includes(`@discover --research ${BRIEF}`) && !ls.includes('bart~> gone-1'), 'the box it adjusts goes');
    assert.ok(ls.includes('@discover --refine only studies with people'));
    assert.deepEqual([m.asks[0].agent, m.asks[0].refine], ['discover', true]);
    assert.deepEqual(m.stopped, [], 'a run the app closed on is not stopped: there is none');
  }
});

test('a refinement sent while the search runs stops it, takes its empty box out (2026-10-15, David), and asks Discover; output the stopped run still sends finds no place', async () => {
  const { placeAnswer } = await doc();
  const m = mounted(conversation(RUNNING), { asks: { run1: { agent: 'discover' } } });
  m.click('refine', { thread: '0' });
  m.editor.followText.set(0, 'Focus on what makes replies feel conversational, rather than their length');
  m.editor.sendFollow(0);
  assert.deepEqual(m.stopped, ['run1'], 'the running search stops when the refinement is sent');
  const ls = m.lines(), said = ls.indexOf(`bart> I'll look for research on ${BRIEF}.`);
  assert.ok(!ls.includes(`@discover --research ${BRIEF}`) && !ls.some((line) => /Stopped: refined below/.test(line)), 'the stopped box is gone');
  assert.ok(!ls.some((line) => line.startsWith('bart+>')), 'nothing collapsed');
  const refined = ls.indexOf('@discover --refine Focus on what makes replies feel conversational, rather than their length');
  assert.ok(refined > said, 'the refinement, the next turn after the reply that said the direction');
  assert.match(ls[refined + 1], /^bart~> /);
  const [asked] = m.asks;
  assert.deepEqual([asked.agent, asked.refine, asked.text], ['discover', true, '--refine Focus on what makes replies feel conversational, rather than their length']);
  assert.deepEqual(asked.turns.map((turn) => turn.question), ['--deep concise replies', 'when being brief starts hurting understanding'], 'the whole conversation, not the latest reply alone (the stopped box is no part of it)');
  assert.equal(placeAnswer(m.props.text, 'run1', ['bart> ## Start here', 'bart> late']), null, 'the stopped run\'s answer finds no pending line');
  assert.ok(!m.props.text.includes('bart> late'));
});

test('the refined direction waits in its box, Not started with Start research on its status row and no Refine (2026-10-16, David\'s mockup); it runs at the same depth', async () => {
  const { placeAnswer, researchLine } = await doc();
  const m = mounted(conversation(DONE));
  m.click('refine', { thread: '0' });
  m.editor.followText.set(0, 'Focus on what makes replies feel conversational');
  m.editor.sendFollow(0);
  assert.deepEqual(m.stopped, [], 'a finished search has nothing to stop');
  assert.ok(m.lines().some((line) => /^bart> ## Start here/.test(line)) && !m.lines().some((line) => line.startsWith('bart+>')), 'the finished guide stays in the document, open: nothing collapsed (2026-10-15)');
  // What the window places for a Refine turn (Workspace askBart, `refine`): the reply, then the box with no search under it.
  const id = m.lines().find((line) => line.startsWith('bart~> ')).slice(7);
  m.props.text = placeAnswer(m.props.text, id, [...answer("I'll now look for research on what makes replies feel conversational."), researchLine('what makes replies feel conversational')]);
  let html = m.html();
  const waiting = m.lines().indexOf('@discover --research what makes replies feel conversational');
  assert.match(rowOf(html, waiting), /data-box-status="ready"[^>]*>.*>Not started · [^<]+<\/span><button type="button" class="bart-go" data-act="startresearch" data-row="\d+"[^>]*><svg[^]*?<\/svg>Start research<\/button>/, 'Not started, then Start research');
  assert.match(rowOf(html, waiting), /Research<\/span>.*Deep/, 'at the depth the conversation runs at');
  assert.ok(!html.includes('data-act="refine"'), 'no Refine: replying adjusts the plan');
  assert.doesNotMatch(footOf(html, m.lines().indexOf('@discover --refine Focus on what makes replies feel conversational')), /data-act="refine"/, 'none on the reply above the box');
  assert.match(rowOf(html, waiting), /class="bart-level" data-act="pick" data-row="\d+"[^>]*>Deep/, 'the depth, a picker while the box waits');
  assert.equal(m.asks.length, 1, 'nothing searched until it is started');
  // Restart: the box is asked as any research box, Deep's five seconds first.
  m.click('startresearch', { row: String(waiting) });
  const pending = m.lines()[waiting + 1];
  assert.match(pending, /^bart~> /);
  const held = m.editor.waits.get(pending.slice(7));
  assert.ok(held && held.ask.research && held.ask.agent === 'discover', 'a Deep search, counting down');
  assert.equal(held.ask.text, '--research what makes replies feel conversational');
  html = m.html();
  assert.ok(!html.includes('data-act="startresearch"'), 'started: no button');
});

test('a waiting box with no run before it says Start research; reloaded, the direction, its button and the runs before are all still there', async () => {
  const fresh = mounted(['@discover concise replies', ...answer("I'll look for research on concise replies."), '@discover --research concise replies', '']);
  assert.match(fresh.html(), /data-act="startresearch"[^>]*><svg[^]*?<\/svg>Start research<\/button>/);
  // The document a Refine left, opened again.
  const m = mounted(conversation(DONE));
  m.click('refine', { thread: '0' }); m.editor.followText.set(0, 'only studies with people'); m.editor.sendFollow(0);
  const { placeAnswer, researchLine } = await doc();
  const id = m.lines().find((line) => line.startsWith('bart~> ')).slice(7);
  const saved = placeAnswer(m.props.text, id, [...answer("I'll now look for studies with people."), researchLine(`${BRIEF}, in studies with people`)]);
  const again = mounted(saved.split('\n'));
  const html = again.html();
  assert.match(html, /data-act="startresearch"[^>]*><svg[^]*?<\/svg>Start research<\/button>/);
  assert.ok(saved.includes(`@discover --research ${BRIEF}, in studies with people`), 'the direction, in the file');
  assert.ok(saved.split('\n').some((line) => /^bart> ## Start here/.test(line)), 'the earlier guide, open, in the file');
});

test('a second refinement replaces a direction still waiting; an answer to Discover\'s question about a refinement stays a Refine turn', async () => {
  const { placeAnswer, researchLine } = await doc();
  const m = mounted(conversation(DONE));
  m.click('refine', { thread: '0' }); m.editor.followText.set(0, 'something else'); m.editor.sendFollow(0);
  let id = m.lines().find((line) => line.startsWith('bart~> ')).slice(7);
  // Unclear: Discover asks; the answer goes to Discover, as part of the Refine, and its direction will wait too.
  m.props.text = placeAnswer(m.props.text, id, answer('What should the search look at instead?'));
  m.editor.followText.set(0, 'the turn-taking'); m.editor.sendFollow(0);
  const answered = m.asks[1];
  assert.deepEqual([answered.agent, answered.refine, answered.text], ['discover', true, 'the turn-taking']);
  id = answered.askId;
  m.props.text = placeAnswer(m.props.text, id, [...answer("I'll now look at turn-taking."), researchLine('turn-taking in conversational replies')]);
  assert.equal(m.lines().filter((line) => line === '@discover --research turn-taking in conversational replies').length, 1);
  // Refined again before it was started: that direction goes, the new one will take its place.
  m.click('refine', { thread: '0' }); m.editor.followText.set(0, 'only in voice assistants'); m.editor.sendFollow(0);
  assert.ok(!m.lines().includes('@discover --research turn-taking in conversational replies'), 'the waiting direction is replaced');
  assert.equal(m.asks[2].refine, true);
});

/* ------------------------------------------------- The research card, every state (2026-10-16, David's mockup) */
// The box's two rows: "Research · Standard" on top, then its status row, the state and its one action on the right.
const STATE_DOCS = {
  ready: [],
  running: ['bart~> run1'],
  interrupted: ['bart~> gone-1'],
  stopped: ['bart> Stopped.'],
  failed: ['bart> **No answer.** The connection to the model dropped.'],
  finished: DONE,
};
const stateOf = (name) => mounted(conversation(STATE_DOCS[name]), name === 'running' ? { asks: { run1: { agent: 'discover', activity: 'Searching' } } } : {});
const boxAt = (m) => m.lines().indexOf(`@discover --research ${BRIEF}`);

test('each state\'s status row: what it says and its action; running, the pending row is the status row', () => {
  const want = {
    ready: [/>Not started · [^<]+</, /class="bart-go" data-act="startresearch"[^>]*><svg[^]*?<\/svg>Start research</],
    stopped: [/>Stopped · [^<]+</, /class="bart-go" data-act="restartresearch"[^>]*><svg[^]*?<\/svg>Restart</],
    interrupted: [/>Interrupted: the app closed before it finished</, /data-act="restartresearch"[^>]*><svg[^]*?<\/svg>Restart</],
    failed: [/>Interrupted: The connection to the model dropped\.</, /data-act="restartresearch"[^>]*><svg[^]*?<\/svg>Restart</],
    finished: [/>Finished in 3 s · Sonnet high</, /class="bart-reply" data-act="restartresearch"[^>]*>Run again</],
  };
  for (const [name, [said, action]] of Object.entries(want)) {
    const m = stateOf(name), row = rowOf(m.html(), boxAt(m));
    assert.match(row, new RegExp(`data-box-state="${name}"`), name);
    assert.match(row, said, `${name}: what it says`);
    assert.match(row, action, `${name}: its action`);
    assert.match(row, /class="bart-level" data-act="pick"/, `${name}: the level can be picked`);
  }
  const running = stateOf('running'), html = running.html(), row = rowOf(html, boxAt(running));
  assert.ok(!row.includes('data-box-status'), 'running: no status row of its own');
  assert.match(row, /class="bart-level" data-act="pick"/, 'running: the level can be picked too (2026-10-16, David): the search goes on at it');
  assert.match(rowOf(html, boxAt(running) + 1), /data-pending="run1"[\s\S]*data-act="stopask"[^>]*>Stop</, 'its pending row, with Stop');
  assert.ok(html.includes('data-followup="0"'), 'a reply line while it runs too (2026-10-16, David): it adjusts the search (steerResearch)');
});

test('cut short, what the run left is not drawn: the status row says it; the reply line is under the box', () => {
  for (const name of ['interrupted', 'stopped', 'failed']) {
    const m = stateOf(name), html = m.html(), shown = html.replace(/ data-raw="[^"]*"/g, '');
    assert.ok(!/>Stopped\.<|No answer came back|>Hide</.test(shown), `${name}: not the line it left`);
    assert.ok(!html.includes(`data-foot="${boxAt(m)}"`), `${name}: no button row of its own`);
    assert.match(html, /data-followup="0"[^>]*border-radius:0 0 10px 10px/, `${name}: the reply line closes the card`);
  }
});

test('Restart and Run again run the plan again from the beginning: what the run wrote goes, a pending line takes its place, and it is searched at the level its line names', () => {
  for (const name of ['interrupted', 'stopped', 'failed', 'finished']) {
    const m = stateOf(name), box = boxAt(m);
    m.click('restartresearch', { row: String(box) });
    const ls = m.lines();
    assert.equal(ls[box], `@discover --research ${BRIEF}`, `${name}: the box's line stays`);
    assert.match(ls[box + 1], /^bart~> /, `${name}: its pending line`);
    assert.ok(!ls.some((line) => /Stopped\.|No answer|Start here|gone-1/.test(line)), `${name}: what it wrote is gone`);
    assert.deepEqual(ls.slice(box + 2), [''], `${name}: nothing else moved`);
    const held = m.editor.waits.get(ls[box + 1].slice(7));
    assert.ok(held && held.ask.research && held.ask.text === `--research ${BRIEF}`, `${name}: searched as the box is (Deep, counting down)`);
  }
  const running = stateOf('running');
  running.click('restartresearch', { row: String(boxAt(running)) });
  assert.ok(running.lines().includes('bart~> run1') && !running.editor.waits.size, 'running: nothing happens');
});

test('a box not running takes a level from its menu, written into its line, for its next Start, Restart or Run again', () => {
  for (const name of ['ready', 'stopped', 'finished']) {
    const m = stateOf(name), box = boxAt(m);
    m.editor.state.picker = { kind: 'line', i: box };
    m.editor.pickLevel({ mode: 'standard', provider: MODELS.provider });
    assert.match(m.lines()[box], /--standard/, `${name}: the level in its line`);
    assert.equal(m.asks.length, 0, `${name}: nothing asked`);
  }
});

test('a level picked on a running box (2026-10-16, David): the search goes on at it, as a reply under it does, its level in its line', () => {
  const m = mounted(conversation(RUNNING), { asks: { run1: { agent: 'discover' } } }), box = boxAt(m);
  assert.match(rowOf(m.html(), box), /class="bart-level" data-act="pick"/, 'its level opens the menu while it runs');
  m.editor.state.picker = { kind: 'line', i: box };
  m.editor.pickLevel({ mode: 'deep', provider: MODELS.provider });
  assert.deepEqual([m.lines()[box + 1], m.asks.length], ['bart~> run1', 0], 'the level it runs at (its conversation\'s Deep): nothing changes');
  m.editor.state.picker = { kind: 'line', i: box };
  m.editor.pickLevel({ mode: 'quick', provider: MODELS.provider });
  const ls = m.lines();
  assert.equal(ls[box], `@discover --research ${BRIEF} --quick`);
  assert.match(ls[box + 1], /^bart~> /); assert.notEqual(ls[box + 1], 'bart~> run1', 'the run that goes on');
  assert.equal(m.asks.length, 1);
  assert.deepEqual([m.asks[0].askId, m.asks[0].research, m.asks[0].steer], [ls[box + 1].slice(7), true, { after: 'run1', level: true }]);
  assert.equal(m.editor.state.picker, null, 'the menu closes');
});

test('a research box is a card of its own inside the reply\'s card (2026-10-16, David): running, its running row closes it', () => {
  const ready = mounted(conversation([]));
  assert.match(rowOf(ready.html(), boxAt(ready)), /data-box-card style="[^"]*background:#fff;border:1px solid #ebebeb;border-radius:10px"/);
  const m = mounted(conversation(RUNNING), { asks: { run1: { agent: 'discover' } } }), html = m.html();
  assert.match(rowOf(html, boxAt(m)), /data-box-card style="[^"]*border-bottom:0;border-radius:10px 10px 0 0"/, 'open at its foot');
  assert.match(html, /data-pending="run1"[^>]*>\s*<div data-box-card-end style="[^"]*border-top:0;border-radius:0 0 10px 10px"/, 'the running row its foot');
});

test('a box drawn before its run is known is drawn again whole when it is (patchPending declines): not left saying it was interrupted', () => {
  const m = mounted(conversation(['bart~> run1'])), box = boxAt(m);
  assert.match(rowOf(m.html(), box), /data-box-state="interrupted"/, 'no run known yet');
  const drawn = { dataset: { research: String(box), boxState: 'interrupted' } };
  m.editor.editorEl = () => ({ querySelectorAll: (sel) => (sel === '[data-box-state]' ? [drawn] : []) });
  m.editor.lastKey = m.editor.key();
  m.props.asks = { run1: { agent: 'discover', activity: 'Searching' } };
  assert.equal(DocEditor.prototype.patchPending.call(m.editor), false, 'its state changed: the editor is drawn again');
  drawn.dataset.boxState = 'running';
  assert.equal(DocEditor.prototype.patchPending.call(m.editor), true, 'as drawn: only its pending rows are patched');
  assert.match(rowOf(m.html(), box), /data-box-state="running"/);
});

test('interrupted and failed boxes have no dot before what they say', () => {
  for (const name of ['interrupted', 'failed']) {
    const m = stateOf(name), row = rowOf(m.html(), boxAt(m));
    assert.ok(!/border-radius:50%;background:/.test(row.split('data-box-status')[1] || ''), name);
  }
});
