'use strict';

// Connect your library (src/main/connect, 2026-10-07; every library since 2026-10-08): what is read on this Mac, how a
// Markdown file becomes a note, the import tools, the librarian's reply as it is read, and whole sessions with the fake
// agents. Second build ("Agent onboarding"): the models pinned to Sonnet high / Sol high, the priority queue (surveys,
// recalls, imports, then MEMORY.md), a step handed to the person (needs_you) and answered, MEMORY.md written with its
// secrets taken out and given to @bart, the agents' browser kept to its sites, ChatGPT's and Claude's chats read from
// their pages, Google Drive files, Apple Notes, Cursor's chats, the connectors' OAuth sign-in (against a fake server),
// each app's skill, and the onboarding flow with Connect in place of Add to your library and Custom instructions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const readers = require('../src/main/connect/readers.cjs');
const notes = require('../src/main/connect/notes.cjs');
const { createImportTools, validateImportTool, chatNote, toolsFor, googleMarkdown, csvTable, IMPORT_TOOLS } = require('../src/main/connect/tools.cjs');
const { createConnect, readReply, readSurvey, cleanChoices, projectBlock, connectChoice } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { createWebSignIn } = require('../src/main/connect/web-signin.cjs');
const { detect, scanFor, localRepos } = require('../src/main/connect/scan.cjs');
const { importToolLabel, writeImportConfig, claudeServers, claudeToolsFor } = require('../src/main/connect/agents.cjs');
const { hostAllowed, hostsFor, fileNameOf } = require('../src/main/connect/browser.cjs');
const { listWebChats, readWebChat } = require('../src/main/connect/web-chats.cjs');
const { createAppleNotes, noteMarkdown } = require('../src/main/connect/apple-notes.cjs');
const { cursorChats, cursorTranscript } = require('../src/main/connect/cursor.cjs');
const { createConnectors } = require('../src/main/connect/connectors.cjs');
const memory = require('../src/main/connect/memory.cjs');
const { SKILLS, skillOf, skillsFor } = require('../src/main/connect/skills.cjs');
const prompts = require('../src/main/connect/prompts.cjs');
const { APPS, LOCAL_PDFS } = require('../src/shared/connect-sources.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');
const { buildContext } = require('../src/main/bart/context.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-')));
const layout = ensureHome(homeDir);
let ctx;
// A one-pixel png.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const write = (rel, text) => { const file = path.join(homeDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const vault = path.join(homeDir, 'Vault');
const ALL = ['anthropic', 'openai'];

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

const until = async (read, check, what, tries = 600) => {
  for (let n = 0; n < tries; n += 1) { const now = read(); if (check(now)) return now; await new Promise((resolve) => { setTimeout(resolve, 10); }); }
  assert.fail(`timed out waiting for ${what}: ${JSON.stringify(read()).slice(0, 2000)}`);
};

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

test('detect: Obsidian\'s vaults from obsidian.json, apps installed or signed in to count as found, Apple Notes only once ticked', () => {
  write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { a: { path: vault, ts: 1759900000000, open: true }, b: { path: path.join(homeDir, 'gone') } } }));
  assert.deepEqual(readers.obsidianVaults(homeDir).map((entry) => [entry.name, entry.shown, entry.open]), [['Vault', '~/Vault', true]]);
  const apps = path.join(homeDir, 'Apps');
  fs.mkdirSync(path.join(apps, 'Granola.app'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Perplexity.app'), { recursive: true });
  const found = detect({ homeDir, applications: [apps], signedIn: ['ChatGPT'] }).apps;
  assert.equal(found.Obsidian.found, true);
  assert.equal(found['Claude Code'].found, false);
  assert.deepEqual([found.Granola.found, found.Granola.where], [true, 'on this Mac']);
  assert.deepEqual([found.ChatGPT.found, found.ChatGPT.where, found.ChatGPT.signedIn], [true, 'signed in to Engelbart', true]);
  // MATH-114: a web app found only as its desktop app is not signed in to yet
  assert.deepEqual([found.Perplexity.found, found.Perplexity.where, found.Perplexity.signedIn], [true, 'Sign in to add', false]);
  assert.equal(found.Claude.found, false);
  assert.equal(found['Apple Notes'].found, false, 'macOS asks before Notes is read: never ticked by itself');
});

test('localRepos: Claude Code and Codex sessions grouped by repository, counted, and nothing read inside macOS\'s protected folders', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-repos-')));
  const put = (rel, text) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const lines = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const claude = (name, cwd, prompt) => put(`.claude/projects/p/${name}.jsonl`, lines([{ type: 'user', entrypoint: 'cli', cwd, message: { role: 'user', content: prompt } }]));
  const thesis = path.join(home, 'code', 'thesis');
  fs.mkdirSync(path.join(thesis, '.git'), { recursive: true });
  fs.mkdirSync(path.join(thesis, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, 'scratch'), { recursive: true }); // no .git: not a repository
  claude('11111111-1111-4111-8111-111111111111', thesis, 'Why do the tests fail?');
  claude('22222222-2222-4222-8222-222222222222', path.join(thesis, 'src'), 'Tidy this module');
  claude('33333333-3333-4333-8333-333333333333', path.join(home, 'scratch'), 'Try something');
  claude('44444444-4444-4444-8444-444444444444', path.join(home, 'Documents', 'paper-code'), 'Plot the results');
  claude('55555555-5555-4555-8555-555555555555', home, 'Where am I?');
  claude('66666666-6666-4666-8666-666666666666', path.join(home, 'Documents'), 'What is here?');
  put('.codex/sessions/2026/10/01/rollout-a.jsonl', lines([
    { type: 'session_meta', payload: { id: 'c1', cwd: thesis, timestamp: '2026-10-01T10:00:00Z' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Add a benchmark' } },
  ]));
  const looked = [];
  const access = fs.accessSync;
  fs.accessSync = (file, ...rest) => { looked.push(String(file)); return access(file, ...rest); };
  let repos;
  try { repos = localRepos({ homeDir: home, env: {} }); } finally { fs.accessSync = access; }
  assert.deepEqual(repos.map((repo) => [repo.name, repo.shown, repo.sessions, repo.checked]), [
    ['thesis', '~/code/thesis', 3, true],
    ['paper-code', '~/Documents/paper-code', 1, false],
  ]);
  assert.ok(looked.includes(path.join(thesis, '.git')), 'a repository outside the protected folders is checked');
  assert.equal(looked.some((file) => file.startsWith(path.join(home, 'Documents') + path.sep)), false, 'nothing read inside ~/Documents');
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

// What an import brought in: Markdown files of the library's own in <data root>/assets/md (2026-10-08), by name.
const mdFiles = async () => (await ctx.libraryDb.list()).filter((row) => row.type === 'md' && row.path && row.path.startsWith(path.join(ctx.dataRoot, 'assets', 'md') + path.sep));

test('the import tools: validated arguments, notes and chats as Markdown files in assets/md (no project needed), nothing brought in twice', async () => {
  assert.throws(() => validateImportTool('import_note_files', {}), /files is required/);
  assert.throws(() => validateImportTool('import_note_files', { files: 'x' }), /list of text/);
  assert.throws(() => validateImportTool('import_google_files', { items: ['x'] }), /list of objects/);
  assert.throws(() => validateImportTool('nope', {}), /Unknown tool/);
  const dir = path.join(ctx.dataRoot, '.connect', 'tools-test');
  let projectId = null;
  const counted = { notes: 0, items: 0 };
  const call = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir, projectId: () => projectId, exports: {}, folders: {} }, context: async () => ctx, added: (kind, n) => { counted[kind] += n; }, env: {} });
  const listed = await call('list_note_files', { folder: '~/Vault', exclude: ['Journal', 'Personal'] });
  assert.equal(listed.total, 2);
  const first = await call('import_note_files', { files: listed.files, root: vault });
  assert.equal(first.added, 2);
  assert.match(first.where, /assets\/md/);
  assert.equal(notes.stagedCount(dir), 0, 'nothing waits for a project');
  const idea = (await mdFiles()).find((row) => row.name === 'Idea');
  assert.ok(idea, 'Idea is a file of the library');
  assert.deepEqual([idea.tags, idea.project_id, path.basename(idea.path), path.basename(path.dirname(idea.path))], [[], null, 'Idea.md', idea.id]);
  const text = fs.readFileSync(idea.path, 'utf8');
  assert.match(text, /builds on @\[Other note\]/);
  assert.match(text, /!\[pic\]\(pic\.png\)/, 'its picture beside it, linked by its name');
  assert.match(text, /!\[alt\]\(alt\.png\)/);
  assert.deepEqual(fs.readdirSync(path.dirname(idea.path)).sort(), ['Idea.md', 'alt.png', 'pic.png']);
  const again = await call('import_note_files', { files: [...listed.files, '/etc/hosts'] });
  assert.equal(again.added, 0);
  assert.deepEqual(again.skipped.map((entry) => entry.why).sort(), ['Only files inside the home directory can be read', 'brought in before', 'brought in before']);
  await assert.rejects(call('folder_overview', { path: 'relative' }), /absolute/);

  const chats = await call('list_chats', { app: 'Claude Code' });
  assert.equal((await call('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) })).added, 1);
  assert.equal((await call('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) })).added, 0);
  await assert.rejects(call('list_chats', { app: 'Claude' }), /There is no Claude export on this Mac; use web_chats/);
  await assert.rejects(call('web_chats', { app: 'ChatGPT' }), /browser is not available/, 'no browser: said, not crashed');
  await assert.rejects(call('needs_you', { kind: 'signin', reason: 'x' }), /Nobody can be asked/);
  assert.match(chatNote('Claude Code', { date: '2026-10-01T00:00:00Z', project: '~/x', turns: [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }] }), /^\*Claude Code · 2026-10-01 · ~\/x\*\n\n\*\*You:\*\* Q\n\n\*\*Claude:\*\* A\n$/);

  const site = await call('add_to_library', { input: 'https://distill.pub/', name: 'Distill' });
  assert.equal(site.added, true);
  assert.equal((await call('add_to_library', { input: 'distill.pub' })).added, false);
  assert.deepEqual(counted, { notes: 3, items: 1 });
  await assert.rejects(call('zotero_collections', {}), /Zotero is not signed in/);

  // A project changes nothing: what comes in is still the library's, never a project's note.
  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'Imported' });
  projectId = project.id;
  await call('add_note', { title: 'Meeting with Ana', markdown: 'We agreed on twenty participants.', source: 'granola:1' });
  assert.equal((await call('add_note', { title: 'Meeting with Ana', markdown: 'again', source: 'granola:1' })).added, false);
  assert.deepEqual((await mdFiles()).map((row) => row.name).filter((name) => ['Idea', 'Meeting with Ana', 'Other note', 'Why do novices skip tests?'].includes(name)).sort(), ['Idea', 'Meeting with Ana', 'Other note', 'Why do novices skip tests?']);
  const inProject = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name);
  assert.deepEqual(inProject, ['Welcome!'], 'no note was made in the project');
  assert.equal(notes.stagedNotes(dir).length, 0);
});

test('each kind of agent is served its own tools: a survey brings nothing in, a recall only keeps its answer', async () => {
  const names = (kind) => toolsFor(kind).map((tool) => tool.name);
  assert.ok(names('survey').includes('browser_read') && !names('survey').includes('import_note_files') && !names('survey').includes('save_memory'));
  assert.deepEqual(names('recall').filter((name) => !name.startsWith('browser_')), ['needs_you', 'wait_for_you', 'save_memory']);
  assert.ok(!names('import').includes('save_memory') && names('import').includes('import_google_files'));
  assert.equal(new Set(IMPORT_TOOLS.map((tool) => tool.name)).size, IMPORT_TOOLS.length);
  const survey = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'survey-test'), projectId: () => null }, context: async () => ctx, kind: 'survey' });
  await assert.rejects(survey('import_note_files', { files: [] }), /A survey brings nothing in/);
  const kept = [];
  const recall = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'recall-test'), projectId: () => null }, context: async () => ctx, kind: 'recall', recall: (app, text) => kept.push([app, text]) });
  await assert.rejects(recall('save_memory', { app: 'ChatGPT', text: 'short' }), /too short/);
  assert.deepEqual(await recall('save_memory', { app: 'ChatGPT', text: '# Research profile\nStudies help-seeking.' }), { saved: true, chars: 40 });
  assert.deepEqual(kept, [['ChatGPT', '# Research profile\nStudies help-seeking.']]);
  await assert.rejects(recall('add_note', { title: 'x', markdown: 'y' }), /not one of this agent's tools/);
});

test('the librarian\'s reply as it is read: one-line options with their why, buttons and imports checked against what was picked', () => {
  const choices = cleanChoices({ sources: { notes: { on: true, apps: ['Obsidian', 'Nope'], folders: ['/etc', '~/Vault'] }, papers: { on: false } }, permissions: { browser: false } }, homeDir);
  assert.deepEqual(choices.sources.notes, { on: true, apps: ['Obsidian'], folders: [vault], repos: [] });
  assert.deepEqual(choices.permissions, { files: true, browser: false, recall: true, notes: false });
  const reply = readReply('```json\n{"say":"Found it.","ask":{"source":"notes","kind":"multi","title":"Which folders?","options":["Research",{"label":"Essays","why":"12 notes"},{"label":"Essays"}]},"authorize":{"app":"Zotero","kind":"signin"},"dispatch":[{"source":"notes","apps":["Obsidian"],"label":"Obsidian","plan":"Research only"},{"source":"papers","plan":"all"}],"done":false}\n```', choices);
  assert.deepEqual(reply.ask, { source: 'notes', kind: 'multi', title: 'Which folders?', options: [{ label: 'Research', why: '', detail: '' }, { label: 'Essays', why: '12 notes', detail: '' }], placeholder: '' });
  assert.equal(reply.authorize, null, 'one thing at a time: the question wins');
  assert.deepEqual(reply.dispatch.map((entry) => entry.source), ['notes'], 'papers was not picked');
  assert.deepEqual(readReply('{"say":"","authorize":{"app":"Zotero","kind":"signin"}}', choices).authorize, { source: 'papers', app: 'Zotero', kind: 'signin', label: 'Sign in to Zotero' });
  assert.equal(readReply('{"authorize":{"app":"Granola","kind":"connector"}}', choices).authorize.label, 'Sign in to Granola');
  assert.equal(readReply('{"authorize":{"app":"Apple Notes","kind":"permission"}}', choices).authorize.label, 'Allow Engelbart to read Apple Notes');
  assert.equal(readReply('{"connect":{"app":"Obsidian","kind":"folder"}}', choices).authorize.kind, 'folder', 'the first build\'s "connect" still reads');
  assert.equal(readReply('{"authorize":{"app":"ChatGPT","kind":"folder"}}', choices).authorize, null, 'a web app is never a folder to choose');
  assert.equal(readReply('{"authorize":{"app":"Obsidian","kind":"signin"}}', choices).authorize, null, 'only Zotero and GitHub sign in to Engelbart');
  assert.equal(readReply('{"say":"Looking.","waiting":true}', choices).waiting, true);
  const prose = readReply('Sorry, I could not read that.', choices);
  assert.equal(prose.say, 'Sorry, I could not read that.');
  assert.equal(prose.unread, true);
  const survey = readSurvey('{"app":"Google Docs","signedIn":true,"summary":"40 docs in 6 folders.","total":40,"items":[{"id":"1abcDEF_ghij","label":"Thesis draft","kind":"doc","date":"2026-10-01","why":"research"},{"label":""}]}');
  assert.deepEqual(survey.items.map((item) => [item.id, item.label]), [['1abcDEF_ghij', 'Thesis draft']]);
  assert.equal(readSurvey('not json').summary, 'not json');
  assert.equal(importToolLabel('import_note_files', { files: ['a', 'b'] }), 'Bringing in 2 notes');
  assert.equal(importToolLabel('browser_open', { url: 'https://www.overleaf.com/project' }), 'Opening overleaf.com');
  assert.equal(importToolLabel('import_google_files', { items: [{}] }), 'Bringing in 1 Google Drive file');
});

