'use strict';

// Connect your library (src/main/connect, 2026-10-07; experimental, onboarding in test mode only): what is read on this
// Mac, how a Markdown file becomes a note, the import tools, the librarian's reply as it is read, and a whole session with
// the fake agents: a folder chosen from a button, a question answered, the import it starts, Import for the rest, and the
// staged notes written into the project onboarding makes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const readers = require('../src/main/connect/readers.cjs');
const notes = require('../src/main/connect/notes.cjs');
const { createImportTools, validateImportTool, chatNote } = require('../src/main/connect/tools.cjs');
const { createConnect, readReply, cleanChoices } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { detect } = require('../src/main/connect/scan.cjs');
const { importToolLabel, writeImportConfig } = require('../src/main/connect/agents.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-')));
const layout = ensureHome(homeDir);
let ctx;
// A one-pixel png.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const write = (rel, text) => { const file = path.join(homeDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const vault = path.join(homeDir, 'Vault');

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
  write('Vault/.obsidian/daily-notes.json', JSON.stringify({ folder: 'Journal' }));
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) write(`Vault/Journal/${day}.md`, `# ${day}\nate lunch\n`);
  write('Vault/Research/Idea.md', 'An idea that builds on [[Other note]] and [[Folder/Third|the third]].\n\n![[pic.png|300]]\n\nSee https://example.org/paper and ![alt](../attachments/pic.png).\n');
  write('Vault/Research/Other note.md', 'The other note. ![[Idea]]\n');
  write('Vault/Personal/Secret.md', 'private\n');
  fs.mkdirSync(path.join(vault, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'attachments', 'pic.png'), PNG);
});
test.after(async () => { await db.closeAll(); });

test('a folder at a glance: notes per top folder, the daily-notes folder from Obsidian\'s setting, the files under it', () => {
  const overview = readers.folderOverview(vault, { homeDir });
  assert.equal(overview.shown, '~/Vault');
  assert.equal(overview.notes, 6);
  assert.equal(overview.images, 1);
  assert.equal(overview.dailyFolder, 'Journal');
  assert.deepEqual(overview.folders.map((entry) => [entry.name, entry.notes, entry.dated]), [['Journal', 3, 1], ['Research', 2, 0], ['Personal', 1, 0], ['attachments', 0, 0]]);
  const files = readers.noteFiles(vault, { exclude: ['Journal', 'Personal'] }).map((file) => path.relative(vault, file)).sort();
  assert.deepEqual(files, ['Research/Idea.md', 'Research/Other note.md']);
  assert.deepEqual(readers.noteFiles(vault, { include: ['Personal'] }).map((file) => path.basename(file)), ['Secret.md']);
  assert.deepEqual(readers.linksIn(vault).map((link) => [link.url, link.count, link.notes]), [['https://example.org/paper', 1, ['Idea']]]);
});

test('Obsidian\'s vaults come from obsidian.json, only those still there', () => {
  write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { a: { path: vault, ts: 1759900000000, open: true }, b: { path: path.join(homeDir, 'gone') } } }));
  assert.deepEqual(readers.obsidianVaults(homeDir).map((entry) => [entry.name, entry.shown, entry.open]), [['Vault', '~/Vault', true]]);
  assert.equal(detect({ homeDir }).apps.Obsidian.found, true);
  assert.equal(detect({ homeDir }).apps['Claude Code'].found, false);
});

