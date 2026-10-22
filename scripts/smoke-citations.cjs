'use strict';

// npm run build && npx electron scripts/smoke-citations.cjs
// Runs the real app, hidden, against disposable project/user data, and clicks Chat's citations of a workspace's document
// (src/renderer/model/cite-open.js, screens/Workspace.jsx openCited, workspace/DocEditor.jsx showPassage; 2026-10-21).
// The cited workspace holds each quote where it is out of sight at first: inside a collapsed conversation, inside an
// answer collapsed to its question, and past the cut of a long answer ("Show more"). Each click must open that workspace
// beside the document, open whatever hid the words, and light up exactly the quoted words where they can be seen.
// ENGELBART_CITE_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cite-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');
const { replyLines } = require('../src/main/bart/reply.cjs');
const { citeHref } = require('../src/shared/passage-link.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const PANE = (i) => `main [data-doc-pane="${i}"]`;
const WS = 'Getting started';
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const SHOTS = process.env.ENGELBART_CITE_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

// What is lit in the pane beside: the highlighted words, and whether they are drawn where the pane shows them (inside
// the pane's view, none of them cut off by a box they are in, the topmost thing at their middle being in that pane).
const LIT = `(()=>{const h=CSS.highlights.get('cite-passage');if(!h)return null;const r=[...h][0];if(!r)return null;
  const box=r.getClientRects()[0];const pane=document.querySelector(${JSON.stringify(PANE(1))});if(!box||!pane)return{text:r.toString(),seen:false};
  const p=pane.getBoundingClientRect();const x=box.left+Math.min(box.width/2,20),y=box.top+box.height/2;const at=document.elementFromPoint(x,y);
  const rects=[...r.getClientRects()];let clipped=false;for(let el=r.startContainer.parentElement;el&&el!==pane;el=el.parentElement){const cs=getComputedStyle(el);if(cs.overflowX!=='visible'||cs.overflowY!=='visible'||cs.textOverflow==='ellipsis'){const c=el.getBoundingClientRect();if(rects.some((b)=>b.left<c.left-1||b.right>c.right+1||b.top<c.top-1||b.bottom>c.bottom+1))clipped=true}}
  return{text:r.toString().replace(/\\s+/g,' ').trim(),seen:box.width>0&&!clipped&&rects.every((b)=>b.top>=p.top&&b.bottom<=p.bottom)&&!!at&&pane.contains(at),clipped}})()`;

const answer = (paras) => replyLines(paras.join('\n\n'), { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false });
const filler = (n, what) => Array.from({ length: n }, (_, i) => `${what} ${i + 1}: another sentence or two so this answer runs long enough to be cut.`);

// The quotes, each somewhere out of sight in the cited workspace.
const IN_TITLED = 'the librarian gets the context before it answers';
const ASKED_IN_TITLED = 'should we ask about the project before connect';
const IN_FOLDED = 'previews should sleep instead of being deleted';
const ASKED_FOLDED = 'what happens to the previews and the';
const PAST_MORE = 'search by meaning came from OpenAlex itself';
const DEEP = 'the related papers list is read';

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Cite smoke', directory:${JSON.stringify(root)}})`);
    const pid = made.project.id, wid = made.workspaceId;
    const api = (call) => js(wc, `window.engelbartAPI.${call}`);
    const source = await api(`createWorkspace(${JSON.stringify(pid)}, {name:'Source'})`);
    const write = (ref, text) => api(`writeDoc(${JSON.stringify(pid)}, ${JSON.stringify(ref)}, ${JSON.stringify(text)})`);
    const tree = await api(`loadProject(${JSON.stringify(pid)})`);
    const node = tree.workspaces.find((w) => w.id === source.id);
    assert.ok(node && node.folder, 'the tree says each workspace\'s folder');
    const file = path.join(tree.project.dir, node.folder, 'workspace.md');

    const doc = [
      'Notes from the week.',
      ...filler(12, 'Opening note').map((l) => l.replace(/ another.*$/, ' to scroll past.')),
      // a titled conversation, collapsed to its title: the person's question and Chat's answer both hidden
      'bart#+ [chat 2026-10-10T15:00:00Z] Asking first',
      `@chat ${ASKED_IN_TITLED} your library?`,
      ...answer(['Yes, ask first.', `That way ${IN_TITLED}, not after.`]),
      '',
      // an answer collapsed to its question
      `@chat ${ASKED_FOLDED} idle sandboxes?`,
      ...answer(['They stop.', `The ${IN_FOLDED} after a while.`]).map((l) => l.replace(/^bart> ?/, 'bart+> ').trimEnd()),
      '',
      // a long answer between a conversation's first and latest, cut after its first lines (Show more)
      '@chat which paper API?',
      ...answer(['OpenAlex.']),
      '@chat why OpenAlex over Elicit?',
      ...answer(['OpenAlex has the citation graph.', ...filler(8, 'Reason'), `And ${PAST_MORE}, added later.`]),
      '@chat and Semantic Scholar?',
      ...answer(['Its keyless pool kept returning 429s.']),
      '',
      // the same, its conversation collapsed to its title too
      'bart#+ [chat 2026-10-12T15:00:00Z] Paper sources',
      '@chat which sources for essays?',
      ...answer(['The web.']),
      '@chat and for papers?',
      ...answer(['OpenAlex.', ...filler(8, 'Point'), `Last, ${DEEP} for each.`]),
      '@chat thanks',
      ...answer(['Sure.']),
      '',
      ...filler(20, 'Closing note').map((l) => l.replace(/ another.*$/, ' to scroll past.')),
    ].join('\n');
    await write({ kind: 'workspace', workspaceId: source.id }, `${doc}\n`);
    const cite = (label, find, kind) => `[${label}](${citeHref({ address: file, find, cite: kind })})`;
    await write({ kind: 'workspace', workspaceId: wid }, [
      `Asked first ${cite('Chat · Oct 10', IN_TITLED, 'other')}.`,
      `You asked ${cite('You · Oct 10', ASKED_IN_TITLED, 'you')}.`,
      `Sleeping ${cite('Chat · Oct 10', IN_FOLDED, 'other')}.`,
      `Asked ${cite('You · Oct 10', ASKED_FOLDED, 'you')}.`,
      `Meaning ${cite('Chat · Oct 10', PAST_MORE, 'other')}.`,
      `Deep ${cite('Chat · Oct 12', DEEP, 'other')}.`,
      '',
    ].join('\n'));

    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-doc-tab]")').catch(() => false), 'the workspace screen');
    await js(wc, `(()=>{const row=[...document.querySelectorAll('aside[aria-label="Sidebar"] *')].find((el)=>el.children.length===0&&el.textContent.trim()===${JSON.stringify(WS)});if(row)row.click()})()`);
    await until(() => js(wc, `document.querySelectorAll(${JSON.stringify(`${PANE(0)} [data-editor] a[data-cite]`)}).length===6`).catch(() => false), 'the six citations, drawn as chips');
    await pause(400);
    const chips = await js(wc, `[...document.querySelectorAll(${JSON.stringify(`${PANE(0)} [data-editor] a[data-cite]`)})].map((a)=>getComputedStyle(a,'::after').content)`);
    assert.deepEqual(chips, ['"Chat · Oct 10"', '"You · Oct 10"', '"Chat · Oct 10"', '"You · Oct 10"', '"Chat · Oct 10"', '"Chat · Oct 12"'], 'each chip shows its label');
    console.log('PASS the citations are chips with their labels');

    const cases = [['inside a collapsed conversation', IN_TITLED], ['a question inside a collapsed conversation', ASKED_IN_TITLED], ['the question of an exchange collapsed to its row', ASKED_FOLDED], ['inside a collapsed answer', IN_FOLDED], ['past a long answer\'s Show more', PAST_MORE], ['past Show more in a collapsed conversation', DEEP]];
    for (const [where, words] of cases) {
      await press(wc, `${PANE(0)} [data-editor] a[data-cite][data-find="${words}"]`);
      const lit = await until(async () => { const now = await js(wc, LIT); return now && now.seen ? now : null; }, `the words ${where}, lit and in sight`, 100).catch(async (error) => { await shot(wc, `fail-${words.slice(0, 12)}`); console.log('lit:', JSON.stringify(await js(wc, LIT))); throw error; });
      assert.equal(lit.text.toLowerCase(), words.toLowerCase(), 'exactly the quoted words');
      const title = await js(wc, `(document.querySelector('${PANE(1)} [data-doc-title]')||{}).value`);
      assert.equal(title, 'Source', 'the cited workspace, beside the document');
      await shot(wc, `lit-${words.slice(0, 12)}`);
      console.log(`PASS a quote ${where}: opened beside, uncovered, lit and in sight`);
      await press(wc, '[data-pane-close]');
      await until(() => js(wc, `!document.querySelector('${PANE(1)}')`), 'the pane closes');
      await pause(300);
    }
    console.log('ALL PASS');
    app.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