test('the agents\' tools per kind, and the connectors handed to Claude Code and Codex for one run', () => {
  assert.deepEqual(claudeToolsFor('interview'), { tools: 'Read,Grep,Glob', allowed: 'Read,Grep,Glob' });
  assert.deepEqual(claudeToolsFor('redact'), { tools: '', allowed: '' }, 'taking secrets out needs no tools');
  assert.deepEqual(claudeToolsFor('import', [{ name: 'granola' }, { name: 'bad name' }]), { tools: 'Read,Grep,Glob,WebSearch,WebFetch', allowed: 'Read,Grep,Glob,WebSearch,WebFetch,mcp__engelbart__*,mcp__granola__*' });
  assert.deepEqual(claudeServers({ node: '/bin/node', server: '/x/import-mcp.cjs', connection: '/x/c.json', connectors: [{ name: 'granola', url: 'https://mcp.granola.ai/mcp', token: 'tok' }, { name: 'engelbart', url: 'https://evil', token: 't' }] }).mcpServers, {
    engelbart: { command: '/bin/node', args: ['/x/import-mcp.cjs', '/x/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    granola: { type: 'http', url: 'https://mcp.granola.ai/mcp', headers: { Authorization: 'Bearer tok' } },
  });
  // Codex's import home: Engelbart's tools approved in advance (codex exec cannot ask anyone), its own browser and computer
  // use off, a connector's token read from the environment, nothing else.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-codex-'));
  writeImportConfig(codexHome, { command: '/bin/node', args: ['/x/import-mcp.cjs', '/x/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } }, [{ name: 'granola', url: 'https://mcp.granola.ai/mcp' }]);
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[features\]\ncomputer_use = false\nbrowser_use = false\nbrowser_use_external = false/);
  assert.match(config, /\[mcp_servers\.engelbart\]\ncommand = "\/bin\/node"\nargs = \["\/x\/import-mcp\.cjs", "\/x\/c\.json"\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(config, /\[mcp_servers\.granola\]\nurl = "https:\/\/mcp\.granola\.ai\/mcp"\nbearer_token_env_var = "ENGELBART_CONNECTOR_GRANOLA"/);
});

test('the models are pinned: Sonnet high on Claude Code, Sol high on Codex, ids from Build\'s list', () => {
  assert.deepEqual(connectChoice('anthropic', null), { provider: 'anthropic', model: 'sonnet', modelId: 'claude-sonnet-5-5', modelName: 'Sonnet', effort: 'high' });
  assert.deepEqual(connectChoice('openai', { providers: { openai: { models: { sol: { id: 'gpt-7-sol', name: 'Sol' } } } } }), { provider: 'openai', model: 'sol', modelId: 'gpt-7-sol', modelName: 'Sol', effort: 'high' });
  assert.equal(connectChoice('nonsense', null).provider, 'anthropic');
});

test('the agents\' browser opens only its apps\' sites and the sign-in pages they send it through', () => {
  const hosts = hostsFor(APPS.ChatGPT.sites);
  assert.equal(hostAllowed('https://chatgpt.com/backend-api/conversations', hosts), true);
  assert.equal(hostAllowed('https://auth.openai.com/log-in', hosts), true, 'its sign-in page');
  assert.equal(hostAllowed('https://accounts.google.com/o/oauth2', hosts), true, 'signing in with Google');
  assert.equal(hostAllowed('https://mail.google.com/', hosts), false);
  assert.equal(hostAllowed('https://evilchatgpt.com/', hosts), false, 'a suffix is not a subdomain');
  assert.equal(hostAllowed('http://chatgpt.com/', hosts), false, 'https only');
  assert.equal(hostAllowed('file:///etc/passwd', hosts), false);
  assert.equal(hostAllowed('http://127.0.0.1:9/', ['127.0.0.1']), true, 'plain http only for a loopback host named outright');
  assert.equal(fileNameOf({ headers: new Map([['content-disposition', 'attachment; filename="My Paper.zip"']]) }, 'https://x/y'), 'My Paper.zip');
  assert.equal(fileNameOf({ headers: new Map([['content-disposition', "attachment; filename*=UTF-8''Th%C3%A8se.md"]]) }, 'https://x/y'), 'Thèse.md');
  assert.equal(fileNameOf({ headers: new Map() }, 'https://www.overleaf.com/project/abc/download/zip'), 'zip');
});

test('ChatGPT\'s and Claude\'s chats read from their signed-in pages, into turns', async () => {
  const opened = [];
  const gpt = {
    ensure: async (url) => { opened.push(url); },
    evaluate: async (script) => (/backend-api\/conversations\?/.test(script)
      ? { signedIn: true, account: 'me@example.org', items: [{ id: 'g-111111', title: 'Regression help', updated: '2026-10-02T00:00:00Z', project: null }, { id: 'g-222222', title: 'Old recipe', updated: 1500000000 }] }
      : { signedIn: true, conversation: { title: 'Regression help', update_time: 1759000100, current_node: 'b', mapping: { root: { parent: null, message: null }, a: { parent: 'root', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Which model?'] } } }, b: { parent: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A mixed model.'] } } } } } }),
  };
  const listed = await listWebChats(gpt, 'ChatGPT', { days: 365 * 3 });
  assert.equal(listed.account, 'me@example.org');
  assert.deepEqual(listed.chats.map((chat) => chat.title), ['Regression help'], 'a chat older than the days asked is left out');
  const chat = await readWebChat(gpt, 'ChatGPT', 'g-111111');
  assert.deepEqual(chat.turns, [{ role: 'user', text: 'Which model?' }, { role: 'assistant', text: 'A mixed model.' }]);
  assert.deepEqual(opened, ['https://chatgpt.com/', 'https://chatgpt.com/']);
  const claudePage = {
    ensure: async () => {},
    evaluate: async (script) => (/chat_conversations\?/.test(script)
      ? { signedIn: true, items: [{ id: 'c-111111', title: 'Study design', updated: '2026-10-01T00:00:00Z', project: 'Thesis' }, { id: 'c-222222', title: 'Pasta', updated: '2026-10-01T00:00:00Z', project: null }] }
      : { signedIn: true, conversation: { name: 'Study design', chat_messages: [{ sender: 'human', text: 'How many?' }, { sender: 'assistant', content: [{ type: 'text', text: 'Twenty.' }] }] } }),
  };
  assert.deepEqual((await listWebChats(claudePage, 'Claude', { project: 'thes' })).chats.map((entry) => entry.id), ['c-111111']);
  assert.deepEqual((await readWebChat(claudePage, 'Claude', 'c-111111')).turns.map((turn) => turn.text), ['How many?', 'Twenty.']);
  const signedOut = { ensure: async () => {}, evaluate: async () => ({ signedIn: false }) };
  await assert.rejects(listWebChats(signedOut, 'Claude'), (error) => error.code === 'SIGNED_OUT' && /needs_you/.test(error.message));
  await assert.rejects(listWebChats(gpt, 'Gemini'), /must be one of ChatGPT, Claude/);
});

test('Google Drive: a Doc\'s pictures kept out of its Markdown export, a Sheet as a table', () => {
  const dir = path.join(homeDir, 'google-test');
  const md = googleMarkdown(`# Thesis\n\nA figure: ![][image1]\n\n[image1]: <data:image/png;base64,${PNG.toString('base64')}>\n`, dir);
  const linked = md.match(/!\[image1\]\(([^)]+)\)/);
  assert.ok(linked, md);
  assert.deepEqual(fs.readFileSync(linked[1]), PNG);
  assert.doesNotMatch(md, /base64/);
  assert.equal(csvTable('name,count\n"Smith, J",3\nLee,"say ""hi"""\n'), '| name | count |\n| --- | --- |\n| Smith, J | 3 |\n| Lee | say "hi" |');
});

test('Apple Notes through macOS Automation: folders, notes, a note\'s HTML as Markdown with its picture, and a refusal said plainly', async () => {
  const pictureDir = path.join(homeDir, 'apple-notes-test');
  const body = `<div><h1>Reading list</h1></div><div>Papers on <b>help-seeking</b> &amp; tutoring<br></div><ul><li>VanLehn 2011</li><li><a href="https://doi.org/10.1080/00461520.2011.611369">the paper</a></li></ul><div><img src="data:image/png;base64,${PNG.toString('base64')}"></div>`;
  const markdown = noteMarkdown(body, { name: 'Reading list', pictureDir, key: 'k' });
  assert.match(markdown, /^Papers on \*\*help-seeking\*\* & tutoring\n\n?- VanLehn 2011\n- \[the paper\]\(https:\/\/doi\.org\/10\.1080\/00461520\.2011\.611369\)/);
  assert.match(markdown, /!\[picture 1\]\(.*k-1\.png\)/);
  const calls = [];
  const answers = {
    folders: [{ id: 'x-coredata://f1', name: 'Research', account: 'iCloud', count: 2 }],
    list: [{ id: 'x-coredata://n1', name: 'Reading list', folder: 'Research', modified: '2026-10-05T00:00:00Z' }, { id: 'x-coredata://n2', name: 'Old', folder: 'Recently Deleted', modified: '2026-10-05T00:00:00Z' }, { id: 'not-an-id', name: 'Bad' }],
    read: [{ id: 'x-coredata://n1', name: 'Reading list', body, modified: '2026-10-05T00:00:00Z', folder: 'Research' }],
  };
  const run = (program, args, options, done) => { calls.push(args[4]); done(null, JSON.stringify(answers[args[4]]), ''); };
  const notesApp = createAppleNotes({ run, platform: 'darwin' });
  assert.deepEqual(await notesApp.folders(), answers.folders);
  assert.deepEqual((await notesApp.list({})).map((note) => note.id), ['x-coredata://n1'], 'Recently Deleted and odd ids left out');
  const read = await notesApp.read(['x-coredata://n1', 'nope'], { pictureDir });
  assert.equal(read.length, 1);
  assert.match(read[0].markdown, /help-seeking/);
  const refused = createAppleNotes({ run: (program, args, options, done) => done(Object.assign(new Error('failed'), { code: 1 }), '', 'execution error: Not authorized to send Apple events to Notes. (-1743)'), platform: 'darwin' });
  assert.deepEqual(await refused.permission(), { allowed: false, error: require('../src/main/connect/apple-notes.cjs').NOT_ALLOWED, refused: true });
  assert.deepEqual((await createAppleNotes({ run, platform: 'linux' }).permission()).allowed, false);
});

test('Cursor\'s chats, read from its database in place', (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('no node:sqlite'); return; }
  const file = path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fixture = new DatabaseSync(file);
  fixture.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = fixture.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  put.run(`composerData:${id}`, JSON.stringify({ composerId: id, name: 'Refactor the tutor', createdAt: Date.now() - 5000, lastUpdatedAt: Date.now(), fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }, { bubbleId: 'b2', type: 2 }, { bubbleId: 'b3', type: 2 }] }));
  put.run(`bubbleId:${id}:b1`, JSON.stringify({ type: 1, text: 'Split the tutor into modules' }));
  put.run(`bubbleId:${id}:b2`, JSON.stringify({ type: 2, text: 'Here is a plan.' }));
  put.run(`bubbleId:${id}:b3`, JSON.stringify({ type: 2, text: '' }));
  put.run('composerData:empty', JSON.stringify({ composerId: 'empty', fullConversationHeadersOnly: [] }));
  fixture.close();
  assert.deepEqual(cursorChats(homeDir).map((chat) => [chat.id, chat.title, chat.first, chat.turns]), [[id, 'Refactor the tutor', 'Split the tutor into modules', 3]]);
  assert.deepEqual(cursorTranscript(homeDir, id).turns, [{ role: 'user', text: 'Split the tutor into modules' }, { role: 'assistant', text: 'Here is a plan.' }]);
  assert.throws(() => cursorTranscript(homeDir, '../x'), /No Cursor chat/);
});