test('Claude Code and Codex sessions: listed by first typed prompt, programs\' runs left out, read as turns of text', () => {
  const lines = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  write('.claude/projects/-Users-me-thesis/11111111-1111-4111-8111-111111111111.jsonl', lines([
    { type: 'user', entrypoint: 'cli', cwd: path.join(homeDir, 'thesis'), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', cwd: path.join(homeDir, 'thesis'), message: { role: 'user', content: 'Why do novices skip tests?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Mostly time pressure.' }, { type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'And habit.' }] } },
  ]));
  write('.claude/projects/-Users-me-thesis/22222222-2222-4222-8222-222222222222.jsonl', lines([
    { type: 'user', entrypoint: 'sdk-ts', cwd: '/tmp/run', message: { role: 'user', content: 'Summarize this note' } },
  ]));
  write('.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-abc.jsonl', lines([
    { type: 'session_meta', payload: { id: 'abc', cwd: path.join(homeDir, 'code'), originator: 'codex-tui', source: 'cli' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>x</environment_context>' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Plan the study' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Here is a plan.' } },
  ]));
  write('.codex/sessions/2026/10/02/rollout-2026-10-02T10-00-00-def.jsonl', lines([
    { type: 'session_meta', payload: { id: 'def', cwd: '/tmp', originator: 'codex_exec', source: 'exec' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'automated' } },
  ]));
  const env = {};
  const claude = readers.localChats('Claude Code', { homeDir, env });
  assert.deepEqual(claude.map((chat) => [chat.id, chat.title, chat.project]), [['-Users-me-thesis/11111111-1111-4111-8111-111111111111', 'Why do novices skip tests?', '~/thesis']]);
  assert.equal(readers.localChats('Claude Code', { homeDir, env, automated: true }).length, 2);
  const transcript = readers.localTranscript('Claude Code', claude[0].id, { homeDir, env });
  assert.deepEqual(transcript.turns, [{ role: 'user', text: 'Why do novices skip tests?' }, { role: 'assistant', text: 'Mostly time pressure.\n\nAnd habit.' }]);
  const codex = readers.localChats('Codex', { homeDir, env });
  assert.deepEqual(codex.map((chat) => [chat.id, chat.title]), [['2026/10/01/rollout-2026-10-01T10-00-00-abc', 'Plan the study']]);
  assert.deepEqual(readers.localTranscript('Codex', codex[0].id, { homeDir, env }).turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.throws(() => readers.localTranscript('Claude Code', '../../etc/passwd', { homeDir, env }), /No Claude Code session/);
  assert.equal(readers.localChatCounts('Codex', { homeDir, env }).total, 2);
});

test('Claude and ChatGPT exports: conversations.json read from the file, a folder, or a zip', () => {
  const claudeExport = write('exports/claude/conversations.json', JSON.stringify([
    { uuid: 'c1', name: 'Tutoring study design', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', chat_messages: [{ sender: 'human', text: 'How many participants?' }, { sender: 'assistant', text: 'About twenty.' }] },
    { uuid: 'c2', name: 'Recipe', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'Pasta?' }] },
  ]));
  const chats = readers.exportChats(claudeExport);
  assert.deepEqual(chats.map((chat) => [chat.id, chat.title, chat.turns]), [['c1', 'Tutoring study design', 2], ['c2', 'Recipe', 1]]);
  assert.deepEqual(readers.exportTranscript(path.dirname(claudeExport), 'c1').turns, [{ role: 'user', text: 'How many participants?' }, { role: 'assistant', text: 'About twenty.' }]);
  const gpt = write('exports/gpt/conversations.json', JSON.stringify([{ conversation_id: 'g1', title: 'Regression help', create_time: 1759000000, update_time: 1759000100, current_node: 'b', mapping: {
    root: { parent: null, message: null }, a: { parent: 'root', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Which model?'] } } },
    b: { parent: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A mixed model.'] } } },
  } }]));
  assert.deepEqual(readers.exportTranscript(gpt, 'g1').turns.map((turn) => turn.text), ['Which model?', 'A mixed model.']);
  try {
    const zip = path.join(homeDir, 'exports', 'claude.zip');
    execFileSync('zip', ['-j', '-q', zip, claudeExport]);
    assert.equal(readers.exportChats(zip).length, 2);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.throws(() => readers.exportChats(write('exports/bad.json', '{"x":1}')), /not a Claude or ChatGPT export/);
});

test('a Chromium browser: bookmarks, and its history by site from a copy of the locked database', async (t) => {
  const dir = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  write('Library/Application Support/Google/Chrome/Default/Bookmarks', JSON.stringify({ roots: { bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Distill', url: 'https://distill.pub/' }, { type: 'folder', name: 'Reading', children: [{ type: 'url', name: 'arXiv', url: 'https://arxiv.org/' }] }] } } }));
  assert.deepEqual(readers.browserBookmarks(dir).map((entry) => [entry.title, entry.folder]), [['Distill', 'Bookmarks bar'], ['arXiv', 'Bookmarks bar / Reading']]);
  try { execFileSync('sqlite3', ['-version']); } catch { t.skip('no sqlite3'); return; }
  const recent = readers.chromeTime(Date.now() - 86_400_000);
  execFileSync('sqlite3', [path.join(dir, 'History'), `CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
    INSERT INTO urls(url,title,visit_count,last_visit_time) VALUES ('https://distill.pub/a','A',5,${recent}),('https://distill.pub/b','B',3,${recent}),('https://mail.google.com/','Mail',90,${recent}),('https://old.example/','Old',50,1);`]);
  const sites = await readers.browserHistory(dir, { days: 30, exclude: ['mail.google.com'] });
  assert.deepEqual(sites.map((site) => [site.host, site.visits, site.pages]), [['distill.pub', 8, 2]]);
  assert.equal(readers.browserProfiles(homeDir)[0].browser, 'Chrome');
});

test('a Markdown file as a note: Obsidian links become mentions, pictures are set aside and saved into the project', async () => {
  const index = notes.createIndex();
  const source = path.join(vault, 'Research', 'Idea.md');
  const { body, images } = notes.convertMarkdown(fs.readFileSync(source, 'utf8'), { sourcePath: source, root: vault, index });
  assert.match(body, /builds on @\[Other note\] and @\[Third\]\./);
  assert.equal(images.length, 2, 'the embed found by name in the vault, the link by its relative path');
  assert.deepEqual(images.map((image) => path.relative(vault, image.file)), ['attachments/pic.png', 'attachments/pic.png']);
  assert.match(body, /!\[pic\]\(engelbart-image:0\)/);
  assert.match(body, /!\[alt\]\(engelbart-image:1\)/);
  assert.match(notes.convertMarkdown('![[Idea]] and [x](Plan%20abcdef0123456789abcdef0123456789.md)').body, /^@\[Idea\] and @\[Plan\]$/);

  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'Pictures' });
  const written = await notes.writeNote(ctx, project.id, { title: 'Idea', body, images }, { projects });
  const text = fs.readFileSync(path.join(projects.findProject(ctx, project.id).dir, `${written.name}.md`), 'utf8');
  const ids = [...text.matchAll(/!\[[^\]]*\]\(img:([\w-]+)\)/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  for (const id of ids) assert.equal((await ctx.libraryDb.get(id)).type, 'image');
});

test('the import tools: validated arguments, notes staged until there is a project, nothing brought in twice', async () => {
  assert.throws(() => validateImportTool('import_note_files', {}), /files is required/);
  assert.throws(() => validateImportTool('import_note_files', { files: 'x' }), /list of text/);
  assert.throws(() => validateImportTool('nope', {}), /Unknown tool/);
  const dir = path.join(ctx.dataRoot, '.connect', 'tools-test');
  let projectId = null;
  const counted = { notes: 0, items: 0 };
  const call = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir, projectId: () => projectId, exports: {}, folders: {} }, context: async () => ctx, added: (kind, n) => { counted[kind] += n; }, env: {} });
  const listed = await call('list_note_files', { folder: '~/Vault', exclude: ['Journal', 'Personal'] });
  assert.equal(listed.total, 2);
  const first = await call('import_note_files', { files: listed.files, root: vault });
  assert.equal(first.added, 2);
  assert.match(first.where, /held until/);
  assert.equal(notes.stagedNotes(dir).length, 2);
  const again = await call('import_note_files', { files: [...listed.files, '/etc/hosts'] });
  assert.equal(again.added, 0);
  assert.deepEqual(again.skipped.map((entry) => entry.why).sort(), ['Only files inside the home directory can be read', 'brought in before', 'brought in before']);
  await assert.rejects(call('folder_overview', { path: 'relative' }), /absolute/);

  const chats = await call('list_chats', { app: 'Claude Code' });
  assert.equal((await call('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) })).added, 1);
  assert.equal((await call('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) })).added, 0);
  await assert.rejects(call('list_chats', { app: 'Claude' }), /has not chosen a Claude export/);
  assert.match(chatNote('Claude Code', { date: '2026-10-01T00:00:00Z', project: '~/x', turns: [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }] }), /^\*Claude Code · 2026-10-01 · ~\/x\*\n\n\*\*You:\*\* Q\n\n\*\*Claude:\*\* A\n$/);

  const site = await call('add_to_library', { input: 'https://distill.pub/', name: 'Distill' });
  assert.equal(site.added, true);
  assert.equal((await call('add_to_library', { input: 'distill.pub' })).added, false);
  assert.deepEqual(counted, { notes: 3, items: 1 });
  await assert.rejects(call('zotero_collections', {}), /Zotero is not signed in/);

  // The project made: the staged notes go in, named by their files, and later notes go straight there.
  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'Imported' });
  const flushed = await notes.flushStaged(ctx, dir, project.id, { projects });
  assert.deepEqual(flushed.map((note) => note.name).sort(), ['Idea', 'Other note', 'Why do novices skip tests?']);
  assert.equal(notes.stagedNotes(dir).length, 0);
  projectId = project.id;
  await call('add_note', { title: 'Meeting with Ana', markdown: 'We agreed on twenty participants.', source: 'granola:1' });
  const rows = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name).sort();
  assert.deepEqual(rows, ['Idea', 'Meeting with Ana', 'Other note', 'Welcome!', 'Why do novices skip tests?']);
});

test('the librarian\'s reply as it is read: questions, buttons and imports checked against what was picked', () => {
  const choices = cleanChoices({ sources: { notes: { on: true, apps: ['Obsidian', 'Nope'], folders: ['/etc', '~/Vault'] }, papers: { on: false } } }, homeDir);
  assert.deepEqual(choices.sources.notes, { on: true, apps: ['Obsidian'], folders: [vault], repos: [] });
  const reply = readReply('```json\n{"say":"Found it.","ask":{"source":"notes","kind":"multi","title":"Which folders?","options":["Research",{"label":"Essays"}]},"connect":{"app":"Zotero","kind":"signin"},"dispatch":[{"source":"notes","apps":["Obsidian"],"label":"Obsidian","plan":"Research only"},{"source":"papers","plan":"all"}],"done":false}\n```', choices);
  assert.deepEqual(reply.ask, { source: 'notes', kind: 'multi', title: 'Which folders?', options: ['Research', 'Essays'], placeholder: '' });
  assert.equal(reply.connect, null, 'one thing at a time: the question wins');
  assert.deepEqual(reply.dispatch.map((entry) => entry.source), ['notes'], 'papers was not picked');
  const button = readReply('{"say":"","connect":{"app":"Zotero","kind":"signin"}}', choices);
  assert.equal(button.connect.label, 'Sign in to Zotero');
  assert.equal(readReply('{"connect":{"app":"Obsidian","kind":"signin"}}', choices).connect, null, 'only Zotero and GitHub sign in');
  const prose = readReply('Sorry, I could not read that.', choices);
  assert.equal(prose.say, 'Sorry, I could not read that.');
  assert.equal(prose.unread, true);
  assert.equal(importToolLabel('import_note_files', { files: ['a', 'b'] }), 'Bringing in 2 notes');
  // Codex's import home: Engelbart's tools approved in advance (codex exec cannot ask anyone), nothing else.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-codex-'));
  writeImportConfig(codexHome, { command: '/bin/node', args: ['/x/import-mcp.cjs', '/x/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.match(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), /\[mcp_servers\.engelbart\]\ncommand = "\/bin\/node"\nargs = \["\/x\/import-mcp\.cjs", "\/x\/c\.json"\][\s\S]*default_tools_approval_mode = "approve"/);
});

test('a session with the fake agents: a button, a question, imports in the background, Import, and the notes into the project', async () => {
  const snapshots = [];
  const fresh = fs.mkdtempSync(path.join(homeDir, 'fresh-')); // a home with no Obsidian: the vault comes from the button
  const connect = createConnect({
    agents: createFakeConnectAgents({ delayMs: 5 }),
    resolveChoice: (pick) => ({ provider: 'anthropic', model: (pick && pick.model) || 'opus', modelId: 'opus', modelName: 'Opus', effort: (pick && pick.effort) || 'high' }),
    context: async () => ctx,
    homeDir: fresh,
    env: {},
    notify: (snapshot) => snapshots.push(snapshot),
    openBridge: openToolBridge,
  });
  const until = async (id, check, what) => {
    for (let n = 0; n < 400; n += 1) { const now = connect.state(id); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
    assert.fail(`timed out waiting for ${what}: ${JSON.stringify(connect.state(id))}`);
  };
  await assert.rejects(connect.start({ sources: {} }), /Pick at least one source/);
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, sites: { on: true } }, pick: { model: 'opus', effort: 'high' } });
  let state = await until(started.id, (now) => !now.thinking && now.chat.length, 'the first turn');
  assert.equal(state.chat[0].connect.app, 'Obsidian', 'no vault found: the button for it first');
  // A folder outside the home folder is refused; the vault copied into it is taken.
  await assert.rejects(connect.connected(started.id, { app: 'Obsidian', kind: 'folder', path: vault }), /inside your home folder/);
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  await connect.connected(started.id, { app: 'Obsidian', kind: 'folder', path: '~/Vault' });
  state = await until(started.id, (now) => !now.thinking && now.chat.some((entry) => entry.ask), 'the notes question');
  assert.deepEqual(state.chat.map((entry) => entry.role), ['agent', 'user', 'agent']);
  assert.equal(state.chat[2].ask.kind, 'single');
  assert.throws(() => connect.answer(started.id, {}), /Say something first/);
  connect.answer(started.id, { picked: ['Everything'] });
  state = await until(started.id, (now) => now.jobs.length && now.jobs[0].status === 'done', 'the notes import');
  assert.equal(state.jobs[0].source, 'notes');
  assert.equal(state.jobs[0].notes, 5, 'the fake brings in five of the vault\'s notes');
  assert.equal(state.staged, 5);
  assert.ok(snapshots.some((snapshot) => snapshot.jobs.some((job) => job.status === 'running')), 'its progress was sent while it ran');
  // Websites were never talked through: Import hands them over at once.
  await until(started.id, (now) => !now.thinking, 'the websites question');
  state = connect.importNow(started.id);
  assert.deepEqual(state.jobs.map((job) => job.source), ['notes', 'sites']);
  assert.equal(state.done, true);
  state = await until(started.id, (now) => now.jobs.every((job) => job.status === 'done'), 'every import');
  assert.ok(fs.existsSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json')));

  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'From connect' });
  assert.equal(await connect.attachProject(ctx, started.id, project.id), 5);
  assert.equal(connect.state(started.id).staged, 0);
  const names = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name);
  assert.equal(names.length, 6, 'Welcome! and the five notes');
  connect.stop(started.id);
});

test('the choose screen\'s model and the onboarding flow with Connect your library in it (test mode)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { Obsidian: { found: true }, 'Claude Code': { found: true } }, sites: { found: true }, github: { found: false } };
  const start = model.initialPicks(found);
  assert.deepEqual(start.picks, { notes: true, transcripts: false, chats: true, sites: true, papers: false, code: false });
  assert.deepEqual(start.open, { notes: true });
  assert.equal(model.subOf('notes', { on: true, apps: start.apps }), '1 of 6');
  assert.equal(model.subOf('notes', { on: false, apps: start.apps }), '');
  assert.equal(model.subOf('code', { on: true, apps: {}, repos: ['a/b'], folders: ['/x', '/y'] }), '1 repo · 2 folders');
  const sent = model.choicesOf({ picks: start.picks, apps: start.apps, folders: { papers: ['/p'] }, repos: ['a/b'], custom: ' skip drafts ', computer: false, pick: { model: 'opus' } });
  assert.deepEqual(sent.sources.notes, { on: true, apps: ['Obsidian'], folders: [], repos: [] });
  assert.deepEqual(sent.sources.papers, { on: false, apps: [], folders: [], repos: [] });
  assert.equal(sent.custom, 'skip drafts');
  assert.equal(model.statusOf({ status: 'done', notes: 3, items: 2 }).text, '✓ 5 added');
  assert.equal(model.statusOf({ status: 'running', notes: 0, items: 0 }).text, 'importing…');
  assert.equal(model.allEnded([{ status: 'done' }, { status: 'queued' }]), false);

  const flow = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  assert.deepEqual(flow.forward('new', { step: 'tools', sub: 0 }, { connect: true }), { step: 'connect', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'connect', sub: 0 }, { connect: true }), { step: 'import', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'tools', sub: 0 }), { step: 'import', sub: 0 }, 'not in the flow outside test mode');
  assert.deepEqual(flow.pagerOf('new', 'connect', { connect: true }), { count: 7, index: 2 });
  assert.equal(flow.pagerOf('new', 'connect'), null);
});
