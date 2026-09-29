'use strict';
// Separate Electron processes, one disposable home. No real models or user data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-session-smoke-')));
  for (const phase of ['write', 'read', 'annotations', 'recording', 'edit', 'missing', 'home']) {
    if (phase === 'missing') fs.unlinkSync(JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'))).textFile);
    const result = spawnSync(require('electron'), [__filename, phase, root], { stdio: 'inherit', timeout: 90000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    if (result.status !== 0) { console.error('Failed phase', phase, root, result.error || result.signal); process.exit(1); }
  }
  console.log(JSON.stringify({ ok: true, root, checks: ['separate-process restart', 'window and panel geometry', 'sidebar and nested folders', 'active note and document scroll', 'last-keystroke document save', 'unsent reply', 'local file tabs and scroll', 'PDF page and zoom', 'annotation selection and draft without live website', 'recording selection and seek', 'home screen', 'no resumed agents or live pages'] }));
} else {
  const { app, BrowserWindow, webContents } = require('electron');
  const [, , phase, root] = process.argv;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_BUILD_FAKE: '1', ENGELBART_TOOLS: 'off' });
  let win, wc, server;
  const stateFile = path.join(root, 'fixture.json');
  let fixture = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
  const saveFixture = () => fs.writeFileSync(stateFile, JSON.stringify(fixture));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => wc.executeJavaScript(code, true).catch(error => { console.error('Renderer script:', code.slice(0, 700)); throw error; });
  const call = (method, ...args) => js(`window.engelbartAPI.${method}(...${JSON.stringify(args)})`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => js(`(() => {const el=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const open = url => js(`window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(url)}}}))`);
  const until = async (fn, label) => { for (let i = 0; i < 220; i++) { if (await fn()) return; await pause(60); } throw new Error(`Timed out: ${label}`); };
  const waitFor = selector => until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false), selector);
  const quit = () => { saveFixture(); console.log('Verified phase:', phase); app.quit(); };
  const deadline = setTimeout(() => { console.error('Restart smoke timed out', phase, root); app.exit(1); }, 80000);
  app.on('will-quit', () => { clearTimeout(deadline); server?.close(); });
  const pdfFile = () => {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
    for (let n = 1; n <= 3; n++) {
      const text = `BT /F1 18 Tf 50 740 Td (Page ${n}) Tj ET`;
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${n * 2 + 2} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    }
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    let file = '%PDF-1.4\n', offsets = [0];
    objects.forEach((value, i) => { offsets.push(Buffer.byteLength(file)); file += `${i + 1} 0 obj\n${value}\nendobj\n`; });
    const at = Buffer.byteLength(file);
    file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    const target = path.join(root, 'reading.pdf'); fs.writeFileSync(target, file); return target;
  };
  const selectStage = name => js(`(() => { const title=[...document.querySelectorAll('[data-stage-tab-title]')].find(el=>el.textContent===${JSON.stringify(name)}); title.parentElement.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); })()`);
  const options = async kind => { await click('[data-stage] [aria-label="More"]'); await waitFor(`[data-${kind}-browse]`); await click(`[data-${kind}-browse]`); };
  require('../src/main/index.cjs');
  (async () => {
    try {
      await app.whenReady();
      await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('engelbart://app/')); return win; }, 'window');
      win.setFocusable(false); win.showInactive(); win.show = () => {}; win.focus = () => {};
      wc = win.webContents;
      await until(() => js('!!window.engelbartAPI').catch(() => false), 'bridge');
      if (phase === 'write') {
        const made = await call('createProjectWithWelcome', { name: 'Resume test' });
        Object.assign(fixture, { pid: made.project.id, wid: made.workspaceId, nid: made.noteId });
        const text = ['@bart Explain this', 'bart> Saved answer.', '', ...Array.from({ length: 90 }, (_, i) => `Research paragraph ${i}. ${'Notes and observations. '.repeat(4)}`), ''].join('\n');
        await call('writeDoc', fixture.pid, { kind: 'note', id: fixture.nid }, text);
        await call('setView', fixture.pid, fixture.wid, { active: fixture.nid, tabs: [{ id: fixture.nid, title: 'Welcome!' }], positions: {} });
        await call('setLastOpen', { projectId: fixture.pid, workspaceId: fixture.wid });
        await call('saveSessionUI', { 'app:screen': 'workspace' });
        wc.reload(); await waitFor('[data-follow-input]');
        assert.equal(await js('document.querySelectorAll("[data-rail-section-toggle][aria-expanded=true]").length'), 0);
        await click('[data-rail-section-toggle="Files"]');
        await waitFor('[data-rail-subsection-toggle="Files/images"]');
        await click('[data-rail-subsection-toggle="Files/images"]');
        await click('[data-rail-section-toggle="Documents"]');
        await click('[data-projects-toggle="google"]');
        // Real pointer handlers, with the pointer capture stubbed for synthetic input.
        await js(`(() => {for(const [name,delta] of [['Resize sidebar',-34],['Resize right panel',-45]]){const el=document.querySelector('[aria-label="'+name+'"]');if(!el)throw Error(name);el.setPointerCapture=()=>{};el.hasPointerCapture=()=>true;el.releasePointerCapture=()=>{};const x=el.getBoundingClientRect().x;for(const [type,dx]of [['pointerdown',0],['pointermove',delta],['pointerup',delta]])el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,clientX:x+dx,button:0}));}})()`);
        win.setBounds({ x: 60, y: 60, width: 1280, height: 800 });
        fixture.pdf = pdfFile(); fixture.textFile = path.join(root, 'research.txt');
        fs.writeFileSync(fixture.textFile, Array.from({ length: 300 }, (_, i) => `Local file line ${i}`).join('\n'));
        await open(fixture.pdf); await waitFor('[data-pdf] [data-page="2"]');
        await click('[aria-label="Zoom in"]'); await pause(300);
        await js(`(() => {const page=document.querySelector('[data-pdf] [data-page="2"]');let box=page.parentElement;while(box&&getComputedStyle(box).overflowY!=='auto')box=box.parentElement;box.scrollTop=page.offsetTop+45;box.dispatchEvent(new Event('scroll'));})()`);
        await pause(150);
        await open(fixture.textFile); await waitFor('[data-stage-view="text"]');
        await js(`(() => {const box=document.querySelector('[data-stage-view="text"]');box.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));box.scrollTop=750;box.dispatchEvent(new Event('scroll'));})()`);
        await input('[data-follow-input]', 'Unsent follow-up');
        await js(`(() => {const ed=document.querySelector('[data-editor]');const box=ed.parentElement.parentElement;box.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));box.scrollTop=550;box.dispatchEvent(new Event('scroll'));})()`);
        fixture.bounds = win.getNormalBounds();
        fixture.widths = await js(`({rail:document.querySelector('[aria-label="Sidebar"]').getBoundingClientRect().width,right:document.querySelector('[aria-label="Right pane"]').getBoundingClientRect().width})`);
        // Quit immediately after editing, before the 400 ms autosave can run.
        await js(`(() => {const ed=document.querySelector('[data-editor]');ed.focus({preventScroll:true});const line=[...ed.querySelectorAll('[data-line]')].find(el=>el.dataset.raw?.startsWith('Research paragraph 0'));const range=document.createRange();range.selectNodeContents(line.querySelector('.t'));getSelection().removeAllRanges();getSelection().addRange(range);})()`);
        await js(`(() => {const line=[...document.querySelectorAll('[data-editor] [data-line]')].find(el=>el.dataset.raw?.startsWith('Research paragraph 0'));const text=line.querySelector('.t');text.textContent='Final keystroke before quit';const range=document.createRange();range.selectNodeContents(text);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);text.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        assert.ok(await js('document.querySelector("[data-editor]").innerText.includes("Final keystroke before quit")'), 'editor accepted input');
        await js(`(() => {const box=document.querySelector('[data-editor]').parentElement.parentElement;box.dispatchEvent(new WheelEvent('wheel',{bubbles:true}));box.scrollTop=550;box.dispatchEvent(new Event('scroll'));})()`);
        quit();
      } else if (phase === 'home') {
        await until(() => js('document.body.innerText.includes("Resume test") && !document.querySelector("[data-editor]")'), 'home restored');
        assert.equal((await call('sessionUI'))['app:screen'], 'home');
        quit();
      } else {
        await waitFor('[data-follow-input]');
        assert.equal(await js('document.querySelector("[data-follow-input]").value'), 'Unsent follow-up');
        assert.ok((await call('readDoc', fixture.pid, { kind: 'note', id: fixture.nid })).includes('Final keystroke before quit'), 'last document keystroke was saved');
        assert.equal(await js('document.querySelector("[data-rail-section-toggle=Files]").getAttribute("aria-expanded")'), 'true');
        assert.equal(await js('document.querySelector("[data-rail-subsection-toggle=\\"Files/images\\"]").getAttribute("aria-expanded")'), 'true');
        assert.equal(await js('document.querySelector("[data-projects-toggle=google]").getAttribute("aria-expanded")'), 'true');
        assert.equal(await js('window.terminalAPI.bootstrap().then(s=>s.sessions.length)'), 0);
        assert.equal(webContents.getAllWebContents().filter(w => /^https?:/.test(w.getURL())).length, 0, 'websites remain closed');
        if (phase === 'read') {
          assert.deepEqual(win.getNormalBounds(), fixture.bounds);
          const widths = await js(`({rail:document.querySelector('[aria-label="Sidebar"]').getBoundingClientRect().width,right:document.querySelector('[aria-label="Right pane"]').getBoundingClientRect().width})`);
          assert.deepEqual(widths, fixture.widths);
          await waitFor('[data-stage-view="text"]');
          await until(() => js('Math.abs(document.querySelector("[data-stage-view=text]").scrollTop-750)<2'), 'file scroll');
          assert.ok(await js('document.querySelector("[data-editor]").parentElement.parentElement.scrollTop > 500'), 'document scroll');
          await selectStage('reading'); await waitFor('[data-pdf] [data-page="2"]');
          await until(() => js(`(()=>{let el=document.querySelector('[data-pdf] [data-page="2"]');while(el&&getComputedStyle(el).overflowY!=='auto')el=el.parentElement;return el&&el.scrollTop>500;})()`), 'PDF scroll');
          assert.equal(await js(`document.querySelector('[title="100% = fit width"]').textContent`), '110%');
          server = require('node:http').createServer((_req, res) => res.end('<!doctype html><title>Resume fixture</title><button id="target">Review</button>'));
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          fixture.url = `http://127.0.0.1:${server.address().port}/`;
          await open(fixture.url); await until(() => js('!!document.querySelector("[data-record-toggle]:not(:disabled)")'), 'live fixture');
          const tabId = await js(`document.querySelector('[data-stage-tab-title][title="Resume fixture"]').closest('[data-stage-tab]').dataset.stageTab`);
          await call('recordingStart', tabId, fixture.pid); await pause(700); await call('recordingStop');
          fixture.recording = (await call('recordingList', fixture.pid, fixture.url))[0];
          fixture.annotation = await call('createInterfaceAnnotation', { projectId: fixture.pid, url: fixture.url }, { body: 'Saved annotation', anchor: { route: '/', frames: [], ancestors: [], element: { tag: 'button', selector: '#target', text: 'Review' } } });
          await options('annotations'); await waitFor('.ia-list button'); await click('.ia-list button');
          await js(`(()=>{const button=[...document.querySelectorAll('.ia-actions button')].find(el=>el.textContent==='Ask Bart');button.click();})()`);
          await waitFor('[aria-label="Message Bart"]');
          await input('[aria-label="Message Bart"]', 'Unsent annotation reply');
          quit();
        } else if (phase === 'annotations') {
          await waitFor('[aria-label="Message Bart"]');
          assert.equal(await js(`document.querySelector('[aria-label="Message Bart"]').value`), 'Unsent annotation reply');
          assert.match(await js('document.querySelector(".interface-annotations").innerText'), /Saved annotation/);
          await click('[aria-label="Close annotations"]');
          // Put the saved recording in front, just as choosing it in the list does.
          await call('saveSessionUI', { [`stage:${fixture.pid}:panel`]: { kind: 'recordings', url: fixture.url }, [`recordings:${fixture.pid}:${fixture.url}:selected`]: fixture.recording, [`recording-position:${fixture.pid}:${fixture.recording.id}`]: 350 });
          wc.reload(); await waitFor('[aria-label="Recording playback"]');
          await until(() => js('document.querySelector(".recording-progress input")?.disabled===false || document.querySelector("input[type=range]")?.disabled===false'), 'replay ready');
          quit();
        } else if (phase === 'recording') {
          await waitFor('[aria-label="Recording playback"]');
          await until(() => js('Number(document.querySelector("input[type=range]")?.value)>=300'), 'recording seek restored');
          assert.equal(await js('!!document.querySelector("[aria-label=Pause]")'), false, 'replay is paused on launch');
          fixture.editNote = await call('createInterfaceAnnotation', { projectId: fixture.pid, url: fixture.url }, { body: 'Original note', anchor: fixture.annotation.anchor });
          await call('saveSessionUI', { [`stage:${fixture.pid}:panel`]: { kind: 'annotations', url: fixture.url }, [`annotation:${fixture.pid}:${fixture.url}:selected`]: fixture.editNote.id, [`annotation:${fixture.pid}:${fixture.url}:editing`]: true, [`annotation:${fixture.pid}:${fixture.url}:body`]: 'Unsaved note edit' });
          wc.reload(); await waitFor('[aria-label="Annotation note"]');
          quit();
        } else if (phase === 'edit') {
          await waitFor('[aria-label="Annotation note"]');
          assert.equal(await js(`document.querySelector('[aria-label="Annotation note"]').value`), 'Unsaved note edit');
          await call('deleteInterfaceAnnotation', { projectId: fixture.pid, url: fixture.url }, fixture.editNote.id);
          const saved = await call('sessionUI'), local = saved[`stage:${fixture.pid}:local-tabs`];
          await call('saveSessionUI', { [`stage:${fixture.pid}:local-tabs`]: { ...local, active: fixture.textFile } });
          quit();
        } else {
          await waitFor('[data-stage-view="error"]');
          await until(() => js(`!!document.querySelector('.ia-list[aria-busy="false"]')`), 'deleted annotation fallback');
          assert.equal(await js(`!!document.querySelector('[aria-label="Annotation note"]')`), false);
          await click('[aria-label="Close annotations"]');
          // Home is a persistent view too.
          await call('saveSessionUI', { 'app:screen': 'home' });
          wc.reload(); await until(() => js('!document.querySelector("[data-editor]") && document.body.innerText.includes("Resume test")'), 'home');
          quit();
        }
      }
    } catch (error) { console.error(error.stack, phase, root); clearTimeout(deadline); server?.close(); app.exit(1); }
  })();
}