test('a connector\'s sign-in: discovery, registration, the code back on the loopback port, tokens kept and refreshed', async () => {
  const seen = { registered: null, exchanged: 0, refreshed: 0 };
  let base;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { seen.registered = JSON.parse(body); return json({ ...seen.registered, client_id: 'client-1' }, 201); }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') { seen.exchanged += 1; assert.equal(form.get('code'), 'the-code'); assert.ok(form.get('code_verifier')); return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 600, refresh_token: 'refresh-1' }); }
      if (form.get('grant_type') === 'refresh_token') { seen.refreshed += 1; return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2' }); }
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(homeDir, 'connectors.json');
  const crypt = { available: () => true, encrypt: (text) => Buffer.from(text).toString('base64'), decrypt: (text) => Buffer.from(text, 'base64').toString('utf8') };
  let clock = Date.now();
  // The person's browser: it goes to the authorization page and the "server" sends it back with a code.
  const openExternal = async (href) => {
    const asked = new URL(href);
    assert.equal(asked.pathname, '/authorize');
    assert.equal(asked.searchParams.get('code_challenge_method'), 'S256');
    const back = new URL(asked.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'the-code');
    back.searchParams.set('state', asked.searchParams.get('state'));
    setTimeout(() => { fetch(back.href).catch(() => {}); }, 10);
  };
  const changes = [];
  const connectors = createConnectors({ file: () => file, crypt, openExternal, now: () => clock, urls: { Granola: `${base}/mcp` }, onChange: (status) => changes.push(status.connected) });
  try {
    assert.equal(connectors.status('Granola').connected, false);
    assert.equal(await connectors.accessToken('Granola'), null);
    const status = await connectors.signIn('Granola');
    assert.equal(status.connected, true);
    assert.equal(seen.registered.client_name, 'Engelbart');
    assert.match(seen.registered.redirect_uris[0], /^http:\/\/localhost:\d+\/callback$/);
    assert.equal(seen.exchanged, 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /access-1/, 'the tokens are kept sealed');
    assert.equal(await connectors.accessToken('Granola'), 'access-1');
    clock += 500_000; // within two minutes of its end: refreshed first
    assert.equal(await connectors.accessToken('Granola'), 'access-2');
    assert.equal(seen.refreshed, 1);
    assert.deepEqual(await connectors.serversFor(['Granola', 'Notion', 'ChatGPT']), [{ app: 'Granola', name: 'granola', url: `${base}/mcp`, token: 'access-2' }]);
    assert.equal(connectors.signOut('Granola').connected, false);
    assert.ok(changes.includes(true) && changes[changes.length - 1] === false);
    assert.throws(() => connectors.status('ChatGPT'), /has no connector/);
  } finally {
    server.close();
  }
});

test('every app the choose screen lists has a skill, the person\'s own replaces one, and a job gets its apps\' skills', () => {
  for (const app of Object.keys(APPS)) assert.ok(SKILLS[app] && SKILLS[app].length > 80, `${app} has a skill`);
  assert.ok(SKILLS.Websites);
  const root = path.join(homeDir, 'skills-root');
  fs.mkdirSync(path.join(root, '.context', 'connect-skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.context', 'connect-skills', 'Granola.md'), 'Use the export button.');
  assert.equal(skillOf('Granola', root), 'Use the export button.');
  const block = skillsFor({ source: 'chats', apps: ['ChatGPT', 'Claude'] }, null);
  assert.match(block, /^<skills note="[^"]*help pages[^"]*">\n# ChatGPT[\s\S]*# Claude \(claude\.ai\)[\s\S]*<\/skills>$/);
  assert.match(skillsFor({ source: 'sites', apps: [] }), /# Websites/);
  assert.match(prompts.RECALL_PROMPT, /structured profile of me \*as a researcher\*/, 'the custom instructions step\'s prompt, adapted');
  assert.doesNotMatch(prompts.INTERVIEW_SYSTEM_PROMPT, /Settings → Data controls/, 'the librarian never tells the person how to export');
});

test('MEMORY.md: secrets of a known shape masked, the old version kept, and @bart given it', async () => {
  const scrubbed = memory.scrubSecrets('key sk-ant-api03-abcdefghijklmnop and ghp_0123456789abcdefghijABCDEFGHIJ\npassword: hunter2\npassword: [removed]\nnothing else');
  assert.equal(scrubbed.removed, 3);
  assert.equal(scrubbed.text, 'key [removed] and [removed]\npassword: [removed]\npassword: [removed]\nnothing else');
  const root = fs.mkdtempSync(path.join(homeDir, 'memory-root-'));
  assert.equal(memory.memoryBlock(root), '');
  const first = memory.saveMemory(root, '# Memory\nOne.');
  assert.equal(first.previous, null);
  const second = memory.saveMemory(root, '# Memory\nTwo.');
  assert.equal(fs.readFileSync(second.previous, 'utf8'), '# Memory\nOne.\n');
  assert.equal(memory.readMemory(root), '# Memory\nTwo.');
  assert.match(memory.memoryBlock(root), /^<memory note="MEMORY\.md[^"]*">\n# Memory\nTwo\.\n<\/memory>$/);
  write('.claude/CLAUDE.md', 'Prefers terse answers.');
  assert.deepEqual(memory.localMemories(homeDir, {}).map((entry) => [entry.app, entry.file]), [['Claude Code', '~/.claude/CLAUDE.md']]);

  // @bart's first message carries it, in the data root's own MEMORY.md.
  const { project, workspaceId } = await projects.createProjectWithWelcome(ctx, { name: 'Memory read' });
  memory.saveMemory(ctx.dataRoot, '# Memory\nStudies help-seeking.');
  const context = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId }, workspaceId, askId: 'mem' });
  assert.match(context.head, /<memory note="[^"]*">\n# Memory\nStudies help-seeking\.\n<\/memory>/);
  fs.rmSync(memory.memoryPath(ctx.dataRoot));
});

function fakeConnect({ home = homeDir, delayMs = 5, agents = null, ...rest } = {}) {
  const snapshots = [];
  const connect = createConnect({ agents: agents || createFakeConnectAgents({ delayMs }), ready: () => ALL, context: async () => ctx, homeDir: home, env: {}, notify: (snapshot) => snapshots.push(snapshot), openBridge: openToolBridge, ...rest });
  return { connect, snapshots, state: (id) => () => connect.state(id) };
}

test('a session with the fake agents: a folder button, a question card, imports in the background as files of the library, Import, MEMORY.md without its secrets', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'fresh-')); // a home with no Obsidian: the vault comes from the button
  const { connect, snapshots, state } = fakeConnect({ home: fresh });
  const before = (await mdFiles()).length;
  const earlier = new Set((await mdFiles()).map((row) => row.id));
  await assert.rejects(connect.start({ sources: {} }), /Pick at least one source/);
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, sites: { on: true } }, provider: 'openai' });
  assert.deepEqual(started.choice, { provider: 'openai', name: 'Codex', modelName: 'Sol', effort: 'high' }, 'only the provider was chosen; its model is pinned');
  let now = await until(state(started.id), (s) => !s.thinking && s.chat.length, 'the first turn');
  assert.equal(now.chat[0].opener, true, 'a first line at once, before the librarian');
  assert.equal(now.chat[0].text, 'Had a look at what you picked. Starting with your notes.', 'nothing found: said plainly, without the model');
  assert.deepEqual(now.chat[1].authorize, { source: 'notes', app: 'Obsidian', kind: 'folder', label: 'Choose your Obsidian folder…' });
  // A folder outside the home folder is refused; the vault copied into it is taken.
  await assert.rejects(connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: vault }), /inside your home folder/);
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  await connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: '~/Vault' });
  now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
  assert.deepEqual(now.chat.map((entry) => entry.role), ['agent', 'agent', 'user', 'agent']);
  assert.deepEqual(now.chat[3].ask.options[0], { label: 'Everything', why: 'all of it', detail: '' });
  assert.throws(() => connect.answer(started.id, {}), /Say something first/);
  connect.answer(started.id, { picked: ['Everything'], text: 'but not Personal' });
  assert.equal(connect.state(started.id).chat[4].text, 'Everything — but not Personal');
  now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the notes import');
  assert.equal(now.jobs[0].notes, 5, 'the fake brings in five of the vault\'s notes');
  assert.equal(now.staged, 0, 'nothing waits for a project');
  assert.equal((await mdFiles()).length - before, 5, 'each a Markdown file in assets/md');
  assert.ok(snapshots.some((snapshot) => snapshot.jobs.some((job) => job.status === 'running')), 'its progress was sent while it ran');
  assert.ok(now.log.some((entry) => /Brought in 5 notes/.test(entry.text)), 'the action log says what it did');
  // Websites were never talked through: Import hands them over at once.
  await until(state(started.id), (s) => !s.thinking, 'the websites question');
  now = connect.importNow(started.id);
  assert.deepEqual(now.jobs.filter((job) => job.kind === 'import').map((job) => job.source), ['notes', 'sites']);
  assert.equal(now.done, true);
  now = await until(state(started.id), (s) => s.memory.status === 'saved' || s.memory.status === 'failed', 'MEMORY.md', 1500);
  assert.equal(now.memory.status, 'saved', JSON.stringify(now.memory));
  const saved = fs.readFileSync(memory.memoryPath(ctx.dataRoot), 'utf8');
  assert.match(saved, /^# Memory/);
  assert.match(saved, /password: \[removed\]/, 'the secrets agent took the password out');
  assert.doesNotMatch(saved, /sk-test/, 'the shape check took the key out');
  assert.equal(now.memory.removed, 1);
  assert.ok(fs.existsSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json')));

  const { project, workspaceId, noteId } = await projects.createProjectWithWelcome(ctx, { name: 'From connect' });
  assert.equal(await connect.attachProject(ctx, started.id, project.id, workspaceId), 0, 'no notes were held for it');
  const names = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name);
  assert.deepEqual(names, ['Welcome!']);
  // What it brought into the library joins the Welcome workspace (2026-10-10), so that workspace's agents are told of it.
  const brought = (await mdFiles()).filter((row) => !earlier.has(row.id)).map((row) => row.id);
  assert.equal(brought.length, 5);
  const held = projects.findWorkspace(ctx, project.id, workspaceId).workspace.context;
  assert.equal(held[0], noteId, 'the Welcome! note first');
  assert.deepEqual(brought.filter((id) => !held.includes(id)), [], 'every note it brought in');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8')).rows.sort(), [...new Set(held.slice(1))].sort(), 'kept with the session, for a resume');
  connect.dismiss(started.id);
  assert.equal(connect.list(ctx.dataRoot).some((s) => s.id === started.id), false);
  fs.rmSync(memory.memoryPath(ctx.dataRoot));
});

test('an import started from a project and a workspace lands in both; a row removed from the project is not brought back (2026-10-11)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'placed-'));
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  const { project, workspaceId } = await projects.createProjectWithWelcome(ctx, { name: 'Imported into' });
  const { connect, state } = fakeConnect({ home: fresh });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } }, provider: 'openai', projectId: project.id, workspaceId });
  assert.equal(started.mode, 'existing');
  await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the folder button');
  await connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: '~/Vault' });
  await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
  connect.answer(started.id, { picked: ['Everything'] });
  await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the notes import');
  const listed = () => projects.findProject(ctx, project.id).library;
  await until(() => connect.state(started.id).placed, (placed) => placed.project === 5 && placed.workspace === 5, 'the five placed');
  assert.equal(listed().length, 5, 'on the project\'s own list');
  const context = projects.findWorkspace(ctx, project.id, workspaceId).workspace.context;
  assert.deepEqual(listed().filter((id) => !context.includes(id)), [], 'and in the workspace it was started from');
  assert.deepEqual((await library.libraryForProject(ctx, project.id)).map((row) => row.id).filter((id) => listed().includes(id)).sort(), [...listed()].sort(), 'the project holds them');

  // Taken out of the project, then the session places what it brought again (as a resumed or repeated import does).
  const [gone] = listed();
  await projects.removeFromProject(ctx, project.id, [gone]);
  await connect.attachProject(ctx, started.id, project.id, workspaceId);
  assert.ok(!listed().includes(gone), 'not back on the project\'s list');
  assert.ok(!projects.findWorkspace(ctx, project.id, workspaceId).workspace.context.includes(gone), 'nor in the workspace');
  assert.ok(!(await library.libraryForProject(ctx, project.id)).some((row) => row.id === gone));
  // Only an add brings it back.
  await projects.addToProject(ctx, project.id, [gone]);
  assert.ok(listed().includes(gone));

  // A workspace that is not the project's is left out: what comes in is the project's alone.
  const other = await projects.createProjectWithWelcome(ctx, { name: 'Someone else' });
  const second = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } }, provider: 'openai', projectId: project.id, workspaceId: other.workspaceId });
  const savedAt = path.join(ctx.dataRoot, '.connect', second.id, 'session.json');
  await until(() => fs.existsSync(savedAt), Boolean, 'the second session saved');
  assert.equal(JSON.parse(fs.readFileSync(savedAt, 'utf8')).workspaceId, null);
  connect.stop(second.id);
  connect.dismiss(started.id);
  connect.dismiss(second.id);
});

test('Connect sends the open workspace with its project, and says where what came in went', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const pid = randomUUID(), wid = randomUUID();
  assert.equal(model.choicesOf({ picks: {}, apps: {}, projectId: pid, workspaceId: wid }).workspaceId, wid);
  assert.equal('workspaceId' in model.choicesOf({ picks: {}, apps: {}, workspaceId: wid }), false, 'no project, no workspace');
  const line = (project, workspace) => model.placedLine({ projectId: pid, placed: { project, workspace } });
  assert.equal(line(742, 500), '742 added to the project. The first 500 are also in this workspace.');
  assert.equal(line(3, 3), '3 added to the project. They are also in this workspace.');
  assert.equal(line(4, 0), '4 added to the project.');
  assert.equal(line(0, 0), '');
  assert.equal(model.placedLine({ projectId: null, placed: { project: 3, workspace: 0 } }), '', 'onboarding before its project');
});

/**
 * The web sign-in with a fake machine (2026-10-09): Safari the default, `browsers` { id: { apps: [signed in], deny } }; a
 * sign-in made after the page opens: `later` { app: looks }. `keychain` lists each Chromium import, as macOS would be asked.
 */
function fakeSignIn({ browsers = {}, later = {} } = {}) {
  const COOKIES = { 'chatgpt.com': '__Secure-next-auth.session-token', 'claude.ai': 'sessionKey' };
  const NAMES = { chrome: ['Chrome', 'chromium', 'com.google.Chrome'], firefox: ['Firefox', 'firefox', 'org.mozilla.firefox'] };
  const held = [];
  const calls = { keychain: [], openedIn: [], looks: 0 };
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: [{ id: 'Default', name: 'Me' }] })),
    cookieNames: (id, profile, domains) => {
      const app = domains[0] === 'chatgpt.com' ? 'ChatGPT' : domains[0] === 'claude.ai' ? 'Claude' : '';
      if (later[app] != null && calls.openedIn.length) calls.looks += 1;
      const signedIn = browsers[id].apps.includes(app) || (later[app] != null && calls.looks > later[app]);
      return signedIn ? [{ domain: domains[0], name: COOKIES[domains[0]] }] : [];
    },
    import: async ({ browser: id, domains }) => {
      if (NAMES[id][1] === 'chromium') calls.keychain.push(id);
      if (browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
      held.push({ domain: `.${domains[0]}`, name: COOKIES[domains[0]] });
    },
  };
  const webSignIn = createWebSignIn({
    cookieImport, defaultBrowser: () => 'Safari', pollMs: 1, timeoutMs: 2000, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    getSession: () => ({ cookies: { get: async ({ domain }) => held.filter((cookie) => cookie.domain.endsWith(domain)) } }),
    openExternal: async () => { throw new Error('Safari is never opened'); },
    openIn: async (id, url) => { calls.openedIn.push([id, url]); },
  });
  return { webSignIn, calls };
}

