'use strict';
// Optional real-subscription smoke. Builds one tiny app in disposable data, using
// the configured provider. No real workspace or library context is supplied.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureHome, readJson } = require('../src/main/store/home.cjs');
const { normalizeModels, MODELS_FILE } = require('../src/main/bart/models.cjs');
const { createProcesses } = require('../src/main/local-preview/process.cjs');
const { createBuildAgent } = require('../src/main/local-preview/agent.cjs');
const { createLocalPreviews } = require('../src/main/local-preview/manager.cjs');
const { createBrowserVerifier } = require('../src/main/local-preview/verify.cjs');
const projects = require('../src/main/store/projects.cjs');
const db = require('../src/main/store/db.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-real-local-build-'));
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {}); // the verifier's hidden window is not this harness's lifetime
let manager, bart;
const timeout = setTimeout(() => { console.error('Real-agent smoke timed out'); void finish(1); }, 420_000);
async function finish(code) {
  clearTimeout(timeout);
  bart?.stopAll();
  await manager?.close();
  await db.closeAll();
  app.exit(code);
}
(async () => {
  try {
    await app.whenReady();
    const layout = ensureHome(root);
    const ctx = { homeDir: root, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
    const project = await projects.createProject(ctx, { name: 'Real-agent smoke', directory: root });
    const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Counter' });
    await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, '# Counter\nUse a warm-white background and charcoal text.');
    const models = normalizeModels(readJson(path.join(os.homedir(), '.engelbart', MODELS_FILE)));
    const provider = process.argv.includes('--claude') ? 'anthropic' : models.provider;
    const selected = models.providers[provider].ladder[0];
    const processes = createProcesses();
    const run = processes.run;
    processes.run = async (command, options) => {
      const result = await run(command, options);
      if (options?.env?.ENGELBART_PLAN_INPUT && options.onData) {
        const final = require('../src/main/context/summarizer.cjs').lastResultLine(result.stdout);
        if (final && !final.is_error) fs.writeFileSync(path.join(root, 'planner-result.json'), JSON.stringify(final, null, 2), { mode: 0o600 });
      }
      return result;
    };
    manager = createLocalPreviews({ processes, confirm: async () => true,
      planner: require('../src/main/local-preview/plan.cjs').createBuildPlanner({ readModels: () => models, processes, runDirectory: path.join(root, 'plans') }),
      agent: createBuildAgent({ readModels: () => models, processes, runDirectory: path.join(root, 'runs'), codexHome: path.join(root, 'codex-build-home') }),
      verify: createBrowserVerifier({ BrowserWindow }),
    });
    const input = {
      askId: randomUUID(), workspaceId: workspace.id, ref: { kind: 'workspace', workspaceId: workspace.id }, turns: [],
      text: `--${selected.model} --medium Create the smallest working browser counter. Use dependency-free index.html and a Node built-in HTTP server in server.cjs (no npm packages or installs). Show a heading, a number initially zero and an Increment button that updates the number. Follow the workspace colors.`,
    };
    bart = require('../src/main/bart/ask.cjs').createBart({ readModels: () => models, runDirectory: path.join(root, 'read-runs'), codexHome: path.join(root, 'codex-read-home') });
    const proposed = await bart.ask(ctx, project.id, input);
    assert.ok(proposed.buildProposal, 'a natural build request produces a proposal without --build');
    const out = await manager.build(ctx, project.id, { ...input, buildRequest: proposed.buildProposal.request }, { onProgress: update => { if (update.activity) console.log(update.activity); } });
    assert.equal(out.preview.status, 'ready');
    assert.ok(fs.existsSync(path.join(out.preview.directory, '.git')));
    const html = await (await fetch(out.preview.url)).text();
    assert.match(html, /button/i);
    const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `counter-probe-${randomUUID()}` } });
    try {
      await probe.loadURL(out.preview.url);
      const changed = await probe.webContents.executeJavaScript(`(async () => {
        const button = [...document.querySelectorAll('button')].find(node => /increment/i.test(node.textContent));
        if (!button) return false;
        const before = document.body.innerText;
        button.click();
        await new Promise(resolve => setTimeout(resolve, 100));
        return document.body.innerText !== before;
      })()`);
      assert.equal(changed, true, 'the real counter updates when clicked');
    } finally { probe.destroy(); }
    console.log(JSON.stringify({ ok: true, root, provider, model: out.meta.level.model, naturalProposal: true, counterIncremented: true, plannedBy: out.preview.plan.by, steps: out.preview.plan.steps.map(row => ({ title: row.title, status: row.status })), status: out.preview.status, recipe: out.preview.recipe, libraryId: out.preview.libraryId }));
    await finish(0);
  } catch (error) { console.error(error.message); console.error({ root }); await finish(1); }
})();
