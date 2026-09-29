'use strict';
// Real renderer, IPC, Git and PTYs in an isolated home. Optionally verify a copy
// of an existing saved interface with ENGELBART_SAVED_INTERFACE=/absolute/app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-workspace-repositories-ui-')));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_BUILD_FAKE: '1', ENGELBART_TOOLS: 'off' });
let store, win, wc, pid, wid;
const moduleIpc = require('../src/main/ipc.cjs'), createStore = moduleIpc.createStore;
moduleIpc.createStore = options => (store = createStore(options));
// Exercise each agent's real launch configuration and cwd with an idle PTY in
// place of the CLI. This check never starts a subscription-backed agent.
const { SessionManager } = require('../src/main/terminal/session-manager.cjs');
const createSession = SessionManager.prototype.create, agentLaunches = [];
SessionManager.prototype.create = function (request) {
  if (!['claude', 'codex'].includes(request.provider)) return createSession.call(this, request);
  const pty = this.pty;
  this.pty = { spawn: (file, args, options) => {
    agentLaunches.push({ provider: request.provider, cwd: options.cwd, args });
    return pty.spawn(file, ['-il'], options);
  } };
  try { return createSession.call(this, request); } finally { this.pty = pty; }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async source => {
  try { return await wc.executeJavaScript(source, true); }
  catch (error) { console.error('Failed renderer check:', source); throw error; }
};
const call = (name, ...args) => js(`window.engelbartAPI.${name}(...${JSON.stringify(args)})`);
async function until(check, label) { for (let n = 0; n < 200; n++) { const out = await check(); if (out) return out; await pause(60); } throw new Error(`Timed out: ${label}`); }
async function finish(code) {
  clearTimeout(deadline);
  if (wc && !wc.isDestroyed()) {
    if (pid && wid) await call('stopLocalPreview', pid, wid).catch(() => {});
    await js('window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))').catch(() => {});
  }
  app.exit(code);
}
const deadline = setTimeout(() => { console.error('Repository UI timeout', root); void finish(1); }, 120000);
(async () => {
  try {
    require('../src/main/index.cjs'); await app.whenReady();
    win = await until(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('engelbart://app/')), 'app');
    win.setFocusable(false); win.setSize(1460, 940); win.showInactive(); win.show = () => {}; win.focus = () => {};
    wc = win.webContents;
    await until(() => js('!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await call('createProjectWithWelcome', { name: 'Workspace repositories', path: 'repository-ui-fixed' }); pid = made.project.id; wid = made.workspaceId;
    const generated = made.project.repositories[made.project.defaultRepoId];
    assert.equal(generated.name, 'Workspace repositories');
    const inherited = await call('createWorkspace', pid, { parentId: wid, name: 'Inherited' });
    const child = await call('createWorkspace', pid, { parentId: wid, name: 'Charts', createDefault: true });
    await call('linkToWorkspace', pid, wid, made.project.repositories[made.project.defaultRepoId].libraryId);
    await call('writeDoc', pid, { kind: 'workspace', workspaceId: wid }, '@bart Explain this repository');
    // Reopen an already-migrated project with an old generated label. Library
    // data is deliberately read concurrently during startup by other clients.
    const ctx = await store.context(), projectFile = path.join(made.project.dir, 'project.json');
    const prior = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    prior.repositories[generated.id].name += ' code'; delete prior.repositories[generated.id].autoName;
    require('../src/main/store/home.cjs').writeJson(projectFile, prior);
    await ctx.libraryDb.rename(generated.libraryId, 'Workspace repositories code');
    await call('setLastOpen', { projectId: pid, workspaceId: wid }); wc.reload();
    await until(() => js('document.querySelector("[data-code-context]")?.title.includes("/code")').catch(() => false), 'default code context');
    assert.equal(await js('!!document.querySelector("[data-directory-gate]")'), false);
    const original = (await call('workspaceRepository', pid, wid)).connected;
    assert.equal(original.inherited, true);
    assert.equal(original.name, 'Workspace repositories');
    assert.equal((await call('workspaceRepository', pid, inherited.id)).connected.repoId, original.repoId);
    assert.equal(fs.existsSync(path.join(made.project.dir, 'Getting started', 'Inherited', 'code')), false);
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.includes("Workspace repositories")'), 'Bart inherited code context');
    const terminal = (provider, cwd) => js(`window.terminalAPI.createSession(${JSON.stringify({ provider, cwd, projectId: pid, workspaceId: wid, cols: 80, rows: 24 })})`);
    const first = await terminal('shell', original.directory);
    assert.equal(first.repoId, null); assert.equal(first.cwd, original.directory);
    const agentDirs = Object.fromEntries(['codex', 'claude'].map(provider => {
      const directory = path.join(root, `${provider}-work`); fs.mkdirSync(directory); return [provider, directory];
    }));
    const before = await Promise.all(Object.entries(agentDirs).map(async ([provider, directory]) => {
      const session = await terminal(provider, directory); assert.equal(session.cwd, directory); return session;
    }));
    await js('document.querySelector("[data-rail-section-toggle=GitHub]").click()');
    await until(() => js(`document.querySelector('[data-repo-item-actions="${original.libraryId}"]')?.getAttribute('aria-label') === 'Repository actions for Workspace repositories'`), 'migrated sidebar name');
    assert.equal(await js('document.querySelector("[data-code-context]").textContent.trim()'), 'Code context: Workspace repositories ⌄');
    await js('document.querySelector("[data-build-doc]").click()');
    await until(() => js('document.querySelector("[data-build-panel] [data-repository-toggle]")?.textContent.trim() === "Build in: Workspace repositories"'), 'migrated Build name');
    // A custom project path permits this title-only rename even while the
    // independent terminals are open. Both mounted selectors update in place.
    const renamedProject = await call('renameProject', pid, 'Renamed repositories');
    assert.equal(renamedProject.dir, made.project.dir);
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.includes("Code context: Renamed repositories") && document.querySelector("[data-build-panel] [data-repository-toggle]")?.textContent.trim() === "Build in: Renamed repositories"'), 'renamed synchronized selectors');
    await until(() => js(`document.querySelector('[data-repo-item-actions="${original.libraryId}"]')?.getAttribute('aria-label') === 'Repository actions for Renamed repositories'`), 'renamed sidebar');
    const renamedRecord = (await call('workspaceRepository', pid, wid)).connected;
    assert.equal(renamedRecord.repoId, original.repoId); assert.equal(renamedRecord.libraryId, original.libraryId);
    assert.equal(renamedRecord.directory, original.directory);
    const afterRename = await js('window.terminalAPI.bootstrap().then(s=>s.sessions)');
    for (const session of [first, ...before]) assert.equal(afterRename.find(row => row.id === session.id).cwd, session.cwd);
    fs.writeFileSync(path.join(root, 'project-repository-name.png'), (await wc.capturePage()).toPNG());
    await call('renameLibraryItem', original.libraryId, 'My custom repository');
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.includes("Code context: My custom repository") && document.querySelector("[data-build-panel] [data-repository-toggle]")?.textContent.trim() === "Build in: My custom repository"'), 'custom label synchronized');
    await call('renameProject', pid, 'Another project title');
    assert.equal((await call('workspaceRepository', pid, wid)).connected.name, 'My custom repository', 'project rename preserves custom labels');
    await js('document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector("[data-build-panel]")'), 'naming check Build panel closed');
    await js('document.querySelector("[data-rail-section-toggle=GitHub]").click()');
    assert.equal(await js('!!document.querySelector("[data-workspace-repository]")'), false, 'no repository row beneath the title');
    assert.equal(await js('!!document.querySelector("[data-doc-title]")'), true, 'workspace title remains');
    assert.equal(await js('!!document.querySelector("[data-repository-chooser]")'), false, 'closed initially');
    await js('document.querySelector("[data-code-context]").click()');
    await until(() => js('!!document.querySelector("[data-repository-chooser]")'), 'chooser');
    await until(() => js('document.activeElement?.getAttribute("aria-checked") === "true"'), 'selected repository focused');
    assert.equal(await js('!!document.querySelector("[data-repository-inherit]")'), false, 'no Project default row');
    assert.equal(await js('document.activeElement?.getAttribute("data-repository-option")'), original.repoId, 'inherited repository stays selected');
    assert.equal(await js('document.querySelector("[data-repository-chooser]").textContent.includes("Connect local repository")'), false);
    assert.equal(await js('document.querySelector("[data-repository-chooser]").textContent.includes("Create separate workspace")'), false);
    await js('document.activeElement.dispatchEvent(new MouseEvent("mouseover", {bubbles:true}))');
    assert.equal(await js('!!document.querySelector("[data-repository-chooser] [role=tooltip]")'), false, 'no separate name/path box on focus or hover');
    assert.equal(await js(`document.querySelector('[data-repository-chooser]').textContent.includes(${JSON.stringify(original.directory)})`), false, 'no visible path field in picker');
    fs.writeFileSync(path.join(root, 'repository-picker-clean.png'), (await wc.capturePage()).toPNG());
    await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector("[data-repository-chooser]")'), 'Escape closes chooser');
    assert.equal(await js('document.activeElement?.hasAttribute("data-code-context")'), true);
    await js('document.querySelector("[data-code-context]").click()');
    await until(() => js('!!document.querySelector("[data-repository-chooser]")'), 'reopened chooser');
    await js(`document.querySelector('[data-repository-option="${child.repoId}"]').click()`);
    await until(async () => (await call('workspaceRepository', pid, wid)).repoId === child.repoId, 'connection changed');
    const selected = (await call('workspaceRepository', pid, wid)).connected;
    assert.notEqual(selected.directory, original.directory);
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.includes("Charts code")'), 'Bart reflects repository selection');
    await js('document.querySelector("[data-build-doc]").click()');
    await until(() => js('document.querySelector("[data-build-panel] [data-repository-toggle]")?.textContent.includes("Build in: Charts code")'), 'Build shares the override');
    await pause(250); // capture the settled panel, not its entry animation
    fs.writeFileSync(path.join(root, 'repository-build-controls.png'), (await wc.capturePage()).toPNG());
    // The simplified picker hides the inheritance action; existing inherited
    // connections and the API still resolve the same shared project default.
    await call('connectWorkspaceRepository', pid, wid, { useProjectDefault: true });
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.includes("My custom repository") && document.querySelector("[data-build-panel] [data-repository-toggle]")?.textContent.includes("My custom repository")'), 'both selectors inherit together');
    await js('document.querySelector("[data-build-panel] [data-repository-toggle]").click()');
    await until(() => js('!!document.querySelector("[data-project-default-action]")'), 'separate default action');
    await js('document.querySelector("[data-project-default-action]").click()');
    await until(() => js('document.querySelector("[data-repository-chooser]")?.getAttribute("aria-label") === "Project default repository"'), 'project-wide scope is explicit');
    await js(`document.querySelector('[data-repository-option="${child.repoId}"]').click()`);
    await until(() => js('document.querySelector("[data-code-context]")?.textContent.trim() === "Code context: Charts code ⌄"'), 'Bart follows a changed project default');
    assert.equal((await call('workspaceRepository', pid, inherited.id)).connected.repoId, child.repoId);
    await js('document.body.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    await until(() => js('!document.querySelector("[data-build-panel]")'), 'Build panel closed');
    await js('document.querySelector("[data-code-context]").click()');
    await until(() => js('!!document.querySelector("[data-repository-chooser]")'), 'Bart opens the shared chooser');
    await js(`document.querySelector('[data-repository-option="${child.repoId}"]').click()`);
    await until(async () => (await call('workspaceRepository', pid, wid)).repoId === child.repoId, 'Bart makes an explicit override');
    await js('document.querySelector("[data-rail-section-toggle=GitHub]").click()');
    await until(() => js(`!!document.querySelector('[data-repo-item-actions="${original.libraryId}"]')`), 'repository sidebar actions');
    await js(`document.querySelector('[data-repo-item-actions="${original.libraryId}"]').click()`);
    await until(() => js('!!document.querySelector("[data-repo-item-menu] button")'), 'repository item menu');
    await js('document.querySelector("[data-repo-item-menu] button").click()');
    await until(async () => (await call('workspaceRepository', pid, wid)).repoId === original.repoId, 'Use for this workspace');
    await call('connectWorkspaceRepository', pid, wid, { repoId: child.repoId });
    const answer = await call('askBart', pid, { askId: 'repository-ui-question', workspaceId: wid, ref: { kind: 'workspace', workspaceId: wid }, text: '@bart Explain this repository', repository: original });
    assert.equal(answer.meta.repository.repoId, child.repoId, 'main captures the authoritative repository, not renderer input');
    const question = JSON.parse(fs.readFileSync(path.join(made.project.dir, '.bart/questions/repository-ui-question.json'), 'utf8'));
    assert.equal(question.repository.repoId, child.repoId); assert.equal(question.status, 'answered');
    fs.writeFileSync(path.join(root, 'repository-bart-controls.png'), (await wc.capturePage()).toPNG());
    const second = await terminal('shell', original.directory);
    assert.equal(second.repoId, null); assert.equal(second.cwd, original.directory);
    for (const [provider, directory] of Object.entries(agentDirs)) {
      const fresh = await terminal(provider, directory);
      assert.equal(fresh.cwd, directory); assert.equal(fresh.repoId, null);
    }
    const sessions = await js('window.terminalAPI.bootstrap().then(s=>s.sessions)');
    assert.equal(sessions.find(session => session.id === first.id).cwd, original.directory);
    for (const session of before) assert.equal(sessions.find(row => row.id === session.id).cwd, session.cwd);
    assert.equal(agentLaunches.length, 4);
    for (const launch of agentLaunches) {
      assert.equal(launch.cwd, agentDirs[launch.provider]);
      assert.ok(launch.args[1].includes(`${launch.provider};`));
    }
    // An unavailable Build target cannot prevent using an unrelated terminal.
    fs.renameSync(selected.directory, selected.directory + '-unavailable');
    try { assert.equal((await terminal('shell', root)).cwd, root); }
    finally { fs.renameSync(selected.directory + '-unavailable', selected.directory); }
    // Renderer reload must reattach those same sessions and + must inherit the
    // current terminal directory, not the workspace's newly selected repository.
    wc.reload();
    await until(() => js('!!document.querySelector("[data-right-mode=terminal]")').catch(() => false), 'terminal switch');
    await js('document.querySelector("[data-right-mode=terminal]").click()');
    await until(() => js(`document.querySelector('[data-term-path]')?.title === ${JSON.stringify(original.directory)}`), 'original terminal restored');
    const oldIds = new Set((await js('window.terminalAPI.bootstrap().then(s=>s.sessions)')).map(session => session.id));
    await js('document.querySelector("[title=\\"New terminal (⌘T) in the current directory\\"]").click()');
    const added = await until(async () => (await js('window.terminalAPI.bootstrap().then(s=>s.sessions)')).find(session => !oldIds.has(session.id)), 'new terminal from +');
    assert.equal(added.cwd, original.directory);
    await js('document.querySelector("[data-right-mode=stage]").click()');
    // Same project/workspace UI, but no session runs in the folder being moved.
    await call('renameWorkspace', pid, wid, 'Independent sessions allowed');
    assert.ok(fs.existsSync(path.join(made.project.dir, 'Independent sessions allowed', 'Charts', 'code', '.git')));
    await call('renameWorkspace', pid, wid, 'Getting started');
    await terminal('shell', selected.directory);
    await assert.rejects(call('renameWorkspace', pid, wid, 'Renamed'), /Close.*terminals/);
    assert.ok(fs.existsSync(original.directory));
    await js('window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
    await call('renameWorkspace', pid, wid, 'Renamed');
    const tree = await call('loadProject', pid);
    assert.equal(tree.workspaces[0].repoId, child.repoId);
    assert.ok(fs.existsSync(path.join(tree.project.dir, 'Renamed', 'Charts', 'code', '.git')));
    await call('setLastOpen', { projectId: pid, workspaceId: wid }); wc.reload();
    await until(() => js('document.querySelector("[data-code-context]")?.title.includes("Renamed/Charts/code")').catch(() => false), 'renamed code context');
    fs.writeFileSync(path.join(root, 'workspace-header.png'), (await wc.capturePage()).toPNG());
    await js('document.querySelector("[data-code-context]").click()');
    await until(() => js('document.activeElement?.getAttribute("aria-checked") === "true"'), 'chooser focus after rename');
    await pause(150);
    fs.writeFileSync(path.join(root, 'repository-chooser.png'), (await wc.capturePage()).toPNG());
    await js('document.querySelector("[data-doc-title]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await until(() => js('!document.querySelector("[data-repository-chooser]")'), 'click away closes menu');
    win.setSize(1000, 720);
    await pause(150);
    await js('document.querySelector("[data-code-context]").click()');
    await until(() => js('document.activeElement?.getAttribute("aria-checked") === "true"'), 'narrow chooser');
    await pause(150);
    assert.ok(await js('(()=>{const r=document.querySelector("[data-repository-chooser]").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()'), 'menu fits narrow window');
    fs.writeFileSync(path.join(root, 'repository-narrow.png'), (await wc.capturePage()).toPNG());
    await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
    win.setSize(1460, 940);
    let savedInterface = null;
    if (process.env.ENGELBART_SAVED_INTERFACE) {
      const source = fs.realpathSync(process.env.ENGELBART_SAVED_INTERFACE);
      const recipe = require('../src/main/local-preview/files.cjs').readRecipe(source);
      assert.equal(recipe.install, null, 'this smoke test does not install dependencies');
      const ctx = await store.context(), where = require('../src/main/local-preview/files.cjs').locations(ctx, pid, wid, true);
      fs.cpSync(source, where.directory, { recursive: true, filter: file => !['node_modules', '.env', '.env.local'].includes(path.basename(file)) });
      require('../src/main/local-preview/files.cjs').saveState(where, { id: where.id, projectId: pid, workspaceId: wid, directory: where.directory, name: recipe.name, recipe, runId: 'saved-interface-check', logs: [], status: 'stopped' });
      await js(`window.repositoryRestart = window.engelbartAPI.restartLocalPreview(${JSON.stringify(pid)},${JSON.stringify(wid)}).then(value => ({value}), error => ({error:String(error)})); true`);
      const awaiting = await until(async () => { const state = await call('localPreview', pid, wid); return state?.approval && state; }, 'restart approval');
      await call('approveLocalPreview', pid, wid, awaiting.approval.id, true);
      const result = await js('window.repositoryRestart');
      assert.ok(!result.error, result.error); assert.equal(result.value.status, 'ready');
      const response = await fetch(result.value.url); assert.equal(response.status, 200);
      savedInterface = { name: recipe.name, status: result.value.status, html: (await response.text()).length, originalUntouched: fs.existsSync(source) };
      await call('stopLocalPreview', pid, wid);
    }
    console.log(JSON.stringify({ ok: true, root, savedInterface, checks: ['one project default and nested inheritance', 'automatic project names; migration and rename update sidebar/Bart/Build labels', 'explicit workspace repository', 'synchronized Bart/Build selectors', 'separate project-default action', 'sidebar Use for this workspace', 'workspace title without repository row; Code context keyboard menu', 'narrow window layout', 'existing and new shell/Codex/Claude directories stay independent', 'missing Build repository does not block terminals', 'unrelated terminals permit rename; affected terminals refuse before filesystem changes', 'rename updates disconnected and nested repositories'] }));
    await finish(0);
  } catch (error) {
    console.error(error.stack, root);
    if (wc && !wc.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await wc.capturePage()).toPNG());
    await finish(1);
  }
})();