test('sign-ins sorted before the run: one signed in is surveyed, one signed out gets its card up front and its survey after', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'Claude';
  const { webSignIn, calls } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } }, later: { Claude: 1 } });
  const chats = [];
  const { connect, state } = fakeConnect({ webSignIn, notify: (snapshot) => chats.push(JSON.parse(JSON.stringify(snapshot.chat))) });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    assert.deepEqual(chats.find((chat) => chat.length).map((entry) => [entry.opener, entry.text]), [[true, 'Looking at what you picked…']], 'a first line at once');
    const asked = await until(state(started.id), (s) => s.needs.length === 1 && !s.thinking, 'Claude\'s card, before any survey asks');
    assert.ok(asked.log.some((entry) => entry.text === 'Signed in to ChatGPT from Chrome'));
    assert.deepEqual([asked.needs[0].app, asked.needs[0].kind, asked.needs[0].reason, asked.needs[0].error], ['Claude', 'signin', 'Sign in to Claude', '']);
    assert.equal(asked.needs[0].note, '', 'macOS was asked for Chrome\'s sign-ins already (ChatGPT\'s)');
    assert.deepEqual(asked.jobs.filter((job) => job.kind === 'survey').map((job) => job.apps[0]), ['ChatGPT'], 'no survey of Claude until its sign-in is done');
    assert.deepEqual(asked.jobs.filter((job) => job.kind === 'recall').map((job) => job.apps[0]), ['ChatGPT'], 'nor its recall');
    assert.match(asked.chat[0].text, /^(Found .*|Had a look at what you picked\.) Starting with your ai chats\.\n\nUsing your Chrome sign-ins for ChatGPT\.$/, 'the sign-in brought over is said; Claude, signed out, has its card');
    // Log in: Safari is the default, so the page opens in Chrome; done once the sign-in is brought over.
    await connect.need(started.id, asked.needs[0].id, 'open');
    const after = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'Claude' && job.status === 'done'), 'Claude\'s survey, after its sign-in');
    assert.deepEqual(calls.openedIn, [['chrome', 'https://claude.ai/login']]);
    assert.equal(after.needs.length, 0, 'its survey did not ask again');
    assert.ok(after.log.some((entry) => entry.text === 'Signed in to Claude from Chrome'));
    assert.ok(after.jobs.some((job) => job.kind === 'recall' && job.apps[0] === 'Claude'), 'then its recall');
  } finally {
    if (started) connect.stop(started.id);
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

test('a Keychain refusal in the check: no cards that cannot succeed, macOS asked once; both skipped and said so in the chat', async () => {
  const { webSignIn, calls } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT', 'Claude'], deny: true } } });
  const { connect, state } = fakeConnect({ webSignIn });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    assert.deepEqual(calls.keychain, ['chrome'], 'one question to macOS in the check');
    assert.deepEqual(now.needs, [], 'refused apps get no card');
    assert.equal(now.jobs.some((job) => job.apps.includes('ChatGPT') || job.apps.includes('Claude')), false, 'nothing of either runs');
    assert.match(now.chat[0].text, /\n\nSkipped ChatGPT and Claude: macOS didn't allow Chrome's sign-ins\. You can add them later from Add sources\.$/);
    assert.doesNotMatch(now.chat[0].text, /Using your/);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('refused is told apart from signed out: the refused app is skipped, the signed-out one keeps its card up front', async () => {
  const { webSignIn } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'], deny: true } } });
  const { connect, state } = fakeConnect({ webSignIn });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.needs.length === 1 && s.chat.length > 1 && !s.thinking, 'Claude\'s card');
    assert.deepEqual([now.needs[0].app, now.needs[0].error], ['Claude', '']);
    assert.match(now.chat[0].text, /\n\nSkipped ChatGPT: macOS didn't allow Chrome's sign-ins\. You can add it later from Add sources\.$/);
    assert.ok(now.log.some((entry) => entry.text === 'Skipped ChatGPT: macOS didn\'t allow Chrome\'s sign-ins'));
    assert.equal(now.jobs.some((job) => job.apps.includes('ChatGPT')), false);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('Log in that macOS refuses: the card closes as skipped, and the chat says so', async () => {
  const { webSignIn, calls } = fakeSignIn({ browsers: { chrome: { apps: [], deny: true } }, later: { ChatGPT: 1 } });
  const { connect, state } = fakeConnect({ webSignIn });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    const asked = await until(state(started.id), (s) => s.needs.length === 1 && !s.thinking, 'ChatGPT\'s card (signed out, nothing to ask macOS)');
    assert.deepEqual(calls.keychain, []);
    await connect.need(started.id, asked.needs[0].id, 'open');
    const now = await until(state(started.id), (s) => s.needs.length === 0, 'the card closed');
    assert.deepEqual(calls.keychain, ['chrome'], 'macOS was asked once the sign-in was made in Chrome');
    assert.ok(now.chat.some((entry) => entry.role === 'agent' && entry.text === 'Skipped ChatGPT: macOS didn\'t allow Chrome\'s sign-ins. You can add it later from Add sources.'), 'said in the chat');
    assert.ok(now.log.some((entry) => entry.text === 'Skipped: Sign in to ChatGPT'), 'closed as skipped');
    assert.equal(now.jobs.some((job) => job.apps.includes('ChatGPT')), false);
  } finally {
    if (started) connect.stop(started.id);
  }
});

/** The fake machine's webSignIn, with each signInQuiet counted and, with `slowMs`, answered that much later. */
function countedSignIn(fake, { slowMs = 0 } = {}) {
  const quiet = [];
  const webSignIn = { ...fake.webSignIn, signInQuiet: async (app, options) => {
    quiet.push(app);
    if (slowMs) await new Promise((resolve) => { setTimeout(resolve, slowMs); });
    return fake.webSignIn.signInQuiet(app, options);
  } };
  return { webSignIn, quiet };
}

test('checked when ticked: the run uses that answer without looking again; the opener names the browser remembered', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } } });
  const { webSignIn, quiet } = countedSignIn(fake);
  const { connect, state } = fakeConnect({ webSignIn });
  let started = null;
  try {
    assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: 'Chrome', note: 'macOS will ask to use Chrome\'s sign-ins. Choose Always Allow so it doesn\'t ask again.' });
    assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-in', browser: 'Chrome' });
    assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: '', note: '' }, 'held now: macOS will not be asked');
    // Ticked again: signInQuiet answers browser '' (held already); the browser it came from is remembered.
    assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-in', browser: 'Chrome' });
    assert.deepEqual(await connect.signInCheck('Claude'), { status: 'signed-out', browser: '' });
    assert.deepEqual(quiet, ['ChatGPT', 'ChatGPT', 'Claude']);
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.needs.length === 1 && s.chat.length > 1 && !s.thinking, 'Claude\'s card');
    assert.deepEqual(quiet, ['ChatGPT', 'ChatGPT', 'Claude'], 'no signInQuiet for an app checked when ticked');
    assert.equal(now.needs[0].app, 'Claude', 'its signed-out answer is used: its card up front');
    assert.match(now.chat[0].text, /\n\nUsing your Chrome sign-ins for ChatGPT\.$/);
    assert.ok(now.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'ChatGPT'));
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a check when ticked waits on macOS as long as the person takes; the run waits for it too; no check keeps the 10 s limit', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT', 'Claude'] } } });
  const { webSignIn, quiet } = countedSignIn(fake, { slowMs: 80 });
  const { connect, state } = fakeConnect({ webSignIn, deps: { signInCheckMs: 20 } });
  let started = null;
  try {
    const checking = connect.signInCheck('ChatGPT'); // macOS's prompt answered after longer than the run's limit
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    assert.deepEqual(await checking, { status: 'signed-in', browser: 'Chrome' });
    const now = await until(state(started.id), (s) => s.needs.length === 1 && s.chat.length > 1 && !s.thinking, 'Claude\'s card');
    assert.deepEqual(quiet, ['ChatGPT', 'Claude']);
    assert.equal(now.needs[0].app, 'Claude', 'Claude, not checked when ticked, ran out of the limit: signed out, its card');
    assert.match(now.chat[0].text, /Using your Chrome sign-ins for ChatGPT\.$/, 'ChatGPT, still being checked when the run started, ended signed in');
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('no panel for an app no browser holds: the check opens nothing, so macOS is not promised; the Log in card still names where it opens', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['Claude'] } } }); // Chrome would open ChatGPT's sign-in page, but holds none
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: '', note: '' }, 'no browser holds it: no panel');
  assert.equal(fake.webSignIn.keychainNote('ChatGPT'), 'macOS will ask to use Chrome\'s sign-ins. Choose Always Allow so it doesn\'t ask again.', 'the Log in card\'s note keeps the opener');
  assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-out', browser: '' }, 'straight to "You\'ll sign in after you start"');
  assert.deepEqual(fake.calls.keychain, [], 'macOS was not asked');
  assert.deepEqual((await connect.signInNote('Claude')).browser, 'Chrome', 'one it holds still has its panel');
});

test('a refusal when ticked: the browser is not asked again, until Try again', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT', 'Claude'], deny: true } } });
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'refused', browser: 'Chrome' });
  assert.equal((await connect.signInNote('Claude')).note, '', 'refused: no panel, macOS won\'t be asked');
  assert.deepEqual(await connect.signInCheck('Claude'), { status: 'refused', browser: 'Chrome' });
  assert.deepEqual(fake.calls.keychain, ['chrome'], 'Chrome is in denied: asked once');
  assert.deepEqual(await connect.signInCheck('ChatGPT', { retry: true }), { status: 'refused', browser: 'Chrome' });
  assert.deepEqual(fake.calls.keychain, ['chrome', 'chrome'], 'Try again asks macOS again');
  assert.deepEqual(await connect.signInCheck('Notion'), { status: '', browser: '' }, 'a connector is not checked here');
  const none = fakeConnect({ webSignIn: fakeSignIn({ browsers: {} }).webSignIn });
  assert.deepEqual(await none.connect.signInCheck('ChatGPT'), { status: 'no-browser', browser: '' });
});

test('no browser whose sign-ins can be read (Safari only): the card says which it needs, and keeps Skip', async () => {
  const { webSignIn, calls } = fakeSignIn({ browsers: {} });
  const shown = [];
  const browser = { has: () => true, show: (jobId) => { shown.push(jobId); return true; }, hide: () => {} };
  const { connect, state } = fakeConnect({ webSignIn, browser });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    const asked = await until(state(started.id), (s) => s.needs.length === 1 && !s.thinking, 'ChatGPT\'s card');
    await connect.need(started.id, asked.needs[0].id, 'open');
    const now = await until(state(started.id), (s) => s.needs[0] && s.needs[0].error, 'the error');
    assert.equal(now.needs[0].error, 'Signing in to ChatGPT needs Chrome, Brave, Edge, Arc or Firefox.');
    assert.deepEqual([shown, calls.openedIn], [[], []], 'no window of Engelbart\'s, nothing opened');
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('the priority queue: surveys first, then the recalls, three at a time, MEMORY.md after everything; a survey waits on the person', async () => {
  const order = [];
  const inner = createFakeConnectAgents({ delayMs: 30 });
  const agents = { turn: (input) => { if (input.meta && input.meta.job) order.push(`${input.meta.job.kind}:${input.meta.job.apps.join(',')}`); return inner.turn(input); } };
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'Claude';
  const { connect, state } = fakeConnect({ agents });
  try {
    const started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude', 'Gemini', 'Grok'] } } });
    const first = await until(state(started.id), (s) => s.jobs.filter((job) => job.status === 'running' || job.status === 'waiting').length === 3, 'three running');
    assert.deepEqual(first.jobs.filter((job) => job.status !== 'queued').map((job) => job.kind), ['survey', 'survey', 'survey'], 'surveys take the first places');
    assert.equal(first.jobs.filter((job) => job.kind === 'recall').length, 4, 'every assistant will be asked what it remembers');
    // Claude's survey hands the person its sign-in: one request, then done.
    const asked = await until(state(started.id), (s) => s.needs.length === 1, 'Claude\'s sign-in');
    assert.deepEqual([asked.needs[0].app, asked.needs[0].kind, asked.needs[0].reason], ['Claude', 'signin', 'Sign in to Claude']);
    assert.equal(asked.jobs.find((job) => job.kind === 'survey' && job.apps[0] === 'Claude').status, 'waiting');
    const answered = await connect.need(started.id, asked.needs[0].id, 'done');
    assert.equal(answered.needs.length, 0);
    await until(state(started.id), (s) => s.jobs.filter((job) => job.kind === 'survey').every((job) => job.status === 'done'), 'every survey');
    assert.deepEqual(order.slice(0, 4).map((entry) => entry.split(':')[0]), ['survey', 'survey', 'survey', 'survey'], 'no recall before the surveys have their places');
    // The librarian waited for the surveys, then asks about what they found, one item per line.
    const card = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask && entry.ask.kind === 'multi'), 'the chats question');
    assert.deepEqual(card.chat.find((entry) => entry.ask).ask.options.slice(0, 2).map((option) => option.label), ['Everything', 'ChatGPT item 1']);
    connect.answer(started.id, { picked: ['Everything'] });
    const ended = await until(state(started.id), (s) => s.memory.status === 'saved', 'MEMORY.md', 2000);
    const memoryAt = order.indexOf('memory:');
    assert.ok(memoryAt > order.lastIndexOf('import:') && memoryAt > order.lastIndexOf('recall:Grok'), `MEMORY.md waits for every import and recall: ${order.join(' ')}`);
    assert.equal(order[order.length - 1], 'redact:', 'then one agent takes the secrets out');
    assert.ok(ended.log.some((entry) => /Kept what ChatGPT remembers/.test(entry.text)));
    assert.ok(fs.existsSync(path.join(ctx.dataRoot, '.connect', started.id, 'memories', 'ChatGPT.md')));
    fs.rmSync(memory.memoryPath(ctx.dataRoot));
  } finally {
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

test('a whole source handed over still reaches its apps: its import gets the agents\' browser on their sites', async () => {
  const opened = [];
  const stub = { tools: (job) => { opened.push({ label: job.label, sites: job.sites }); return {}; }, close: () => {}, hide: () => {}, has: () => false, show: () => false, closeAll: () => {} };
  const { connect, state } = fakeConnect({ browser: stub });
  const started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } }, permissions: { recall: false } });
  await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the chats question');
  connect.answer(started.id, { picked: ['Everything'] });
  const now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the chats import');
  assert.deepEqual(now.jobs.find((job) => job.kind === 'import').apps, [], 'handed over whole');
  assert.deepEqual(opened.map((entry) => [entry.label, entry.sites.includes('chatgpt.com')]), [['Looking through ChatGPT', true], ['AI chats', true]]);
  connect.stop(started.id);
});

