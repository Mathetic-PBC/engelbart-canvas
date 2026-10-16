'use strict';

// A live @brainstorm card (src/renderer/workspace/DocEditor.jsx): since 2026-10-13 drawn as any answer is, its options a
// list of rows to click, answered in the follow-up field under it; Skip and Wrap up (round 6, which writes the answer given,
// if any, and "; (wrap up)") on its foot. @discover's own cards have no Wrap up. No card has the Send to
// Discover field under it (MATH-40 follow-up): an older recap does (MATH-31), which starts an @discover thread of its own
// on what the person typed, after the brainstorm thread. An older document's `@orient` line (2026-10-05) is asked, drawn
// and answered as @brainstorm's. An exchange's result (MATH-40) ends on a small line that sends their sentence on. There
// is no document here: the editor and its elements are stand-ins.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const card = require('../src/main/bart/card.cjs');
const { replyLines } = require('../src/main/bart/reply.cjs');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-cards-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

const editorModule = load('DocEditor.jsx'), DocEditor = editorModule.default;
// A search an older card suggested (round 6): no longer kept, nor drawn (MATH-31).
const LOOK = 'how others have handled “it stops when the lock frees”';
const TYPED = 'how tutors notice struggle';
const FREE = { say: 'You said “it stops when the lock frees”.', card: 'questions', questions: { items: [{ id: 'next-2', type: 'free', title: 'Within “Retries”, what would change your mind?' }] }, lookFor: LOOK, ready: false };
const FOCUS = { say: '', card: 'focus', focus: { title: 'Which part do you want prior work on?', options: [{ label: 'Retries' }, { label: 'Timeouts' }] }, ready: false };
// A card as the runner writes it under its line: the fenced JSON, then the foot.
const answer = (value) => replyLines(card.cardBody(JSON.stringify(value)).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });

/** An editor as mounted on `lines`, with what it asks and writes kept. */
function mounted(lines) {
  const asks = [];
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; }, onAsk: (ask) => asks.push(ask) };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  editor.forceUpdate = () => {};
  const entry = (q) => editor.cardsOf(editor.lines()).byQ.get(q);
  const html = (q) => editor.cardHtml('', entry(q));
  // A click on a button the card drew, as the editor's click listener gets it.
  const click = (act, turn) => editor.editorClick({ target: { closest: () => ({ dataset: { act, turn: String(turn) } }) }, preventDefault() {} });
  // Send to Discover: `text` typed into the field named `target`, then its Send clicked, or Enter pressed in it.
  const typeDiscover = (target, text) => editor.discoverInput(field(target, text));
  const sendDiscover = (target) => editor.editorClick({ target: { closest: () => ({ dataset: { act: 'senddiscover', target } }) }, preventDefault() {} });
  const enterDiscover = (target, more = {}) => { const e = { key: 'Enter', shiftKey: false, isComposing: false, target: field(target), prevented: false, preventDefault() { this.prevented = true; }, ...more }; editor.discoverKey(e); return e; };
  return { editor, props, asks, entry, html, click, typeDiscover, sendDiscover, enterDiscover, lines: () => props.text.split('\n') };
}

/** A Send to Discover field as the page holds it: its target, what it holds, and its Send. */
function field(target, value = '') {
  const send = { style: {} };
  return { dataset: { discoverInput: target }, value, style: {}, scrollHeight: 24, selectionStart: value.length, selectionEnd: value.length, setSelectionRange() {}, send, parentElement: { querySelector: (sel) => (sel.includes('senddiscover') ? send : null) } };
}

test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('Send to Discover after an older recap: with nothing typed it does nothing; Enter sends and Shift+Enter puts in nothing; what is typed survives a redraw and goes back into the field (MATH31-03, -05)', () => {
  const RECAP = ['@brainstorm (wrap up)', 'bart> Your question: Why do retries loop?', 'bart> *3 s*'];
  const m = mounted([...RECAP, '']);
  const before = m.lines();
  m.sendDiscover('t0');
  m.typeDiscover('t0', '   ');
  m.sendDiscover('t0');
  const enter = m.enterDiscover('t0');
  assert.deepEqual([m.asks, m.lines(), enter.prevented], [[], before, true], 'nothing typed: nothing asked, nothing written');
  const grey = field('t0', '   ');
  m.editor.discoverInput(grey);
  assert.deepEqual([grey.send.style.background, grey.send.style.color], ['#f2f2f2', '#8f8f8f'], 'spaces alone leave Send grey');

  // Typed, then the editor redrawn: the drawn field holds none of it, and restoreDiscover puts it back.
  m.typeDiscover('t0', 'how tutors\nnotice');
  assert.equal(m.editor.discoverText.get('t0'), 'how tutors notice', 'a line break becomes a space');
  m.editor.lastHtml = null;
  const page = m.editor.editorHtml();
  assert.ok(page.includes('data-discover-input="t0"') && !page.includes('how tutors notice'), 'the field is open, and what is typed is not in the HTML');
  const fresh = field('t0'), other = field('t9');
  m.editor.restoreDiscover({ querySelectorAll: (sel) => (sel === '[data-discover-input]' ? [fresh, other] : []) }, null);
  assert.deepEqual([fresh.value, fresh.send.style.background, other.value, other.send.style.background], ['how tutors notice', '#0070f3', '', '#f2f2f2'], 'back in its own field, Send blue; another field untouched');

  const shift = m.enterDiscover('t0', { shiftKey: true });
  assert.deepEqual([shift.prevented, m.asks.length], [true, 0], 'Shift+Enter: nothing put in, nothing sent');
  m.typeDiscover('t0', `${TYPED} more`);
  m.enterDiscover('t0');
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns], ['discover', `${TYPED} more`, []], 'Enter sends');
  assert.equal(m.lines()[m.lines().length - 3], `@discover ${TYPED} more`);
  assert.equal(m.editor.discoverText.get('t0'), undefined, 'and empties it');

  // A field whose thread no longer ends in the recap sends nothing.
  const done = mounted([...RECAP, '@brainstorm', 'bart~> a1', '']);
  done.typeDiscover('t0', TYPED);
  done.sendDiscover('t0');
  assert.deepEqual(done.asks, []);
});

