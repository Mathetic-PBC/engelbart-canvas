'use strict';

// npm run build && npx electron scripts/smoke-panel.cjs
// Runs the real app, hidden, against disposable project/user data and the fake agents (src/main/bart/ask.cjs), on a
// document drawn as the middle panel's threads are since 2026-10-13 (Hudson's screenshot): one conversation collapsed to
// a line, one open with its earlier exchanges folded to lines at the top of its card and a long answer cut off, and the
// @bart message box (plain, on the cards' grey). It checks what is drawn, Show more, Reply, the strip under the page and Collapse all, and that an answer landing
// while the document is open shows in full.
// ENGELBART_PANEL_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-panel-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const ED = 'main [data-editor]';
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(200);
};
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const spot = (wc, selector, center = false) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();if(!r.width)return null;return{x:Math.round(r.x+(${center}?r.width/2:Math.min(r.width/2,40))),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector, center = false) => { const at = await until(() => spot(wc, selector, center), selector); await click(wc, at); };
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
const SHOTS = process.env.ENGELBART_PANEL_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

const iso = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
const LONG = [
  'Partly. Two agents have real few-shot examples, Brainstorm has tone examples, and the rest work from rules and templates only.',
  '',
  '- **Bart (router)**: this one is the most few-shot. `src/main/bart/route-system-prompt.cjs` (lines 18–39) lists 21 labelled "Hard cases", each a line and the agent it should go to.',
  '- **Chat**: `src/main/bart/system-prompt.cjs` (lines 54–67) has an `<examples>` block with a few Q/A pairs. They show what an answer should look like, not what it should say.',
  '- **Brainstorm**: `brainstorm-system-prompt.cjs` has a "How it sounds" section (lines 139–153). It gives three of your answers in a real session, each with a "Not:" card and a "But:" card.',
  '- **Discover**: no examples. Its reading guide is a fill-in template (`**[Title]**`, `**Read:**`, `**Why:**`, `**Try:**`, lines 90–99), plus a JSON schema for its one refine card.',
  '- **Create, Build and chat naming**: no examples. `create-system-prompt.cjs` and `build/prompt.cjs` are instructions only. `name-chat.cjs` sends a single instruction line.',
  '',
  'I\'m inferring this part: the router depends most on examples, since it runs on Haiku or Luna at low effort with nothing else to go on. Discover\'s "Why" lines and Brainstorm\'s question choices are where the earlier critiques found weak output, and they are the two places with no worked examples. If you add any, those are where I\'d start.',
];
const DOC = [
  'Strategies',
  `bart#+ [chat ${iso(14, 37)}] Summarizing high-level strategies request`,
  '@bart summarize the strategies above',
  'bart> They keep answers short.',
  'bart> *Chat · Opus · high · 12 s*',
  '',
  `bart# [chat ${iso(15, 2)}] Few-shot examples`,
  '@bart can you research how the above companies and products make their agents so concise and clear?',
  'bart+> They write rules, then show examples.',
  'bart+> *Chat · Opus · high · 20 s*',
  '@bart so what do you think the response should be?',
  'bart+> Shorter.',
  'bart+> *Chat · Opus · high · 14 s*',
  '@bart Chat: give Bart\'s answers a voice and five pillars, and stop the long preambles before every answer it gives',
  'bart+> Done.',
  'bart+> *Chat · Opus · high · 31 s*',
  '@bart do any of our agents use few-shot examples?',
  ...LONG.map((l) => `bart> ${l}`.trimEnd()),
  'bart>',
  'bart> *Chat · Opus · high · 23 s*',
  '',
  '@bart',
  '',
];

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Panel smoke', directory:${JSON.stringify(root)}})`);
    await js(wc, `window.engelbartAPI.writeDoc(${JSON.stringify(made.project.id)}, ${JSON.stringify({ kind: 'workspace', workspaceId: made.workspaceId })}, ${JSON.stringify(DOC.join('\n'))})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(`${ED} [data-thread-row]`)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ opened: both conversations collapsed to a line; open the second */
    const collapsed = await js(wc, `[...document.querySelectorAll('${ED} [data-thread-row]')].map((r)=>({h:Math.round(r.getBoundingClientRect().height),text:r.innerText}))`);
    assert.equal(collapsed.length, 2, 'both conversations collapsed when the document opened');
    assert.ok(collapsed.every((r) => r.h === 42), `42px rows: ${JSON.stringify(collapsed)}`);
    assert.match(collapsed[0].text, /Summarizing high-level strategies request\s+2:37 PM/, 'the title, then the time, no agent for Chat');
    assert.equal(await js(wc, `document.querySelector('[data-fold-all]').textContent`), 'Expand all', 'everything folded: Expand all');
    await shot(wc, '1-collapsed');
    console.log('PASS opened: each conversation a 42px line with its time on the right; the top says Expand all');
    await press(wc, `${ED} [data-thread-row] .bart-link[aria-label="Expand Few-shot examples"]`);
    await until(() => js(wc, `!!document.querySelector('${ED} [data-folded-row]')`), 'the conversation open');
    await pause(200);

    /* ------------------------------------------------ the open card */
    const card = await js(wc, `(()=>{
      const folded=[...document.querySelectorAll('${ED} [data-folded-row]')].map((r)=>({text:r.innerText,color:getComputedStyle(r).color,h:r.getBoundingClientRect().height}));
      const q=[...document.querySelectorAll('${ED} [data-line]')].find((d)=>d.dataset.raw==='@bart do any of our agents use few-shot examples?');
      const more=document.querySelector('${ED} [data-more]'), foot=q&&document.querySelector('${ED} [data-foot="'+q.dataset.line+'"]');
      const answer=document.querySelector('${ED} [data-answer-of="'+(q&&q.dataset.line)+'"] .t');
      const box=document.querySelector('${ED} [data-message-box]'), send=box&&box.querySelector('[data-act="ask"]');
      return {folded, q:q&&q.innerText, qColor:q&&getComputedStyle(q).color, more:more&&getComputedStyle(more).display, cut:more&&more.dataset.open, label:more&&more.innerText.trim(),
        answerColor:answer&&getComputedStyle(answer).color, foot:foot&&[...foot.querySelectorAll('button')].map((b)=>b.getAttribute('aria-label')).join(' '), reply:!!(foot&&foot.querySelector('[data-act="reply"]')),
        field:!!document.querySelector('${ED} [data-followup]'), box:box&&{border:getComputedStyle(box).borderTopStyle,bg:getComputedStyle(box).backgroundColor,text:box.querySelector('.t').innerText.trim(),send:send&&getComputedStyle(send).backgroundColor,chip:(box.querySelector('[data-act="pick"]')||{}).textContent||null},
        top:document.querySelector('[data-fold-all]').textContent, footer:[...document.querySelectorAll('[data-doc-footer] button')].map((b)=>b.textContent)};
    })()`);
    assert.equal(card.folded.length, 3, 'three earlier exchanges folded to lines');
    assert.ok(card.folded.every((r) => !/^@/.test(r.text) && r.color === 'rgb(122, 122, 122)'), `no @bart, #7a7a7a: ${JSON.stringify(card.folded)}`);
    assert.equal(card.q, '@bart do any of our agents use few-shot examples?', 'the question says @bart');
    assert.equal(card.qColor, 'rgb(23, 23, 23)');
    assert.equal(card.answerColor, 'rgb(38, 38, 38)', 'the answer is dark');
    // The @bart answer restyle (2026-10-15, David's reference): folded after its first paragraph, "Show more" (a paragraph
    // follows its list, so what is hidden is not a list alone); the latest
    // answer's icons (Copy, Regenerate, Delete) and its reply line under them.
    assert.deepEqual([card.more, card.cut, card.label], ['block', '0', 'Show more'], 'an answer there when the document opened starts folded');
    assert.ok(!card.reply && card.foot === 'Copy Regenerate Delete', `the icons: ${card.foot}`);
    assert.equal(card.field, true, 'the latest answer\'s reply line');
    assert.deepEqual(card.box, { border: 'none', bg: 'rgb(250, 250, 250)', text: '@bart', send: 'rgb(236, 236, 236)', chip: 'Sonnet High' }, 'the @bart box');
    assert.deepEqual([card.top, card.footer], ['Collapse all', ['Copy', 'Build', 'Clear']], 'Collapse all at the top; Copy, Build and Clear under the page');
    await shot(wc, '2-open');
    console.log(`PASS the open card: 3 folded lines, @bart, a dark answer folded with Show more, "${card.foot}" and the reply line, the @bart box, Collapse all, and Copy, Build and Clear under the page`);

    /* ------------------------------------------------ Show more, Show less */
    await press(wc, `${ED} [data-act="more"]`);
    const opened = await js(wc, `(()=>{const m=document.querySelector('${ED} [data-more]');return{open:m.dataset.open,label:m.innerText.trim(),hidden:[...document.querySelectorAll('${ED} [data-answer-of]')].filter((r)=>getComputedStyle(r).display==='none').length}})()`);
    assert.deepEqual(opened, { open: '1', label: 'Show less', hidden: 0 });
    await shot(wc, '3-show-more');
    await press(wc, `${ED} [data-act="more"]`);
    assert.equal(await js(wc, `document.querySelector('${ED} [data-more]').innerText.trim()`), 'Show more', 'Show less folds it again');
    console.log('PASS Show more shows it whole, Show less folds it again');

    /* ------------------------------------------------ Reply opens the field; Escape with nothing typed shuts it */
    await press(wc, `${ED} [data-follow-input]`);
    const field = await js(wc, `(()=>{const f=document.querySelector('${ED} [data-follow-input]');return f?{focused:document.activeElement===f,white:getComputedStyle(f.parentElement).backgroundColor}:null})()`);
    assert.deepEqual(field, { focused: true, white: 'rgb(255, 255, 255)' }, 'the reply line, focused, a white box');
    await shot(wc, '4-reply');
    await key(wc, 'Escape');
    await pause(300);
    assert.equal(await js(wc, `!!document.querySelector('${ED} [data-follow-input]')`), true, 'the latest answer\'s reply line stays');
    console.log('PASS the latest answer\'s reply line takes the caret; Escape with nothing typed leaves it there');

    /* ------------------------------------------------ the strip under the page */
    await press(wc, '[data-copy-doc]', true);
    await until(() => js(wc, `(document.querySelector('[data-copy-doc]')||{}).textContent==='Copied'`), 'Copied');
    await shot(wc, '5-copied');
    console.log('PASS Copy under the page says Copied');

    /* ------------------------------------------------ the @bart box: typing turns its send blue; asked, the answer lands whole */
    await press(wc, `${ED} [data-message-box] .t`, true); // past the end of `@bart`
    await typeKeys(wc, ' what does Discover do?');
    const ready = await js(wc, `getComputedStyle(document.querySelector('${ED} [data-message-box] [data-act="ask"]')).backgroundColor`);
    assert.equal(ready, 'rgb(0, 112, 243)', 'blue once there is text');
    await shot(wc, '6-typed');
    await key(wc, 'Enter', { ch: '\r' });
    await until(async () => !(await rows(wc)).some((l) => /^bart~> /.test(l)), 'the answer', 600);
    await pause(300);
    const landed = await js(wc, `(()=>{const q=[...document.querySelectorAll('${ED} [data-line]')].find((d)=>d.dataset.raw==='@bart what does Discover do?');const m=document.querySelector('${ED} [data-more="'+q.dataset.line+'"]');return{folded:!!m&&!!m.offsetHeight&&m.dataset.open==='0',hidden:[...document.querySelectorAll('${ED} [data-answer-of="'+q.dataset.line+'"]')].filter((r)=>getComputedStyle(r).display==='none'||r.style.maxHeight).length}})()`);
    assert.deepEqual(landed, { folded: false, hidden: 0 }, 'an answer that lands while the document is open is whole (2026-10-15: open, its toggle Show less if it is long)');
    await shot(wc, '7-landed');
    console.log('PASS the @bart box sends; its answer lands in full');

    /* ------------------------------------------------ Collapse all */
    await press(wc, '[data-fold-all]', true);
    await until(() => js(wc, `document.querySelector('[data-fold-all]').textContent==='Expand all'`), 'Expand all');
    await shot(wc, '8-collapse-all');
    console.log('PASS Collapse all folds everything and turns to Expand all');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'failed'); console.error('The document then:', JSON.stringify(await rows(wc))); } catch { /* none */ }
    app.exit(1);
  }
});