// Google Docs is shown as Google Drive (2026-10-10): its id is what is picked, sent, saved and resumed; what the person reads says Drive.
test('Google Docs is picked, saved and resumed by its id, and every line the person reads during the run says Google Drive', async () => {
  const home = fs.mkdtempSync(path.join(homeDir, 'drive-')); // no Obsidian vault: the notes import reads Google Drive alone
  const first = fakeConnect({ home, delayMs: 30 });
  const started = await first.connect.start({ sources: { notes: { on: true, apps: ['Google Docs'] } }, permissions: { recall: false } });
  await until(first.state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
  first.connect.answer(started.id, { picked: ['Everything'] });
  const going = await until(first.state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'running'), 'the import running');
  const survey = going.jobs.find((job) => job.kind === 'survey');
  assert.deepEqual([survey.apps, survey.label], [['Google Docs'], 'Looking through Google Drive']);
  const shown = (s) => JSON.stringify({ jobs: s.jobs.map((job) => [job.label, job.activity, job.error]), needs: s.needs.map((need) => [need.reason, need.note, need.error]), log: s.log.map((entry) => entry.text) });
  assert.doesNotMatch(shown(going), /Google Docs/, shown(going));
  first.connect.suspendAll();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.choices.sources.notes.apps, ['Google Docs'], 'saved by its id');

  const second = fakeConnect({ home, delayMs: 5 });
  second.connect.resume(ctx);
  assert.ok(second.connect.has(started.id));
  const done = await until(second.state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the import finished after the restart', 1500);
  assert.deepEqual(done.jobs.find((job) => job.kind === 'survey').apps, ['Google Docs'], 'resumed by its id');
  assert.doesNotMatch(shown(done), /Google Docs/, shown(done));
  for (const one of second.connect.list(ctx.dataRoot)) second.connect.stop(one.id);
});

test('an existing user\'s session belongs to their project; Stop ends every agent and MEMORY.md is not written', async () => {
  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'Existing' });
  const { connect, state } = fakeConnect({ delayMs: 60 });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, chats: { on: true, apps: ['ChatGPT'] } }, projectId: project.id, permissions: { recall: false } });
  assert.equal(started.mode, 'existing');
  assert.equal(started.projectId, project.id);
  let now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the first question');
  assert.equal(now.jobs.filter((job) => job.kind === 'recall').length, 0, 'not allowed to ask what ChatGPT remembers');
  connect.answer(started.id, { picked: ['Everything'] });
  now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.notes > 0), 'notes coming in');
  assert.equal(now.staged, 0, 'nothing staged: the project exists');
  connect.stop(started.id);
  now = await until(state(started.id), (s) => s.jobs.every((job) => ['done', 'failed', 'stopped'].includes(job.status)), 'everything stopped');
  assert.equal(now.stopped, true);
  assert.ok(['stopped', 'waiting'].includes(now.memory.status));
  assert.equal(fs.existsSync(memory.memoryPath(ctx.dataRoot)), false);
  assert.throws(() => connect.retryMemory(started.id), /stopped/);
});

test('without Claude Code or Codex signed in nothing starts; the provider can change, never to one that cannot run', async () => {
  const none = createConnect({ agents: createFakeConnectAgents({ delayMs: 5 }), ready: () => [], context: async () => ctx, homeDir, env: {}, openBridge: openToolBridge });
  await assert.rejects(none.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } }), /Sign in to Claude Code or Codex first/);
  const one = createConnect({ agents: createFakeConnectAgents({ delayMs: 5 }), ready: () => ['openai'], context: async () => ctx, homeDir, env: {}, openBridge: openToolBridge });
  assert.deepEqual(one.providers().map((entry) => [entry.provider, entry.modelName, entry.effort, entry.ready]), [['anthropic', 'Sonnet', 'high', false], ['openai', 'Sol', 'high', true]]);
  const started = await one.start({ sources: { notes: { on: true, apps: ['Obsidian'] } }, provider: 'anthropic' });
  assert.equal(started.provider, 'openai', 'the one that can run');
  assert.throws(() => one.setProvider(started.id, 'anthropic'), /Claude Code is not signed in/);
  one.stop(started.id);
});

test('Skip holds for the run: the app is never put to the person again, and its queued work ends as skipped', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'Claude';
  const { connect, state } = fakeConnect({ delayMs: 150 });
  let started = null;
  try {
    // three surveys take the three places, so the recalls wait their turn
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Gemini', 'Claude'] } } });
    const asked = await until(state(started.id), (s) => s.needs.length === 1, 'Claude\'s sign-in');
    const after = await connect.need(started.id, asked.needs[0].id, 'skip');
    assert.equal(after.needs.length, 0);
    // queued or already started, Claude's recall ends as skipped
    const ended = await until(state(started.id), (s) => ['stopped', 'done', 'failed'].includes(s.jobs.find((job) => job.kind === 'recall' && job.apps[0] === 'Claude').status), 'Claude\'s recall ended');
    const recall = ended.jobs.find((job) => job.kind === 'recall' && job.apps[0] === 'Claude');
    assert.deepEqual([recall.status, recall.skipped], ['stopped', true], 'Claude\'s recall is not run');
    assert.ok(!fs.existsSync(path.join(ctx.dataRoot, '.connect', started.id, 'memories', 'Claude.md')));
    // Import hands nothing over for a skipped app, and an agent that asks again hears "skipped" with no card.
    await until(state(started.id), (s) => !s.thinking, 'the librarian');
    const imported = connect.importNow(started.id);
    const handed = imported.jobs.filter((job) => job.kind === 'import');
    assert.ok(handed.every((job) => !job.apps.includes('Claude')), JSON.stringify(handed.map((job) => job.apps)));
    assert.equal(imported.needs.length, 0);
  } finally {
    if (started) connect.stop(started.id); // nothing left waiting: a session left running keeps the test process open
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

test('a session still going when Engelbart quits is picked up again when the library opens: its work queued again, the librarian asked again', async () => {
  const first = fakeConnect({ delayMs: 400 });
  const started = await first.connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, chats: { on: true, apps: ['ChatGPT'] } }, permissions: { recall: false } });
  await until(first.state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the first question');
  first.connect.answer(started.id, { picked: ['Everything'] });
  await until(first.state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'running'), 'an import running');
  first.connect.suspendAll(); // Engelbart quits
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.equal(saved.suspended, true);
  assert.equal(saved.stopped, false, 'put away, not stopped');
  assert.equal(first.connect.list(ctx.dataRoot).length, 0);

  // The next launch: the same library opened again.
  const second = fakeConnect({ delayMs: 5 });
  assert.ok(second.connect.resume(ctx) >= 1);
  assert.ok(second.connect.has(started.id));
  assert.equal(second.connect.resume(ctx), 0, 'once a launch');
  const back = second.connect.state(started.id);
  assert.equal(back.chat[0].role, 'agent', 'the chat as it was');
  assert.ok(back.log.some((entry) => /Picked up again/.test(entry.text)));
  const done = await until(second.state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the import finished after the restart', 1500);
  assert.ok(done.jobs.find((job) => job.kind === 'import' && job.status === 'done').notes >= 0);
  // An old session that was stopped by the person is left alone.
  const stoppedOne = fakeConnect({ delayMs: 5 });
  const other = await stoppedOne.connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } });
  stoppedOne.connect.stop(other.id);
  const third = fakeConnect({ delayMs: 5 });
  third.connect.resume(ctx);
  assert.equal(third.connect.has(other.id), false);
  for (const s of second.connect.list(ctx.dataRoot)) second.connect.stop(s.id);
  for (const s of third.connect.list(ctx.dataRoot)) third.connect.stop(s.id);
});

// Ask about the project before Connect your library, and give it to the librarian (2026-10-10).
test('the project goes to the librarian, its surveys and its imports, and is kept through a quit; onboarding sends no project id, so its session is found again', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const long = `  ${'d'.repeat(5000)}  `;
  const sent = model.choicesOf({ picks: {}, apps: {}, project: { name: '  Teachable agents  ', description: long } });
  assert.deepEqual([sent.project.name, sent.project.description.length, 'projectId' in sent], ['Teachable agents', 4000, false], 'trimmed, capped like MAX_DESCRIPTION, and no id');
  assert.equal('project' in model.choicesOf({ picks: {}, apps: {}, project: { name: ' ', description: '' } }), false);
  assert.equal('project' in model.choicesOf({ picks: {}, apps: {} }), false);
  assert.deepEqual(cleanChoices({ sources: {}, project: { name: ' A ', description: ` ${'x'.repeat(4100)}`, extra: 1 } }, homeDir).project, { name: 'A', description: 'x'.repeat(4000) }, 'main keeps it, cleaned');
  assert.equal(cleanChoices({ sources: {} }, homeDir).project, null);
  assert.equal(projectBlock({ project: { name: 'A', description: '' } }), '', 'no description: told nothing, as before');
  assert.equal(projectBlock({ project: null }), '');

  const seen = [];
  const watched = (delayMs) => { const inner = createFakeConnectAgents({ delayMs }); return { ...inner, turn: (input) => { seen.push({ kind: input.kind, message: input.message }); return inner.turn(input); } }; };
  const first = fakeConnect({ agents: watched(30) });
  const project = { name: 'Teachable agents', description: 'How novices debug code with an LLM tutor' };
  // What the guided setup sends: the project's name and description, never its id.
  const started = await first.connect.start(model.choicesOf({ picks: { chats: true }, apps: { chats: { ChatGPT: true } }, permissions: { recall: false }, project }));
  assert.equal(started.mode, 'onboarding', 'no project id: still an onboarding session');
  assert.equal(started.projectId, null);
  await until(first.state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the chats question');
  first.connect.answer(started.id, { picked: ['Everything'] });
  await until(first.state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'running'), 'the import running');
  const block = '<project note="What the person is working on: the project this library is being connected for.">\nName: Teachable agents\nDescription: How novices debug code with an LLM tutor\n</project>';
  for (const kind of ['interview', 'survey', 'import']) {
    const message = (seen.find((entry) => entry.kind === kind) || {}).message || '';
    assert.ok(message.includes(block), `the ${kind} is told the project: ${message.slice(0, 300)}`);
  }
  assert.ok(seen.find((entry) => entry.kind === 'interview').message.indexOf('<project') < seen.find((entry) => entry.kind === 'interview').message.indexOf('<choices>'), 'before what was picked');

  // Engelbart quits mid-setup: the session is kept with its project, picked up again, and the onboarding screen finds it.
  first.connect.suspendAll();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.choices.project, project);
  seen.length = 0;
  const second = fakeConnect({ agents: watched(5) });
  second.connect.resume(ctx);
  assert.ok(second.connect.has(started.id));
  const entry = second.connect.list(ctx.dataRoot).find((one) => one.id === started.id);
  assert.equal(model.resumable([entry]), entry, 'ConnectLibrary\'s resume lookup takes it');
  assert.equal(model.resumable([{ ...entry, projectId: 'p1' }]), null, 'it would not with an id');
  await until(() => seen, (list) => list.some((one) => one.kind === 'import'), 'the import queued again');
  assert.ok(seen.every((one) => one.message.includes(block)), 'still told the project after the restart');
  for (const one of second.connect.list(ctx.dataRoot)) second.connect.stop(one.id);

  // With no description, the agents are told nothing of it, as before.
  seen.length = 0;
  const third = fakeConnect({ agents: watched(5) });
  const plain = await third.connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } }, permissions: { recall: false }, project: { name: 'Untitled', description: '' } });
  await until(third.state(plain.id), (s) => !s.thinking && s.chat.some((one) => one.ask), 'the chats question');
  assert.ok(seen.length && seen.every((one) => !one.message.includes('<project')), 'no <project> block');
  third.connect.stop(plain.id);
});

