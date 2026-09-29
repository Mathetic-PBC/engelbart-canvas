'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const repositories = require('../src/main/store/workspace-repositories.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');
const { createBart, createThreads, threadKey } = require('../src/main/bart/ask.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { buildPreviewTabChanges } = require('../src/renderer/workspace/build-preview-tabs.js');
const { affectedBy, busyReason } = require('../src/main/store/repository-activity.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-repository-context-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(() => db.closeAll());

test('unmentioned Context repositories have absolute paths and read grants without changing the working repository', async () => {
  const project = await projects.createProject(ctx, 'Context paths');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Question' });
  const source = path.join(homeDir, 'read-only-source');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'README.md'), 'Context source');
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Source repo', type: 'folder', tags: ['git'], path: null, folder_path: source });
  const remote = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Remote repo', type: 'website', tags: ['git'], url: 'https://github.com/example/source' });
  await projects.linkToWorkspace(ctx, project.id, workspace.id, [row.id, remote.id]);
  const before = repositories.resolve(ctx, project.id, workspace.id);
  const context = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'paths' });
  const entries = JSON.parse(context.contextJson.replace(/^<context_json>\n|\n<\/context_json>$/g, ''));
  const entry = entries.find(entry => entry.name === row.name);
  assert.equal(entry.mentioned, false);
  assert.equal(entry.path, source); assert.equal(entry.folderPath, source);
  assert.equal(fs.readFileSync(path.join(entry.path, 'README.md'), 'utf8'), 'Context source');
  assert.ok(context.dirs.includes(source));
  assert.equal(entries.find(entry => entry.name === remote.name).path, null);
  assert.equal(context.repository.repoId, before.repoId);
  assert.equal(context.repository.directory, before.directory);
  assert.equal(repositories.resolve(ctx, project.id, workspace.id).repoId, before.repoId);
});

