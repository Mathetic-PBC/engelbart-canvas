'use strict';

// Real Chromium/React regression: typing must survive parent updates and card redraws.
// Run: npx electron scripts/smoke-canvas-focus.cjs
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const models = require('../src/main/bart/models.cjs').normalizeModels(null);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-focus-'));
app.setPath('userData', scratch);
const bundle = buildSync({
  stdin: { resolveDir: path.join(__dirname, '..'), loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import DocEditor from './src/renderer/workspace/DocEditor.jsx';
    function Fixture() {
      const [text, change] = React.useState('Notes\\n@bart why?\\nbart> because\\n');
      const [tick, update] = React.useState(0);
      const ref = React.useRef();
      window.redraw = () => { update(n => n + 1); change(s => s.replace('bart> because', 'bart> because\\nbart> more answer text')); };
      window.editor = ref;
      return <DocEditor ref={ref} docKey="test" text={text} onChange={change}
        models={JSON.parse(${JSON.stringify(JSON.stringify(models))})} images={{ tick }} onAsk={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(scratch, 'fixture.js'), bundle.outputFiles[0].text);
fs.writeFileSync(path.join(scratch, 'fixture.html'), `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    win.webContents.on('console-message', event => console.log(event.message));
    win.setFocusable(false);
    await win.loadFile(path.join(scratch, 'fixture.html'));
    const wc = win.webContents;
    const js = code => wc.executeJavaScript(code, true);
    await pause(200);
    for (const selector of ['[data-editor]', '[data-follow-input]']) {
      // A finished answer has a Reply button; its field opens once that is pressed (DocEditor replyOpen, 2026-10-13).
      if (selector === '[data-follow-input]') { await js("(() => { if (!document.querySelector('[data-follow-input]')) document.querySelector('[data-act=\"reply\"]').click(); })()"); await pause(100); }
      await js(`(() => { const el = document.querySelector('${selector}'); el.focus(); if (el.dataset.editor) window.editor.current.focusEnd(); })()`);
      await pause(50);
      const text = 'typing keeps working through updates';
      let typed = '';
      for (const ch of text) {
        typed += ch;
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch });
        await js('window.redraw()');
        await pause(20);
        assert.equal(await js(`document.activeElement.matches('${selector}')`), true, `focus lost after ${JSON.stringify(ch)} in ${selector}`);
        if (selector === '[data-editor]') assert.equal(await js("getSelection().anchorNode.parentElement.closest('[data-line]').dataset.raw"), typed, 'the caret must stay on the original editable line');
      }
      const value = await js(`(() => {const el = document.querySelector('${selector}'); return el.value ?? el.textContent;})()`);
      assert.ok(value.includes(text), `typed text was lost: ${value}`);
      console.log('PASS continuous typing and redraws in ' + selector);
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
app.on('quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