test('an answered @discover choice can be picked again (2026-10-15, David): asked first, then what came after its answer goes and the new pick is asked, once nothing in it is at work', () => {
  const after = ['@discover picked "Retries"', ...answer(FREE), '@discover because loops', ...answer(FREE)];
  const m = mounted(['@discover', ...answer(FOCUS), ...after, '']);
  const card = m.html(0);
  assert.match(card, /<button type="button" class="dv-opt" disabled role="radio" aria-checked="true">[\s\S]*?>Retries</, 'the pick stays checked, not a button');
  assert.match(card, /<button type="button" class="dv-opt" data-act="cardrepick" data-turn="0" data-opt="1" title="[^"]+" role="radio" aria-checked="false">[\s\S]*?>Timeouts</, 'the other can be picked');
  const press = (act, opt) => m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, turn: '0', ...(opt == null ? {} : { opt: String(opt) }) } } : null) }, preventDefault() {} });
  const repick = (opt) => press('cardrepick', opt);
  const before = m.lines().join('\n');
  repick(0);
  assert.deepEqual(m.asks, [], 'the same pick asks nothing');
  assert.ok(!m.html(0).includes('data-repick-confirm'), 'and asks nothing of them');
  // Another row: asked first (2026-10-15, David: "it should ask me if i want to do that since it will restart"), nothing
  // changed until Restart from here.
  repick(1);
  assert.deepEqual(m.asks, [], 'nothing asked yet');
  assert.equal(m.lines().join('\n'), before, 'nor anything taken out');
  let asking = m.html(0);
  assert.match(asking, /data-opt="1" title="[^"]+" data-repicking="1"[^>]*>[\s\S]*?>Timeouts</, 'the row asked for, dashed');
  assert.match(asking, /<span class="dv-confirm" data-repick-confirm="0"[^>]*><span class="dv-confirm-text">Pick <b>Timeouts<\/b> instead\? Everything after this will be asked again from that pick\.<\/span>/);
  assert.match(asking, /data-act="cardrepickno" data-turn="0">Cancel<\/button><button type="button" class="dv-restart" data-act="cardrepickgo" data-turn="0" data-opt="1">Restart from here</);
  press('cardrepickno');
  assert.ok(!m.html(0).includes('data-repick-confirm') && !m.html(0).includes('data-repicking'), 'Cancel: as it was answered');
  assert.equal(m.lines().join('\n'), before);
  repick(1);
  assert.equal(m.editor.escapeShut({ key: 'Escape', preventDefault() {} }), true, 'Escape cancels it too');
  assert.ok(!m.html(0).includes('data-repick-confirm'));
  assert.equal(m.editor.shutMenus(), false, 'and is used up');
  repick(1);
  press('cardrepickgo', 1);
  const ls = m.lines(), q = 1 + answer(FOCUS).length;
  assert.equal(ls[q], '@discover picked "Timeouts"', 'the answering line says the new pick');
  assert.match(ls[q + 1], /^bart~> /, 'and is asked again');
  assert.equal(ls.length, q + 3, 'every turn after it is gone');
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['discover', 'picked "Timeouts"', 1], 'asked as a follow-up of the card');
  assert.ok(!m.html(0).includes('cardrepick') && !m.html(0).includes('data-repick-confirm'), 'while it is at work, nothing can be picked, and nothing is asked');
});