test('the choose screen\'s sign-in checks: each row state, the web apps a tick starts checks for, the panel and Not now', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const label = (signIn) => model.rowLabel('ChatGPT', { found: { apps: { ChatGPT: { found: true } } }, signIn });
  assert.deepEqual(label({ status: 'checking', browser: '' }), { text: 'Waiting for macOS…', tone: 'busy' });
  assert.deepEqual(label({ status: 'signed-in', browser: 'Chrome' }), { text: '✓ Signed in from Chrome', tone: 'ok' });
  assert.deepEqual(label({ status: 'signed-in', browser: '' }), { text: '✓ Signed in', tone: 'ok' });
  assert.deepEqual(label({ status: 'signed-out', browser: '' }), { text: 'You\'ll sign in after you start', tone: 'muted' });
  assert.deepEqual(label({ status: 'refused', browser: 'Chrome' }), { text: 'macOS didn\'t allow it', tone: 'error', retry: true });
  assert.deepEqual(label({ status: 'no-browser', browser: '' }), { text: 'Needs Chrome, Brave, Edge, Arc or Firefox', tone: 'muted' });
  assert.deepEqual(label(null), { text: 'Needs sign-in', tone: 'muted' }, 'not checked: as before');
  assert.deepEqual(model.rowLabel('Granola', { signIn: { status: 'signed-in', browser: 'Chrome' } }), { text: 'Needs sign-in', tone: 'muted' }, 'only web apps');

  const found = { apps: { ChatGPT: { found: true }, Claude: { found: true }, 'Claude Code': { found: true }, Obsidian: { found: true } }, sites: { found: false }, github: { found: false } };
  const start = model.initialPicks(found);
  assert.deepEqual(model.newlyTickedWeb(null, start).map((row) => row.app).filter((app) => ['ChatGPT', 'Claude'].includes(app)), [], 'assistants that remember start unticked');
  // A row, a group's header, Select all: each the web apps it newly ticks, and nothing else.
  const one = model.tickRow(start, 'chats', 'ChatGPT', true);
  assert.deepEqual(model.newlyTickedWeb(start, one), [{ id: 'chats', app: 'ChatGPT' }]);
  const cleared = model.tickGroup(start, 'chats', found);
  const group = model.tickGroup(cleared, 'chats', found);
  assert.deepEqual(model.newlyTickedWeb(cleared, group), [{ id: 'chats', app: 'ChatGPT' }, { id: 'chats', app: 'Claude' }], 'the group\'s web apps, not Claude Code');
  const all = model.tickAll(model.tickAll(start, found, false), found, true);
  assert.deepEqual(model.newlyTickedWeb(model.tickAll(start, found, false), all), [{ id: 'chats', app: 'ChatGPT' }, { id: 'chats', app: 'Claude' }]);
  assert.deepEqual(model.newlyTickedWeb(all, model.tickAll(all, found, false)), [], 'unticking checks nothing');

  // One panel per browser, naming every app waiting on it.
  let waiting = model.waitForYes({}, [{ id: 'chats', app: 'ChatGPT', browser: 'Chrome' }]);
  waiting = model.waitForYes(waiting, [{ id: 'chats', app: 'Claude', browser: 'Chrome' }, { id: 'chats', app: 'ChatGPT', browser: 'Chrome' }]);
  assert.deepEqual(waiting, { Chrome: [{ id: 'chats', app: 'ChatGPT' }, { id: 'chats', app: 'Claude' }] });
  const panel = model.signInPanel(all, 'Chrome', waiting.Chrome);
  assert.equal(panel.title, 'Use your Chrome sign-ins for ChatGPT and Claude?');
  assert.equal(panel.lead, 'macOS will ask for your Mac password next. Choose Always Allow so it only asks once.', 'the macOS line leads');
  assert.deepEqual(panel.body, ['Engelbart copies only these apps\' sign-ins from Chrome, and only reads from them, so you don\'t log in again. Not now leaves them out.']);
  const claudeOff = model.tickRow(all, 'chats', 'Claude', false);
  assert.equal(model.signInPanel(claudeOff, 'Chrome', waiting.Chrome).title, 'Use your Chrome sign-ins for ChatGPT?', 'an app unticked meanwhile leaves the panel');
  assert.match(model.signInPanel(claudeOff, 'Chrome', waiting.Chrome).body[0], /this app's sign-in from Chrome.*Not now leaves it out\.$/);

  // After Continue, the modal says how it went (2026-10-11): waiting while macOS asks, then signed in, refused, or not there.
  const rows = waiting.Chrome;
  const outcome = (chatgpt, claude) => model.keychainOutcome('Chrome', rows, { ...(chatgpt ? { ChatGPT: { status: chatgpt } } : {}), ...(claude ? { Claude: { status: claude } } : {}) });
  assert.deepEqual(outcome('checking', 'signed-in'), { done: false, title: 'Waiting for macOS…', lines: ['Enter your Mac password in the macOS window, then choose Always Allow.'], tone: 'busy' });
  assert.deepEqual(outcome('signed-in', 'signed-in'), { done: true, title: 'Signed in to ChatGPT and Claude', lines: ['Brought over from Chrome. You won\'t need to log in again.'], tone: 'ok' });
  const mixed = outcome('signed-in', 'signed-out');
  assert.equal(mixed.tone, 'warn');
  assert.deepEqual(mixed.lines.slice(1), ['Chrome isn\'t signed in to Claude. The import will ask you to log in once it starts.']);
  assert.deepEqual(outcome('refused', 'refused'), { done: true, title: 'Not allowed', lines: ['macOS didn\'t allow it, so ChatGPT and Claude were unticked. Try again on their rows to be asked again.'], tone: 'refused' });
  assert.equal(outcome('signed-in', null).tone, 'warn', 'a check that failed and was cleared counts as not brought over, never waits forever');
  // Not now unticks them: no panel is left.
  const notNow = waiting.Chrome.reduce((next, row) => model.tickRow(next, row.id, row.app, false), all);
  assert.equal(model.signInPanel(notNow, 'Chrome', waiting.Chrome), null);
  assert.deepEqual([model.ticked(notNow, 'chats', 'ChatGPT'), model.ticked(notNow, 'chats', 'Claude'), model.ticked(notNow, 'chats', 'Claude Code')], [false, false, true]);

  // "Use my … subscription" off: no sign-in is checked (ticked, Try again, or a panel's Continue at start) and no panel shows.
  const ticking = model.newlyTickedWeb(start, one);
  assert.deepEqual(model.signInsToCheck(true, ticking), ticking);
  assert.deepEqual(model.signInsToCheck(false, ticking), [], 'consent off: nothing checked');
  assert.deepEqual(model.waitingWhile(true, waiting), waiting);
  assert.deepEqual(model.waitingWhile(false, waiting), {}, 'consent off: the panels go, and start has none to allow');
  assert.deepEqual(Object.keys(model.waitingWhile(false, waiting)).map((browser) => model.signInPanel(all, browser, waiting[browser])), [], 'no panel shown');
});

test('the window\'s model, and the onboarding flow with Connect your library in place of Add to your library and Custom instructions', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { Obsidian: { found: true }, 'Claude Code': { found: true }, ChatGPT: { found: true } }, sites: { found: true }, github: { found: false } };
  const start = model.initialPicks(found);
  assert.deepEqual(start.picks, { notes: true, transcripts: false, email: false, chats: true, sites: true, papers: false, code: false });
  assert.deepEqual(start.open, { notes: true });
  // MATH-114: an assistant that remembers the person starts unticked even when found; the rest found start ticked
  assert.deepEqual([start.apps.chats.ChatGPT, start.apps.chats['Claude Code'], start.apps.notes.Obsidian, start.apps.sites[model.BROWSER_ROW]], [false, true, true, true]);
  assert.deepEqual(model.pickedApps(start.picks, start.apps), ['Obsidian', 'Claude Code']);
  assert.equal(model.subOf('notes', start), 'Obsidian');
  assert.equal(model.subOf('transcripts', start), 'nothing picked');
  assert.equal(model.subOf('sites', start), model.BROWSER_ROW);
  assert.equal(model.rowSub('ChatGPT'), '', 'what asking an assistant is, the refine chat says');
  assert.equal(model.rowSub('Apple Notes'), 'macOS will ask');
  assert.equal(model.rowSub('Obsidian'), '');
  assert.deepEqual(model.permissionsFor(['Granola', 'Apple Notes', 'Claude']), { web: ['Claude'], recall: ['Claude'], connectors: ['Granola'], notes: true });
  // recall only once a memory app is ticked; files and the browser from the one checkbox
  assert.deepEqual(model.permissionsOf(start, { consent: true }), { files: true, browser: true, recall: false, notes: false });
  const withChatGPT = model.tickRow(start, 'chats', 'ChatGPT', true);
  assert.equal(withChatGPT.picks.chats, true);
  assert.deepEqual(model.permissionsOf(withChatGPT, { consent: false, notes: true }), { files: false, browser: false, recall: true, notes: true });
  // the checkbox names what is read on this Mac and in Engelbart's browser, not connectors, Apple Notes or recall
  const more = ['Notion', 'Apple Notes', 'Google Docs'].reduce((state, app) => model.tickRow(state, 'notes', app, true), withChatGPT);
  assert.deepEqual(model.consentFor(more), ['Obsidian', 'Google Docs', 'ChatGPT', 'Claude Code', 'your browser history']);
  assert.deepEqual(model.consentFor(model.tickAll(start, found, false)), []);
  // each row's label, by how it is reached and where it stands
  const seen = { apps: { Obsidian: { found: true, where: '~/Vault' }, ChatGPT: { found: true, signedIn: true, where: 'signed in to Engelbart' }, Perplexity: { found: true, signedIn: false, where: 'Sign in to add' }, Cursor: { found: false }, Evernote: { found: false } } };
  assert.deepEqual(model.rowLabel('Obsidian', { found: seen }), { text: '~/Vault', tone: '' });
  assert.deepEqual(model.rowLabel('Cursor', { found: seen }), { text: 'Not found', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Cursor', { found: seen, folder: '~/Work' }), { text: '~/Work', tone: '' });
  assert.deepEqual(model.rowLabel('ChatGPT', { found: seen }), { text: 'signed in to Engelbart', tone: '' });
  assert.deepEqual(model.rowLabel('Perplexity', { found: seen }), { text: 'Needs sign-in', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Evernote', { found: seen }), { text: 'Not found', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Granola', { found: seen }), { text: 'Needs sign-in', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Granola', { found: seen, connectors: { Granola: { pending: true } } }), { text: 'Waiting for Granola sign-in…', tone: 'busy' });
  assert.deepEqual(model.rowLabel('Notion', { found: seen, connectors: { Notion: { connected: true } } }), { text: 'signed in', tone: '' });
  assert.deepEqual(model.rowLabel('Apple Notes', { notes: 'asking' }), { text: 'macOS is asking you…', tone: 'busy' });
  // a group's header: tri-state, and a group is never on with no row ticked (appsOf would read that as every app)
  assert.equal(model.groupState(start, 'notes'), 'some');
  assert.equal(model.groupState(start, 'sites'), 'all');
  assert.equal(model.groupState(start, 'transcripts'), 'none');
  const offObsidian = model.tickRow(start, 'notes', 'Obsidian', false);
  assert.deepEqual([offObsidian.picks.notes, model.groupState(offObsidian, 'notes'), model.choicesOf({ picks: offObsidian.picks, apps: offObsidian.apps }).sources.notes.apps], [false, 'none', []]);
  const notesOff = model.tickGroup(start, 'notes', found);
  assert.deepEqual([notesOff.picks.notes, Object.values(notesOff.apps.notes).some(Boolean)], [false, false]);
  const notesOn = model.tickGroup(notesOff, 'notes', found);
  assert.deepEqual(model.choicesOf({ picks: notesOn.picks, apps: notesOn.apps }).sources.notes.apps, ['Obsidian'], 'the header ticks the rows found, not every app');
  const nothing = model.tickGroup(start, 'transcripts', found);
  assert.deepEqual([nothing.picks.transcripts, nothing.open.transcripts], [false, true], 'a group with nothing found opens for the person to pick');
  // Code: GitHub, and the repositories on this Mac (unticked to start; sent as Code's folders)
  const withRepos = { ...found, github: { found: true, where: 'signed in' }, localRepos: [{ path: '/Users/me/a', sessions: 3 }, { path: '/Users/me/b', sessions: 1 }] };
  const code = model.initialPicks(withRepos);
  assert.deepEqual([code.apps.code.GitHub, model.localPicked(code), model.groupState(code, 'code')], [true, [], 'some']);
  const oneRepo = model.tickRepo(code, '/Users/me/a', true);
  assert.deepEqual([model.localPicked(oneRepo), model.subOf('code', oneRepo), model.groupState(oneRepo, 'code')], [['/Users/me/a'], 'GitHub, 1 local repo', 'all']);
  const allCode = model.tickGroup(model.tickGroup(code, 'code', withRepos), 'code', withRepos);
  assert.deepEqual([model.localPicked(allCode), allCode.apps.code.GitHub], [['/Users/me/a', '/Users/me/b'], true]);
  assert.equal(model.allPicked(model.tickAll(code, withRepos), withRepos), true);
  assert.equal(model.allPicked(code, withRepos), false);
  const sent = model.choicesOf({ picks: start.picks, apps: start.apps, folders: { papers: ['/p'] }, repos: ['a/b'], custom: ' skip drafts ', permissions: { files: false, recall: false }, provider: 'openai', projectId: 'p1' });
  assert.deepEqual(sent.sources.notes, { on: true, apps: ['Obsidian'], folders: [], repos: [] });
  assert.deepEqual(sent.permissions, { files: false, browser: true, recall: false, notes: false });
  assert.deepEqual([sent.computer, sent.provider, sent.projectId, sent.custom], [false, 'openai', 'p1', 'skip drafts']);
  assert.equal(model.statusOf({ status: 'done', notes: 3, items: 2 }).text, '✓ 5 added');
  assert.deepEqual(model.statusOf({ status: 'waiting', notes: 0, items: 0 }), { text: 'needs you', done: false, waiting: true });
  assert.equal(model.statusOf({ kind: 'survey', status: 'running' }).text, 'looking…');
  assert.equal(model.statusOf({ kind: 'recall', status: 'done' }).text, '✓ remembered');
  assert.equal(model.allEnded([{ status: 'done' }, { status: 'queued' }]), false);
  // "one login button on the right ... or skip"
  assert.equal(model.needView({ app: 'ChatGPT', kind: 'signin' }).action, 'Log in');
  assert.equal(model.needView({ app: 'Granola', kind: 'connector' }).action, 'Log in');
  assert.equal(model.needView({ app: 'Apple Notes', kind: 'permission' }).action, 'Allow');
  assert.equal(model.statusOf({ status: 'stopped', skipped: true, notes: 0, items: 0 }).text, 'skipped');
  // "show the ones still running at the top"
  const jobs = [{ id: 'a', status: 'done' }, { id: 'b', status: 'queued' }, { id: 'c', status: 'running' }, { id: 'd', status: 'waiting' }, { id: 'e', status: 'failed' }];
  assert.deepEqual(model.runningFirst(jobs).map((job) => job.id), ['c', 'd', 'b', 'a', 'e']);
  // the line under the chat: the librarian, then one subagent at a time
  const going = { thinking: true, activity: 'Reading what you picked', jobs: [{ id: 's1', kind: 'survey', label: 'Looking through ChatGPT', status: 'running', activity: 'Opened chatgpt.com' }, { id: 's2', kind: 'import', label: 'Notes', status: 'waiting' }, { id: 'm', kind: 'memory', status: 'running' }] };
  assert.deepEqual(model.workLine(going, 0), { lead: 'Reading what you picked…', agent: { id: 's1', label: 'Looking through ChatGPT', doing: 'Opened chatgpt.com', place: '1 of 2', waiting: false } });
  assert.deepEqual(model.workLine(going, 1).agent, { id: 's2', label: 'Notes', doing: 'needs you', place: '2 of 2', waiting: true });
  assert.equal(model.workLine({ thinking: false, jobs: [{ status: 'done', kind: 'import' }] }), null);
  // the sidebar's Inbox: needs you, or done; this project's or one with no project yet
  const inbox = model.connectInbox([
    { id: '1', projectId: 'p1', needs: [{ app: 'Claude', kind: 'signin' }], jobs: [], created: '2026-10-08T00:00:00Z' },
    { id: '2', projectId: null, done: true, needs: [], jobs: [{ status: 'done', notes: 2, items: 0 }], memory: { status: 'saved' }, counts: { notes: 2, items: 0 } },
    { id: '3', projectId: 'p1', done: true, needs: [], jobs: [{ status: 'running', notes: 0, items: 0 }], memory: { status: 'waiting' } },
    { id: '4', projectId: 'p2', needs: [{ app: 'Claude', kind: 'signin' }], jobs: [] },
  ], 'p1');
  assert.deepEqual(inbox.map((entry) => [entry.sessionId, entry.did]), [['1', 'Claude needs you to sign in'], ['2', 'Library connected · 2 added · MEMORY.md saved']]);
  assert.equal(model.memoryLine({ status: 'saved', removed: 2 }).text, 'Saved · 2 secrets masked');
  assert.deepEqual(model.dockLine({ needs: [{ app: 'ChatGPT', kind: 'signin' }], jobs: [] }), { tone: 'warn', short: 'Needs you', text: 'ChatGPT needs you to sign in' });
  assert.deepEqual(model.dockLine({ needs: [], done: true, jobs: [{ status: 'running', notes: 0, items: 0 }, { status: 'done', notes: 1, items: 0 }], memory: { status: 'waiting' } }), { tone: 'busy', short: 'Importing 1/2', text: 'Importing · 1 of 2 done' });
  assert.deepEqual(model.dockLine({ needs: [], done: true, jobs: [{ status: 'done', notes: 4, items: 1 }], memory: { status: 'saved' }, counts: { notes: 4, items: 1 } }), { tone: 'done', short: 'Library', text: 'Library connected · 5 added · MEMORY.md saved' });

  const flow = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  // "replace steps 3 and 4 with this, since it will essentially be the same"
  // 2026-10-10: Create before Connect, so the librarian is told what the project is; the project is made after Connect.
  assert.deepEqual(flow.flowOf('new', { connect: true }), ['welcome', 'tools', 'create', 'connect']);
  assert.deepEqual(flow.flowOf('new', { connect: true, tools: false }), ['welcome', 'create', 'connect']);
  assert.deepEqual(flow.flowOf('new'), ['welcome', 'tools', 'create', 'import', 'instructions'], 'without Connect (the tools screen skipped with no agent): Create, then its screens');
  assert.deepEqual(flow.forward('new', { step: 'tools', sub: 0 }, { connect: true }), { step: 'create', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'create', sub: 1 }, { connect: true }), { step: 'connect', sub: 0 });
  assert.deepEqual(flow.pagerOf('new', 'connect', { connect: true }), { count: 4, index: 3 });
  assert.deepEqual(flow.forward('new', { step: 'connect', sub: 0 }, { connect: true }), { step: 'open', sub: 0 }, 'the project is made after Connect');
  assert.equal(flow.pagerOf('new', 'import', { connect: true }), null);
  // "signing into claude code and/or codex must be done before this step"
  const tool = (status, extra = {}) => ({ status, installed: status !== 'missing', ...extra });
  const snap = (git, claude, codex) => ({ checked: true, platform: 'darwin', tools: { git: { id: 'git', name: 'Git', ...git }, claude: { id: 'claude', name: 'Claude Code', ...claude }, codex: { id: 'codex', name: 'Codex', ...codex } } });
  const signedOut = snap(tool('ready'), tool('signed-out'), tool('missing'));
  assert.equal(flow.toolsWanted(signedOut), false, 'without Connect, signing in waits for the dialog');
  assert.equal(flow.toolsWanted(signedOut, { connect: true }), true, 'with Connect, the tools screen signs one in first');
  assert.equal(flow.toolsWanted(snap(tool('ready'), tool('ready'), tool('missing')), { connect: true }), false);
  assert.deepEqual(flow.toolsStep(signedOut, { connect: true }), { ids: ['claude', 'codex'], install: [], label: 'Continue', disabled: true, stay: true });
  assert.deepEqual(flow.toolsStep(snap(tool('ready'), tool('missing'), tool('missing')), { connect: true }), { ids: ['claude', 'codex'], install: ['claude', 'codex'], label: 'Install all', disabled: false, stay: true });
  assert.deepEqual(flow.toolsStep(snap(tool('ready'), tool('ready'), tool('missing')), { connect: true }).label, 'Continue');
  assert.equal(flow.agentReady(signedOut), false);
});

// Papers on this Mac (2026-10-08, "Agent onboarding": "add capability to search local papers ... the questions for this
// should center around folders and genres of papers rather than individual ones").
const pdfHome = () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(homeDir, 'pdfs-')));
  const put = (rel, text) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `%PDF-1.4\n${text}\n%%EOF\n`); return file; };
  put('Downloads/2310.01234v2.pdf', '1 0 obj << /Title (Scaffolding novice debugging) >> endobj');
  put('Downloads/Invoice-2026-09.pdf', '1 0 obj << /Title (Invoice) >> endobj');
  put('Downloads/scan.pdf', '<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Working Spheres in Information Work</rdf:li></rdf:Alt></dc:title></x:xmpmeta>');
  put('Documents/Research/HCI/mark2004.pdf', '');
  put('Documents/Research/HCI/142750.142767.pdf', '');
  put('Documents/Research/HCI/Lecture 3 slides.pdf', '');
  put('Downloads/Some.app/Contents/Resources/manual.pdf', '');
  put('Zotero/storage/ABCD/paper.pdf', '');
  return home;
};

