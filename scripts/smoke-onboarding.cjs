'use strict';

// npm run build && npx electron scripts/smoke-onboarding.cjs
// Runs the real app, hidden, against disposable data, the fake Bart (ENGELBART_BART_FAKE=1) and a fake OpenAlex served
// here (ENGELBART_OPENALEX_API: no call reaches the real one, whose keyless allowance is small), and walks onboarding
// as a new user (2026-10-08 follow-ups): What are you working on? → Why are you interested in this? (each card its
// question and box, nothing above it) → Putting it together (their answers joined by Bart, their parts underlined and
// editable, and the question, filled with Bart's suggestion; Submit always works) → the preparing
// screen (no step counter) → the workspace: "Questions to investigate", rows of a triangle and the words, no way to
// delete one, papers as rows, the empty page's hint. ENGELBART_ONBOARDING_SHOTS=<dir> saves pictures along the way.
// ENGELBART_ONBOARDING_429=1 has the fake OpenAlex refuse every call: the block says OpenAlex is not available.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-onboarding-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
const shots = process.env.ENGELBART_ONBOARDING_SHOTS || '';
const refusing = process.env.ENGELBART_ONBOARDING_429 === '1';

// The fake OpenAlex: four works, one of them uncited; a search honours the cited_by_count filter.
const WORKS = [
  { id: 'W101', title: 'Help seeking in interactive learning environments', cited: 900, year: 2006, venue: 'Review of Educational Research', type: 'review', abstract: 'Help seeking is a self-regulated learning strategy. Students who ask for help at the right moments learn more than students who avoid help or abuse it.' },
  { id: 'W102', title: 'Productive failure', cited: 700, year: 2008, venue: 'Cognition and Instruction', type: 'article', abstract: 'Students who struggle with a problem before instruction learn more from it. Productive failure designs that struggle on purpose and measures what transfers to new problems.' },
  { id: 'W103', title: 'Generative AI can harm learning', cited: 300, year: 2025, venue: 'PNAS', type: 'article', abstract: 'Students who practised with an AI tutor did better while it was there, and worse on an exam taken without it. Access to answers can stand in for learning.' },
  { id: 'W104', title: 'Deep shift-invariant behavior prediction', cited: 0, year: 2024, venue: null, type: 'article', abstract: 'We propose a network for predicting behavior from sequences of events in many settings.' },
];
const asList = (work) => ({ id: `https://openalex.org/${work.id}`, title: work.title, publication_year: work.year, authorships: [{ author: { display_name: 'Ann Author' } }], primary_location: work.venue ? { source: { display_name: work.venue } } : null, doi: null, cited_by_count: work.cited, type: work.type });
const inverted = (text) => { const index = {}; text.split(' ').forEach((word, i) => { (index[word] = index[word] || []).push(i); }); return index; };
const calls = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(url.pathname + url.search);
  if (refusing && !url.pathname.startsWith('/s2') && !url.pathname.startsWith('/arxiv')) { res.writeHead(429); res.end(); return; }
  const send = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const one = url.pathname.match(/^\/works\/(W\d+)$/);
  if (one) {
    const work = WORKS.find((w) => w.id === one[1]);
    if (!work) { res.writeHead(404); res.end(); return; }
    send({ ...asList(work), abstract_inverted_index: inverted(work.abstract), best_oa_location: null, open_access: { is_oa: false }, locations: [], referenced_works: [], related_works: [] });
    return;
  }
  if (url.pathname === '/works') {
    const filter = url.searchParams.get('filter') || '';
    const min = Number((filter.match(/cited_by_count:>(\d+)/) || [])[1] || -1);
    const results = WORKS.filter((w) => w.cited > min).map(asList);
    send({ meta: { count: results.length }, results });
    return;
  }
  res.writeHead(404); res.end();
});

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 600) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const shot = async (wc, name) => { if (!shots) return; fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, `${name}.png`), (await wc.capturePage()).toPNG()); };
// Types into a React field: the native setter, then an input event.
const fill = (wc, selector, value) => js(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
const click = (wc, selector) => js(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_TOOLS: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1',
    ENGELBART_OPENALEX_API: base, ENGELBART_SEMANTIC_SCHOLAR_API: `${base}/s2`, ENGELBART_ARXIV_API: `${base}/arxiv/api`, ENGELBART_ARXIV: `${base}/arxiv`, OPENALEX_API_KEY: '',
  });
  require('../src/main/index.cjs');
  await app.whenReady();
  const { BrowserWindow } = require('electron');
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\.html/.test(w.webContents.getURL())), 'the window');
  const wc = win.webContents;
  await until(() => js(wc, '!!document.querySelector("[data-onboarding]")'), 'onboarding');
  const step = () => js(wc, 'document.querySelector("[data-onboarding]") && document.querySelector("[data-onboarding]").dataset.step');
  if (await step() === 'welcome') await click(wc, '[data-onboarding-continue] button, button[data-onboarding-continue]');
  await until(async () => (await step()) !== 'welcome', 'past welcome');
  if (await step() === 'tools') { await until(() => click(wc, '[data-onboarding-skip]'), 'skip tools'); }

  // 1. What are you working on?
  await until(async () => (await step()) === 'working', 'the first card');
  assert.equal(await js(wc, 'document.querySelector("[data-onboarding-card] div").textContent'), 'What are you working on?');
  assert.equal(await js(wc, '!!document.querySelector("[data-onboarding-so-far]")'), false, 'nothing above the card');
  await fill(wc, '[data-onboarding-field="working"]', 'How what students do before asking an AI tutor relates to what they learn');
  await click(wc, '[data-onboarding-submit]');
  // 2. Why are you interested in this?
  await until(async () => (await step()) === 'why', 'the second card');
  assert.equal(await js(wc, 'document.querySelector("[data-onboarding-card] div").textContent'), 'Why are you interested in this?');
  assert.equal(await js(wc, '!!document.querySelector("[data-onboarding-so-far]")'), false, 'no growing sentence above the card');
  await fill(wc, '[data-onboarding-field="why"]', 'Because instructors could grade the process, not only the answer');
  await pause(500); // the card rises in
  await shot(wc, '1-why');
  await click(wc, '[data-onboarding-submit]');
  // 3. Putting it together: Bart's sentence, the question filled with Bart's suggestion, Submit enabled throughout.
  await until(async () => (await step()) === 'together', 'Putting it together');
  assert.equal(await js(wc, '!!document.querySelector("[data-onboarding-field=unsure]")'), false);
  await until(() => js(wc, '!!document.querySelector("[data-onboarding-sentence]")'), 'the sentence');
  const joined = await js(wc, '({ text: document.querySelector("[data-onboarding-sentence]").textContent, bart: document.querySelector("[data-onboarding-sentence]").dataset.joined || null, parts: [...document.querySelectorAll("[data-onboarding-sentence] [data-onboarding-part]")].map((el) => el.dataset.onboardingPart) })');
  assert.equal(joined.text, "I'm working on how what students do before asking an AI tutor relates to what they learn because instructors could grade the process, not only the answer.");
  assert.equal(joined.bart, '1', 'joined by Bart, not their words as they are');
  assert.deepEqual(joined.parts, ['working', 'why'], 'their parts, underlined and editable');
  assert.equal(await js(wc, 'document.querySelector("[data-onboarding-submit]").disabled'), false, 'Submit works before anything is typed');
  assert.match(await js(wc, 'document.querySelector("label[for=ob-question]").textContent'), /^The question I want to answer:$/);
  const suggested = await until(() => js(wc, 'document.querySelector("[data-onboarding-question]").value'), 'Bart\'s suggestion in the field');
  assert.equal(suggested, 'What would a fake question ask?');
  await shot(wc, '2-together');
  await click(wc, '[data-onboarding-stuck]');
  const another = await until(async () => { const value = await js(wc, 'document.querySelector("[data-onboarding-question]") && document.querySelector("[data-onboarding-question]").value'); return value && value !== suggested ? value : null; }, 'Stuck? suggests another question');
  assert.match(another, /\?$/);
  await fill(wc, '[data-onboarding-question]', 'Which behaviors before asking predict learning?');
  await shot(wc, '3-their-question');
  await click(wc, '[data-onboarding-submit]');
  // 4. The preparing screen: no step counter.
  const preparing = await until(() => js(wc, '(() => { const el = document.querySelector("[data-onboarding-preparing]"); return el ? { label: el.dataset.onboardingPreparing, counter: !!document.querySelector("[data-onboarding-step-of]") } : null; })()'), 'the preparing screen', 200).catch(() => null);
  if (preparing) { assert.equal(preparing.counter, false, 'no step counter'); await shot(wc, '4-preparing'); }
  // 5. The workspace.
  await until(() => js(wc, '!!document.querySelector("[data-starts]")'), 'the workspace', 1600);
  const page = await js(wc, `(() => ({
    title: document.querySelector('[data-doc-title]').value,
    heading: document.querySelector('[data-starts] [data-starts-toggle]').textContent,
    rows: document.querySelectorAll('[data-start]').length,
    remove: document.querySelectorAll('[data-start-remove], [data-start-bart]').length,
    circles: document.querySelectorAll('[data-starts] circle').length,
    hint: (document.querySelector('[data-doc-placeholder]') || {}).textContent || null,
  }))()`);
  assert.equal(page.title, 'Which behaviors before asking predict learning?', 'the question they settled on is the page\'s title');
  assert.equal(page.heading, 'Questions to investigate');
  assert.equal(page.rows, 3);
  assert.deepEqual([page.remove, page.circles], [0, 0], 'no way to delete, no dashed circles');
  assert.equal(page.hint, 'Write your thoughts, or ask @bart to explain, brainstorm, or find papers.');
  if (refusing) {
    await until(() => js(wc, '!!document.querySelector("[data-starts-unavailable]")'), 'OpenAlex is said to be unavailable', 1600);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-rung-kind=action]").length'), 0, 'no step stands in for papers');
  } else {
    await until(() => js(wc, 'document.querySelectorAll("[data-start]")[0].querySelectorAll("[data-rung-kind=paper]").length >= 1'), 'papers under the first question', 1600);
    const titles = await js(wc, '[...document.querySelectorAll("[data-rung-title]")].map((el) => el.textContent)');
    assert.ok(!titles.includes('Deep shift-invariant behavior prediction'), 'the uncited paper is never shown');
    assert.match(await js(wc, 'document.querySelector("[data-rung-where]").textContent'), /^Author \d{4} · /);
  }
  await pause(400);
  await shot(wc, '5-workspace');
  const brief = JSON.parse(fs.readFileSync(fs.readdirSync(path.join(root, '.engelbart', 'test')).map((dir) => path.join(root, '.engelbart', 'test', dir, 'project.json')).find((file) => fs.existsSync(file)) || fs.readdirSync(path.join(root, '.engelbart')).map((dir) => path.join(root, '.engelbart', dir, 'project.json')).find((file) => fs.existsSync(file)), 'utf8')).brief;
  assert.deepEqual(Object.keys(brief).sort(), ['question', 'why', 'working']);
  console.log(`onboarding smoke passed (${refusing ? 'OpenAlex refusing' : 'OpenAlex answering'}); fake OpenAlex calls: ${calls.filter((one) => one.startsWith('/works')).length}`);
}

main().then(() => { server.close(); app.exit(0); }, (error) => { console.error(error); server.close(); app.exit(1); });