for (const restart of [false, true]) for (const move of ['rename workspace', 'move workspace', 'rename project']) {
  test(`Bart follow-up refreshes location after ${move}${restart ? ' and restart' : ''}, keeping conversation history`, async () => {
    const project = await projects.createProject(ctx, `${move} ${restart}`);
    const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Before', createDefault: move !== 'move workspace' });
    const beforeWorkspace = projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir;
    const parent = await projects.createWorkspace(ctx, project.id, { name: 'Parent' });
    const ref = { kind: 'workspace', workspaceId: workspace.id };
    const before = repositories.resolve(ctx, project.id, workspace.id);
    const file = path.join(homeDir, `${project.id}-threads.json`);
    const threads = () => createThreads({ file, setTimer: () => null, clearTimer: () => {} });
    const calls = [];
    const makeBart = () => createBart({ readModels: () => normalizeModels(null), threads: threads(), runDirectory: path.join(homeDir, 'runs'), environment: { PATH: process.env.PATH, SHELL: '/bin/zsh', HOME: homeDir }, run(_shell, args, options, callback) {
      calls.push({ command: args.at(-1), input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
      callback(null, JSON.stringify({ type: 'result', subtype: 'success', result: `answer ${calls.length}`, is_error: false }) + '\n');
    } });
    let bart = makeBart();
    const turns = [];
    const ask = async text => {
      const result = await bart.ask(ctx, project.id, { askId: `ask-${turns.length}`, ref, workspaceId: workspace.id, text, turns: [...turns] });
      turns.push({ question: text, answer: result.lines[0].replace('bart> ', '') });
    };
    await ask('--opus first question');
    await ask('--opus second question');
    assert.match(calls[1].command, / --resume /, 'unchanged location still resumes');
    const document = '@bart first question\nbart> answer 1\n@bart second question\nbart> answer 2\n';
    await projects.writeDoc(ctx, project.id, ref, document);
    if (move === 'rename workspace') await projects.renameWorkspace(ctx, project.id, workspace.id, 'After');
    if (move === 'move workspace') await projects.moveWorkspace(ctx, project.id, workspace.id, parent.id);
    if (move === 'rename project') await projects.renameProject(ctx, project.id, 'Relocated ' + project.name);
    if (restart) bart = makeBart();
    await ask('--opus follow up after relocation');
    const after = repositories.resolve(ctx, project.id, workspace.id);
    assert.equal(after.repoId, before.repoId);
    const afterWorkspace = projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir;
    assert.notEqual(afterWorkspace, beforeWorkspace);
    if (move === 'move workspace') assert.equal(after.directory, before.directory, 'an inherited repository stays put but the workspace context still changed');
    else assert.notEqual(after.directory, before.directory);
    assert.doesNotMatch(calls[2].command, / --resume /);
    assert.match(calls[2].command, / --restricted /, 'Bart remains read-only');
    assert.ok(calls[2].input.includes(after.directory));
    if (after.directory !== before.directory) assert.ok(!calls[2].input.includes(before.directory));
    assert.ok(calls[2].input.includes(afterWorkspace));
    assert.match(calls[2].input, /<conversation>[\s\S]+answer 1[\s\S]+answer 2/);
    assert.equal(await projects.readDoc(ctx, project.id, ref), document);
    await ask('--opus another follow up');
    assert.match(calls[3].command, / --resume /, 'fresh session resumes at the new location');
  });
}

test('pre-location-stamp persisted Bart sessions are not resumed', () => {
  const file = path.join(homeDir, 'legacy-threads.json');
  const key = threadKey('project:workspace:repo', { kind: 'workspace', workspaceId: 'workspace' }, [{ question: 'where?', answer: 'old' }]);
  fs.writeFileSync(file, JSON.stringify([[key, { provider: 'anthropic', session: 'old-session', at: Date.now() }]]));
  const threads = createThreads({ file, setTimer: () => null, clearTimer: () => {} });
  assert.equal(threads.take(key, 'anthropic', 'current location'), null);
  assert.equal(threads.size(), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
});

test('Stage synchronizes all tabs sharing a preview URL without touching review or navigated-away tabs', () => {
  const tabs = [
    { id: 'A', requestKey: 'build-preview:A', url: 'http://127.0.0.1:1111/' },
    { id: 'C', requestKey: 'build-preview:C', url: 'http://127.0.0.1:1111/' },
    { id: 'fallback', requestKey: 'accepted-build-preview', url: 'http://127.0.0.1:1111/' },
    { id: 'B', requestKey: 'build-preview:B', url: 'http://127.0.0.1:2222/' },
    { id: 'elsewhere', requestKey: 'build-preview:D', url: 'https://example.com/' },
    { id: 'route', requestKey: 'build-preview:E', url: 'http://127.0.0.1:1111/settings?view=chart#part' },
  ];
  const preview = { status: 'ready', replacesUrl: tabs[0].url, url: 'http://127.0.0.1:3333/' };
  assert.deepEqual(buildPreviewTabChanges(tabs, preview), [...['A', 'C', 'fallback'].map(id => ({ id, url: preview.url })), { id: 'route', url: 'http://127.0.0.1:3333/settings?view=chart#part' }]);
  assert.deepEqual(buildPreviewTabChanges(tabs, { ...preview, status: 'stopped', url: null }), ['A', 'C', 'fallback', 'route'].map(id => ({ id, url: null })));
  assert.deepEqual(buildPreviewTabChanges(tabs, { status: 'stopped', replacesUrl: tabs[3].url }), [{ id: 'B', url: null }]);
});

test('busy coordinator uses terminal cwd, preview dependencies and workspace identity, not project membership', () => {
  const scope = { projectId: 'P', roots: [path.join(homeDir, 'Moved')], workspaceIds: ['W'] };
  const terminal = { projectId: 'P', workspaceId: 'W', cwd: path.join(homeDir, 'independent'), status: 'running' };
  assert.equal(busyReason(scope, { terminals: [terminal] }), null);
  assert.match(busyReason(scope, { terminals: [{ ...terminal, projectId: 'elsewhere', cwd: path.join(scope.roots[0], 'src') }] }), /terminals/);
  assert.equal(busyReason(scope, { terminals: [{ ...terminal, status: 'exited', cwd: scope.roots[0] }] }), null);
  assert.equal(busyReason(scope, { previews: [{ projectId: 'P', workspaceId: 'other', directory: terminal.cwd, status: 'ready' }] }), null);
  for (const status of ['planning', 'starting', 'ready']) assert.match(busyReason(scope, { previews: [{ projectId: 'other', workspaceId: 'X', directory: scope.roots[0], status }] }), /preview/);
  assert.match(busyReason(scope, { previews: [{ projectId: 'P', workspaceId: 'W', directory: terminal.cwd, status: 'confirming' }] }), /preview/);
  assert.equal(affectedBy(scope, { projectId: 'elsewhere', repositories: [scope.roots[0]] }), true);
  assert.equal(affectedBy(scope, { projectId: 'elsewhere', repositories: [path.join(homeDir, 'Moved-other')] }), false);
});