test('PDFs on this Mac: the folders that hold them with counts, kinds and titles; a folder\'s PDFs listed and brought in by path', async () => {
  const home = pdfHome();
  assert.equal(readers.pdfTitle(path.join(home, 'Downloads', '2310.01234v2.pdf')), 'Scaffolding novice debugging');
  assert.equal(readers.pdfTitle(path.join(home, 'Downloads', 'scan.pdf')), 'Working Spheres in Information Work');
  assert.deepEqual(['2310.01234v2.pdf', 'Invoice-2026-09.pdf', 'smith2019.pdf', 'Lecture 3 slides.pdf', 'scan.pdf', 'CV_draft.pdf'].map((name) => readers.pdfGuess(name)), ['paper', 'personal', 'paper', 'book', 'unclear', 'unclear']);
  const found = detect({ homeDir: home, applications: [] }).apps[LOCAL_PDFS];
  assert.deepEqual([found.found, found.where], [true, 'Downloads, Documents']);
  const glance = readers.pdfFolders([...readers.pdfRoots(home), path.join(home, 'Downloads')], { homeDir: home });
  assert.equal(glance.pdfs, 6, 'app bundles and ~/Zotero are passed over, and a folder is not counted twice');
  assert.deepEqual(glance.folders.map((entry) => [entry.folder, entry.pdfs, entry.kinds]), [
    ['~/Documents/Research/HCI', 3, { paper: 2, book: 1 }],
    ['~/Downloads', 3, { paper: 1, personal: 1, unclear: 1 }],
  ]);
  assert.ok(glance.folders[1].examples.some((line) => line === 'scan.pdf — Working Spheres in Information Work'), JSON.stringify(glance.folders[1].examples));
  assert.ok(!glance.folders[1].examples.some((line) => /Invoice/.test(line)), 'personal PDFs are never shown as examples');
  // The librarian's first look: everywhere when the person let the agents read their home folder, else a folder button.
  const scanned = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true } }, { homeDir: home });
  assert.equal(scanned.papers[LOCAL_PDFS].pdfs, 6);
  const narrow = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: false } }, { homeDir: home });
  assert.deepEqual(narrow.papers[LOCAL_PDFS], { reach: 'local', needs: 'folder' });
  const chosen = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [path.join(home, 'Documents')] } }, permissions: { files: false } }, { homeDir: home });
  assert.deepEqual(chosen.papers[LOCAL_PDFS].lookedIn, ['~/Documents']);
  // The import agent's tools: list by kind and words, bring in by path, nothing twice.
  const call = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir: home, dir: path.join(ctx.dataRoot, '.connect', 'pdf-test'), projectId: () => null, exports: {}, folders: {} }, context: async () => ({ ...ctx, homeDir: home }), env: {} });
  const papers = await call('list_pdfs', { folder: '~/Documents', kind: 'paper' });
  assert.deepEqual(papers.pdfs.map((pdf) => [pdf.name, pdf.folder]).sort(), [['142750.142767.pdf', 'Research/HCI'], ['mark2004.pdf', 'Research/HCI']]);
  assert.equal((await call('list_pdfs', { folder: '~/Downloads', query: 'working spheres' })).pdfs[0].name, 'scan.pdf', 'found by its title');
  const first = await call('import_pdfs', { files: [...papers.pdfs.map((pdf) => pdf.path), path.join(home, 'Documents', 'nope.pdf')] });
  assert.equal(first.added, 2);
  assert.deepEqual(first.skipped.map((entry) => entry.why), ['not there']);
  const again = await call('import_pdfs', { files: papers.pdfs.map((pdf) => pdf.path) });
  assert.deepEqual([again.added, again.skippedCount], [0, 2]);
  const rows = (await ctx.libraryDb.list()).filter((row) => row.path && row.path.startsWith(home + path.sep));
  assert.deepEqual(rows.map((row) => [row.type, path.basename(row.path)]).sort(), [['pdf', '142750.142767.pdf'], ['pdf', 'mark2004.pdf']], 'kept where they are');
  assert.equal(importToolLabel('import_pdfs', { files: ['a', 'b'] }), 'Bringing in 2 PDFs');
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /folders and kinds of papers, never about single files/);
});

test('PDFs on this Mac with a project: each folder\'s examples begin with the PDFs that share words with it, and those folders come first; without one, the newest as before', async () => {
  const home = pdfHome();
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(home, 'Downloads', '2310.01234v2.pdf'), old, old); // the matching paper is the oldest in Downloads
  const roots = [path.join(home, 'Downloads'), path.join(home, 'Documents')];
  const before = readers.pdfFolders(roots, { homeDir: home });
  assert.deepEqual(before.folders.map((entry) => entry.folder), ['~/Documents/Research/HCI', '~/Downloads'], 'most PDFs first, as before');
  const downloads = before.folders[1];
  assert.equal(downloads.examples[downloads.examples.length - 1], '2310.01234v2.pdf — Scaffolding novice debugging', 'the newest first: it comes last');
  assert.equal('relatedToProject' in downloads, false);
  const project = { name: 'Debugging tutor', description: 'How novices debug their code with scaffolding from an LLM' };
  const after = readers.pdfFolders(roots, { homeDir: home, project });
  assert.deepEqual(after.folders.map((entry) => [entry.folder, entry.relatedToProject]), [['~/Downloads', 1], ['~/Documents/Research/HCI', 0]], 'the folder holding a match first');
  assert.equal(after.folders[0].examples[0], '2310.01234v2.pdf — Scaffolding novice debugging', 'matched by its title, listed first');
  assert.deepEqual(after.folders[0].examples.slice(1).sort(), downloads.examples.slice(0, -1).sort(), 'then the newest, without it twice');
  assert.ok(!after.folders[0].examples.some((line) => /Invoice/.test(line)), 'personal PDFs still never shown');
  // The scan passes the project from the choices.
  const scanned = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project }, { homeDir: home });
  assert.equal(scanned.papers[LOCAL_PDFS].folders[0].examples[0], '2310.01234v2.pdf — Scaffolding novice debugging');
  assert.match(scanned.papers[LOCAL_PDFS].examplesFirst, /shares words with the project/);
  assert.equal('examplesFirst' in (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true } }, { homeDir: home })).papers[LOCAL_PDFS], false);
  // The librarian offers them by title, with folders and kinds of paper as the fallback.
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /offer up to ten of the papers among them that bear on the project, by title/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /When there is no project, or nothing in <found> bears on it, ask about folders and kinds of papers, never about single files/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /recommend first the items that bear on it: by their real titles/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /\("and 61 others in Downloads"\)/);
  assert.match(prompts.SURVEY_SYSTEM_PROMPT, /those related to the project in <project> first when there is one .*then research-looking, then the most recent/);
  for (const prompt of [prompts.INTERVIEW_SYSTEM_PROMPT, prompts.IMPORT_SYSTEM_PROMPT, prompts.SURVEY_SYSTEM_PROMPT]) assert.match(prompt, /- <project>, when there is one: what the person is working on/);
});

// The period picked on Connect your library (2026-10-10): the past 6 months, the past year or all time.
const DAY = 86_400_000;
const agePdf = (file, days) => { const at = new Date(Date.now() - days * DAY); fs.utimesSync(file, at, at); };
const periodHome = () => {
  const home = pdfHome();
  agePdf(path.join(home, 'Downloads', '2310.01234v2.pdf'), 800); // bears on the project, older than a year
  agePdf(path.join(home, 'Documents', 'Research', 'HCI', 'mark2004.pdf'), 800); // older, and bears on nothing
  const receipt = path.join(home, 'Downloads', 'Receipt debugging tutor.pdf'); // personal, shares the project's words
  fs.writeFileSync(receipt, '%PDF-1.4\n%%EOF\n');
  agePdf(receipt, 800);
  return home;
};
const tutor = { name: 'Debugging tutor', description: 'How novices debug their code with scaffolding from an LLM' };

