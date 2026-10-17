'use strict';

// npx electron scripts/smoke-page-sections.cjs
// A guide's Read link into an HTML file (2026-10-16, Hudson: it sometimes opened the page and did not scroll to the
// passage). Each page here is loaded in a hidden window with the real page preload (src/main/browser/page-preload.cjs),
// asked for a section as views.cjs section() asks (an answer within SELECTION_TIMEOUT_MS, else none), and given Stage's
// find when it says not shown, as Stage does. Then, in the browser's own layout, the passage must be in view:
//  1. far below the fold;  2. its words split across inline tags;  3. its words drawn by a script after the page loaded;
//  4. a page with `scroll-behavior: smooth`;  5. a page that scrolls inside a <main>, not the window;  6. a display:none
//  copy of the words before the one shown;  7. curly quotes and a dash where the words have straight ones and a hyphen;
//  8. the words across a table's cells;  9. the page already open and scrolled elsewhere, asked again.
//  10. Words that are nowhere: the page stays at its top, waits out SECTION_WAIT, and logs no error.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SELECTION_TIMEOUT_MS } = require('../src/main/browser/views.cjs');
const { CHANNELS, SECTION_WAIT } = require('../src/main/browser/page-preload.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-page-sections-'));
app.setPath('userData', path.join(dir, 'electron'));

const WORDS = 'The target passage lives far below';
const filler = (n) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p>`).join('\n');
const page = ({ head = '', body, open = '', close = '' }) => `<!doctype html><html><head><meta charset=utf-8><title>t</title>${head}</head><body>${open}<h1>Page</h1>${filler(60)}<h2>Results</h2>${body}${filler(60)}${close}</body></html>`;
const PLAIN = '<p>The target passage lives far below the fold in this page.</p>';
const PAGES = {
  long: page({ body: PLAIN }),
  split: page({ body: "<p>The <em>target</em> passage <a href='#'>lives</a> far <b>below</b> the fold.</p>" }),
  late: page({ body: "<div id=late></div><script>addEventListener('load', () => setTimeout(() => { document.getElementById('late').innerHTML = '<p>The target passage lives far below the fold in this page.</p>'; }, 700));</script>" }),
  smooth: page({ head: '<style>html{scroll-behavior:smooth}</style>', body: PLAIN }),
  inner: page({ head: '<style>html,body{height:100%;margin:0;overflow:hidden}main{height:100%;overflow:auto}</style>', open: '<main>', close: '</main>', body: PLAIN }),
  hidden: page({ open: "<nav style='display:none'>" + PLAIN + '</nav>', body: PLAIN }),
  entities: page({ body: '<p>It&rsquo;s the target passage &mdash; far below the fold.</p>' }),
  tables: page({ body: '<table><tr><td>The target passage</td><td>lives far below</td></tr></table>' }),
};
const CASES = [
  { name: 'far below the fold', page: 'long' },
  { name: 'split across inline tags', page: 'split', probe: 'passage' },
  { name: 'drawn after load', page: 'late' },
  { name: 'scroll-behavior: smooth', page: 'smooth' },
  { name: 'an inner scroll container', page: 'inner' },
  { name: 'a display:none copy first', page: 'hidden' },
  { name: 'curly quotes and a dash', page: 'entities', words: "It's the target passage - far below", probe: 'target' },
  { name: "across a table's cells", page: 'tables', probe: 'target passage' },
  { name: 'open already, scrolled elsewhere', page: 'long', again: 12000 },
  { name: 'words that are nowhere', page: 'long', words: 'words that are nowhere', missing: true },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Where the window is and whether a drawn element holding `probe` is in view (its own box, or its scroll container's).
const where = (probe) => `(() => {
  const want = ${JSON.stringify(probe)}.toLowerCase();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let inView = false;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.data.toLowerCase().includes(want)) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (r.height > 0 && r.top >= 0 && r.bottom <= innerHeight) inView = true;
  }
  const main = document.querySelector('main');
  return { y: Math.round(scrollY + (main ? main.scrollTop : 0)), inView };
})()`;

app.whenReady().then(async () => {
  for (const name of Object.keys(PAGES)) fs.writeFileSync(path.join(dir, `${name}.html`), PAGES[name]);
  // One window for every page: the command sandbox lets this script start one renderer.
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { preload: path.join(__dirname, '../src/main/browser/page-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const contents = win.webContents;
  const errors = [];
  contents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  contents.ipc.handle(CHANNELS.marks, () => []);
  const replies = new Map();
  contents.ipc.on(CHANNELS.section, (_event, value) => { const done = replies.get(value && value.nonce); if (done) done(!!value.shown); });
  const section = (words) => new Promise((resolve) => {
    const nonce = String(Math.random());
    const timer = setTimeout(() => { replies.delete(nonce); resolve(false); }, SELECTION_TIMEOUT_MS);
    replies.set(nonce, (shown) => { clearTimeout(timer); replies.delete(nonce); resolve(shown); });
    contents.send(CHANNELS.section, { nonce, words });
  });

  let failed = 0;
  for (const c of CASES) {
    try {
      errors.length = 0;
      contents.stopFindInPage('clearSelection');
      await contents.loadURL('about:blank');
      await contents.loadURL(`${pathToFileURL(path.join(dir, `${c.page}.html`)).href}?n=${Math.random()}`);
      if (c.again) await contents.executeJavaScript(`scrollTo(0, ${c.again})`);
      const words = c.words || WORDS;
      const shown = await section(words);
      if (!shown) contents.findInPage(words, { matchCase: false }); // Stage's land(), as views.cjs answers false
      await wait(c.missing ? SECTION_WAIT + 500 : 1500);
      const got = await contents.executeJavaScript(where(c.probe || words));
      if (c.missing) {
        assert.equal(shown, false, 'not shown');
        assert.equal(got.y, 0, 'left at the top');
      } else {
        assert.equal(got.inView, true, `in view (y ${got.y})`);
      }
      assert.deepEqual(errors, [], 'no error in the page');
      console.log(`ok   ${c.name}  (shown ${shown}, y ${got.y})`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${c.name}: ${error.message}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} of ${CASES.length} failed` : `all ${CASES.length} passed`);
  app.exit(failed ? 1 : 0);
});