test('@discover\'s cards have no Wrap up and no Send to Discover field, and Wrap up or Send asked of one does nothing; Skip is on the foot, and the field under it answers it as @discover', async () => {
  const m = mounted(['@discover', ...answer({ ...FOCUS, lookFor: LOOK }), '']);
  assert.equal(m.entry(0).live, true);
  const shown = m.editor.editorHtml();
  // Its field is in the card since 2026-10-14 (the mock), with Submit; none under the foot.
  assert.ok(shown.includes('data-act="cardskip"') && shown.includes('data-act="cardopt"') && /<span class="dv-field"><textarea data-follow-input="0" data-agent="discover"/.test(shown) && !shown.includes('data-followup='));
  assert.ok(!shown.includes('data-act="cardwrap"') && !shown.includes('data-act="senddiscover"') && !shown.includes('data-act="opendiscover"') && !shown.includes('data-discover-input') && !shown.includes('Wrap up'));
  m.click('cardwrap', 0);
  m.typeDiscover('c0', TYPED);
  m.sendDiscover('c0');
  assert.deepEqual(m.asks, [], 'nothing asked');
  m.click('cardskip', 0);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text], ['discover', '(skipped)']);

  // An older recap's Look for line is a section, not a button; the field after the recap asks what was typed (A-02, A-04).
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  const recap = mounted(['@brainstorm (wrap up)', 'bart> Your question: Why do retries loop?', 'bart> Look for: retry loops', 'bart> *3 s*', '']);
  const ls = recap.lines(), drawn = recap.editor.lineHtml(2, ls[2], model.parseLine(ls[2]), false, false, recap.editor.layout(ls).get(2), false);
  assert.match(drawn, />Look for<\/span><span style="display:block;">retry loops<\/span>/, 'drawn as a section');
  assert.ok(!drawn.includes('<button'), 'no button');
  // Brainstorm again is shut until Reply opens it (2026-10-13); Send to Discover's row is under the foot either way.
  const shut = recap.editor.editorHtml();
  assert.ok(!shut.includes('data-followup="0"') && shut.indexOf('data-recap-discover="0"') > shut.indexOf('data-foot="0"') && shut.includes('data-act="reply" data-thread="0"'), 'Reply on the foot, then Send to Discover');
  recap.editor.replyOpen.add(0);
  const page = recap.editor.editorHtml();
  assert.ok(page.indexOf('data-recap-discover="0"') > page.indexOf('data-followup="0"') && page.indexOf('data-followup="0"') > page.indexOf('data-foot="0"'), 'a row of its own, under Brainstorm again');
  recap.typeDiscover('t0', TYPED);
  recap.sendDiscover('t0');
  assert.deepEqual([recap.asks[0].text, recap.asks[0].agent, recap.asks[0].turns], [TYPED, 'discover', []]);
  assert.deepEqual(recap.lines().slice(ls.length - 1), ['', `@discover ${TYPED}`, `bart~> ${recap.asks[0].askId}`, '']);
  assert.deepEqual(model.threads(recap.lines()).map((t) => model.agentOf(model.parseLine(recap.lines()[t.from]))), ['brainstorm', 'discover']);
});

test('on a live @brainstorm versions card the field under it reads "Or rewrite it yourself…", and the rest is as on any card; elsewhere it reads as before (round 7)', () => {
  const VERSIONS = { say: '', card: 'questions', questions: { items: [{ id: 'versions', type: 'mcq', title: 'Which one is your question?', options: [{ label: 'Why do retries loop?', why: 'as you wrote it' }, { label: 'Why specifically do retries loop?', why: 'narrower' }] }] }, lookFor: LOOK, ready: false };
  const m = mounted(['@brainstorm', ...answer(VERSIONS), '']);
  const shown = m.editor.editorHtml();
  assert.match(shown, /placeholder="Or rewrite it yourself…" aria-label="Answer"/);
  assert.ok(!shown.includes('Or say it in your own words'));
  for (const act of ['cardskip', 'cardwrap', 'cardopt']) assert.ok(shown.includes(`data-act="${act}"`), `it keeps ${act}`);
  assert.ok(!shown.includes('opendiscover'), 'and has no Send to Discover');
  // A rewrite typed with nothing picked is sent as their words.
  m.editor.followText.set(0, '  Why do retries   loop at all? ');
  m.editor.sendFollow(0);
  assert.equal(m.asks[0].text, 'Why do retries loop at all?');
  assert.match(mounted(['@brainstorm', ...answer(FOCUS), '']).editor.editorHtml(), /placeholder="Pick one, or say it in your own words…"/, '@brainstorm: as on any card');
  assert.match(mounted(['@discover', ...answer(VERSIONS), '']).editor.editorHtml(), /placeholder="Or say it in your own words…"/, '@discover: its field in the card (2026-10-14)');
  assert.match(editorModule.BRAINSTORM_ITEM.summary, /^Think something through out loud/, '2026-10-14: a conversation');
  assert.ok(!/dig into next|card/.test(editorModule.BRAINSTORM_ITEM.summary + editorModule.BRAINSTORM_ITEM.facts), 'no fixed ending, no cards');
});

/* ------------------------------------------------------------- @orient folded into @brainstorm (2026-10-05) */

const lineOf = async (m, i) => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href), ls = m.editor.lines();
  return m.editor.lineHtml(i, ls[i], model.parseLine(ls[i]), false, false, m.editor.layout(ls).get(i), m.editor.lockedAt(ls, i));
};
const KNOW = { say: '', card: 'questions', questions: { eyebrow: 'what you know', items: [{ id: 'know', type: 'open', title: 'Write what you know about “metacognition”.', subtitle: 'For a colleague.' }] }, ready: false };