test('the period: choicesOf sends it, cleanChoices keeps 182 or 365, and PDFs are counted only in it, older related ones named apart', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  assert.deepEqual(model.PERIODS.map((period) => [period.days, period.label]), [[182, 'the past 6 months'], [365, 'the past year'], [null, 'all time']]);
  assert.equal(model.DEFAULT_PERIOD_DAYS, 365);
  assert.equal(model.choicesOf({ picks: {}, apps: {}, days: 365 }).days, 365);
  assert.equal(model.choicesOf({ picks: {}, apps: {}, days: 182 }).days, 182);
  const allTime = model.choicesOf({ picks: {}, apps: {}, days: null });
  assert.ok('days' in allTime && allTime.days === null, 'all time is sent as null');
  assert.deepEqual([182, 365, null, undefined, 90, 0, '365', -1, 10000].map((days) => cleanChoices({ sources: {}, days }, homeDir).days), [182, 365, null, null, null, null, null, null, null]);

  const home = periodHome();
  const roots = [path.join(home, 'Downloads'), path.join(home, 'Documents')];
  const asToday = readers.pdfFolders(roots, { homeDir: home, project: tutor });
  assert.deepEqual(readers.pdfFolders(roots, { homeDir: home, project: tutor, days: null }), asToday, 'all time: as before');
  assert.equal(asToday.pdfs, 7);
  assert.equal('olderRelated' in asToday || asToday.folders.some((entry) => 'olderLeftOut' in entry), false);

  const year = readers.pdfFolders(roots, { homeDir: home, project: tutor, days: 365 });
  assert.equal(year.pdfs, 4, 'only the PDFs changed in the past year are counted');
  assert.equal(year.olderLeftOut, 3);
  assert.deepEqual(year.folders.map((entry) => [entry.folder, entry.pdfs, entry.kinds, entry.relatedToProject, entry.olderLeftOut]), [
    ['~/Documents/Research/HCI', 2, { paper: 1, book: 1 }, 0, 1],
    ['~/Downloads', 2, { personal: 1, unclear: 1 }, 0, 2],
  ]);
  const examples = year.folders.flatMap((entry) => entry.examples).join('\n');
  assert.ok(!/2310\.01234v2|mark2004|Receipt/.test(examples), `older PDFs are not examples: ${examples}`);
  assert.deepEqual(year.olderRelated, [{ name: '2310.01234v2.pdf', title: 'Scaffolding novice debugging', path: path.join(home, 'Downloads', '2310.01234v2.pdf'), changed: new Date(fs.statSync(path.join(home, 'Downloads', '2310.01234v2.pdf')).mtimeMs).toISOString() }], 'the older paper that bears on the project, by path; never the personal one, nor one that bears on nothing');
  assert.deepEqual(readers.pdfFolders(roots, { homeDir: home, days: 365 }).olderRelated, [], 'no project: nothing older is named');

  // The scan passes the period from the choices; the chats count what is in it.
  const scanned = (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project: tutor, days: 365 }, { homeDir: home })).papers[LOCAL_PDFS];
  assert.deepEqual([scanned.pdfs, scanned.olderLeftOut, scanned.olderRelated.map((pdf) => pdf.name)], [4, 3, ['2310.01234v2.pdf']]);
  assert.match(scanned.period, /the past year/);
  const allScanned = (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project: tutor }, { homeDir: home })).papers[LOCAL_PDFS];
  assert.deepEqual([allScanned.pdfs, 'olderLeftOut' in allScanned, 'olderRelated' in allScanned, 'period' in allScanned], [7, false, false, false]);
  const chats = (days) => scanFor({ sources: { chats: { on: true, apps: ['Claude Code'] } }, days }, { homeDir, env: {} }).then((found) => found.chats['Claude Code']);
  const inYear = await chats(365);
  assert.equal(typeof inYear.inPeriod, 'number');
  assert.ok(inYear.inPeriod <= inYear.total);
  assert.equal('inPeriod' in (await chats(null)), false);

  // The librarian, the import agents and the surveys are told to hold to it.
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /Only offer and bring in things from the period in <choices>\. Say the period in your first message/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /Items in olderRelated may be offered by title: say they are older than the period and ask first\. When the person agrees, the plan passes their paths to import_pdfs directly/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /everything from the period in <choices> \(the default/);
  assert.match(prompts.IMPORT_SYSTEM_PROMPT, /- <period>: how far back the person chose to look/);
  assert.match(prompts.SURVEY_SYSTEM_PROMPT, /- <period>: how far back the person chose to look/);
});

test('the period goes to the librarian in <choices>, to surveys and imports as <period>, is kept through a quit, and a folder chosen in the chat is scanned with it', async () => {
  const home = periodHome();
  const seen = [];
  const watched = (delayMs) => { const inner = createFakeConnectAgents({ delayMs }); return { ...inner, turn: (input) => { seen.push({ kind: input.kind, message: input.message }); return inner.turn(input); } }; };
  const first = fakeConnect({ home, agents: watched(10) });
  const started = await first.connect.start({ sources: { papers: { on: true, apps: [LOCAL_PDFS] } }, permissions: { files: false, recall: false }, project: tutor, days: 365 });
  await until(first.state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the folder button');
  const opening = seen.find((entry) => entry.kind === 'interview').message;
  const choices = JSON.parse(opening.match(/<choices>\n([\s\S]*?)\n<\/choices>/)[1]);
  assert.deepEqual([choices.period, choices.days], ['the past year', 365]);
  first.connect.suspendAll();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.equal(saved.choices.days, 365, 'kept in session.json');

  // Picked up again after the quit, the period holds: the folder chosen in the chat is scanned with it.
  seen.length = 0;
  const second = fakeConnect({ home, agents: watched(10) });
  second.connect.resume(ctx);
  await second.connect.authorize(started.id, { app: LOCAL_PDFS, kind: 'folder', path: '~/Downloads' });
  await until(() => seen, (list) => list.some((one) => one.kind === 'interview'), 'the librarian told of the folder');
  const told = seen.find((one) => one.kind === 'interview').message;
  const found = JSON.parse(told.match(/<found[^>]*>\n([\s\S]*?)\n<\/found>/)[1]);
  const pdfs = (found.papers || found)[LOCAL_PDFS];
  assert.deepEqual([pdfs.pdfs, pdfs.olderLeftOut, pdfs.olderRelated.map((pdf) => pdf.path)], [2, 2, [path.join(home, 'Downloads', '2310.01234v2.pdf')]], 'only the past year is counted; the older related paper named apart');
  for (const one of second.connect.list(ctx.dataRoot)) second.connect.stop(one.id);

  // Imports and surveys carry <period>.
  seen.length = 0;
  const third = fakeConnect({ agents: watched(10) });
  const chats = await third.connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } }, permissions: { recall: false }, days: 182 });
  await until(third.state(chats.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the chats question');
  third.connect.answer(chats.id, { picked: ['Everything'] });
  await until(third.state(chats.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'running'), 'the import running');
  for (const kind of ['survey', 'import']) assert.match((seen.find((one) => one.kind === kind) || {}).message || '', /<period days="182">Only the past 6 months/, `the ${kind} is told the period`);
  third.connect.stop(chats.id);

  // All time: said so, with days null.
  seen.length = 0;
  const fourth = fakeConnect({ agents: watched(5) });
  const all = await fourth.connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } }, permissions: { recall: false } });
  await until(fourth.state(all.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the chats question');
  const allChoices = JSON.parse(seen.find((one) => one.kind === 'interview').message.match(/<choices>\n([\s\S]*?)\n<\/choices>/)[1]);
  assert.deepEqual([allChoices.period, allChoices.days], ['all time', null]);
  fourth.connect.stop(all.id);
});

test('the listing tools hold to the session\'s period: left out, it is used; longer, cut to it; shorter, kept; import_pdfs by path is not held to it', async () => {
  const got = {};
  const spies = {
    noteFiles: (dir, options) => { got.list_note_files = options.days; return []; },
    pdfFiles: (dir, options) => { got.list_pdfs = options.days; return { total: 0, pdfs: [] }; },
    localChats: (app, options) => { got.list_chats = options.days; return []; },
    profileOf: () => ({ browser: 'Chrome', name: 'Default', dir: '/nowhere' }),
    browserHistory: async (dir, options) => { got.browser_history = options.days; return []; },
  };
  const real = {};
  for (const [name, spy] of Object.entries(spies)) { real[name] = readers[name]; readers[name] = spy; }
  const page = { ensure: async () => {}, evaluate: async () => ({ signedIn: true, items: [10, 100, 300, 500].map((age, i) => ({ id: `chat-00${i}`, title: `Chat ${i}`, updated: Date.now() - age * DAY })) }) };
  const appleNotes = { list: async (options) => { got.apple_notes_list = options.days; return []; } };
  const toolsWith = (period, home = homeDir) => createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir: home, dir: path.join(ctx.dataRoot, '.connect', 'period-test'), projectId: () => null, exports: {}, folders: {}, get days() { return period; } }, context: async () => ({ ...ctx, homeDir: home }), env: {}, page, appleNotes });
  const run = async (period, days) => {
    for (const key of Object.keys(got)) delete got[key];
    const call = toolsWith(period);
    const asked = days === undefined ? {} : { days };
    await call('list_note_files', { folder: '~', ...asked });
    await call('list_pdfs', { folder: '~', ...asked });
    await call('list_chats', { app: 'Claude Code', ...asked });
    await call('apple_notes_list', { ...asked });
    await call('browser_history', { ...asked });
    const web = await call('web_chats', { app: 'ChatGPT', ...asked });
    return { ...got, web_chats: web.chats.length };
  };
  const each = (days, browser, web) => ({ list_note_files: days, list_pdfs: days, list_chats: days, apple_notes_list: days, browser_history: browser, web_chats: web });
  try {
    assert.deepEqual(await run(365), each(365, 90, 3), 'no days: the period (browser history keeps its shorter 90)');
    assert.deepEqual(await run(365, 1000), each(365, 365, 3), 'a longer days: cut to the period');
    assert.deepEqual(await run(365, 30), each(30, 30, 1), 'a shorter days: kept');
    assert.deepEqual(await run(182), each(182, 90, 2));
    assert.deepEqual(await run(182, 120), each(120, 120, 2));
    assert.deepEqual(await run(null), each(null, 90, 4), 'no period: as before');
    assert.deepEqual(await run(null, 1000), each(1000, 1000, 4));
  } finally {
    for (const [name, fn] of Object.entries(real)) readers[name] = fn;
  }

  // An older paper the person agreed to comes in by path, though list_pdfs leaves it out.
  const home = periodHome();
  const call = toolsWith(365, home);
  const old = path.join(home, 'Downloads', '2310.01234v2.pdf');
  assert.ok(!(await call('list_pdfs', { folder: '~/Downloads' })).pdfs.some((pdf) => pdf.path === old), 'not listed: older than the period');
  const brought = await call('import_pdfs', { files: [old] });
  assert.equal(brought.added, 1);
  assert.ok((await ctx.libraryDb.list()).some((row) => row.path === old), 'in the library');
});

test('Skip on the librarian\'s question brings nothing of it in: the source is left out, and Import does not hand it over', async () => {
  const { connect, state } = fakeConnect();
  const started = await connect.start({ sources: { sites: { on: true }, code: { on: true } }, permissions: { browser: false, recall: false } });
  let now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the websites question');
  assert.equal(now.chat[now.chat.length - 1].ask.source, 'sites');
  connect.answer(started.id, { skipped: true });
  now = await until(state(started.id), (s) => !s.thinking && s.chat.filter((entry) => entry.ask).length === 2, 'the next question');
  assert.equal(now.chat[2].text, 'Skip');
  assert.ok(now.log.some((entry) => entry.text === 'Skipped Websites'));
  // Import hands over what was not talked through, never what was skipped.
  now = connect.importNow(started.id);
  assert.deepEqual(now.jobs.filter((job) => job.kind === 'import').map((job) => job.source), ['code']);
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.skippedSources, ['sites'], 'kept for a session picked up again');
  connect.stop(started.id);
  // A question that named its apps leaves out only those; a button, its app.
  const choices = cleanChoices({ sources: { papers: { on: true, apps: ['Zotero', LOCAL_PDFS] } } }, homeDir);
  assert.deepEqual(readReply(`{"ask":{"source":"papers","apps":["${LOCAL_PDFS}","Obsidian"],"kind":"multi","title":"Which folders?","options":["Research"]}}`, choices).ask.apps, [LOCAL_PDFS]);
  assert.equal(readReply(`{"authorize":{"app":"${LOCAL_PDFS}","kind":"folder"}}`, choices).authorize.label, 'Choose a folder of PDFs…');
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /Skip means nothing of it comes in/);
  assert.doesNotMatch(prompts.INTERVIEW_SYSTEM_PROMPT, /Decide sensibly yourself/);
});

test('a row of onboarding\'s "Bringing everything in": the apps, what it brings in, where it stands (2026-10-09, David\'s mockup)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const row = (job) => { const view = model.workRow({ kind: 'import', apps: [], notes: 0, items: 0, ...job }); return [view.title, view.sub, view.status.text]; };
  assert.deepEqual(row({ source: 'transcripts', apps: ['Google Meet', 'Zoom'], label: 'Meeting transcripts: Google Meet, Zoom', status: 'running' }), ['Google Meet and Zoom', 'Meeting transcripts', 'Adding…']);
  assert.deepEqual(row({ source: 'chats', apps: ['ChatGPT'], label: 'AI chats: chats about Engelbart product work', status: 'running', items: 65 }), ['ChatGPT', 'Chats about Engelbart product work', 'Adding · 65 so far']);
  assert.deepEqual(row({ source: 'sites', label: 'Websites', status: 'queued' }), ['Websites', 'Pages from your browser history', 'Queued']);
  assert.deepEqual(row({ source: 'notes', apps: ['Obsidian'], label: 'Obsidian: mathetic and Obsidian Vault', status: 'done', notes: 11 }), ['Obsidian', 'Mathetic and Obsidian Vault', '✓ 11 added']);
  assert.deepEqual(row({ source: 'papers', label: 'Papers', status: 'failed' }), ['Papers', '', 'Failed']);
  assert.equal(model.workRow({ kind: 'survey', apps: ['Overleaf'], label: 'Looking through Overleaf', status: 'running' }).status.text, 'Looking…');
});

test('the foot of onboarding\'s chat and what the chat says while it waits (2026-10-09, David\'s mockup)', async () => {
  const model = await import(require('node:url').pathToFileURL(require('node:path').join(__dirname, '../src/renderer/model/connect.js')).href);
  const jobs = [
    { kind: 'import', label: 'Notes: Obsidian', status: 'running', notes: 1, items: 0 },
    { kind: 'import', label: 'AI chats', status: 'queued', notes: 0, items: 0 },
    { kind: 'survey', label: 'Looking through Overleaf', status: 'running', notes: 0, items: 0 },
    { kind: 'survey', label: 'Looking through Notion', status: 'done', notes: 0, items: 0 },
    { kind: 'memory', label: 'MEMORY.md', status: 'queued', notes: 0, items: 0 },
  ];
  assert.equal(model.footLine({ jobs, needs: [{}, {}] }), 'Bringing in 2 sources · 1 of 4 · 2 need you');
  assert.equal(model.footLine({ jobs: jobs.slice(2), needs: [{}] }), 'Looking through your apps · 1 of 2 · 1 needs you');
  assert.equal(model.footLine({ jobs: [jobs[3]], needs: [] }), 'Everything looked at · 1 of 1');
  assert.equal(model.footLine({ jobs: [], needs: [] }), '');
  assert.equal(model.chatStatus({ thinking: true, activity: 'Reading what the surveys found', jobs }), 'Reading what the surveys found…');
  assert.equal(model.chatStatus({ waiting: true, jobs, needs: [] }), 'Looking through Overleaf…');
  assert.equal(model.chatStatus({ waiting: true, jobs: [{ ...jobs[2], status: 'waiting' }], needs: [{}] }), 'Waiting for your sign-in…');
  assert.equal(model.chatStatus({ jobs }), '', 'nothing while it waits on nothing');
  assert.equal(model.needView({ app: 'ChatGPT', kind: 'signin' }).hint, 'Opens in your browser · read-only');
});
