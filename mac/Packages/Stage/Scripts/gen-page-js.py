import os
# Regenerates Sources/EngelbartStage/Resources/page.js from src/main/browser/page-preload.cjs (run after that file changes).
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
src = open(os.path.join(ROOT, 'src/main/browser/page-preload.cjs')).read()
start = src.index('const CHANNELS = Object.freeze({')
run = src.index('function runInPage() {')
boot = src.index("if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInPage();")
pure = src[start:run]
body = src[run:boot]
old_req = "  const { ipcRenderer } = require('electron');\n"
assert old_req in body
body = body.replace(old_req, "  const ipcRenderer = bridge();\n")
exports = src[boot:].split('module.exports = ')[1].strip().rstrip(';')
header = '''// The Stage's page script (Swift port of src/main/browser/page-preload.cjs, generated from it by the Stage agent: every
// function above runInPage, and runInPage itself, is that file's word for word, but for the bridge). It runs in every
// Stage page as a WKUserScript in the content world "engelbart-page" (Electron's isolated world): the page sees none of
// it, and the page's DOM is never changed. It talks to the app over the `engelbartPage` script message handler (Electron's
// ipcRenderer on the tab's own webContents): send is postMessage({ channel, value }); invoke is the same, awaited (a
// WKScriptMessageHandlerWithReply); the app's messages arrive through window.__engelbartPage.receive(channel, payload),
// called in this world. What main did with insertCSS (the tints' rule, the boxes' html::after rule, a handle's cursor)
// is a constructed stylesheet adopted by the document (`css(key, text)`, `uncss(key)`): no node is added. What
// Chromium's findInPage did is `find(text, { backward, findNext })` here, which tints the matches with CSS highlights as
// the tints are, and says how many there are (WebKit's own find gives no count).
// Under JavaScriptCore alone (the Swift tests) there is no document: the pure functions go on
// globalThis.__engelbartPagePure instead.
(function engelbartPage() {
'use strict';
if (typeof window !== 'undefined' && window.__engelbartPage) return;
'''
bridge = r'''
// ---------------------------------------------------------------------------------------- the bridge (WebKit)
function bridge() {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.engelbartPage;
  const listeners = new Map(); // channel → [fn]
  const post = (channel, value) => { try { return handler ? handler.postMessage({ channel, value: value === undefined ? null : value }) : Promise.resolve(null); } catch { return Promise.resolve(null); } };
  const api = {
    send: (channel, value) => { void Promise.resolve(post(channel, value)).catch(() => {}); },
    invoke: (channel, value) => Promise.resolve(post(channel, value)),
    on: (channel, fn) => { const list = listeners.get(channel) || []; list.push(fn); listeners.set(channel, list); },
  };
  const sheets = new Map(); // key → CSSStyleSheet
  const adopt = () => {
    if (!document.adoptedStyleSheets) return;
    const list = document.adoptedStyleSheets;
    const missing = [...sheets.values()].filter((sheet) => !list.includes(sheet));
    if (missing.length) document.adoptedStyleSheets = [...list, ...missing];
  };
  const config = window.__engelbartConfig || {};
  const page = {
    receive(channel, payload) { for (const fn of listeners.get(channel) || []) { try { fn(null, payload); } catch { /* one listener's failure is its own */ } } return true; },
    css(key, text) {
      if (typeof CSSStyleSheet !== 'function') return false;
      let sheet = sheets.get(key);
      if (!sheet) { sheet = new CSSStyleSheet(); sheets.set(key, sheet); }
      try { sheet.replaceSync(String(text || '')); } catch { return false; }
      adopt();
      return true;
    },
    uncss(key) {
      const sheet = sheets.get(key);
      if (!sheet) return false;
      sheets.delete(key);
      if (document.adoptedStyleSheets) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((one) => one !== sheet);
      return true;
    },
  };
  window.__engelbartPage = page;
  // the tints' and find's rules, with each document (Electron's insertCSS on dom-ready); a page that replaces its own
  // adopted sheets is given them back the next time anything is tinted or found (adopt)
  const styled = () => { if (config.markCSS) page.css('marks', config.markCSS); if (config.findCSS) page.css('find', config.findCSS); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', styled, { once: true }); else styled();
  api.page = page;
  api.adopt = adopt;
  return api;
}
'''
find = r'''
  /* ------------------------------------------------------------------- find in the page (Chromium's findInPage) */
  // A new query starts over from the first match, the same one steps (forward or back), an empty one stops; any case,
  // each run of whitespace one space, only text that is drawn. The matches are tinted (engelbart-find) and the one in
  // front (engelbart-find-on) is scrolled into the middle of the view when it is out of it. → { matches, active }
  // (active counts from 1; 0 for none).
  const FIND = 'engelbart-find', FIND_ON = 'engelbart-find-on';
  let finding = { text: '', ranges: [], active: -1 };
  function findRanges(text) {
    const want = String(text || '').replace(/\s+/g, ' ').toLowerCase();
    if (!want.trim()) return [];
    const map = textMap(textNodes()), hay = map.text.toLowerCase(), out = [];
    for (let at = hay.indexOf(want); at >= 0 && out.length < 10000; at = hay.indexOf(want, at + want.length)) {
      const range = domRange(rangeOf(map, at, at + want.length));
      if (range && drawn(range)) out.push(range);
    }
    return out;
  }
  function paintFind() {
    const h = registry();
    if (!h) return;
    const { ranges, active } = finding;
    if (!ranges.length) { h.delete(FIND); h.delete(FIND_ON); return; }
    const all = new Highlight(...ranges.filter((_, i) => i !== active));
    all.priority = 1;
    h.set(FIND, all);
    const on = new Highlight(...(ranges[active] ? [ranges[active]] : []));
    on.priority = 2;
    h.set(FIND_ON, on);
    const range = ranges[active];
    const el = range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
    if (el && el.scrollIntoView) {
      const r = range.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
  }
  ipcRenderer.page.find = (text, options) => {
    const forward = !(options && options.backward);
    const value = String(text || '');
    if (!value) { ipcRenderer.page.stopFind(true); return { matches: 0, active: 0 }; }
    if (value !== finding.text || !(options && options.findNext)) {
      const ranges = findRanges(value);
      finding = { text: value, ranges, active: ranges.length ? (forward ? 0 : ranges.length - 1) : -1 };
    } else if (finding.ranges.length) {
      finding.active = (finding.active + (forward ? 1 : -1) + finding.ranges.length) % finding.ranges.length;
    }
    ipcRenderer.adopt();
    paintFind();
    return { matches: finding.ranges.length, active: finding.active + 1 };
  };
  ipcRenderer.page.stopFind = (clearSelection) => {
    finding = { text: '', ranges: [], active: -1 };
    const h = registry();
    if (h) { h.delete(FIND); h.delete(FIND_ON); }
    if (clearSelection) { const selection = document.getSelection(); if (selection) selection.removeAllRanges(); }
    return true;
  };
  window.addEventListener('pagehide', () => { finding = { text: '', ranges: [], active: -1 }; });
  // What a right-click is over, for the app's menu (Electron's context-menu params: linkURL, selectionText, isEditable).
  // Sent while the event is dispatched, so it reaches the app before WebKit asks it for the menu.
  window.addEventListener('contextmenu', (event) => {
    const target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    const link = target && target.closest ? target.closest('a[href]') : null;
    const selection = document.getSelection();
    ipcRenderer.send('engelbart-page:context', { linkURL: link ? link.href : '', selectionText: selection ? String(selection) : '', isEditable: !!(target && (isField(target) || target.isContentEditable)) });
  }, true);
'''
marker = "  const load = () => ipcRenderer.invoke(CHANNELS.marks)"
assert marker in body
body = body.replace(marker, find + "\n" + marker)
old_paint = "  function paint() {\n    const h = registry();\n    if (!h) return;"
assert old_paint in body
body = body.replace(old_paint, "  function paint() {\n    ipcRenderer.adopt();\n    const h = registry();\n    if (!h) return;")
footer = '''
if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.webkit) runInPage();
else globalThis.__engelbartPagePure = ''' + exports + ''';
})();
'''
out = header + pure + bridge + body + footer
open(os.path.join(ROOT, 'mac/Packages/Stage/Sources/EngelbartStage/Resources/page.js'), 'w').write(out)
print(len(out.splitlines()))