test('a live @brainstorm card is drawn as an answer: what it says, then its question, on the answer\'s grey inside its rule, with no box, field or Submit on it; Skip and Wrap up are on its foot, and the follow-up field under it answers it; no Send to Discover, no search suggested (2026-10-13; MATH31-03, MATH-40)', () => {
  const { html, entry, editor, asks, typeDiscover, sendDiscover } = mounted(['Notes', '@brainstorm', ...answer(FREE), '']);
  assert.equal(entry(1).live, true);
  assert.equal(entry(1).card.lookFor, undefined, 'an older card\'s search is not kept');
  const shown = html(1);
  assert.match(shown, /^<div [^>]*data-card="1"[^>]*background:#fafafa;color:#262626;font-size:16px;line-height:1\.65"><span style="display:block;padding:2px 0 2px 14px;border-left:2px solid #d6d6d6">/, 'an answer\'s grey, rule and type');
  for (const gone of ['data-card-box', 'data-card-input', 'cardsend', 'cardskip', 'cardwrap', 'Submit', 'border:1px solid', 'font:600']) assert.ok(!shown.includes(gone), `no ${gone} on the card`);
  const said = shown.indexOf('You said “it stops when the lock frees”.');
  assert.ok(said > 0 && said < shown.indexOf('Within “Retries”'), 'its say, then the question');
  const page = editor.editorHtml(), foot = page.slice(page.indexOf('data-foot="1"'));
  assert.ok(foot.indexOf('data-act="copybart"') < foot.indexOf('data-act="cardskip"') && foot.indexOf('data-act="cardskip"') < foot.indexOf('data-act="cardwrap"'), 'Copy, Skip, Wrap up on the foot');
  assert.match(page, /data-followup="1" data-answers="1"[^>]*><div[^>]*><span[^>]*>@bart<\/span><textarea data-follow-input="1" data-agent="brainstorm" placeholder="Respond…" aria-label="Answer"/, 'the field under it answers it, always open, saying @bart (2026-10-13)');
  assert.ok(!page.includes('opendiscover') && !page.includes('data-discover-input') && !page.includes('Send to Discover'), 'no Send to Discover under a card');
  // A field it no longer draws sends nothing.
  typeDiscover('c1', TYPED);
  sendDiscover('c1');
  assert.deepEqual(asks, []);
  assert.ok(!shown.includes(LOOK) && !shown.includes('cardlook') && !shown.includes('discoverlook'), 'no suggested search, no old button');
  // A card with nothing said: its question first. The next card: its lead-in said, then the question; its field asks for one thing.
  const bare = mounted(['@brainstorm', ...answer({ ...FREE, say: '' }), '']).html(0);
  assert.match(bare, /border-left:2px solid #d6d6d6"><span data-card-question="1"/, 'nothing above the question');
  const NEXT = { say: 'You kept coming back to “correct”.', card: 'questions', questions: { eyebrow: 'what next', items: [{ id: 'next', type: 'open', title: card.NEXT_TITLE, placeholder: card.NEXT_PLACEHOLDER }] }, ready: false };
  const next = mounted(['@brainstorm', ...answer(NEXT), '']);
  assert.match(next.html(0), /<span data-card-say="1"[^>]*>You kept coming back to “correct”\.<\/span><span [^>]*><\/span><span data-card-question="1"[^>]*>So what do you want to dig into next\?<\/span>/, 'the lead-in, then the question');
  // An open question's field says "Respond…", never the card's own hint (2026-10-15, David).
  assert.match(next.editor.editorHtml(), /placeholder="Respond…" aria-label="Answer"/);
  assert.ok(!next.editor.editorHtml().includes('placeholder="One thing, as specific as you can make it"'));
});

test('a free card is answered by what is typed in the field under it, sent with Enter or Send as a follow-up is, never routed; with one turn before it nothing collapses (2026-10-14: the two newest stay open); nothing typed sends nothing (2026-10-13)', () => {
  const m = mounted(['@brainstorm', ...answer(FREE), '']);
  m.props.onRoute = () => { throw new Error('routed'); };
  m.editor.sendFollow(0);
  assert.deepEqual(m.asks, [], 'nothing typed: nothing sent');
  m.editor.followText.set(0, '  when the lock frees  ');
  m.editor.sendFollow(0);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', 'when the lock frees', 1]);
  const ls = m.lines();
  assert.equal(ls[ls.length - 3], '@brainstorm when the lock frees');
  assert.ok(ls.slice(1, ls.length - 3).every((l) => l.startsWith('bart>')), 'the card\'s turn stays open: two turns');
  assert.equal(m.editor.followText.get(0), undefined, 'the field emptied');
});

test('a single choice answers with the row clicked, with what is typed as a note; a select-all ticks rows and Enter sends them; the answer line reads as said (2026-10-13)', async () => {
  const opt = (m, q, n) => m.editor.editorClick({ target: { closest: () => ({ dataset: { act: 'cardopt', turn: String(q), opt: String(n) } }) }, preventDefault() {} });
  const one = mounted(['@brainstorm', ...answer(FOCUS), '']);
  assert.match(one.html(0), /<button type="button" class="bs-row" data-act="cardopt" data-turn="0" data-opt="1" role="radio" aria-checked="false"><span aria-hidden="true" class="bs-mark">•<\/span><span class="bs-label">Timeouts<\/span><\/button>/, 'a list row to click');
  assert.match(one.editor.editorHtml(), /placeholder="Pick one, or say it in your own words…"/);
  one.editor.followText.set(0, 'soon');
  opt(one, 0, 1);
  assert.deepEqual([one.asks[0].agent, one.asks[0].text], ['brainstorm', 'picked "Timeouts"; note: soon']);

  const MANY = { say: '', card: 'questions', questions: { items: [{ id: 'which', type: 'select_all', title: 'Which of these happen?', options: [{ label: 'Retries', why: 'you said so' }, { label: 'Timeouts' }, { label: 'Deadlocks' }] }] }, ready: false };
  const many = mounted(['@brainstorm', ...answer(MANY), '']);
  many.editor.forceUpdate = () => {};
  assert.ok(many.html(0).includes('Pick any, then press Enter.'), 'says how');
  assert.match(many.editor.editorHtml(), /data-agent="brainstorm" placeholder="Pick any, or say it in your own words…"/, 'send grey until a row is ticked');
  opt(many, 0, 0); opt(many, 0, 2); opt(many, 0, 1); opt(many, 0, 1);
  assert.deepEqual(many.asks, [], 'ticking sends nothing');
  const ticked = many.html(0);
  assert.match(ticked, /data-opt="0" role="checkbox" aria-checked="true"><span aria-hidden="true" class="bs-mark">✓<\/span><span class="bs-label">Retries<span class="bs-why"> · you said so<\/span>/);
  assert.match(ticked, /data-opt="1" role="checkbox" aria-checked="false"/, 'a second click unticks');
  assert.match(many.editor.editorHtml(), /data-agent="brainstorm" data-empty="1"/, 'send blue once a row is ticked');
  many.editor.sendFollow(0);
  assert.equal(many.asks[0].text, 'picked "Retries", "Deadlocks"');

  // Answered: the line under the card reads as said, its rows still and ticked; the line itself is as main reads it.
  const done = mounted(['@brainstorm', ...answer(MANY), '@brainstorm picked "Retries", "Deadlocks"; note: mostly at night', 'bart> FAKE', 'bart> *3 s*', '']);
  const row = done.lines().indexOf('@brainstorm picked "Retries", "Deadlocks"; note: mostly at night');
  const line = await lineOf(done, row);
  assert.ok(line.includes('<span class="t" style="flex:1;min-width:0"><span style="color:#0070f3;font-weight:500">@brainstorm</span> Retries, Deadlocks · mostly at night</span>'), 'their picks and note, after the agent the line names (2026-10-14)');
  assert.match(line, /data-raw="@brainstorm picked &quot;Retries&quot;, &quot;Deadlocks&quot;; note: mostly at night"/, 'the line as main reads it');
  assert.match(done.html(0), /class="bs-row" disabled role="checkbox" aria-checked="true">/, 'still, ticked');
  const skipped = await lineOf(mounted(['@brainstorm', ...answer(FREE), '@brainstorm (skipped)', 'bart> x', '']), answer(FREE).length + 1);
  assert.match(skipped, /color:#8f8f8f">Skipped<\/span>/);
});

test('Wrap up with nothing given writes "(wrap up)" alone, and works on a choice card with a pick; the answered card has no buttons and its answer line says Wrapped up', async () => {
  const empty = mounted(['@brainstorm', ...answer(FREE), '']);
  empty.click('cardwrap', 0);
  assert.equal(empty.asks[0].text, '(wrap up)');
  assert.equal(empty.lines()[empty.lines().length - 3], '@brainstorm (wrap up)');

  const picked = mounted(['@brainstorm', ...answer(FOCUS), '']);
  picked.editor.cardState.set(0, { picks: ['Timeouts'] });
  picked.editor.followText.set(0, 'soon');
  picked.click('cardwrap', 0);
  assert.equal(picked.asks[0].text, 'picked "Timeouts"; note: soon; (wrap up)');

  // The card as it then stands: answered, its answer read back, no controls.
  const done = mounted(['@brainstorm', ...answer(FREE), '@brainstorm I will read the logs; (wrap up)', 'bart> Where you are: x', '']);
  const entry = done.entry(0);
  assert.deepEqual([entry.live, entry.answer], [false, { skipped: false, picks: [], text: 'I will read the logs', note: '', wrap: true }]);
  const page = done.editor.editorHtml();
  for (const act of ['cardskip', 'cardwrap', 'cardopt']) assert.ok(!page.includes(`data-act="${act}"`), `no ${act} once answered`);
  const said = await lineOf(done, done.lines().indexOf('@brainstorm I will read the logs; (wrap up)'));
  assert.ok(said.includes('I will read the logs <span style="color:#8f8f8f">· Wrapped up</span>'), 'the answer, then Wrapped up');
  const alone = await lineOf(mounted(['@brainstorm', ...answer(FREE), '@brainstorm (wrap up)', 'bart> Where you are: x', '']), answer(FREE).length + 1);
  assert.ok(alone.includes('>Wrapped up</span>') && !alone.includes('Skipped'), 'Wrap up alone says Wrapped up, not Skipped');
});

test('an @orient line is asked as @brainstorm and stays as written; its live card is a brainstorm card, with Skip and Wrap up, and its answers are @brainstorm lines that go on with its thread (M-02, M-08, A-06)', async () => {
  const asked = mounted(['Notes', '@orient metacognition', '']);
  asked.editor.askInline(1);
  assert.deepEqual([asked.asks[0].agent, asked.asks[0].text, asked.asks[0].turns], ['brainstorm', 'metacognition', []]);
  // As @brainstorm, it starts a conversation: an empty title line above it, to be named (2026-10-12).
  assert.deepEqual(asked.lines().slice(2, 4), ['@orient metacognition', `bart~> ${asked.asks[0].askId}`], 'the line is not rewritten');
  assert.match(asked.lines()[1], /^bart# \[brainstorm \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, 'the empty title line, keeping its agent and when');
  assert.equal(asked.asks[0].name, true);

  const m = mounted(['Notes', '@orient metacognition', ...answer(KNOW), '']);
  assert.deepEqual([m.entry(1).live, m.entry(1).agent], [true, 'brainstorm']);
  const shown = m.editor.editorHtml();
  const at = (act) => shown.indexOf(`data-act="${act}"`);
  assert.ok(at('cardskip') > 0 && at('cardskip') < at('cardwrap') && at('opendiscover') < 0, 'Skip, Wrap up, and no Send to Discover');
  assert.ok(!m.html(1).includes('For a colleague.'), 'no subtitle');
  m.click('cardwrap', 1);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', '(wrap up)', 1]);
  assert.equal(m.lines()[m.lines().length - 3], '@brainstorm (wrap up)');
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(model.threads(m.lines()).map((t) => t.turns.length), [2], 'the answer goes on with the @orient thread');

  const s = mounted(['@orient', ...answer(KNOW), '']);
  s.editor.followText.set(0, 'people overrate what they learn');
  s.editor.sendFollow(0);
  assert.deepEqual([s.asks[0].agent, s.asks[0].text, s.lines()[s.lines().length - 3]], ['brainstorm', 'people overrate what they learn', '@brainstorm people overrate what they learn']);

  // A running one shows what it is doing, never the JSON of the card arriving.
  const p = mounted(['@orient', 'bart~> run1', '']);
  p.props.asks = { run1: { agent: 'brainstorm', activity: 'Reading tutortrace.pdf', lines: ['{"say": "", "card"'] } };
  const pending = await lineOf(p, 1);
  assert.ok(pending.includes('Reading tutortrace.pdf') && !pending.includes('&quot;card&quot;') && !pending.includes('"card"'));
});

test('an older recap is drawn as sections, the paper path\'s "What you took from it" and an older @orient recap\'s labels too; under it the follow-up field, which needs words since 2026-10-14, then Send to Discover on a row of its own (M-07, M-08, A-05, A-06)', async () => {
  for (const [first, label] of [['@brainstorm @[TutorTrace]', 'What you took from it'], ['@orient metacognition', 'What you know']]) {
    const lines = [first, ...answer(KNOW), '@brainstorm (wrap up)', `bart> ${label}: learners query before trying`, 'bart> Where it thins out: not said', 'bart> What draws you: the gap', 'bart> Your question: not written yet', 'bart> ', 'bart> *3 s*', ''];
    const m = mounted(lines);
    const row = (text) => m.lines().indexOf(text);
    assert.match(await lineOf(m, row(`bart> ${label}: learners query before trying`)), new RegExp(`>${label}</span>`), `${label}: a section, its label in bold`);
    assert.match(await lineOf(m, row('bart> Where it thins out: not said')), /font-style:italic;">not said/, 'not said in grey');
    assert.match(await lineOf(m, row('bart> What draws you: the gap')), />What draws you<\/span>/, 'an older recap\'s label still draws');
    const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
    const follow = m.editor.followHtml(m.lines(), model.threads(m.lines())[0]);
    assert.match(follow, /data-agent="brainstorm" placeholder="Respond…" aria-label="Ask a follow-up"/, 'the conversation\'s next turn, as Chat\'s field is');
    assert.ok(!follow.includes('data-empty'), 'it is not sent empty');
    assert.match(follow, />@brainstorm<\/span>/);
    m.editor.replyOpen.add(0); // Reply opened it (2026-10-13)
    const page = m.editor.editorHtml();
    assert.ok(page.indexOf('data-recap-discover="0"') > page.indexOf('data-followup="0"'), 'Send to Discover, a row of its own under it');
    assert.ok(!page.includes('Orient again'));
    m.editor.sendFollow(0);
    assert.equal(m.asks.length, 0, 'sent empty: nothing is asked');
    m.editor.followText.set(0, 'Actually the gap is narrower than that');
    m.editor.sendFollow(0);
    assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', 'Actually the gap is narrower than that', 2], 'typed: the same conversation goes on, with its earlier turns');
    assert.equal(m.lines()[lines.length - 1], '@brainstorm Actually the gap is narrower than that');
  }
});

test('an @brainstorm result is their sentence, then one small line whose @discover and @chat start a thread of their own on it; no Send to Discover row and no sections (MATH-40)', async () => {
  const SENTENCE = 'Look at how often people correct an agent mid-task.';
  const NEXT = { say: 'You came back to “correct” three times.', card: 'questions', questions: { eyebrow: 'what next', items: [{ id: 'next', type: 'open', title: card.NEXT_TITLE }] }, ready: false };
  const result = replyLines(card.resultText(SENTENCE), { level: { name: '', effort: '' }, trail: [], ms: 0 }, { model: false });
  const lines = ['@brainstorm corrigibility', ...answer(NEXT), `@brainstorm ${SENTENCE}`, ...result, ''];
  const m = mounted(lines), row = (text) => m.lines().indexOf(text), offer = row(`bart> ${card.RESULT_OFFER}`);
  const drawn = await lineOf(m, offer);
  assert.match(drawn, /font-size:13px;line-height:1\.6;color:#8f8f8f/, 'small and grey');
  assert.match(drawn, /data-act="resultask" data-agent="discover"[^>]*>@discover<\/button>, or ask about it with <button[^>]*data-act="resultask" data-agent="bart"[^>]*>@chat<\/button>/);
  const said = await lineOf(m, row(`bart> ${SENTENCE}`));
  assert.ok(said.includes(SENTENCE) && !said.includes('<button') && !said.includes('font-weight:600'), 'their sentence as written, not a section');
  assert.ok(!m.editor.editorHtml().includes('data-recap-discover'), 'no Send to Discover row: the offer line stands in for it');
  // Mid-exchange, nothing sends on: no Send to Discover under its live cards, and none once they are answered.
  const mid = mounted(['@brainstorm corrigibility', ...answer(KNOW), '@brainstorm people overrate it', ...answer(NEXT), '']).editor.editorHtml();
  assert.ok(!mid.includes('opendiscover') && !mid.includes('data-discover-input') && !mid.includes('resultask'), 'nothing under the cards in between');
  const ended = m.editor.editorHtml();
  assert.ok(!ended.includes('opendiscover') && ended.includes('resultask'), 'only the offer line under the finished result');
  // @discover, then @chat: each a thread of its own after the brainstorm thread, on their sentence, with no earlier turns.
  const press = (agent) => m.editor.editorClick({ target: { closest: () => ({ dataset: { act: 'resultask', agent, row: String(offer) } }) }, preventDefault() {} });
  press('discover');
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns], ['discover', SENTENCE, []]);
  press('bart');
  assert.deepEqual([m.asks[1].agent, m.asks[1].text, m.asks[1].turns], ['bart', SENTENCE, []]);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(model.threads(m.lines()).map((t) => m.lines()[t.from]), ['@brainstorm corrigibility', `@chat ${SENTENCE}`, `@discover ${SENTENCE}`], 'each right after the brainstorm thread, the latest first');
  press('nope');
  assert.equal(m.asks.length, 2, 'no other agent');
  // Left open: nothing to send on, and nothing drawn as an offer.
  const left = mounted(['@brainstorm corrigibility', ...answer(NEXT), '@brainstorm (skipped)', ...replyLines(card.LEFT_OPEN, { level: { name: '', effort: '' }, trail: [], ms: 0 }, { model: false }), '']);
  assert.ok(!left.editor.editorHtml().includes('resultask'));
});

test('Send to Discover is not drawn after @bart or @discover answers, under a recap still being asked again, or after an @brainstorm reply that is not a recap (MATH31-04, A-05)', () => {
  const none = (lines, why) => { const page = mounted(lines).editor.editorHtml(); assert.ok(!page.includes('data-discover-input') && !page.includes('opendiscover'), why); };
  none(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', ''], 'not after @bart');
  none(['@discover retry loops', 'bart> ## Start here', 'bart> *3 s*', ''], 'not after an @discover guide');
  none(['@orient (wrap up)', 'bart> What you know: a', 'bart> *3 s*', '@brainstorm', 'bart~> o9', ''], 'not while it is asked again');
  none(['@brainstorm', 'bart> FAKE REPLY that is not a card: {"say": "cut off', 'bart> *3 s*', ''], 'not after a reply that is not a recap');
  const bart = mounted(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '']);
  bart.editor.discoverText.set('t0', 'x');
  bart.editor.sendDiscover('t0');
  assert.deepEqual(bart.asks, [], 'a target that is not drawn sends nothing');
  // The latest @bart answer's reply line is always there (2026-10-15, David's reference); an older one's is shut until Reply.
  assert.match(bart.editor.editorHtml(), /aria-label="Ask a follow-up"/, 'the latest answer\'s reply line');
  const two = mounted(['@bart why?', 'bart> because', 'bart> *Sonnet · high · 3 s*', '', '@bart how?', 'bart> so', 'bart> *Sonnet · high · 3 s*', '']);
  assert.equal((two.editor.editorHtml().match(/aria-label="Ask a follow-up"/g) || []).length, 1, 'the older answer\'s is shut until Reply');
  assert.match(two.editor.editorHtml(), /data-foot="0"[^>]*>(?:(?!<\/div>)[\s\S])*data-act="reply" data-thread="0" aria-label="Reply"/, 'its Reply is in its icons at the bottom');
  two.editor.replyOpen.add(0);
  assert.equal((two.editor.editorHtml().match(/aria-label="Ask a follow-up"/g) || []).length, 2, 'the older answer\'s, once Reply opened it');
});

test('the @ menu no longer offers Orient: the editor, the rail model and the workspace list Bart, Chat, Brainstorm and Discover; the rail names no Orient (M-01)', async () => {
  assert.equal(editorModule.ORIENT_ITEM, undefined);
  const rail = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);
  assert.equal(rail.ORIENT_VERB, undefined);
  assert.deepEqual(rail.mentionRows({ query: 'or', library: [], page: null, pageRow: null }).map((r) => r.key), [], 'nothing starts with "or"');
  assert.equal(rail.isVerbRow({ id: 'orient' }), false);
  const fs = require('node:fs');
  const workspaceSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspaceSrc, /\[BART_ITEM, CHAT_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM, /);
  assert.ok(!/ORIENT_ITEM/.test(workspaceSrc));
  assert.ok(!/Orient asked/.test(fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Rail.jsx'), 'utf8')));
  // A row picked from an editor's own list by id: no @Orient is written.
  const m = mounted(['@or']);
  m.editor.state.mention = { i: 0, start: 0, caret: 3, query: 'or' };
  m.editor.pickMention({ id: 'brainstorm', name: 'brainstorm' });
  assert.equal(m.lines()[0], '@Brainstorm ');
});

test('the walkthrough\'s Brainstorm types @brainstorm at the end of the document, on a thread of its own, and runs it (2026-10-10)', () => {
  const ID = /^bart~> [a-z0-9]+-[a-z0-9]+$/;
  // After the person's writing: one blank line between, the line, its pending line, an empty last line.
  const m = mounted(['Welcome!', 'My notes on retries', '', '']);
  assert.equal(m.editor.startAgent('brainstorm'), true);
  const ls = m.lines();
  assert.deepEqual(ls.slice(0, 4), ['Welcome!', 'My notes on retries', '', '@brainstorm']);
  assert.match(ls[4], ID);
  assert.deepEqual(ls.slice(5), ['']);
  assert.equal(m.asks.length, 1);
  assert.deepEqual({ ...m.asks[0], askId: undefined }, { askId: undefined, text: '', turns: [], agent: 'brainstorm', place: { line: 3, text: '@brainstorm' } }, 'asked as Enter on an empty @brainstorm line is: from the workspace, with no earlier turns');
  assert.equal(ls[4], `bart~> ${m.asks[0].askId}`);
  // An empty document: the line first, with nothing above it.
  const empty = mounted(['']);
  empty.editor.startAgent('brainstorm');
  assert.equal(empty.lines()[0], '@brainstorm');
  assert.match(empty.lines()[1], ID);
  // A document ending on an answered card: the new line starts a thread of its own after it.
  const after = mounted(['Notes', '@brainstorm', ...answer(FREE)]);
  const before = after.lines().length;
  after.editor.startAgent('brainstorm');
  assert.deepEqual(after.lines().slice(before, before + 2), ['', '@brainstorm']);
  // @bart needs words: it is never started this way.
  const bart = mounted(['Notes']);
  assert.equal(bart.editor.startAgent('bart'), false);
  assert.deepEqual(bart.lines(), ['Notes']);
  assert.equal(bart.asks.length, 0);
});

test('the walkthrough\'s handoff asks @discover on the last brainstorm result, once, and not while that brainstorm is still pending (2026-10-10)', async () => {
  const SENTENCE = 'Find studies of novice debugging.';
  const NEXT = { say: '', card: 'questions', questions: { eyebrow: 'what next', items: [{ id: 'next', type: 'open', title: 'What are your next steps?' }] }, ready: false };
  const result = replyLines(card.resultText(SENTENCE), { level: { name: '', effort: '' }, trail: [], ms: 0 }, { model: false });
  const lines = ['Welcome!', '', '@brainstorm', ...answer(NEXT), `@brainstorm ${SENTENCE}`, ...result, ''];
  // The pending brainstorm line is still there: nothing yet.
  const waiting = mounted(['Welcome!', '', '@brainstorm', 'bart~> ab-cd', '']);
  assert.equal(waiting.editor.discoverLastResult('ab-cd'), false);
  assert.equal(waiting.asks.length, 0);
  const m = mounted(lines);
  assert.equal(m.editor.discoverLastResult('ab-cd'), true);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns], ['discover', SENTENCE, []]);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(model.threads(m.lines()).map((t) => m.lines()[t.from]), ['@brainstorm', `@discover ${SENTENCE}`], 'a thread of its own after the brainstorm');
  // Asked once: an @discover after the result stops a second.
  assert.equal(m.editor.discoverLastResult(), false);
  assert.equal(m.asks.length, 1);
  // No result in the document: nothing.
  const none = mounted(['Welcome!', '@brainstorm', ...answer(NEXT), '']);
  assert.equal(none.editor.discoverLastResult(), false);
});

/* ------------------------------------------------------------- @brainstorm as a conversation (2026-10-14) */

test('an @brainstorm answer in prose is drawn as Chat\'s: its own lines, Copy, Regenerate and Reply on its foot, no card, Skip, Wrap up, Send to Discover or result line; one that asks nothing still takes a reply, which goes on in the same thread', async () => {
  const prose = (text) => replyLines(text, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false, agent: 'brainstorm' });
  const REFLECT = 'So the rubric did more than the model swap.';
  const lines = ['@brainstorm why did the second version feel better', ...prose('Was it the model, or the rubric you wrote at the same time?'), '@brainstorm the rubric, I think', ...prose(`${REFLECT}\n\nWhat you know: the comparison mixed two changes.`), ''];
  const m = mounted(lines);
  assert.equal(m.editor.cardsOf(m.lines()).byQ.size, 0, 'no card');
  const page = m.editor.editorHtml();
  for (const act of ['cardskip', 'cardwrap', 'cardopt', 'opendiscover', 'resultask']) assert.ok(!page.includes(`data-act="${act}"`), `no ${act}`);
  assert.ok(!page.includes('data-recap-discover'), 'a line that reads like an older recap section is not one: no Send to Discover');
  assert.doesNotMatch(await lineOf(m, m.lines().indexOf('bart> What you know: the comparison mixed two changes.')), />What you know<\/span>/, 'nor drawn as a section');
  assert.match(page, /data-act="regen"[^>]*data-plain="1"/, 'Regenerate, on its one model');
  assert.match(page, /data-act="reply"/, 'Reply, though it asked nothing');
  assert.match(await lineOf(m, m.lines().indexOf(`bart> ${REFLECT}`)), /So the rubric did more than the model swap\./, 'its words as written');
  m.editor.replyOpen.add(0);
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.match(m.editor.followHtml(m.lines(), model.threads(m.lines())[0]), /data-agent="brainstorm" placeholder="Respond…" aria-label="Ask a follow-up"/);
  m.editor.followText.set(0, 'and the rubric came from the tutors');
  m.editor.sendFollow(0);
  assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].turns.length], ['brainstorm', 'and the rubric came from the tutors', 2], 'the same conversation, with its two turns');
  assert.equal(model.threads(m.lines()).length, 1);
});
