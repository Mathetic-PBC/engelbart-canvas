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
const { createImportTools, validateImportTool, chatNote, toolsFor, googleMarkdown, csvTable, IMPORT_TOOLS, toolNamesFor } = require('../src/main/connect/tools.cjs');
const { createConnect, readReply, readSurvey, cleanChoices, projectBlock, connectChoice } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { createWebSignIn } = require('../src/main/connect/web-signin.cjs');
const { detect, scanFor, localRepos, pdfsAtAGlance } = require('../src/main/connect/scan.cjs');
const folderAccess = require('../src/main/connect/folder-access.cjs');
const { importToolLabel, writeImportConfig, claudeServers, claudeToolsFor } = require('../src/main/connect/agents.cjs');
const { hostAllowed, hostsFor, fileNameOf } = require('../src/main/connect/browser.cjs');
const { listWebChats, readWebChat, CHATGPT_LIST, CHATGPT_ONE, CLAUDE_LIST, CLAUDE_ONE } = require('../src/main/connect/web-chats.cjs');
const { createAppleNotes, noteMarkdown } = require('../src/main/connect/apple-notes.cjs');
const { cursorChats, cursorTranscript, cursorDb } = require('../src/main/connect/cursor.cjs');
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
  const files = readers.noteFiles(vault, { exclude: ['Journal', 'Personal'] }).map((file) => path.relative(vault, file).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['Research/Idea.md', 'Research/Other note.md']);
  assert.deepEqual(readers.noteFiles(vault, { include: ['Personal'] }).map((file) => path.basename(file)), ['Secret.md']);
  assert.deepEqual(readers.linksIn(vault).map((link) => [link.url, link.count, link.notes]), [['https://example.org/paper', 1, ['Idea']]]);
});

test('detect: Obsidian\'s vaults from obsidian.json, apps installed or signed in to count as found, Apple Notes only once ticked', () => {
  write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { a: { path: vault, ts: 1759900000000, open: true }, b: { path: path.join(homeDir, 'gone') } } }));
  // A Mac's layout (obsidian.json and .app bundles), so the Mac's (2026-10-18: Linux reads its own places).
  assert.deepEqual(readers.obsidianVaults(homeDir, 'darwin').map((entry) => [entry.name, entry.shown, entry.open]), [['Vault', '~/Vault', true]]);
  const apps = path.join(homeDir, 'Apps');
  fs.mkdirSync(path.join(apps, 'Granola.app'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Perplexity.app'), { recursive: true });
  const found = detect({ homeDir, applications: [apps], signedIn: ['ChatGPT'], platform: 'darwin' }).apps;
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
    { type: 'user', entrypoint: 'sdk-cli', cwd: '/tmp/run', message: { role: 'user', content: 'Summarize this note' } },
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
  // 2026-10-13 ("the number of chats is too low"): a first prompt past the head (attachments before it), an Agent SDK
  // session run for the person (sdk-ts: Engelbart's Builds), its own title, and a Codex prompt that begins with "<".
  const far = (n) => Array.from({ length: n }, (_, i) => ({ type: 'attachment', attachment: { content: 'x'.repeat(4000), at: i } }));
  write('.claude/projects/-Users-me-thesis/33333333-3333-4333-8333-333333333333.jsonl', lines([
    ...far(60),
    { type: 'user', entrypoint: 'sdk-ts', cwd: path.join(homeDir, 'thesis'), message: { role: 'user', content: 'Build the study dashboard' } },
    { type: 'ai-title', aiTitle: 'Study dashboard' },
  ]));
  write('.codex/sessions/2026/10/03/rollout-2026-10-03T10-00-00-ghi.jsonl', lines([
    { type: 'session_meta', payload: { id: 'ghi', cwd: path.join(homeDir, 'code'), originator: 'codex-tui', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'y'.repeat(300 * 1024) }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<div>Why does this page not render?</div>' } },
  ]));
  const more = readers.localChats('Claude Code', { homeDir, env });
  assert.deepEqual(more.map((chat) => chat.title).sort(), ['Study dashboard', 'Why do novices skip tests?'], 'past the head, and its own title');
  const pasted = readers.localChats('Codex', { homeDir, env }).find((chat) => chat.id.endsWith('ghi'));
  assert.equal(pasted.title, '<div>Why does this page not render?</div>', 'a prompt beginning with "<" past 256 KB');
  fs.rmSync(path.join(homeDir, '.claude/projects/-Users-me-thesis/33333333-3333-4333-8333-333333333333.jsonl'));
  fs.rmSync(path.join(homeDir, '.codex/sessions/2026/10/03'), { recursive: true });
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
  assert.equal(readers.browserProfiles(homeDir, 'darwin')[0].browser, 'Chrome', 'Chrome\'s folder on a Mac');
});

test('a Markdown file as a note: Obsidian links become mentions, pictures are set aside and saved into the project', async () => {
  const index = notes.createIndex();
  const source = path.join(vault, 'Research', 'Idea.md');
  const { body, images } = notes.convertMarkdown(fs.readFileSync(source, 'utf8'), { sourcePath: source, root: vault, index });
  assert.match(body, /builds on @\[Other note\] and @\[Third\]\./);
  assert.equal(images.length, 2, 'the embed found by name in the vault, the link by its relative path');
  assert.deepEqual(images.map((image) => path.relative(vault, image.file).split(path.sep).join('/')), ['attachments/pic.png', 'attachments/pic.png']);
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
  assert.deepEqual(reply.ask, { source: 'notes', kind: 'multi', title: 'Which folders?', options: [{ label: 'Research', why: '', detail: '', checked: false }, { label: 'Essays', why: '12 notes', detail: '', checked: false }], placeholder: '' });
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
  // A search for a folder (MATH-117): only folders inside the home folder that are there are kept.
  const report = JSON.stringify({ app: LOCAL_PDFS, summary: 'PDFs in 2 folders.', items: [], folders: ['~/Vault', vault, '/tmp', `${homeDir}/nowhere`, 'Vault', 7], searched: 'Documents and Desktop' });
  assert.deepEqual(readSurvey(report, homeDir).folders, [vault]);
  assert.equal(readSurvey(report, homeDir).searched, 'Documents and Desktop');
  assert.deepEqual(readSurvey(report).folders, [], 'no home folder given, no folder kept');
  assert.deepEqual(readSurvey(JSON.stringify({ folder: path.join(homeDir, '..') }), homeDir).folders, []);
  assert.equal(importToolLabel('import_note_files', { files: ['a', 'b'] }), 'Bringing in 2 notes');
  assert.equal(importToolLabel('browser_open', { url: 'https://www.overleaf.com/project' }), 'Opening overleaf.com');
  assert.equal(importToolLabel('import_google_files', { items: [{}] }), 'Bringing in 1 Google Drive file');
});

test('the agents\' tools per kind, and the connectors handed to Claude Code and Codex for one run', () => {
  assert.deepEqual(claudeToolsFor('interview'), { tools: 'Read,Grep,Glob', allowed: 'Read,Grep,Glob' });
  assert.deepEqual(claudeToolsFor('redact'), { tools: '', allowed: '' }, 'taking secrets out needs no tools');
  // A connector's reading tools only, by name (2026-10-15): never mcp__granola__* (switch_workspace, sign_out), never a
  // connector Engelbart has no reading list for (Linear's and Evernote's are their catalog entries', 2026-10-16).
  const granolaReads = 'mcp__granola__list_meetings,mcp__granola__list_meeting_folders,mcp__granola__get_account_info';
  assert.deepEqual(claudeToolsFor('import', [{ app: 'Granola', name: 'granola' }, { app: 'Granola', name: 'bad name' }, { app: 'Figma', name: 'figma' }]), { tools: 'Read,Grep,Glob,WebSearch,WebFetch', allowed: `Read,Grep,Glob,WebSearch,WebFetch,mcp__engelbart__*,${granolaReads},mcp__granola__get_meetings,mcp__granola__get_meeting_transcript,mcp__granola__get_meeting_attachment,mcp__granola__query_granola_meetings` });
  assert.deepEqual(claudeToolsFor('survey', [{ app: 'Granola', name: 'granola' }]).allowed, `Read,Grep,Glob,WebSearch,WebFetch,mcp__engelbart__*,${granolaReads}`, 'a survey lists the meetings; it reads none');
  assert.ok(!claudeToolsFor('import', [{ app: 'Granola', name: 'granola' }]).allowed.includes('switch_workspace'));
  assert.ok(claudeToolsFor('import', [{ app: 'Linear', name: 'linear' }]).allowed.includes('mcp__linear__list_issues'), 'Linear\'s reading tools, from its catalog entry');
  assert.ok(!claudeToolsFor('survey', [{ app: 'Linear', name: 'linear' }]).allowed.includes('mcp__linear__get_issue'), 'a survey only lists');
  assert.ok(!claudeToolsFor('import', [{ app: 'Notion', name: 'notion' }]).allowed.match(/notion-(create|update|delete|move|duplicate)/));
  assert.deepEqual(claudeServers({ node: '/bin/node', server: '/x/import-mcp.cjs', connection: '/x/c.json', connectors: [{ app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp', token: 'tok' }, { app: 'Granola', name: 'engelbart', url: 'https://evil', token: 't' }, { app: 'Figma', name: 'figma', url: 'https://mcp.figma.com/mcp', token: 'l' }] }).mcpServers, {
    engelbart: { command: '/bin/node', args: ['/x/import-mcp.cjs', '/x/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    granola: { type: 'http', url: 'https://mcp.granola.ai/mcp', headers: { Authorization: 'Bearer tok' } },
  });
  // Codex's import home: Engelbart's tools approved in advance (codex exec cannot ask anyone), its own browser and computer
  // use off, a connector's token read from the environment, nothing else.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-codex-'));
  writeImportConfig(codexHome, { command: '/bin/node', args: ['/x/import-mcp.cjs', '/x/c.json'], env: { ELECTRON_RUN_AS_NODE: '1' } }, [{ app: 'Granola', name: 'granola', url: 'https://mcp.granola.ai/mcp' }, { app: 'Figma', name: 'figma', url: 'https://mcp.figma.com/mcp' }]);
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[features\]\ncomputer_use = false\nbrowser_use = false\nbrowser_use_external = false/);
  assert.match(config, /\[mcp_servers\.engelbart\]\ncommand = "\/bin\/node"\nargs = \["\/x\/import-mcp\.cjs", "\/x\/c\.json"\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(config, /\[mcp_servers\.granola\]\nurl = "https:\/\/mcp\.granola\.ai\/mcp"\nbearer_token_env_var = "ENGELBART_CONNECTOR_GRANOLA"/);
  assert.match(config, /enabled_tools = \["list_meetings", "list_meeting_folders", "get_account_info", "get_meetings", "get_meeting_transcript", "get_meeting_attachment", "query_granola_meetings"\]/, 'Codex is given only the reading tools');
  assert.doesNotMatch(config, /switch_workspace|sign_out|mcp_servers\.figma/);
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

test('a failed session check is not "signed out": asked again a moment later; only an answer that says so is signed out (2026-10-12)', async () => {
  const page = (answers) => { const asked = []; return { asked, ensure: async () => {}, evaluate: async () => { asked.push(1); return answers.shift(); } }; };
  const paused = [];
  const sleep = async (ms) => { paused.push(ms); };
  const listed = { signedIn: true, account: 'me', items: [{ id: 'g-111111', title: 'Regression help', updated: '2026-10-02T00:00:00Z' }] };
  // A 403 (or a 429, a 5xx, a network error) then an answer: read as usual, after a pause of a few seconds.
  const flaky = page([{ signedIn: null, status: 403 }, listed]);
  assert.deepEqual((await listWebChats(flaky, 'ChatGPT', { sleep })).chats.map((chat) => chat.id), ['g-111111']);
  assert.equal(flaky.asked.length, 2);
  assert.deepEqual(paused, [3000]);
  // Twice no answer: an error that is not SIGNED_OUT, so the agent does not ask for a sign-in.
  await assert.rejects(listWebChats(page([{ signedIn: null, status: 429 }, { signedIn: null, status: 0 }]), 'Claude', { sleep }), (error) => error.code !== 'SIGNED_OUT' && /didn't say whether you're signed in.*not a sign-out/.test(error.message));
  await assert.rejects(readWebChat(page([null, null]), 'ChatGPT', 'g-111111', { sleep }), (error) => error.code === 'UNSURE');
  // Signed out only when the site says so (an ok answer with no session, or a 401), and then at once.
  const out = page([{ signedIn: false }]);
  await assert.rejects(listWebChats(out, 'ChatGPT', { sleep }), (error) => error.code === 'SIGNED_OUT');
  assert.equal(out.asked.length, 1, 'not asked again');
  await assert.rejects(listWebChats(page([{ signedIn: null, status: 503 }, { signedIn: false }]), 'ChatGPT', { sleep }), (error) => error.code === 'SIGNED_OUT', 'said on the second ask');
  // The scripts themselves: a 401 is signed out; a 403 or no answer is "couldn't tell"; an ok answer with no token is signed out.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = async (script, respond) => {
    const fetch = async (url) => { const [status, body] = respond(url); if (status === 0) throw new TypeError('Failed to fetch'); return { ok: status >= 200 && status < 300, status, json: async () => body }; };
    return new AsyncFunction('fetch', script)(fetch);
  };
  assert.deepEqual(await run(CHATGPT_LIST(5), () => [401, null]), { signedIn: false });
  assert.deepEqual(await run(CHATGPT_LIST(5), () => [403, null]), { signedIn: null, status: 403 });
  assert.deepEqual(await run(CHATGPT_ONE('g-111111'), () => [0, null]), { signedIn: null, status: 0 });
  assert.deepEqual(await run(CHATGPT_LIST(5), () => [200, {}]), { signedIn: false });
  assert.deepEqual(await run(CLAUDE_LIST(5), () => [500, null]), { signedIn: null, status: 500 });
  // Claude signed out answers a 403 that says so (2026-10-16, claude.ai from Electron with no session); Cloudflare's 403
  // (an HTML page, no JSON) says nothing.
  const invalid = { type: 'error', error: { type: 'permission_error', message: 'Invalid authorization', details: { error_visibility: 'user_facing', error_code: 'account_session_invalid' } } };
  assert.deepEqual(await run(CLAUDE_LIST(5), () => [403, invalid]), { signedIn: false });
  assert.deepEqual(await run(CLAUDE_ONE('c-111111'), () => [403, invalid]), { signedIn: false });
  assert.deepEqual(await run(CLAUDE_LIST(5), () => [403, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }]), { signedIn: null, status: 403 });
  const cloudflare = async () => ({ ok: false, status: 403, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  assert.deepEqual(await new AsyncFunction('fetch', CLAUDE_LIST(5))(cloudflare), { signedIn: null, status: 403 });
  assert.deepEqual(await run(CLAUDE_ONE('c-111111'), () => [200, []]), { signedIn: false });
});

test('ChatGPT\'s chats inside its projects are listed too, with the project\'s name (its list leaves them out; 2026-10-16)', async () => {
  // Checked on a real account: none of a project's 9 chats among the 519 /backend-api/conversations listed. A project's
  // chats come from the sidebar's projects (g-p-…; a GPT's are in the list), each paged by cursor.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const asked = [];
  const answers = (url) => {
    if (url === '/api/auth/session') return [200, { accessToken: 't', user: { email: 'me@example.org' } }];
    if (url.startsWith('/backend-api/conversations?')) return [200, { items: [{ id: 'main-1', title: 'Regression help', update_time: 1759000000 }], total: 1 }];
    if (url.startsWith('/backend-api/gizmos/snorlax/sidebar')) {
      return /cursor=next/.test(url)
        ? [200, { items: [{ gizmo: { gizmo: { id: 'g-p-bbb', display: { name: 'Finances' } } } }], cursor: null }]
        : [200, { items: [{ gizmo: { gizmo: { id: 'g-p-aaa', display: { name: 'introspection' } } } }, { gizmo: { gizmo: { id: 'g-a-gpt', display: { name: 'A GPT' } } } }], cursor: 'next' }];
    }
    if (url === '/backend-api/gizmos/g-p-aaa/conversations?cursor=0') return [200, { items: [{ id: 'proj-1', title: 'Journal', update_time: 1759000100 }], cursor: 'c2' }];
    if (url === '/backend-api/gizmos/g-p-aaa/conversations?cursor=c2') return [200, { items: [{ id: 'proj-2', title: 'Values', update_time: 1759000200 }], cursor: null }];
    if (url === '/backend-api/gizmos/g-p-bbb/conversations?cursor=0') return [200, { items: [{ id: 'proj-3', title: 'Taxes', update_time: 1759000300 }], cursor: null }];
    return [404, null];
  };
  const fetch = async (url) => { asked.push(url); const [status, body] = answers(url); return { ok: status >= 200 && status < 300, status, json: async () => body }; };
  const out = await new AsyncFunction('fetch', CHATGPT_LIST(50))(fetch);
  assert.deepEqual(out.items.map((item) => [item.id, item.project]), [['main-1', null], ['proj-1', 'introspection'], ['proj-2', 'introspection'], ['proj-3', 'Finances']]);
  assert.equal(out.partial, undefined);
  assert.equal(asked.some((url) => url.includes('g-a-gpt')), false, 'a GPT is not a project');
  // Through listWebChats: a project's chats found by its name.
  const page = { ensure: async () => {}, evaluate: async (script) => new AsyncFunction('fetch', script)(fetch) };
  assert.deepEqual((await listWebChats(page, 'ChatGPT', { project: 'intro' })).chats.map((chat) => chat.id), ['proj-2', 'proj-1']);
  // The projects can't be read: the list is still read, and the answer says what was left out.
  const failing = async (url) => (url.startsWith('/backend-api/gizmos/') ? { ok: false, status: 500, json: async () => null } : fetch(url));
  const partial = await new AsyncFunction('fetch', CHATGPT_LIST(50))(failing);
  assert.deepEqual(partial.items.map((item) => item.id), ['main-1']);
  assert.equal(partial.partial, "ChatGPT's projects answered 500");
  const listed = await listWebChats({ ensure: async () => {}, evaluate: async (script) => new AsyncFunction('fetch', script)(failing) }, 'ChatGPT');
  assert.equal(listed.partial, "ChatGPT's projects answered 500", 'the agent is told');
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
  const file = cursorDb(homeDir); // where this platform's Cursor keeps it (a Mac's: ~/Library/Application Support/Cursor/…)
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

// `ask`: the librarian asks before each web app or connector is read (its consent cards); left out, every app was allowed
// before the run (deps.allowed), as most of these tests are about what happens after.
function fakeConnect({ home = homeDir, delayMs = 5, agents = null, ask = false, ...rest } = {}) {
  const snapshots = [];
  // recoverWaitsMs: a sign-in brought back (recover) is copied again once, at once, before its card.
  const deps = { recoverWaitsMs: [0], ...(ask ? {} : { allowed: true }), ...(rest.deps || {}) };
  const connect = createConnect({ agents: agents || createFakeConnectAgents({ delayMs }), ready: () => ALL, context: async () => ctx, homeDir: home, env: {}, notify: (snapshot) => snapshots.push(snapshot), openBridge: openToolBridge, ...rest, deps });
  return { connect, snapshots, state: (id) => () => connect.state(id) };
}

test('a session with the fake agents: a folder button, a question card, imports in the background as files of the library, Import, MEMORY.md without its secrets', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'fresh-')); // a home with no Obsidian: the vault comes from the button
  const { connect, snapshots, state } = fakeConnect({ home: fresh });
  const before = (await mdFiles()).length;
  const earlier = new Set((await mdFiles()).map((row) => row.id));
  await assert.rejects(connect.start({ sources: {} }), /Pick at least one source/);
  // The agents may not read the files on this Mac: no agent looks for the vault, the button comes at once (MATH-117).
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, sites: { on: true } }, provider: 'openai', computer: false });
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
  // What it brought into the library goes on the project's list (2026-10-11) and, for onboarding's run, into the Welcome
  // project's folder too (2026-10-14: "the welcome project folder should be a complete set of their project files"; it
  // replaced 2026-10-13's "imports go only to the library for now, not the workspace", which still holds for an import
  // started inside a project).
  const brought = (await mdFiles()).filter((row) => !earlier.has(row.id)).map((row) => row.id);
  assert.equal(brought.length, 5);
  const held = projects.findWorkspace(ctx, project.id, workspaceId).workspace.context;
  assert.equal(held[0], noteId, 'the Welcome! note first');
  assert.deepEqual([...held.slice(1)].sort(), [...brought].sort(), 'and everything that came in');
  assert.deepEqual(brought.filter((id) => !projects.findProject(ctx, project.id).library.includes(id)), [], 'every note it brought in is the project\'s');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8')).rows.sort(), [...brought].sort(), 'kept with the session, for a resume');
  connect.dismiss(started.id);
  assert.equal(connect.list(ctx.dataRoot).some((s) => s.id === started.id), false);
  fs.rmSync(memory.memoryPath(ctx.dataRoot));
});

/* Import your context (2026-10-13): a "direct" session runs no librarian; one import a tool, kept to the projects picked. */

test('Import your context: one import a tool told the projects picked, a manual folder kept to, a signed-out web app waits on a sign-in card, other tools through the browser', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'direct-'));
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  // Signed out until the person signs in in their browser (round 3: "I'm signed in" copies the sign-in and checks it first).
  // Signed out in their browser, and Engelbart's own window signs it in (2026-10-16: recover's card, Sign in inside Engelbart).
  let signedInHere = false;
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async () => ({ signedIn: false, browser: '' }), signedIn: async () => signedInHere, keychainNote: () => '', browserName: () => 'Chrome' };
  let windowSays = 'closed';
  const signInWindow = { open: async () => { if (windowSays === 'signed-in') signedInHere = true; return { status: windowSays }; }, close: () => {} };
  const { connect, state } = fakeConnect({ home: fresh, webSignIn, signInWindow });
  const projectsPicked = [{ id: 'calc', title: 'Calculus tutoring study', description: 'An RCT of an AI tutor in calculus.' }];
  const started = await connect.start({
    provider: 'openai',
    direct: {
      mode: 'manual', projects: projectsPicked, roles: ['Researcher', 'Nobody'], work: 'I study how students solve problems.',
      apps: ['Obsidian', 'ChatGPT', 'Not a tool'],
      scopes: { Obsidian: { folders: [{ path: '~/Vault' }], note: '' } },
      additional: [{ name: 'Linear', website: 'https://linear.app', note: 'Only the issues about tutoring', projects: ['Calculus tutoring study'] }],
    },
  });
  const now = await until(state(started.id), (s) => s.finished && !s.thinking, 'the run queued');
  assert.equal(now.chat.length, 1, 'no librarian: the opening line alone');
  assert.ok(now.chat[0].opener);
  assert.equal(now.chat.some((entry) => entry.ask), false);
  const saved = savedOf(started.id);
  assert.deepEqual(saved.choices.direct.roles, ['Researcher'], 'only known roles');
  assert.deepEqual(saved.choices.direct.apps, ['Obsidian', 'ChatGPT'], 'only catalog tools');
  assert.equal(saved.choices.project.name, 'Calculus tutoring study', 'every agent is told about the projects picked');
  const obsidian = saved.jobs.find((job) => job.kind === 'import' && job.apps.includes('Obsidian'));
  assert.ok(obsidian, 'Obsidian imported');
  assert.match(obsidian.plan, /only what pertains to these projects/);
  assert.match(obsidian.plan, /Calculus tutoring study: An RCT/);
  assert.match(obsidian.plan, /read only these folders and files: .*Vault/, 'the folder the person chose, and nothing else');
  assert.equal(saved.picked.folders.Obsidian, path.join(fresh, 'Vault'));
  const linear = saved.jobs.find((job) => job.label.startsWith('Other tools'));
  assert.equal(linear.source, 'sites');
  assert.deepEqual(linear.extra, { sites: ['linear.app'], tool: { name: 'Linear', website: 'https://linear.app', sites: ['linear.app'] } }, 'its agent may open the tool\'s site, and a sign-in it asks for is Linear\'s');
  // What the person specified for an extra tool on the tools screen (From Amitav, 2026-10-15) goes to its agent too.
  assert.match(linear.plan, /Linear \(https:\/\/linear\.app\): Only the issues about tutoring; only for these of the projects: Calculus tutoring study/);
  // ChatGPT is signed out: copied again quietly first, then one card (Sign in inside Engelbart · Skip), its import waiting.
  assert.equal(saved.jobs.some((job) => job.apps.includes('ChatGPT')), false, 'not queued yet');
  const card = (await until(state(started.id), (s) => s.needs.some((need) => need.app === 'ChatGPT'), 'ChatGPT\'s card')).needs.find((need) => need.app === 'ChatGPT');
  assert.equal(card.kind, 'signin-here');
  assert.equal(card.where, 'here', 'signed in inside Engelbart (Google\'s alone goes through their browser)');
  // The window closed without signing in: said on the card, which can be tried once more.
  await connect.need(started.id, card.id, 'open');
  await until(state(started.id), (s) => (s.needs.find((need) => need.id === card.id) || {}).error === 'Not signed in to ChatGPT yet.', 'said on the card');
  windowSays = 'signed-in';
  await connect.need(started.id, card.id, 'open');
  await until(state(started.id), (s) => !s.needs.some((need) => need.id === card.id), 'signed in and checked: the step closed');
  await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.apps.includes('ChatGPT')), 'ChatGPT queued once signed in');
  connect.stop(started.id);
  connect.dismiss(started.id);
});

test('Google\'s card is Sign in inside Engelbart, as every app\'s (2026-10-16: every copy from Chrome answered 302 → ServiceLogin); signed in there, its import starts; Skip closes the window and leaves out every Google app picked', async () => {
  // Hudson: "the same fallback logic we have for everything else for Google Drive, including signing in in Engelbart's
  // chromium if it fails".
  const fresh = fs.mkdtempSync(path.join(homeDir, 'google-here-'));
  const opened = [];
  let closeWindow = null;
  let windowSays = null; // null: the window stays open until closed
  let here = false;
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async () => ({ signedIn: false, browser: '' }), signedIn: async () => here, stillSignedIn: async () => here, signedInHere: () => { here = true; }, keychainNote: () => '', browserName: () => 'Chrome' };
  const signInWindow = { open: (app) => { opened.push(app); return windowSays ? Promise.resolve({ status: windowSays }) : new Promise((resolve) => { closeWindow = () => resolve({ status: 'closed' }); }); }, close: () => { if (closeWindow) closeWindow(); closeWindow = null; } };
  const { connect, state } = fakeConnect({ home: fresh, webSignIn, signInWindow });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Memex' }], apps: ['Google Docs', 'Google Meet'], scopes: {} } });
  const cards = (await until(state(started.id), (s) => s.needs.some((need) => need.kind === 'signin-here'), 'Google\'s card')).needs.filter((need) => need.kind === 'signin-here');
  assert.equal(cards.length, 1, 'one card for the one sign-in Drive and Meet share');
  assert.equal(cards[0].where, 'here', 'inside Engelbart, not their browser');
  await connect.need(started.id, cards[0].id, 'open');
  assert.equal(opened.length, 1, 'Engelbart\'s window opened');
  assert.equal(connect.state(started.id).needs.find((need) => need.id === cards[0].id).busy, true);
  await connect.need(started.id, cards[0].id, 'skip');
  assert.equal(closeWindow, null, 'Skip closed the window');
  const after = await until(state(started.id), (s) => s.leftOut.length === 2, 'both Google apps left out');
  assert.deepEqual(after.leftOut.map((entry) => entry.app).sort(), ['Google Docs', 'Google Meet']);
  assert.equal(after.jobs.some((job) => job.kind === 'import'), false, 'nothing of Google comes in');
  connect.stop(started.id);
  connect.dismiss(started.id);

  // Signed in in that window: checked, and Google's import starts.
  windowSays = 'signed-in';
  const again = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Memex' }], apps: ['Google Docs'], scopes: {} } });
  const card = (await until(state(again.id), (s) => s.needs.some((need) => need.kind === 'signin-here'), 'Google\'s card again')).needs.find((need) => need.kind === 'signin-here');
  await connect.need(again.id, card.id, 'open');
  await until(state(again.id), (s) => !s.needs.some((need) => need.id === card.id), 'signed in and checked: the step closed');
  await until(state(again.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.apps.includes('Google Docs')), 'Google Drive queued once signed in');
  connect.stop(again.id);
  connect.dismiss(again.id);
});

test('Google signed in in Chrome and its copy refused: a card to sign in inside Engelbart (it was left out at once, with no way to sign in); Google turning that window away too skips it with one line (2026-10-16)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'google-held-'));
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async () => ({ signedIn: false, browser: '', held: true }), signedIn: async () => false, keychainNote: () => '', browserName: () => 'Chrome' };
  const signInWindow = { open: async () => ({ status: 'rejected' }), close: () => {} };
  const { connect, state } = fakeConnect({ home: fresh, webSignIn, signInWindow });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Memex' }], apps: ['Google Docs', 'Google Meet'], scopes: {} } });
  const card = (await until(state(started.id), (s) => s.needs.some((need) => need.kind === 'signin-here'), 'Google\'s card')).needs.find((need) => need.kind === 'signin-here');
  assert.equal(card.where, 'here');
  assert.equal(connect.state(started.id).leftOut.length, 0, 'not left out before the person is asked');
  await connect.need(started.id, card.id, 'open');
  const after = await until(state(started.id), (s) => !s.needs.some((need) => need.id === card.id) && s.leftOut.length === 2, 'given up on, both Google apps left out');
  assert.deepEqual(after.leftOut.map((entry) => entry.app).sort(), ['Google Docs', 'Google Meet']);
  assert.equal(after.chat.filter((entry) => entry.notice && /^Couldn't connect to .+\. Skipped\.$/.test(entry.text)).length, 1, 'one quiet line');
  connect.stop(started.id);
  connect.dismiss(started.id);
});

/* Browser agents (2026-10-13, second round: "We will use computer use in my real browser"). */

test('Import your context, round 3: web apps in Engelbart\'s browser with the copied sign-ins; the person\'s browser only for a sign-in Engelbart can\'t use; a signed-out app is a popup', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'browse-'));
  // Google Docs and Overleaf come over from Chrome; Google Meet is signed in there but its copy is refused (Google's binding;
  // it was Gmail until Gmail was paused, From Amitav 2026-10-15);
  // ChatGPT is signed out everywhere.
  const quiet = { 'Google Meet': { signedIn: false, held: true }, ChatGPT: { signedIn: false } };
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async (app) => quiet[app] || { signedIn: true, browser: 'Chrome' }, signedIn: async () => false, keychainNote: () => '', browserName: () => 'Chrome', copyDomains: async () => true };
  const turns = [];
  const fake = createFakeConnectAgents({ delayMs: 5 });
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const agents = {
    async turn(input) {
      turns.push({ kind: input.kind, label: input.meta && input.meta.job ? input.meta.job.label : '', system: input.system, message: input.message, browse: input.browse, connectors: input.connectors });
      if (input.kind === 'browse' && input.meta.job.apps.includes('Google Meet')) {
        const out = await input.meta.callTool('needs_you', { kind: 'signin', reason: 'Choose an account in Chrome' });
        await gate;
        return { text: `Google Meet: ${out.status}`, session: null };
      }
      return fake.turn(input);
    },
  };
  const opened = [];
  const browserAgents = { status: ({ provider }) => ({ available: true, use: true, ask: false, allowedByCli: false, consent: 'allowed', provider, browser: { id: 'chrome', name: 'Chrome' }, others: [] }) };
  const { connect, state } = fakeConnect({ home: fresh, webSignIn, agents, browserAgents, openBrowserApp: async (id) => { opened.push(id); return true; } });
  const started = await connect.start({
    provider: 'anthropic',
    browserAgents: { browserId: 'evil', browserName: 'Spoofed', enable: true }, // the window's word is never taken
    direct: { mode: 'auto', projects: [{ id: 'p', title: 'Calculus study' }], roles: [], work: '', apps: ['Google Docs', 'Overleaf', 'Google Meet', 'ChatGPT'], scopes: {}, additional: [{ name: 'Linear', website: 'https://linear.app' }] },
  });
  const saved = () => savedOf(started.id);
  await until(() => saved(), (s) => s.jobs.filter((job) => job.kind === 'import').length >= 4, 'the imports queued');
  const value = saved();
  assert.deepEqual(value.choices.browserAgents, { browserId: 'chrome', browserName: 'Chrome', enable: true }, 'from this Mac and the person\'s answer, not from the window');
  const routeOf = (app) => { const job = value.jobs.find((one) => one.kind === 'import' && one.apps.includes(app)); return job ? job.route || 'engelbart' : 'none'; };
  assert.equal(routeOf('Google Docs'), 'engelbart', 'its copied sign-in: no plugin, nothing brought forward, no tab left');
  assert.equal(routeOf('Overleaf'), 'engelbart');
  assert.equal(routeOf('Google Meet'), 'browser', 'signed in in Chrome, refused in Engelbart: read there instead of a Log in loop');
  assert.equal(routeOf('ChatGPT'), 'none', 'signed out: waits on its sign-in popup');
  assert.equal(value.jobs.find((job) => job.label.startsWith('Other tools')).route, undefined, 'their sites\' sign-ins copied over');
  assert.match(value.jobs.find((job) => job.apps.includes('Google Meet')).plan, /in the person's own Chrome/);
  let now = await until(state(started.id), (s) => s.needs.some((need) => need.app === 'Google Meet') && s.needs.some((need) => need.app === 'ChatGPT'), 'Google Meet\'s stop in Chrome and ChatGPT\'s card');
  const popup = now.needs.find((need) => need.app === 'ChatGPT');
  assert.equal(popup.kind, 'signin-here', 'signed out everywhere: one card, Sign in inside Engelbart · Skip (2026-10-16)');
  assert.equal(popup.own, undefined, 'not a stop in their own browser');
  assert.equal(popup.browser, 'Chrome');
  const card = now.needs.find((need) => need.app === 'Google Meet');
  assert.equal(card.own, true);
  assert.equal(card.browser, 'Chrome');
  await connect.need(started.id, card.id, 'open');
  assert.deepEqual(opened, ['chrome'], 'Open brings their browser forward');
  await connect.need(started.id, card.id, 'done');
  await connect.need(started.id, popup.id, 'skip');
  release();
  now = await until(state(started.id), (s) => s.jobs.filter((job) => job.kind === 'import').every((job) => ['done', 'failed', 'stopped'].includes(job.status)), 'every import ended');
  const browse = turns.filter((turn) => turn.kind === 'browse');
  assert.deepEqual(browse.map((turn) => turn.label), ['Meeting transcripts: Google Meet']);
  for (const turn of browse) {
    assert.match(turn.system, /Never download or export anything/);
    assert.match(turn.system, /Close every tab you opened before you reply/);
    assert.match(turn.system, /never switch, resize or focus a window/);
    assert.match(turn.system, /At a login page .*call needs_you/);
    assert.match(turn.system, /tabs_close_mcp/, 'Claude Code closes its tabs');
    assert.match(turn.message, /<browser note="The person's own browser/);
    assert.doesNotMatch(turn.message, /downloadsLandIn/);
    assert.match(turn.message, /You do not have them: follow the same steps in your own tabs/);
    assert.deepEqual(turn.connectors, [], 'no connector of the person\'s');
  }
  const hidden = turns.filter((turn) => turn.kind === 'import' && turn.label.includes('Google Drive'));
  assert.equal(hidden.length, 1, 'Google Drive in Engelbart\'s browser');
  connect.stop(started.id);
  connect.dismiss(started.id);
  fs.rmSync(memory.memoryPath(ctx.dataRoot), { force: true }); // the next tests start with no MEMORY.md
});

test('without browser agents allowed, web apps keep Engelbart\'s own browser; at most 6 agents run at once', async () => {
  const { MAX_RUNNING } = require('../src/main/connect/session.cjs');
  assert.equal(MAX_RUNNING, 6);
  const fresh = fs.mkdtempSync(path.join(homeDir, 'browse-off-'));
  const webSignIn = { supports: () => true, canSignIn: () => true, signInQuiet: async () => ({ signedIn: true, browser: 'Chrome' }), signedIn: async () => true, keychainNote: () => '' };
  const browserAgents = { status: () => ({ available: true, use: false, ask: false, allowedByCli: false, consent: 'declined', browser: { id: 'chrome', name: 'Chrome' }, others: [] }) };
  const { connect } = fakeConnect({ home: fresh, webSignIn, browserAgents });
  const started = await connect.start({ provider: 'openai', direct: { mode: 'auto', projects: [{ id: 'p', title: 'Study' }], roles: [], work: '', apps: ['Google Docs'], scopes: {}, additional: [] } });
  await until(() => savedOf(started.id), (s) => s.jobs.some((job) => job.apps.includes('Google Docs')), 'Google Docs queued');
  const value = savedOf(started.id);
  assert.equal(value.choices.browserAgents, null);
  assert.equal(value.jobs.find((job) => job.apps.includes('Google Docs')).route, undefined);
  connect.stop(started.id);
  connect.dismiss(started.id);
  fs.rmSync(memory.memoryPath(ctx.dataRoot), { force: true });
});

// Import manually with fine-grained permissions (From Amitav, 2026-10-15): the same choices as a background run, but the
// librarian asks before anything comes in. What the person specified on the tools screen is its import instructions.
test('Import manually: the tools screen\'s choices start a librarian session, what the person specified told to the librarian', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'librarian-'));
  fs.mkdirSync(path.join(fresh, 'Vault'));
  const { connect, state } = fakeConnect({ home: fresh });
  const started = await connect.start({
    provider: 'openai', librarian: true,
    direct: {
      mode: 'manual', projects: [{ id: 'p', title: 'Memex', description: 'The history of the Memex' }], roles: ['Researcher'], work: 'How the Memex was imagined',
      apps: ['Obsidian', 'Notion'], additional: [{ name: 'Figma', website: 'https://figma.com' }],
      scopes: { Notion: { note: 'Only the pages about the Memex', folders: [], people: [], items: [], projects: [] }, Obsidian: { note: '', folders: [{ path: path.join(fresh, 'Vault') }], people: [], items: [], projects: [] } },
    },
  });
  assert.equal(started.direct, null, 'a librarian session, not a background run');
  const value = savedOf(started.id);
  assert.equal(value.choices.direct, null);
  assert.deepEqual(value.choices.sources.notes, { on: true, apps: ['Obsidian', 'Notion'], folders: [], repos: [] });
  assert.equal(value.choices.sources.sites.on, false, 'an extra tool is told to the librarian, not read as the browser history');
  assert.equal(value.choices.project.name, 'Memex');
  assert.match(value.choices.custom, /They describe their work as: Researcher\./);
  assert.match(value.choices.custom, /How the Memex was imagined/);
  assert.match(value.choices.custom, /- Notion: Only the pages about the Memex/);
  assert.match(value.choices.custom, new RegExp(`- Obsidian: only these folders and files: ${path.join(fresh, 'Vault').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(value.choices.custom, /Figma \(https:\/\/figma\.com\)/);
  // The tool asked about first, in the grant (Notion was allowed before the run here: deps.allowed); the librarian waits for it.
  const asked = await until(state(started.id), (s) => s.chat.some((entry) => entry.grant), 'the grant');
  assert.deepEqual(asked.chat.find((entry) => entry.grant).grant.rows, [{ id: 'Figma', name: 'Figma', tool: true, website: 'https://figma.com' }]);
  connect.grant(started.id, { apps: ['Figma'] });
  const now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => !entry.opener && !entry.grant), 'the librarian\'s first turn');
  assert.equal(now.chat[0].opener, true);
  connect.stop(started.id);
  connect.dismiss(started.id);
  fs.rmSync(memory.memoryPath(ctx.dataRoot), { force: true });
});

test('a browser agent\'s tools: what brings in what it read or downloaded, needs_you, never Engelbart\'s hidden browser', () => {
  const names = toolsFor('browse').map((tool) => tool.name);
  for (const name of ['add_note', 'add_to_library', 'import_pdfs', 'unpack', 'import_note_files', 'needs_you', 'wait_for_you']) assert.ok(names.includes(name), name);
  for (const name of ['browser_open', 'browser_eval', 'browser_type', 'browser_download', 'web_chats', 'import_google_files', 'import_gmail_threads', 'save_memory']) assert.equal(names.includes(name), false, name);
  assert.match(prompts.browseSystemPrompt('openai'), /search your tools for "node_repl js"/);
  assert.match(prompts.browseSystemPrompt('anthropic'), /tabs_create_mcp/);
  assert.match(prompts.BROWSE_RULES, /Close every tab you opened before you reply/);
  assert.match(prompts.BROWSE_RULES, /Never download or export anything/);
});

/* MATH-117: an app on this Mac whose folder the scan did not find is looked for by an agent before the button. */

const savedOf = (id) => JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', id, 'session.json'), 'utf8'));
const findJobs = (s, app) => s.jobs.filter((job) => job.kind === 'survey' && job.label === `Looking for your ${app} folder`);

test('a Zoom folder moved out of Documents is looked for and found: its at-a-glance, no button (MATH-117)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'zoom-found-'));
  const meeting = path.join(fresh, 'Movies', 'Zoom', '2026-03-04 10.00.00 Lab meeting');
  fs.mkdirSync(meeting, { recursive: true });
  fs.writeFileSync(path.join(meeting, 'meeting_saved_closed_caption.txt'), 'Alex: shall we start?\n');
  fs.writeFileSync(path.join(meeting, 'closed_caption.vtt'), 'WEBVTT\n');
  const { connect, state } = fakeConnect({ home: fresh });
  let started = null;
  try {
    started = await connect.start({ sources: { transcripts: { on: true, apps: ['Zoom'] } } });
    const now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the transcripts question');
    assert.deepEqual(findJobs(now, 'Zoom').map((job) => job.status), ['done'], 'one search, finished');
    assert.ok(now.log.some((entry) => entry.text === 'Found your Zoom folder at ~/Movies/Zoom'), JSON.stringify(now.log.map((entry) => entry.text)));
    assert.equal(now.chat.some((entry) => entry.authorize), false, 'no button was offered');
    const saved = savedOf(started.id);
    assert.equal(saved.picked.folders.Zoom, path.join(fresh, 'Movies', 'Zoom'));
    const zoom = saved.found.transcripts.Zoom;
    assert.equal(zoom.needs, undefined);
    assert.equal(zoom.looking, undefined);
    assert.equal(zoom.folder, '~/Movies/Zoom', 'the scan\'s at-a-glance of the folder found');
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a Zoom folder that is nowhere: the search says where it looked, then the button (MATH-117)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'zoom-none-'));
  fs.mkdirSync(path.join(fresh, 'Movies'), { recursive: true });
  const seen = []; // copies: a snapshot's chat is the session's own
  const { connect, state } = fakeConnect({ home: fresh, notify: (snapshot) => seen.push(JSON.parse(JSON.stringify({ chat: snapshot.chat, jobs: snapshot.jobs }))) });
  let started = null;
  try {
    started = await connect.start({ sources: { transcripts: { on: true, apps: ['Zoom'] } } });
    const now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the Zoom folder button');
    assert.deepEqual(findJobs(now, 'Zoom').map((job) => job.status), ['done']);
    const button = now.chat.findIndex((entry) => entry.authorize);
    assert.deepEqual(now.chat[button].authorize, { source: 'transcripts', app: 'Zoom', kind: 'folder', label: 'Choose your Zoom folder…' });
    assert.ok(now.chat.slice(1, button).some((entry) => entry.role === 'agent' && /Looking through/.test(entry.text)), 'the librarian waited for the search first');
    assert.ok(seen.some((snapshot) => snapshot.jobs.some((job) => job.label === 'Looking for your Zoom folder' && job.status === 'running')), 'it was seen looking');
    assert.ok(seen.every((snapshot) => !snapshot.chat.some((entry) => entry.authorize) || findJobs(snapshot, 'Zoom').every((job) => job.status === 'done')), 'no button while it looked');
    const zoom = savedOf(started.id).found.transcripts.Zoom;
    assert.equal(zoom.needs, 'folder');
    assert.match(zoom.searched, /home folder/);
    assert.match(zoom.cloud, /zoom\.us/);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('the files on this Mac not allowed: no search, the folder button at once (MATH-117)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'zoom-off-'));
  fs.mkdirSync(path.join(fresh, 'Movies', 'Zoom', '2026-03-04 Lab meeting'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'Movies', 'Zoom', '2026-03-04 Lab meeting', 'closed_caption.vtt'), 'WEBVTT\n');
  const { connect, state } = fakeConnect({ home: fresh });
  let started = null;
  try {
    started = await connect.start({ sources: { transcripts: { on: true, apps: ['Zoom'] } }, computer: false });
    const now = await until(state(started.id), (s) => !s.thinking && s.chat.length > 1, 'the first turn');
    assert.deepEqual(findJobs(now, 'Zoom'), []);
    assert.deepEqual(now.chat[1].authorize, { source: 'transcripts', app: 'Zoom', kind: 'folder', label: 'Choose your Zoom folder…' });
    assert.equal(savedOf(started.id).found.transcripts.Zoom.searched, undefined);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('an Obsidian vault Obsidian does not list is found by its .obsidian folder (MATH-117)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'vault-found-'));
  fs.cpSync(vault, path.join(fresh, 'Documents', 'Research vault'), { recursive: true });
  const { connect, state } = fakeConnect({ home: fresh });
  let started = null;
  // MATH-110: the vault is in ~/Documents, which macOS let Engelbart read on the choose screen.
  const answers = path.join(ctx.dataRoot, '.connect', 'folders.json');
  folderAccess.writeAnswers(ctx.dataRoot, { Documents: 'allowed' });
  try {
    started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } });
    const now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
    assert.deepEqual(findJobs(now, 'Obsidian').map((job) => job.status), ['done']);
    assert.equal(now.chat.some((entry) => entry.authorize), false);
    const saved = savedOf(started.id);
    assert.equal(saved.picked.folders.Obsidian, path.join(fresh, 'Documents', 'Research vault'));
    assert.equal(saved.found.notes.Obsidian.vaults.length, 1, 'the vault\'s at-a-glance');
  } finally {
    if (started) connect.stop(started.id);
    fs.rmSync(answers, { force: true });
  }
});

test('MATH-110: the folder search keeps out of the protected folders macOS did not let Engelbart read, and is told which it may', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'find-skip-'));
  for (const dir of ['Desktop', 'Documents', 'Downloads', 'Movies', 'Projects', 'Library/CloudStorage/GoogleDrive-ada@lab.org']) fs.mkdirSync(path.join(fresh, dir), { recursive: true });
  // A vault in ~/Documents, never asked about: the search does not find it, and the agents are not given the folder.
  fs.cpSync(vault, path.join(fresh, 'Documents', 'Research vault'), { recursive: true });
  const fake = createFakeConnectAgents({ delayMs: 5 });
  const asked = [];
  const agents = { turn: (args) => { if (args.meta && args.meta.job && args.meta.job.find) asked.push({ message: args.message, dirs: args.dirs }); return fake.turn(args); } };
  const answers = path.join(ctx.dataRoot, '.connect', 'folders.json');
  folderAccess.writeAnswers(ctx.dataRoot, { Desktop: 'allowed', Documents: 'denied' });
  // The Mac's folder access, on every platform (off the Mac the search is told nothing is protected: the next test).
  const { connect, state } = fakeConnect({ home: fresh, agents, platform: 'darwin' });
  let started = null;
  try {
    started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } });
    const now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the Obsidian folder button');
    assert.deepEqual(findJobs(now, 'Obsidian').map((job) => job.status), ['done']);
    assert.equal(asked.length, 1);
    const { message } = asked[0];
    const look = message.match(/<look_in[^>]*>([^<]*)<\/look_in>/)[1].split(', ');
    assert.deepEqual(look, ['~/Desktop', '~/Projects'], 'Desktop allowed; Documents, Downloads, Library and Movies left out');
    assert.match(message, /Never look in ~\/Documents, ~\/Downloads, ~\/Library, ~\/Pictures, ~\/Music, ~\/Movies:/, 'the folders to skip, Desktop not among them');
    assert.match(message, /<folders_allowed[^>]*>Desktop \(~\/Desktop\)<\/folders_allowed>/);
    assert.match(message, /Never Glob from the home folder itself/);
    assert.doesNotMatch(message, /look under[^.]*Documents/, 'the usual places name no folder not allowed');
    assert.equal(savedOf(started.id).picked.folders.Obsidian, undefined, 'the vault in ~/Documents was not taken');
  } finally {
    if (started) connect.stop(started.id);
    fs.rmSync(answers, { force: true });
  }
  // Zoom's usual places: Dropbox as a plain folder and what was allowed, never ~/Movies or ~/Documents.
  folderAccess.writeAnswers(ctx.dataRoot, { Downloads: 'allowed' });
  fs.mkdirSync(path.join(fresh, 'Dropbox'));
  const zoom = fakeConnect({ home: fresh, agents, platform: 'darwin' });
  try {
    started = await zoom.connect.start({ sources: { transcripts: { on: true, apps: ['Zoom'] } } });
    await until(zoom.state(started.id), (s) => findJobs(s, 'Zoom').every((job) => job.status === 'done') && findJobs(s, 'Zoom').length, 'the Zoom search');
    const message = asked[asked.length - 1].message;
    assert.match(message, /look under ~\/Dropbox, Downloads \(~\/Downloads\) first/);
    assert.match(message, /Never look in ~\/Desktop, ~\/Documents, ~\/Library, ~\/Pictures, ~\/Music, ~\/Movies:/);
  } finally {
    if (started) zoom.connect.stop(started.id);
    fs.rmSync(answers, { force: true });
  }
});

test('off the Mac (Windows, Linux) the folder search is told no folder is protected, and looks in Documents and Downloads too', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'find-free-'));
  for (const dir of ['AppData', 'Desktop', 'Documents', 'Downloads', 'Projects']) fs.mkdirSync(path.join(fresh, dir), { recursive: true });
  const fake = createFakeConnectAgents({ delayMs: 5 });
  const asked = [];
  const agents = { turn: (args) => { if (args.meta && args.meta.job && args.meta.job.find) asked.push(args.message); return fake.turn(args); } };
  const answers = path.join(ctx.dataRoot, '.connect', 'folders.json');
  folderAccess.writeAnswers(ctx.dataRoot, { Documents: 'denied' }); // a Mac's answer, which counts for nothing elsewhere
  for (const platform of ['win32', 'linux']) {
    const { connect, state } = fakeConnect({ home: fresh, agents, platform });
    let started = null;
    try {
      started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } });
      await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the Obsidian folder button');
      const message = asked[asked.length - 1];
      const look = message.match(/<look_in[^>]*>([^<]*)<\/look_in>/)[1].split(', ');
      assert.deepEqual(look, ['~/Desktop', '~/Documents', '~/Downloads', '~/Projects'], `${platform}: every folder but AppData`);
      assert.doesNotMatch(message, /macOS|Never look in|folders_allowed/, platform);
      assert.match(message, /Skip hidden folders \(a vault's \.obsidian aside\) and ~\/AppData/);
      assert.match(message, /Never Glob from the home folder itself/);
    } finally {
      if (started) connect.stop(started.id);
    }
  }
  fs.rmSync(answers, { force: true });
});

test('an app\'s folder is looked for once a session, however often the scan runs again (MATH-117)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'find-once-'));
  const { connect, state } = fakeConnect({ home: fresh });
  let started = null;
  try {
    started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, transcripts: { on: true, apps: ['Zoom'] } } });
    let now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.authorize), 'the Obsidian folder button');
    assert.equal(now.chat.find((entry) => entry.authorize).authorize.app, 'Obsidian');
    await until(state(started.id), (s) => findJobs(s, 'Zoom').every((job) => job.status === 'done'), 'the Zoom search');
    // Both turn up now; choosing the vault scans the notes again, and Zoom's folder is not looked for a second time.
    fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
    fs.mkdirSync(path.join(fresh, 'Movies', 'Zoom', '2026-03-04 Lab meeting'), { recursive: true });
    fs.writeFileSync(path.join(fresh, 'Movies', 'Zoom', '2026-03-04 Lab meeting', 'closed_caption.vtt'), 'WEBVTT\n');
    await connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: '~/Vault' });
    now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
    assert.equal(findJobs(now, 'Zoom').length, 1);
    assert.equal(findJobs(now, 'Obsidian').length, 1);
    const zoom = savedOf(started.id).found.transcripts.Zoom;
    assert.equal(zoom.needs, 'folder', 'still the button for Zoom');
    assert.match(zoom.searched, /home folder/, 'where it looked is kept through the scan');
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('an import started from a project and a workspace lands on the project\'s list, never in the workspace (2026-10-13: library only); a row removed from the project is not brought back (2026-10-11)', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'placed-'));
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  const { project, workspaceId } = await projects.createProjectWithWelcome(ctx, { name: 'Imported into' });
  const { connect, state } = fakeConnect({ home: fresh });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } }, provider: 'openai', projectId: project.id, workspaceId });
  assert.equal(started.mode, 'existing');
  // Obsidian does not list ~/Vault: the search for it finds it (MATH-117).
  await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
  connect.answer(started.id, { picked: ['Everything'] });
  await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the notes import');
  const listed = () => projects.findProject(ctx, project.id).library;
  await until(() => connect.state(started.id).placed, (placed) => placed.project === 5, 'the five placed');
  assert.equal(connect.state(started.id).placed.workspace, 0, 'none in the workspace');
  assert.equal(listed().length, 5, 'on the project\'s own list');
  const context = projects.findWorkspace(ctx, project.id, workspaceId).workspace.context;
  assert.deepEqual(listed().filter((id) => context.includes(id)), [], 'not in the workspace it was started from: imports go to the library only');
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
  const calls = { keychain: [], openedIn: [], looks: 0, checked: [] };
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: [{ id: 'Default', name: 'Me' }] })),
    cookieNames: (id, profile, domains) => {
      const app = domains[0] === 'chatgpt.com' ? 'ChatGPT' : domains[0] === 'claude.ai' ? 'Claude' : '';
      calls.checked.push(app);
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
    // Chrome picked for the sign-ins (2026-10-16, C4: only the chosen browser is read, never a next one).
    chosen: () => ({ browser: 'chrome' }),
    getSession: () => ({ cookies: { get: async ({ domain }) => held.filter((cookie) => cookie.domain.endsWith(domain)) } }),
    openExternal: async () => { throw new Error('Safari is never opened'); },
    openIn: async (id, url) => { calls.openedIn.push([id, url]); },
  });
  return { webSignIn, calls, held };
}

test('sign-ins sorted before the run: one signed in is surveyed; one still signed out is brought back, quietly and then by its card, its survey waiting; Skip leaves it out (2026-10-16)', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'Claude';
  const { webSignIn } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } } });
  const chats = [];
  const { connect, state } = fakeConnect({ webSignIn, signInWindow: fakeWindow('closed').signInWindow, notify: (snapshot) => chats.push(JSON.parse(JSON.stringify(snapshot.chat))) });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    assert.deepEqual(chats.find((chat) => chat.length).map((entry) => [entry.opener, entry.text]), [[true, 'Looking at what you picked…']], 'a first line at once');
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking && s.needs.length === 1, 'the first turn and Claude\'s card');
    assert.deepEqual(now.needs.map((need) => [need.app, need.kind, need.reason, need.where]), [['Claude', 'signin-here', 'Sign in to Claude', 'here']]);
    assert.ok(now.log.some((entry) => entry.text === 'Signed in to ChatGPT from Chrome'));
    assert.ok(now.log.some((entry) => entry.text === 'Bringing back the Claude sign-in'));
    assert.deepEqual(now.jobs.filter((job) => job.kind === 'survey').map((job) => job.apps[0]), ['ChatGPT']);
    assert.equal(now.jobs.some((job) => job.apps.includes('Claude')), false, 'nothing of Claude runs, nor its recall, while it waits');
    assert.match(now.chat[0].text, /^(Found .*|Had a look at what you picked\.) Starting with your ai chats\.\n\nUsing your Chrome sign-ins for ChatGPT\.$/);
    const after = await connect.need(started.id, now.needs[0].id, 'skip');
    assert.deepEqual(after.needs, []);
    assert.ok(after.leftOut.some((entry) => entry.app === 'Claude' && entry.why === 'you skipped signing in'));
    await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'ChatGPT' && job.status === 'done'), 'ChatGPT\'s survey');
    assert.equal(connect.state(started.id).jobs.some((job) => job.apps.includes('Claude')), false);
  } finally {
    if (started) connect.stop(started.id);
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

test('the librarian must ask, once: one message first, every app unticked; nothing looked at and no librarian before Grant access; those not ticked left out (2026-10-16, in place of From Amitav\'s popup per app)', async () => {
  const { webSignIn, calls } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT', 'Claude'] } } });
  const { connect, state } = fakeConnect({ webSignIn, ask: true, delayMs: 150 });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } }, provider: 'anthropic' });
    let now = connect.state(started.id);
    // At once, before the scan: the first message after the (unshown) opening line.
    assert.deepEqual(now.chat.map((entry) => (entry.opener ? 'opener' : entry.grant ? 'grant' : 'other')), ['opener', 'grant']);
    assert.deepEqual(now.chat[1].grant, { rows: [{ id: 'ChatGPT', name: 'ChatGPT' }, { id: 'Claude', name: 'Claude' }], answered: null });
    assert.deepEqual(now.needs, [], 'no popup per app');
    now = await until(state(started.id), (s) => s.chat[0].text !== 'Looking at what you picked…', 'the scan, behind the grant');
    assert.deepEqual(calls.checked, [], 'no sign-in of theirs is looked at before Grant access');
    assert.deepEqual(calls.keychain, [], 'nor copied');
    assert.deepEqual(now.jobs.filter((job) => job.apps.some((app) => app === 'ChatGPT' || app === 'Claude')).map((job) => job.kind), [], 'no survey before Grant access');
    assert.equal(now.chat.some((entry) => !entry.opener && !entry.grant), false, 'the librarian waits for the grant');
    assert.throws(() => connect.grant(started.id, { apps: [] }), /Pick at least one app/);
    connect.grant(started.id, { apps: ['ChatGPT', 'Not asked'] });
    now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'ChatGPT') && s.chat.some((entry) => !entry.opener && !entry.grant), 'ChatGPT\'s survey and the librarian');
    assert.deepEqual(now.chat[1].grant.answered.allowed, ['ChatGPT']);
    assert.deepEqual(now.chat[1].grant.answered.skipped, ['Claude']);
    assert.ok(calls.checked.includes('ChatGPT'), 'allowed: its sign-in is looked at');
    assert.ok(now.log.some((entry) => entry.text === 'Allowed Engelbart to access ChatGPT' && entry.who === 'You'), JSON.stringify(now.log.map((entry) => entry.text)));
    assert.ok(now.leftOut.some((entry) => entry.app === 'Claude' && entry.why === 'you didn’t allow Engelbart to access it'));
    // Import now hands nothing of Claude over, even as the whole source.
    await until(state(started.id), (s) => !s.thinking, 'the librarian');
    const imported = connect.importNow(started.id);
    connect.stop(started.id); // what was handed over is what is checked; nothing of it needs to come in
    assert.ok(imported.jobs.every((job) => !job.apps.includes('Claude')), JSON.stringify(imported.jobs.map((job) => [job.kind, job.apps])));
    assert.deepEqual(calls.checked.filter((app) => app === 'Claude'), [], 'Claude was never looked at');
    // Import pressed while the grant is still open: its apps are left out, the grant answered so.
    const third = fakeConnect({ ask: true });
    const other = await third.connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude Code'] } } });
    await until(third.state(other.id), (s) => s.chat.some((entry) => entry.grant) && s.chat[0].text !== 'Looking at what you picked…', 'ChatGPT\'s grant');
    const pressed = third.connect.importNow(other.id);
    third.connect.stop(other.id);
    assert.deepEqual(pressed.chat.find((entry) => entry.grant).grant.answered.skipped, ['ChatGPT']);
    assert.ok(pressed.leftOut.some((entry) => entry.app === 'ChatGPT' && /Import before allowing it/.test(entry.why)));
    assert.ok(pressed.jobs.every((job) => !job.apps.includes('ChatGPT')));
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a tool the agents found, ticked in a manual import, is a row of the grant and, allowed, brought in through its site with its own name (2026-10-16)', async () => {
  const { connect, state } = fakeConnect({ ask: true, delayMs: 200 });
  const started = await connect.start({ librarian: true, direct: { mode: 'manual', projects: [{ title: 'Help-seeking study', description: 'A study.' }], roles: [], work: '', apps: ['Obsidian'], scopes: {}, additional: [{ name: 'Linear', website: 'https://linear.app', note: 'only the study board' }, { name: 'Figma', website: 'https://figma.com' }] } });
  let now = await until(state(started.id), (s) => s.chat.some((entry) => entry.grant), 'the grant');
  assert.deepEqual(now.chat.find((entry) => entry.grant).grant.rows.map((row) => [row.id, !!row.tool]), [['Linear', true], ['Figma', true]]);
  assert.equal(now.jobs.some((job) => /Other tools/.test(job.label)), false, 'nothing of them before Grant access');
  connect.grant(started.id, { apps: ['Linear'] });
  now = await until(state(started.id), (s) => s.jobs.some((job) => job.label === 'Other tools: Linear'), 'Linear\'s import');
  assert.ok(now.leftOut.some((entry) => entry.app === 'Figma'));
  connect.stop(started.id);
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  const job = saved.jobs.find((one) => one.label === 'Other tools: Linear');
  assert.deepEqual(job.extra, { sites: ['linear.app'], tool: { name: 'Linear', website: 'https://linear.app', sites: ['linear.app'] } }, 'its site, for the browser to open, and the tool its sign-in is for');
  assert.match(job.plan, /Linear \(linear\.app\)|Linear/);
  assert.match(job.plan, /only the study board/, 'what the person said about it');
  assert.equal(saved.jobs.some((one) => one.label === 'Other tools: Figma'), false, 'left out: nothing of it comes in');
});

test('a grant still open when Engelbart quits is open again after, its apps held; answered, they start and so does the librarian', async () => {
  const first = fakeConnect({ ask: true, delayMs: 40 });
  const started = await first.connect.start({ sources: { notes: { on: true, apps: ['Obsidian', 'Google Docs', 'OneNote'] } }, provider: 'openai' });
  await until(first.state(started.id), (s) => s.chat.some((entry) => entry.grant) && s.chat[0].text !== 'Looking at what you picked…', 'the grant');
  first.connect.suspendAll();
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.allowed, []);
  const second = fakeConnect({ ask: true, delayMs: 5 });
  second.connect.resume(ctx);
  let now = second.connect.state(started.id);
  const grantOf = (snap) => snap.chat.find((entry) => entry.grant).grant;
  assert.deepEqual(grantOf(now).rows.map((row) => row.id), ['Google Docs', 'OneNote']);
  assert.equal(grantOf(now).answered, null, 'still open');
  assert.equal(now.chat.filter((entry) => entry.grant).length, 1, 'not asked twice');
  assert.equal(now.jobs.some((job) => job.apps.includes('Google Docs') || job.apps.includes('OneNote')), false, 'held');
  second.connect.grant(started.id, { apps: ['OneNote'] });
  now = await until(second.state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'OneNote') && s.chat.some((entry) => !entry.opener && !entry.grant && !entry.notice), 'OneNote\'s survey and the librarian');
  assert.ok(now.leftOut.some((entry) => entry.app === 'Google Docs'));
  for (const one of second.connect.list(ctx.dataRoot)) second.connect.stop(one.id);
});

test('what the person ticks is what may be read: Drive ids from the survey kept as approved, and an import reads nothing else (librarian only)', async () => {
  const { connect, state } = fakeConnect({ delayMs: 5 });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Google Docs'] } } });
  const card = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask && entry.ask.kind === 'multi'), 'the Drive question');
  const ask = card.chat.find((entry) => entry.ask).ask;
  assert.deepEqual(ask.options.map((option) => option.label), ['Google Drive item 1', 'Google Drive item 2', 'Google Drive item 3']);
  connect.answer(started.id, { picked: ['Google Drive item 2'] });
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', started.id, 'session.json'), 'utf8'));
  assert.deepEqual(saved.approved, { 'Google Docs': ['google-docs-2'] }, 'matched to the survey\'s item by its name');
  connect.stop(started.id);
  // The tools: an id the person did not tick is skipped, before anything is fetched.
  const fetched = [];
  const page = { url: () => 'about:blank', download: async (url) => { fetched.push(url); throw new Error('not in this test'); } };
  const tools = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'approved-test'), projectId: () => null, apps: ['Google Docs'], approvedFor: (app) => (app === 'Google Docs' ? new Set(['google-docs-2']) : null) }, context: async () => ctx, kind: 'import', page });
  const out = await tools('import_google_files', { items: [{ id: 'google-docs-1', kind: 'doc', name: 'One' }, { id: 'google-docs-3', kind: 'doc', name: 'Three' }] });
  assert.deepEqual(out.skipped.map((entry) => [entry.id, entry.why]), [['google-docs-1', 'the person did not approve it: only what they ticked comes in'], ['google-docs-3', 'the person did not approve it: only what they ticked comes in']]);
  assert.deepEqual(fetched, [], 'nothing of them was fetched');
  // In the librarian's run a Drive import has no browser to find more; in the background it browses freely.
  assert.deepEqual(toolNamesFor('import', { apps: ['Google Docs'], approvals: true }).filter((name) => name.startsWith('browser_open')), []);
  assert.deepEqual(toolNamesFor('survey', { apps: ['Google Docs'], approvals: true }).filter((name) => name === 'browser_open'), ['browser_open'], 'its survey lists Drive');
  assert.deepEqual(toolNamesFor('import', { apps: ['Google Docs'] }).filter((name) => name === 'browser_open'), ['browser_open']);
});

/** A sign-in window (main/connect/signin-window.cjs) that answers `status`, its calls in `opened`. */
function fakeWindow(status = 'signed-in') {
  const opened = [];
  let closed = 0;
  return { opened, closes: () => closed, signInWindow: { open: async (app) => { opened.push(app); return { status }; }, close: () => { closed += 1; } } };
}

test('Sign in in Engelbart\'s own browser: Google Drive signed in there signs in Gmail, Google Meet and Gemini for the run', async () => {
  const { webSignIn } = fakeSignIn({ browsers: {} }); // Safari only: nothing to bring over
  const google = { ...webSignIn, supports: (app) => ['Google Docs', 'Gmail', 'Google Meet', 'Gemini', 'ChatGPT', 'Claude'].includes(app) };
  const win = fakeWindow('signed-in');
  const { connect, state } = fakeConnect({ webSignIn: google, signInWindow: win.signInWindow });
  let started = null;
  try {
    assert.deepEqual(await connect.signInWindowOpen('Google Docs'), { status: 'signed-in' });
    assert.deepEqual(win.opened, ['Google Docs']);
    assert.equal(connect.signInWindowClose(), true);
    assert.equal(win.closes(), 1);
    started = await connect.start({ sources: { notes: { on: true, apps: ['Google Docs'] }, email: { on: true, apps: ['Gmail'] }, transcripts: { on: true, apps: ['Google Meet'] }, chats: { on: true, apps: ['Gemini', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    for (const app of ['Google Drive', 'Gmail', 'Google Meet', 'Gemini']) assert.ok(now.log.some((entry) => entry.text === `Signed in to ${app} already`), app);
    assert.deepEqual(now.jobs.filter((job) => job.kind === 'survey').map((job) => job.apps[0]).sort(), ['Gemini', 'Gmail', 'Google Docs', 'Google Meet']);
    // Another sign-in is not shared: Claude's is brought back on its own (2026-10-16: quietly, then its card).
    assert.doesNotMatch(now.chat[0].text, /Claude/);
    const card = (await until(state(started.id), (s) => s.needs.length === 1, 'Claude\'s card')).needs[0];
    assert.deepEqual([card.app, card.kind], ['Claude', 'signin-here']);
  } finally {
    if (started) connect.stop(started.id);
  }
  // The person closed it first: nothing is marked.
  const shut = fakeWindow('closed');
  const other = fakeConnect({ webSignIn: google, signInWindow: shut.signInWindow });
  assert.deepEqual(await other.connect.signInWindowOpen('Gmail'), { status: 'closed' });
  assert.deepEqual(await other.connect.signInWindowOpen('Notion'), { status: 'closed' });
  // Round 3 (2026-10-13): Notion's sign-in can be told apart now (its token_v2 cookie), so it is one it can sign in.
  assert.deepEqual(shut.opened, ['Gmail', 'Notion']);
});

test('a web app\'s sign-in lost mid-run: copied again quietly from the browser, no card, and the agent carries on (2026-10-12)', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'ChatGPT';
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } } });
  const { webSignIn, quiet } = countedSignIn(fake);
  // The sign-in cookie really is gone when the survey says so (one still held is believed: the test after this).
  const base = createFakeConnectAgents({ delayMs: 5 });
  const agents = { turn: (args) => { if (args.meta && args.meta.kind === 'survey') fake.held.length = 0; return base.turn(args); } };
  const { connect, state } = fakeConnect({ webSignIn, agents });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    const now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.status === 'done'), 'its survey, carried on');
    assert.deepEqual(now.needs, [], 'no Log in card');
    assert.deepEqual(quiet, ['ChatGPT', 'ChatGPT'], 'checked before the run, then copied again when the survey lost it');
    assert.deepEqual(fake.calls.keychain, ['chrome', 'chrome'], 'Chrome\'s key, asked once before the run, is used again (main keeps it: no new prompt)');
    assert.deepEqual(fake.calls.openedIn, [], 'nothing opened');
    assert.ok(now.log.some((entry) => entry.text === 'Copied the ChatGPT sign-in again from Chrome'));
    assert.equal(now.chat.some((entry) => /Left out ChatGPT/.test(entry.text)), false);
  } finally {
    if (started) connect.stop(started.id);
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

/** Fake agents whose survey of `app` (or, with `kind`, whose job of that kind) calls needs_you `times` times with `reason`. */
function claimingAgents({ app = 'ChatGPT', kind = 'survey', times = 1, reason = 'Sign in to ChatGPT' } = {}) {
  const base = createFakeConnectAgents({ delayMs: 5 });
  const answers = [];
  const agents = {
    async turn(args) {
      const meta = args.meta;
      if (!meta || meta.kind !== kind || (kind === 'survey' && meta.job.apps[0] !== app)) return base.turn(args);
      for (let n = 0; n < times; n += 1) answers.push(await meta.callTool('needs_you', { kind: 'signin', reason }));
      return { text: kind === 'survey' ? JSON.stringify({ app, signedIn: true, summary: 'Read with what it had.', items: [] }) : 'Brought in what it could.', session: null };
    },
  };
  return { agents, answers };
}

test('an agent says signed out while the sign-in cookie is still held: still signed in, nothing dropped or stopped, no chat line (2026-10-12)', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } } });
  const { webSignIn, quiet } = countedSignIn(fake);
  const { agents, answers } = claimingAgents({ times: 2 });
  const { connect, state } = fakeConnect({ webSignIn, agents });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    const now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.status === 'done'), 'its survey, finished');
    assert.equal(answers[0].status, 'done');
    assert.equal(answers[0].note, 'Still signed in: the page or its API failed for a moment. Reload and try again, or finish with what you have.');
    assert.equal(answers[1].status, 'skipped', 'the same agent saying so again finishes without it');
    assert.match(answers[1].note, /finish without it/);
    assert.deepEqual(quiet, ['ChatGPT'], 'checked before the run only: not copied again, so nothing was dropped');
    assert.equal(fake.held.length, 1, 'the sign-in cookie kept');
    assert.deepEqual(now.needs, [], 'no card');
    assert.equal(now.chat.some((entry) => /ChatGPT/.test(entry.text) && /Left out|ended/.test(entry.text)), false, 'nothing said in the chat');
    assert.ok(now.log.some((entry) => entry.text === 'Still signed in to ChatGPT: its page or API failed for a moment'));
    assert.ok(now.log.some((entry) => entry.text === 'Carried on without ChatGPT: it still looked signed in'));
    const recall = now.jobs.find((job) => job.kind === 'recall' && job.apps.includes('ChatGPT'));
    if (recall) assert.notEqual(recall.skipped, true, 'Asking ChatGPT what it remembers is not stopped');
    // ChatGPT is not left out for the run: Import still brings it in.
    const imported = connect.importNow(started.id);
    assert.ok(imported.jobs.some((job) => job.kind === 'import' && job.apps.includes('ChatGPT')));
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a sign-in need from a job filed under Codex that names claude.ai goes to Claude: settled quietly, no card for Codex (2026-10-12)', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['Claude'] } } });
  const { webSignIn, quiet } = countedSignIn(fake);
  const { agents, answers } = claimingAgents({ kind: 'import', reason: 'Sign in to Claude (claude.ai) to read its chats' });
  const { connect, state } = fakeConnect({ webSignIn, agents });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['Codex', 'Claude', 'Claude Code'] } }, permissions: { recall: false } });
    await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    const imported = connect.importNow(started.id);
    assert.deepEqual(imported.jobs.find((job) => job.kind === 'import').apps, ['Codex', 'Claude', 'Claude Code']);
    const now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the import');
    assert.equal(answers[0].status, 'done');
    assert.match(answers[0].note, /^Still signed in/);
    assert.deepEqual(now.needs, [], 'no card for Codex');
    assert.ok(now.log.some((entry) => entry.text === 'Still signed in to Claude: its page or API failed for a moment'));
    assert.deepEqual(quiet, ['Claude']);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a sign-in the reason names (GitHub) from a job filed under another app (Folders on this Mac) is that app\'s, tied to the job (2026-10-14)', async () => {
  const { agents } = claimingAgents({ kind: 'import', reason: 'Sign in to GitHub' });
  const { connect, state } = fakeConnect({ agents });
  let started = null;
  try {
    started = await connect.start({ provider: 'openai', direct: { mode: 'manual', projects: [{ id: 'p', title: 'Memex' }], apps: ['Folders on this Mac'], scopes: {} } });
    const now = await until(state(started.id), (s) => s.needs.length > 0, 'the step');
    const need = now.needs[0];
    assert.equal(need.app, 'GitHub', 'not "Sign in to Folders on this Mac"');
    const job = now.jobs.find((one) => one.kind === 'import');
    assert.deepEqual(need.jobIds, [job.id], 'the status ties it to its job (no second row)');
  } finally {
    if (started) connect.stop(started.id);
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

test('refused is told apart from signed out: the refused app is skipped and said in the opener; the signed-out one gets its card (2026-10-16)', async () => {
  const { webSignIn } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'], deny: true } } });
  const { connect, state } = fakeConnect({ webSignIn });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking && s.needs.length === 1, 'the first turn and Claude\'s card');
    assert.deepEqual(now.needs.map((need) => [need.app, need.kind]), [['Claude', 'signin-here']], 'no card for the refused app: one could not succeed');
    assert.match(now.chat[0].text, /\n\nSkipped ChatGPT: macOS didn't allow Chrome's sign-ins\. You can add it later from Add sources\.$/);
    assert.ok(now.log.some((entry) => entry.text === 'Skipped ChatGPT: macOS didn\'t allow Chrome\'s sign-ins'));
    assert.equal(now.jobs.some((job) => job.apps.includes('ChatGPT') || job.apps.includes('Claude')), false);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a sign-in lost mid-run that can\'t be copied again: one card, macOS not asked anew; signed in again yet still not working, skipped with one quiet line that never greys out a question (2026-10-16)', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'ChatGPT'; // signed in in Engelbart's window, then its survey finds the sign-in expired
  const { webSignIn, calls } = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT'] } } });
  const { connect, state } = fakeConnect({ webSignIn, signInWindow: fakeWindow('signed-in').signInWindow });
  let started = null;
  try {
    await connect.signInWindowOpen('ChatGPT');
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    let now = await until(state(started.id), (s) => s.needs.some((need) => need.app === 'ChatGPT'), 'its card');
    const card = now.needs.find((need) => need.app === 'ChatGPT');
    assert.deepEqual([card.kind, card.where, card.reason], ['signin-here', 'here', 'Sign in to ChatGPT']);
    assert.deepEqual(calls.keychain, [], 'Chrome was never asked about this run: not asked now');
    assert.deepEqual(calls.openedIn, []);
    // Signed in inside Engelbart again (the window says so) and still not working: given up on, quietly.
    await connect.need(started.id, card.id, 'open');
    now = await until(state(started.id), (s) => s.chat.some((entry) => entry.notice && entry.text === 'Couldn\'t connect to ChatGPT. Skipped.'), 'the quiet line');
    assert.deepEqual(now.needs, []);
    assert.ok(now.leftOut.some((entry) => entry.app === 'ChatGPT' && entry.why === 'Engelbart couldn’t connect to it'));
    assert.equal(now.chat.find((entry) => entry.notice).role, 'agent');
    assert.equal(now.chat.filter((entry) => entry.notice).length, 1);
    const ended = await until(state(started.id), (s) => s.jobs.every((job) => job.kind !== 'survey' || job.status !== 'running' && job.status !== 'waiting'), 'its survey ended');
    assert.ok(ended.log.some((entry) => entry.text === 'Couldn\'t connect to ChatGPT: skipped'));
  } finally {
    if (started) connect.stop(started.id);
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
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
    assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: 'Chrome', note: 'macOS will ask to use Chrome\'s sign-ins. Choose Allow.', profiles: [], opens: '' });
    assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-in', browser: 'Chrome' });
    assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: '', note: '', profiles: [], opens: '' }, 'held now: macOS will not be asked');
    // Ticked again: signInQuiet answers browser '' (held already); the browser it came from is remembered.
    assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-in', browser: 'Chrome' });
    assert.deepEqual(await connect.signInCheck('Claude'), { status: 'signed-out', browser: '' });
    assert.deepEqual(quiet, ['ChatGPT', 'ChatGPT', 'Claude']);
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    // ChatGPT's answer is used as it is; Claude's signed-out answer is brought back (2026-10-16): copied again once, then its card.
    const carded = await until(state(started.id), (s) => s.needs.length === 1, 'Claude\'s card');
    assert.deepEqual(quiet, ['ChatGPT', 'ChatGPT', 'Claude', 'Claude'], 'no second look at ChatGPT; one quiet copy of Claude');
    assert.deepEqual(carded.needs.map((need) => [need.app, need.kind]), [['Claude', 'signin-here']]);
    assert.match(now.chat[0].text, /\n\nUsing your Chrome sign-ins for ChatGPT\.$/);
    assert.ok(now.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'ChatGPT'));
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a check when ticked waits on macOS as long as the person takes; the run waits for it too; one past the limit is still checking, and joins when signed in', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['ChatGPT', 'Claude'] } } });
  const { webSignIn, quiet } = countedSignIn(fake, { slowMs: 80 });
  const { connect, state } = fakeConnect({ webSignIn, deps: { signInCheckMs: 20 } });
  let started = null;
  try {
    const checking = connect.signInCheck('ChatGPT'); // macOS's prompt answered after longer than the run's limit
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT', 'Claude'] } } });
    assert.deepEqual(await checking, { status: 'signed-in', browser: 'Chrome' });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    assert.deepEqual(quiet, ['ChatGPT', 'Claude']);
    assert.match(now.chat[0].text, /Using your Chrome sign-ins for ChatGPT\.$/, 'ChatGPT, still being checked when the run started, ended signed in');
    assert.doesNotMatch(now.chat[0].text, /Left out Claude/, 'Claude, past the limit, is still checking: not left out (2026-10-12)');
    assert.ok(now.log.some((entry) => entry.text === 'Still checking the Claude sign-in'));
    const joined = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'survey' && job.apps[0] === 'Claude'), 'Claude joins once its answer comes');
    assert.ok(joined.log.some((entry) => entry.text === 'Signed in to Claude from Chrome'));
    assert.deepEqual(joined.needs, []);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('a late answer that is signed out: brought back like any other, its card once the quiet copy fails; Skip leaves it out (2026-10-16)', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: [] } }, later: { Claude: 1 } });
  const { webSignIn } = countedSignIn(fake, { slowMs: 60 });
  const { connect, state } = fakeConnect({ webSignIn, deps: { signInCheckMs: 10 } });
  let started = null;
  try {
    started = await connect.start({ sources: { chats: { on: true, apps: ['Claude'] } } });
    const first = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    assert.doesNotMatch(first.chat[0].text, /Left out Claude/);
    const now = await until(state(started.id), (s) => s.needs.some((need) => need.app === 'Claude'), 'its card');
    assert.equal(now.jobs.some((job) => job.apps.includes('Claude')), false, 'held while it waits');
    assert.deepEqual(fake.calls.openedIn, [], 'nothing opened');
    assert.ok(now.log.some((entry) => entry.text === 'Still checking the Claude sign-in'));
    const after = await connect.need(started.id, now.needs.find((need) => need.app === 'Claude').id, 'skip');
    assert.deepEqual(after.needs, []);
    assert.ok(after.leftOut.some((entry) => entry.app === 'Claude'));
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('no panel for an app no browser holds: the check opens nothing, so macOS is not promised; the Log in card still names where it opens', async () => {
  const fake = fakeSignIn({ browsers: { chrome: { apps: ['Claude'] } } }); // Chrome would open ChatGPT's sign-in page, but holds none
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  assert.deepEqual(await connect.signInNote('ChatGPT'), { browser: '', note: '', profiles: [], opens: '' }, 'no browser holds it: no panel');
  assert.equal(fake.webSignIn.keychainNote('ChatGPT'), 'macOS will ask to use Chrome\'s sign-ins. Choose Allow.', 'the Log in card\'s note keeps the opener');
  assert.deepEqual(await connect.signInCheck('ChatGPT'), { status: 'signed-out', browser: '' }, 'straight to the row\'s Sign in');
  assert.deepEqual(fake.calls.keychain, [], 'macOS was not asked');
  assert.deepEqual((await connect.signInNote('Claude')).browser, 'Chrome', 'one it holds still has its panel');
});

/**
 * Google's sign-in on a fake Mac (2026-10-12): `defaultName` the default browser; `browsers` { id: { profiles: [{ id, name,
 * email, signedIn }], deny } }; `checks` Google's check page's answers in turn (true when none is left). Fixtures only.
 */
function fakeGoogle({ defaultName = 'Safari', browsers = {}, checks = [], picks = {} } = {}) {
  const NAMES = { chrome: ['Chrome', 'chromium', 'com.google.Chrome'], brave: ['Brave', 'chromium', 'com.brave.Browser'], firefox: ['Firefox', 'firefox', 'org.mozilla.firefox'] };
  let jar = [];
  const answers = [...checks];
  const calls = { keychain: [], opened: [], openedIn: [], imports: [] };
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: browsers[id].profiles.map(({ id: pid, name, email }) => ({ id: pid, name, ...(email ? { email } : {}) })) })),
    cookieNames: (id, profileId) => (browsers[id].profiles.find((each) => each.id === profileId) || {}).signedIn ? [{ domain: 'google.com', name: 'SID', stamp: 1 }] : [],
    check: async () => (answers.length ? answers.shift() : true),
    import: async ({ browser: id, profile }) => {
      if (NAMES[id][1] === 'chromium') calls.keychain.push(id);
      if (browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
      calls.imports.push(`${id}/${profile}`);
      jar = [{ domain: '.google.com', name: 'SID', path: '/', secure: true }];
    },
  };
  const stored = { ...picks };
  const webSignIn = createWebSignIn({
    cookieImport, defaultBrowser: () => defaultName, pollMs: 1, timeoutMs: 50, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    // Safari the default, Chrome picked for the sign-ins (2026-10-16, C4: only the chosen browser is read, never a next one).
    chosen: () => ({ browser: defaultName === 'Safari' ? 'chrome' : null }),
    getSession: () => ({ cookies: { get: async ({ domain }) => jar.filter((cookie) => cookie.domain.endsWith(domain)), remove: async (url, name) => { jar = jar.filter((cookie) => cookie.name !== name); } } }),
    openExternal: async (url) => { calls.opened.push(url); }, openIn: async (id, url) => { calls.openedIn.push([id, url]); },
    picks: { get: (key) => stored[key] || null, set: (key, pick) => { stored[key] = pick; } },
  });
  // hold(): Google's sign-in made in Engelbart's own window, in its session.
  return { webSignIn, calls, stored, browsers, hold: () => { jar = [{ domain: '.google.com', name: 'SID', path: '/', secure: true }]; } };
}

test('Google\'s Sign in goes through the person\'s browser: Chrome opens with Safari the default, no time limit, every Google app signed in together', async () => {
  const fake = fakeGoogle({ browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  const win = fakeWindow('signed-in');
  const { connect, state } = fakeConnect({ webSignIn: fake.webSignIn, signInWindow: win.signInWindow });
  let started = null;
  try {
    assert.deepEqual(await connect.signInNote('Google Docs', { route: 'browser' }), { browser: 'Chrome', note: 'macOS will ask to use Chrome\'s sign-ins. Choose Allow.', profiles: [], opens: 'Chrome' }, 'the browser it opens in, and the Keychain modal first');
    const waiting = connect.signInBrowser('Google Docs');
    assert.equal(connect.signInBrowser('Gmail'), waiting, 'one wait for the one Google sign-in');
    await new Promise((resolve) => { setTimeout(resolve, 120); }); // past the 50 ms a Log in card would wait
    assert.deepEqual(fake.calls.openedIn, [['chrome', 'https://accounts.google.com/']]);
    fake.browsers.chrome.profiles[0].signedIn = true; // signed in in Chrome
    assert.deepEqual(await waiting, { status: 'signed-in', browser: 'Chrome' });
    assert.deepEqual(win.opened, [], 'never Engelbart\'s window');
    for (const app of ['Google Docs', 'Gmail', 'Google Meet', 'Gemini']) assert.deepEqual(await connect.signInCheck(app), { status: 'signed-in', browser: 'Chrome' }, app);
    started = await connect.start({ sources: { notes: { on: true, apps: ['Google Docs'] }, email: { on: true, apps: ['Gmail'] } } });
    const now = await until(state(started.id), (s) => s.chat.length > 1 && !s.thinking, 'the first turn');
    assert.deepEqual(now.jobs.filter((job) => job.kind === 'survey').map((job) => job.apps[0]).sort(), ['Gmail', 'Google Docs']);
  } finally {
    if (started) connect.stop(started.id);
  }
});

test('Google\'s Sign in waits until cancelled (the row unticked, Leave out, the choose screen gone)', async () => {
  const fake = fakeGoogle({ defaultName: 'Google Chrome', browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  const waiting = connect.signInBrowser('Gmail');
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(connect.signInBrowserCancel('Gemini'), true, 'any app sharing the sign-in ends it');
  assert.deepEqual(await waiting, { status: 'cancelled' });
  assert.deepEqual(fake.calls.opened, ['https://accounts.google.com/'], 'Chrome the default: opened as itself');
});

test('Google\'s Sign in refused by macOS: "refused" for every Google app, and no Engelbart window', async () => {
  const fake = fakeGoogle({ browsers: { chrome: { deny: true, profiles: [{ id: 'Default', name: 'Me', signedIn: true }] } } });
  const win = fakeWindow('signed-in');
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn, signInWindow: win.signInWindow });
  assert.deepEqual(await connect.signInBrowser('Gmail'), { status: 'refused', browser: 'Chrome' });
  assert.deepEqual(win.opened, []);
  assert.deepEqual(fake.calls.openedIn, [], 'nothing opened once macOS said no');
  assert.equal((await connect.signInNote('Google Docs')).note, '', 'not asked again until Try again');
});

test('Google with Safari only: no browser, nothing opened, no window', async () => {
  const fake = fakeGoogle({ browsers: {} });
  const win = fakeWindow('signed-in');
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn, signInWindow: win.signInWindow });
  assert.deepEqual(await connect.signInBrowser('Gmail'), { status: 'no-browser' });
  assert.equal((await connect.signInNote('Gmail', { route: 'browser' })).opens, '');
  assert.deepEqual(await connect.signInCheck('Gmail'), { status: 'no-browser', browser: '' });
  assert.deepEqual([win.opened, fake.calls.opened, fake.calls.openedIn], [[], [], []]);
});

test('two profiles holding Google: no question on the choose screen (one profile, chosen once in onboarding, C4); a pick made there is that one; another browser never asked about', async () => {
  const fake = fakeGoogle({ defaultName: 'Google Chrome', browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: true }, { id: 'Profile 1', name: 'Work', email: 'me@work.example', signedIn: true }] } } });
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  const note = await connect.signInNote('Gmail');
  assert.equal(note.browser, 'Chrome');
  assert.deepEqual(note.profiles, [], 'the one profile a copy reads: nothing to choose');
  assert.equal(connect.signInPick('Gmail', { browser: 'chrome', profile: 'Profile 1' }), true);
  assert.deepEqual(fake.stored, { 'google.com': { browser: 'chrome', profile: 'Profile 1' } });
  assert.deepEqual(await connect.signInCheck('Gmail'), { status: 'signed-in', browser: 'Chrome', profile: 'Work' });
  assert.deepEqual(fake.calls.imports, ['chrome/Profile 1']);
  const both = fakeGoogle({ defaultName: 'Firefox', browsers: { firefox: { profiles: [{ id: 'x.default-release', name: 'default-release', signedIn: true }] }, chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: true }] } } });
  const across = fakeConnect({ webSignIn: both.webSignIn });
  assert.deepEqual((await across.connect.signInNote('Gmail')).profiles, [], 'Chrome holding it too is never offered');
});

test('a dead Google copy at tick time: copied again from the chosen profile and good; dead there too: held elsewhere, and no other profile tried', async () => {
  const fake = fakeGoogle({ defaultName: 'Google Chrome', checks: [false, true], browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: true }, { id: 'Profile 1', name: 'Work', signedIn: true }] } } });
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn });
  assert.deepEqual(await connect.signInCheck('Gmail'), { status: 'held-elsewhere', browser: 'Chrome' }, 'Me\'s copy dead: Work is not tried (C4)');
  assert.deepEqual(fake.calls.imports, ['chrome/Default']);
  const dead = fakeGoogle({ defaultName: 'Google Chrome', checks: [false], browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: true }] } } });
  const other = fakeConnect({ webSignIn: dead.webSignIn });
  // Round 3 (2026-10-13): Chrome holds the Google sign-in and its copy is dead in Engelbart — Google's binding, not a
  // signed-out browser ("I know I am signed into Gmail in my browser"): said as such, so no Log in loop follows.
  assert.deepEqual(await other.connect.signInCheck('Gmail'), { status: 'held-elsewhere', browser: 'Chrome' });
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
  // Round 3: Notion's sign-in is checked as a web app's (when no connector reaches it); Chrome doesn't hold it here.
  assert.deepEqual(await connect.signInCheck('Notion'), { status: 'signed-out', browser: '' });
  const none = fakeConnect({ webSignIn: fakeSignIn({ browsers: {} }).webSignIn });
  assert.deepEqual(await none.connect.signInCheck('ChatGPT'), { status: 'no-browser', browser: '' });
});

test('no browser whose sign-ins can be read (Safari only): a sign-in lost mid-run gets its card, Sign in inside Engelbart, and nothing opens by itself (2026-10-16)', async () => {
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'ChatGPT'; // signed in in Engelbart's window, then its survey asks again
  const { webSignIn, calls } = fakeSignIn({ browsers: {} });
  const shown = [];
  const browser = { has: () => true, show: (jobId) => { shown.push(jobId); return true; }, hide: () => {}, close: () => {}, closeAll: () => {}, tools: () => null };
  const win = fakeWindow('signed-in');
  const { connect, state } = fakeConnect({ webSignIn, browser, signInWindow: win.signInWindow });
  let started = null;
  try {
    await connect.signInWindowOpen('ChatGPT');
    started = await connect.start({ sources: { chats: { on: true, apps: ['ChatGPT'] } } });
    const now = await until(state(started.id), (s) => s.needs.some((need) => need.app === 'ChatGPT'), 'its card');
    assert.equal(now.needs.find((need) => need.app === 'ChatGPT').where, 'here');
    assert.deepEqual([shown, calls.openedIn, win.opened], [[], [], ['ChatGPT']], 'no window of Engelbart\'s beyond the one signed in before, nothing opened');
  } finally {
    if (started) connect.stop(started.id);
    delete process.env.ENGELBART_CONNECT_FAKE_NEEDS;
  }
});

test('the priority queue: surveys first, then the recalls, three at a time (a limit of 3 here; 6 in the app), MEMORY.md after everything; a survey waits on the person', async () => {
  const order = [];
  const inner = createFakeConnectAgents({ delayMs: 30 });
  const agents = { turn: (input) => { if (input.meta && input.meta.job) order.push(`${input.meta.job.kind}:${input.meta.job.apps.join(',')}`); return inner.turn(input); } };
  process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'Claude';
  const { connect, state } = fakeConnect({ agents, deps: { maxRunning: 3 } });
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
    const chatsAsk = card.chat.find((entry) => entry.ask).ask;
    assert.deepEqual(chatsAsk.options.slice(0, 2).map((option) => [option.label, option.checked]), [['ChatGPT item 1', true], ['ChatGPT item 2', false]], 'no "Everything" beside the parts; the recommendation comes ticked');
    connect.answer(started.id, { picked: chatsAsk.options.filter((option) => option.checked).map((option) => option.label) });
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
  const { connect, state } = fakeConnect({ delayMs: 150, deps: { maxRunning: 3 } });
  let started = null;
  try {
    // three surveys take the three places (a limit of 3 here), so the recalls wait their turn
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

test('the sign-in window closed without signing in: the row, unticked, is plain Sign in when ticked again, not an old "macOS didn\'t allow it" (2026-10-12)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const label = (signIn) => model.rowLabel('ChatGPT', { found: { apps: { ChatGPT: { found: true } } }, signIn });
  const closed = (was) => label(model.afterSignInWindowClosed(was));
  assert.deepEqual(closed({ status: 'refused', browser: 'Chrome' }), { text: '', tone: '', signIn: true }, 'plain Sign in, no "macOS didn\'t allow it"');
  assert.deepEqual(closed({ status: 'rejected', browser: '' }), { text: '', tone: '', signIn: true }, 'nor an old refusal by the site');
  assert.deepEqual(closed({ status: 'signed-out', browser: '' }), { text: '', tone: '', signIn: true });
  assert.deepEqual(closed({ status: 'no-browser', browser: '' }), { text: '', tone: '', signIn: true });
  assert.equal(model.afterSignInWindowClosed(undefined), null, 'nothing before: nothing after');
  assert.deepEqual(model.afterSignInWindowClosed({ status: 'declined', browser: 'Chrome' }), { status: 'declined', browser: 'Chrome' }, 'anything else as it was');
});

test('the choose screen\'s sign-in checks: each row state, the web apps a tick starts checks for, the panel and Not now (the apps stay ticked, with Sign in)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const label = (signIn) => model.rowLabel('ChatGPT', { found: { apps: { ChatGPT: { found: true } } }, signIn });
  assert.deepEqual(label({ status: 'checking', browser: '' }), { text: 'Checking…', tone: 'busy' }, 'no Keychain modal before it: macOS is not asked');
  assert.deepEqual(model.rowLabel('ChatGPT', { found: { apps: { ChatGPT: { found: true } } }, signIn: { status: 'checking', browser: '' }, keychain: true }), { text: 'Waiting for macOS…', tone: 'busy' }, 'started by the modal\'s Continue');
  assert.deepEqual(label({ status: 'signed-in', browser: 'Chrome' }), { text: '✓ Signed in from Chrome', tone: 'ok' });
  assert.deepEqual(label({ status: 'signed-in', browser: '' }), { text: '✓ Signed in', tone: 'ok' });
  // No browser of the person's signed it in (2026-10-11): Sign in, in Engelbart's own browser, not "after you start".
  assert.deepEqual(label({ status: 'signed-out', browser: '' }), { text: '', tone: '', signIn: true });
  assert.deepEqual(label({ status: 'no-browser', browser: '' }), { text: '', tone: '', signIn: true }, 'no "Needs Chrome…": the window needs no browser');
  assert.deepEqual(label({ status: 'refused', browser: 'Chrome' }), { text: 'macOS didn\'t allow it', tone: 'error', retry: true, signIn: true }, 'Try again and Sign in');
  assert.deepEqual(label({ status: 'signing', browser: '' }), { text: 'Signing in…', tone: 'busy' });
  assert.deepEqual(label({ status: 'declined', browser: '' }), { text: '', tone: '', signIn: true }, 'Not now on the Keychain modal: Sign in, Engelbart\'s window');
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
  assert.equal(panel.lead, 'macOS will ask for your Mac password next. Choose Allow.', 'the macOS line leads');
  assert.deepEqual(panel.body, ['Engelbart copies only these apps\' sign-ins from Chrome, and only reads from them, so you don\'t log in again. Not now lets you sign in to them here instead.']);
  const claudeOff = model.tickRow(all, 'chats', 'Claude', false);
  assert.equal(model.signInPanel(claudeOff, 'Chrome', waiting.Chrome).title, 'Use your Chrome sign-ins for ChatGPT?', 'an app unticked meanwhile leaves the panel');
  assert.match(model.signInPanel(claudeOff, 'Chrome', waiting.Chrome).body[0], /this app's sign-in from Chrome.*Not now lets you sign in to it here instead\.$/);

  // After Continue, the modal says how it went (2026-10-11): waiting while macOS asks, then signed in, refused, or not there.
  const rows = waiting.Chrome;
  const outcome = (chatgpt, claude) => model.keychainOutcome('Chrome', rows, { ...(chatgpt ? { ChatGPT: { status: chatgpt } } : {}), ...(claude ? { Claude: { status: claude } } : {}) });
  assert.deepEqual(outcome('checking', 'signed-in'), { done: false, title: 'Waiting for macOS…', lines: ['Enter your Mac password in the macOS window, then choose Allow.'], tone: 'busy' });
  assert.deepEqual(outcome('signed-in', 'signed-in'), { done: true, title: 'Signed in to ChatGPT and Claude', lines: ['Brought over from Chrome. You won\'t need to log in again.'], tone: 'ok' });
  const mixed = outcome('signed-in', 'signed-out');
  assert.equal(mixed.tone, 'warn');
  assert.deepEqual(mixed.lines.slice(1), ['Chrome isn\'t signed in to Claude. Sign in on its row to sign in here.']);
  assert.deepEqual(outcome('refused', 'refused'), { done: true, title: 'Not allowed', lines: ['macOS didn\'t allow it, so ChatGPT and Claude weren\'t brought over. Try again on their rows to be asked again, or Sign in to sign in here.'], tone: 'refused' });
  assert.equal(outcome('signed-in', null).tone, 'warn', 'a check that failed and was cleared counts as not brought over, never waits forever');
  // Not now (2026-10-12): the apps stay ticked, their rows 'declined', offering Sign in in Engelbart's window, so they are
  // still to be signed in before the run (the gate), and that Sign in is the window, Google's too.
  const declined = { ChatGPT: { status: 'declined', browser: '' }, Claude: { status: 'declined', browser: '' } };
  assert.deepEqual([model.ticked(all, 'chats', 'ChatGPT'), model.ticked(all, 'chats', 'Claude')], [true, true]);
  assert.deepEqual(model.unsignedWeb(all, declined, found, true).map((row) => row.app), ['ChatGPT', 'Claude']);
  assert.equal(model.signsInViaBrowser('Gmail', { status: 'declined' }), false, 'Google\'s Sign in after Not now: the window');
  assert.equal(model.signsInViaBrowser('Gmail', { status: 'refused', browser: 'Chrome' }), false, 'after Deny on a check or at Continue: the window');
  assert.equal(model.signsInViaBrowser('Gmail', { status: 'no-browser' }), false, 'Safari only: the window');
  assert.equal(model.signsInViaBrowser('Gmail', { status: 'signed-out' }), true, 'otherwise the browser first');
  assert.equal(model.signsInViaBrowser('Gmail', null), true);
  assert.equal(model.signsInViaBrowser('ChatGPT', null), false, 'every other app: the window');

  // "Use my … subscription" off: no sign-in is checked (ticked, Try again, or a panel's Continue at start) and no panel shows.
  const ticking = model.newlyTickedWeb(start, one);
  assert.deepEqual(model.signInsToCheck(true, ticking), ticking);
  assert.deepEqual(model.signInsToCheck(false, ticking), [], 'consent off: nothing checked');
  assert.deepEqual(model.waitingWhile(true, waiting), waiting);
  assert.deepEqual(model.waitingWhile(false, waiting), {}, 'consent off: the panels go, and start has none to allow');
  assert.deepEqual(Object.keys(model.waitingWhile(false, waiting)).map((browser) => model.signInPanel(all, browser, waiting[browser])), [], 'no panel shown');
});

test('the choose screen with Google signing in in the browser and two profiles: the rows, the waiting line and the profile list', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { 'Google Docs': { found: true }, Gmail: { found: true }, ChatGPT: { found: true } }, sites: { found: false }, github: { found: false } };
  const label = (app, signIn) => model.rowLabel(app, { found, signIn });
  // Google's Sign in waits in the person's browser first, and says how long it takes, with Use another account and Sign in
  // here instead (Engelbart's window) beside it.
  assert.equal(model.signsInThroughBrowser('Gmail'), true);
  assert.equal(model.signsInThroughBrowser('ChatGPT'), false);
  assert.deepEqual(label('Gmail', { status: 'browser', browser: 'Chrome' }), { text: 'Sign in to Google in Chrome. It can take a minute to appear here.', tone: 'busy', here: true, another: true }, 'with Use another account and Sign in here instead');
  assert.deepEqual(label('ChatGPT', { status: 'browser', browser: 'Chrome' }), { text: 'Sign in to ChatGPT in Chrome. It can take a minute to appear here.', tone: 'busy', here: true }, 'Use another account on Google\'s rows only');
  assert.equal(model.waitingIn('Google', 'Brave'), 'Sign in to Google in Brave. It can take a minute to appear here.');
  assert.deepEqual([model.signInName('Google Docs'), model.signInName('Gemini'), model.signInName('Claude')], ['Google', 'Google', 'Claude']);
  // No browser to read (Safari only), macOS's Deny, Not now: Sign in, in Engelbart's window, Google's too (2026-10-12).
  assert.deepEqual(label('Gmail', { status: 'no-browser', browser: '' }), { text: '', tone: '', signIn: true }, 'Safari only: Sign in, no "Google needs…"');
  assert.deepEqual(label('Gmail', { status: 'refused', browser: 'Chrome' }), { text: 'macOS didn\'t allow it', tone: 'error', retry: true, signIn: true }, 'Try again and Sign in');
  assert.deepEqual(label('Gmail', { status: 'declined', browser: '' }), { text: '', tone: '', signIn: true });
  assert.deepEqual(label('Gmail', { status: 'signed-out', browser: '' }), { text: '', tone: '', signIn: true });
  // Google turned the window's sign-in away: Try again.
  assert.deepEqual(label('Gmail', { status: 'rejected', browser: '' }), { text: 'Google refused this sign-in', tone: 'error', retry: true });
  assert.deepEqual(label('Google Docs', { status: 'rejected', browser: '' }).text, 'Google refused this sign-in');
  // Several profiles: the row names the one the sign-in came from.
  assert.deepEqual(label('ChatGPT', { status: 'signed-in', browser: 'Chrome', profile: 'Work' }), { text: '✓ Signed in from Chrome · Work', tone: 'ok' });
  const refused = model.keychainOutcome('Chrome', [{ id: 'email', app: 'Gmail' }], { Gmail: { status: 'refused' } });
  assert.deepEqual(refused.lines, ['macOS didn\'t allow it, so Gmail wasn\'t brought over. Try again on its row to be asked again, or Sign in to sign in here.']);
  assert.deepEqual(model.keychainOutcome('Chrome', [{ id: 'email', app: 'Gmail' }], { Gmail: { status: 'signed-out' } }).lines, ['Chrome isn\'t signed in to Gmail. Sign in on its row to sign in in Chrome.']);

  // Two profiles hold the sign-in: the modal lists them (name, email), the one chosen named in its title.
  const profiles = [
    { browserId: 'chrome', browser: 'Chrome', profileId: 'Default', name: 'Me', email: 'me@example.com', keychain: true },
    { browserId: 'chrome', browser: 'Chrome', profileId: 'Profile 1', name: 'Work', email: '', keychain: true },
  ];
  const waiting = model.waitForYes({}, [{ id: 'chats', app: 'ChatGPT', browser: 'Chrome', note: 'macOS will ask', profiles, route: '' }]);
  assert.deepEqual(waiting.Chrome, [{ id: 'chats', app: 'ChatGPT', note: 'macOS will ask', profiles }]);
  const picks = model.tickRow(model.initialPicks(found), 'chats', 'ChatGPT', true);
  const panel = model.signInPanel(picks, 'Chrome', waiting.Chrome, 1);
  assert.deepEqual(panel.profiles.map((profile) => profile.name), ['Me', 'Work']);
  assert.equal(panel.chosen, 1);
  assert.equal(panel.title, 'Use your Chrome sign-ins for ChatGPT?');
  assert.match(panel.body[0], /^More than one Chrome profile is signed in\. Pick the one to use; Engelbart remembers it\. /);
  assert.equal(model.signInPanel(picks, 'Chrome', waiting.Chrome).chosen, 0, 'the first, until another is chosen');
  // Firefox has no Keychain: no macOS line when its profile is the one chosen.
  const fox = [{ ...profiles[0], browserId: 'firefox', browser: 'Firefox', profileId: 'abcd.default-release', name: 'default-release', email: '', keychain: false }, profiles[1]];
  const mixed = model.signInPanel(picks, 'Firefox', model.waitForYes({}, [{ id: 'chats', app: 'ChatGPT', browser: 'Firefox', profiles: fox }]).Firefox, 0);
  assert.equal(mixed.lead, '');
  assert.equal(mixed.title, 'Use your Firefox sign-ins for ChatGPT?');
  assert.match(mixed.body[0], /^More than one browser profile is signed in\./);
  assert.equal(model.signInPanel(picks, 'Firefox', model.waitForYes({}, [{ id: 'chats', app: 'ChatGPT', browser: 'Firefox', profiles: fox }]).Firefox, 1).lead, 'macOS will ask for your Mac password next. Choose Allow.');
  // One profile: no list.
  const single = model.waitForYes({}, [{ id: 'chats', app: 'ChatGPT', browser: 'Chrome', note: 'macOS will ask', profiles: [profiles[0]] }]);
  assert.deepEqual(model.signInPanel(picks, 'Chrome', single.Chrome).profiles, []);
});

test('Bring these in with ticked web apps not signed in: one modal, grouped by the sign-in they share; Leave them out unticks them', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { Obsidian: { found: true }, ChatGPT: { found: true, signedIn: true } }, sites: { found: false }, github: { found: false } };
  let picks = model.initialPicks(found);
  picks = model.tickRow(picks, 'notes', 'Google Docs', true);
  picks = model.tickRow(picks, 'email', 'Gmail', true);
  picks = model.tickRow(picks, 'chats', 'ChatGPT', true); // signed in in Engelbart's browser when the screen opened
  picks = model.tickRow(picks, 'chats', 'Claude', true);
  picks = model.tickRow(picks, 'notes', 'Evernote', true); // no sign-in Engelbart can make: its agent asks, as before
  const signIns = { 'Google Docs': { status: 'signed-out' }, Gmail: { status: 'no-browser' }, Claude: { status: 'signed-in', browser: 'Chrome' } };
  const unsigned = model.unsignedWeb(picks, signIns, found, true);
  assert.deepEqual(unsigned, [{ id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }]);
  const gate = model.signInGate(unsigned);
  assert.equal(gate.title, 'Google Drive and Gmail need you to sign in');
  assert.deepEqual(gate.groups, [[{ id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }]], 'one Google sign-in');
  assert.deepEqual(gate.lines, []);
  // Google's sign-in opens in the person's browser first (2026-10-12).
  assert.match(gate.body, /^Sign in opens Google's sign-in in your browser\. Leave them out to start without them\.$/);
  assert.equal(gate.canSignIn, true);
  assert.match(model.signInGate([{ id: 'chats', app: 'Perplexity' }]).body, /^Sign in opens its sign-in page in a small window here\. Leave it out/);
  // Two sign-ins: a line each.
  const two = model.signInGate([...unsigned, { id: 'chats', app: 'Perplexity' }]);
  assert.equal(two.title, 'Google Drive, Gmail and Perplexity need you to sign in');
  assert.deepEqual(two.lines, ['Google Drive and Gmail: one sign-in.', 'Perplexity.']);
  assert.match(two.body, /^Sign in opens Google's sign-in in your browser, and the others in a small window here\./);
  // No browser that can be read (Safari only), or Not now, or Deny: Google signs in in Engelbart's window (2026-10-12).
  for (const status of ['no-browser', 'declined', 'refused']) {
    const window = model.signInGate(unsigned, { 'Google Docs': { status }, Gmail: { status } });
    assert.deepEqual(window.lines, [], status);
    assert.equal(window.canSignIn, true, status);
    assert.match(window.body, /^Sign in opens its sign-in page in a small window here\. Leave them out/, status);
  }
  // Off the Mac, every sign-in is the window.
  assert.match(model.signInGate(unsigned, {}, 'win32').body, /^Sign in opens its sign-in page in a small window here\./);
  assert.match(model.signInGate([...unsigned, { id: 'chats', app: 'Perplexity' }], {}, 'linux').body, /^Sign in opens each sign-in page in a small window here\./);
  assert.equal(model.signInGate([{ id: 'chats', app: 'Perplexity' }]).title, 'Perplexity needs you to sign in');
  // Leave them out: unticked, so nothing is left to sign in, and the run starts with the rest.
  const left = unsigned.reduce((next, row) => model.tickRow(next, row.id, row.app, false), picks);
  assert.deepEqual(model.unsignedWeb(left, signIns, found, true), []);
  assert.deepEqual([model.ticked(left, 'notes', 'Google Docs'), model.ticked(left, 'email', 'Gmail'), model.ticked(left, 'chats', 'Claude'), model.ticked(left, 'notes', 'Obsidian')], [false, false, true, true]);
  // Signed in in the window: Google Drive's sign-in is Gmail's too, so nothing is left, and no modal.
  const signedIn = { ...signIns, ...Object.fromEntries(model.sharesSignIn('Google Docs').map((app) => [app, { status: 'signed-in', browser: '' }])) };
  assert.deepEqual(model.sharesSignIn('Google Docs'), ['Google Docs', 'Google Meet', 'Gmail', 'Gemini']);
  assert.deepEqual(model.unsignedWeb(picks, signedIn, found, true), []);
  assert.equal(model.signInGate([]), null, 'every ticked web app signed in: no modal');
  // Still being checked: main waits for it. The consent off: web apps are left out as before, no modal.
  assert.deepEqual(model.unsignedWeb(picks, { ...signedIn, Claude: { status: 'checking' } }, found, true), []);
  assert.deepEqual(model.unsignedWeb(picks, signIns, found, false), []);
});

test('the window\'s model, and the onboarding flow with Connect your library in place of Add to your library and Custom instructions', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { Obsidian: { found: true }, 'Claude Code': { found: true }, ChatGPT: { found: true } }, sites: { found: true }, github: { found: false } };
  const start = model.initialPicks(found);
  assert.deepEqual(start.picks, { notes: true, transcripts: false, email: false, chats: true, sites: true, papers: false, code: false, other: false });
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
  // MATH-144: an app in the cloud is never "Not found" (a web app, Zotero); one read from this Mac still is (Cursor)
  assert.deepEqual(model.rowLabel('Evernote', { found: seen }), { text: 'Needs sign-in', tone: 'muted' }, 'a web app not found, not signed in');
  assert.deepEqual(model.rowLabel('Notion', { found: seen }), { text: 'Needs sign-in', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Zotero', { found: seen }), { text: 'Needs sign-in', tone: 'muted' }, 'Zotero not connected, no ~/Zotero');
  assert.deepEqual(model.rowLabel('Zotero', { found: { apps: { Zotero: { found: true, where: '~/Zotero (sign in to read it)' } } } }), { text: '~/Zotero (sign in to read it)', tone: '' });
  assert.deepEqual(model.rowLabel('Codex', { found: seen }), { text: 'Not found', tone: 'muted' }, 'an app read from this Mac, not on it');
  assert.equal(model.foundRow(seen, 'notes', 'Evernote'), false, 'what starts ticked is unchanged: a web app not found starts unticked');
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
// MATH-110: macOS let Engelbart read every protected folder of `home` (Desktop, Documents, Downloads…), as after Continue.
// The Mac's folder access, on every platform (off the Mac nothing is protected: connect-folder-access.test.cjs).
const allowAll = (home) => folderAccess.guard({ platform: 'darwin', homeDir: home, answers: Object.fromEntries(folderAccess.protectedFolders({ platform: 'darwin', homeDir: home }).map((folder) => [folder.id, 'allowed'])) });

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
  // The HCI folder's PDFs are the newest: written in the same millisecond as Downloads' (Linux, 2026-10-18), the two
  // folders of three tied and came in the order they were walked.
  ['2310.01234v2.pdf', 'Invoice-2026-09.pdf', 'scan.pdf'].forEach((name, i) => { const at = new Date(Date.now() - 63_000 + i * 1000); fs.utimesSync(path.join(home, 'Downloads', name), at, at); });
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
  const scanned = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true } }, { homeDir: home, access: allowAll(home) });
  assert.equal(scanned.papers[LOCAL_PDFS].pdfs, 6);
  // MATH-110: macOS never asked (or Not now): nothing in Downloads or Documents is read, and the librarian is told why.
  const unasked = (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true } }, { homeDir: home, platform: 'darwin' })).papers[LOCAL_PDFS];
  assert.equal(unasked.needs, 'folder');
  assert.deepEqual(unasked.notAllowed, ['Documents', 'Downloads']);
  const narrow = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: false } }, { homeDir: home });
  assert.deepEqual(narrow.papers[LOCAL_PDFS], { reach: 'local', needs: 'folder' });
  // Picked in the folder picker: macOS lets Engelbart read it, asked about or not (MATH-110).
  const chosen = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [path.join(home, 'Documents')] } }, picked: [path.join(home, 'Documents')], permissions: { files: false } }, { homeDir: home });
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
  // Downloads' others a minute older than ~/Documents' (made just after them): Windows' file times can tie within a few ms.
  const minute = new Date(Date.now() - 60_000);
  for (const name of ['Invoice-2026-09.pdf', 'scan.pdf']) fs.utimesSync(path.join(home, 'Downloads', name), minute, minute);
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
  const scanned = await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project }, { homeDir: home, access: allowAll(home) });
  assert.equal(scanned.papers[LOCAL_PDFS].folders[0].examples[0], '2310.01234v2.pdf — Scaffolding novice debugging');
  assert.match(scanned.papers[LOCAL_PDFS].examplesFirst, /shares words with the project/);
  assert.equal('examplesFirst' in (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true } }, { homeDir: home, access: allowAll(home) })).papers[LOCAL_PDFS], false);
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
  // In the period, a day older than HCI's: two PDFs each, the folders go by their newest, and on Windows times written
  // together can tie (port, 0.1.19).
  for (const name of ['Invoice-2026-09.pdf', 'scan.pdf']) agePdf(path.join(home, 'Downloads', name), 1);
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
  const scanned = (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project: tutor, days: 365 }, { homeDir: home, access: allowAll(home) })).papers[LOCAL_PDFS];
  assert.deepEqual([scanned.pdfs, scanned.olderLeftOut, scanned.olderRelated.map((pdf) => pdf.name)], [4, 3, ['2310.01234v2.pdf']]);
  assert.match(scanned.period, /the past year/);
  const allScanned = (await scanFor({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files: true }, project: tutor }, { homeDir: home, access: allowAll(home) })).papers[LOCAL_PDFS];
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
  // MATH-146: it names what is coming in, in runningFirst's order, and counts no jobs.
  const imp = (label, status = 'running', more = {}) => ({ kind: 'import', label, status, notes: 0, items: 0, ...more });
  assert.equal(model.footLine({ jobs, needs: [] }), 'Bringing in Notes: Obsidian and AI chats');
  assert.equal(model.footLine({ jobs: [imp('Zotero papers')], needs: [] }), 'Bringing in Zotero papers');
  assert.equal(model.footLine({ jobs: [imp('AI chats', 'queued'), imp('Zotero papers'), imp('Websites', 'done')], needs: [] }), 'Bringing in Zotero papers and AI chats', 'running before queued; ended imports left out');
  assert.equal(model.footLine({ jobs: [imp('Zotero papers'), imp('AI chats'), imp('Websites', 'queued'), imp('Meeting transcripts', 'waiting')], needs: [] }), 'Bringing in Zotero papers and 3 more');
  assert.equal(model.footLine({ jobs: [imp('Bringing in your Obsidian notes')], needs: [] }), 'Bringing in your Obsidian notes', 'no "Bringing in Bringing in"');
  assert.equal(model.footLine({ jobs: [imp('', 'running', { apps: ['Google Docs'] })], needs: [] }), 'Bringing in Google Drive', 'no label: its apps, as shown');
  assert.equal(model.footLine({ jobs: [imp(undefined, 'running', { source: 'papers' })], needs: [] }), 'Bringing in Papers', 'no label nor apps: its source');
  assert.equal(model.footLine({ jobs: jobs.slice(2), needs: [] }), 'Looking through your apps');
  assert.equal(model.footLine({ jobs: [jobs[3], imp('Zotero papers', 'done'), jobs[4]], needs: [] }), 'Everything\'s in', 'MEMORY.md is not work');
  assert.equal(model.footLine({ jobs: [], needs: [] }), '');
  assert.equal(model.footLine({ jobs: [imp('Zotero papers')], needs: [{ app: 'Google Docs', kind: 'connector' }] }), 'Bringing in Zotero papers · Google Drive needs you');
  assert.equal(model.footLine({ jobs: jobs.slice(2), needs: [{ app: 'Zotero' }, { app: 'GitHub' }, { app: 'Zotero', kind: 'permission' }] }), 'Looking through your apps · Zotero and GitHub need you', 'one app, named once');
  assert.equal(model.footLine({ jobs: [jobs[3]], needs: [{ app: 'Zotero' }, { app: 'GitHub' }, { app: 'Notion' }, { app: 'Gmail', closed: true }] }), 'Everything\'s in · Zotero and 2 more need you', 'a closed step is not waiting');
  assert.equal(model.footLine({ jobs: [jobs[3]], needs: [{}] }), 'Everything\'s in · 1 step needs you');
  assert.equal(model.footLine({ jobs: [jobs[3]], needs: [{}, { app: 'Zotero' }] }), 'Everything\'s in · 2 steps need you');
  assert.equal(model.chatStatus({ thinking: true, activity: 'Reading what the surveys found', jobs }), 'Reading what the surveys found…');
  assert.equal(model.chatStatus({ waiting: true, jobs, needs: [] }), 'Looking through Overleaf…');
  assert.equal(model.chatStatus({ waiting: true, jobs: [{ ...jobs[2], status: 'waiting' }], needs: [{}] }), 'Waiting for your sign-in…');
  assert.equal(model.chatStatus({ jobs }), '', 'nothing while it waits on nothing');
  assert.equal(model.needView({ app: 'ChatGPT', kind: 'signin' }).hint, 'Opens in your browser · read-only');
});

test('MATH-111: the code source\'s github says which organizations GitHub cannot show yet, with how many of their repositories are on this Mac', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-missing-orgs-'));
  const picked = path.join(home, 'work');
  fs.mkdirSync(path.join(picked, 'study', '.git'), { recursive: true });
  const asked = [];
  const github = {
    status: () => ({ connected: true }),
    repos: async (options) => { asked.push(options); return { repos: [{ fullName: 'lab-a/tutor' }], accounts: [{ login: 'lab-a' }], missingOrgs: [{ login: 'lab-b', id: '22', repos: ['/r/b1', '/r/b2'], installUrl: 'https://github.com/apps/x/installations/new/permissions?target_id=22' }, { login: 'lab-c', id: '33', repos: [], installUrl: 'u' }] }; },
  };
  const found = await scanFor({ sources: { code: { on: true, apps: [], folders: [picked] } } }, { homeDir: home, github });
  assert.deepEqual(asked, [{ dirs: [path.join(picked, 'study')] }], 'the picked folders\' repositories count too');
  assert.deepEqual(found.code.github, { signedIn: true, repos: ['lab-a/tutor'], missingOrgs: [{ login: 'lab-b', repos: 2 }, { login: 'lab-c', repos: 0 }] });
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /has missingOrgs[\s\S]*"Add on GitHub" row in the GitHub list/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('off the Mac, a web app can be ticked, and its Sign in is Engelbart\'s window (2026-10-12)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const apps = { 'Google Docs': { found: true }, Gmail: { found: true }, ChatGPT: { found: true, signedIn: true }, Cursor: { found: true } };
  const windows = { platform: 'win32', apps, sites: { found: false }, github: { found: false } };
  assert.equal(model.notOnYet, undefined, 'no "Not on Windows yet"');
  assert.equal(model.webUnavailable, undefined);
  assert.equal(model.copiesSignIns('win32'), false);
  assert.equal(model.copiesSignIns('linux'), false);
  assert.equal(model.copiesSignIns('darwin'), true);
  assert.equal(model.copiesSignIns(undefined), true, 'none given counts as the Mac');
  assert.equal(model.rowLabel('ChatGPT', { found: windows }).text, 'signed in to Engelbart');
  assert.deepEqual(model.rowLabel('Gmail', { found: windows }), { text: 'Needs sign-in', tone: 'muted' });
  assert.deepEqual(model.rowLabel('Gmail', { found: windows, signIn: { status: 'signed-out' } }), { text: '', tone: '', signIn: true }, 'Sign in');
  // Ticked like any app: from the start when found, by a group's header and by Select all.
  const picks = model.initialPicks(windows);
  const all = model.tickAll(picks, windows);
  assert.equal(model.ticked(all, 'notes', 'Google Docs'), true, 'Google Drive ticked by Select all (Gmail never is: NEVER_TICKED)');
  assert.equal(model.foundRow(windows, 'notes', 'Google Docs'), true);
  const gmail = model.tickRow(picks, 'email', 'Gmail', true);
  assert.equal(model.ticked(gmail, 'email', 'Gmail'), true, 'its own row ticks it');
  assert.deepEqual(model.unsignedWeb(gmail, { Gmail: { status: 'signed-out' } }, windows).map((row) => row.app), ['Gmail'], 'asked for before the run');
  // Sign in: Engelbart's window, Google's too, never the browser.
  for (const status of [undefined, 'signed-out']) assert.equal(model.signsInViaBrowser('Gmail', status ? { status } : null, 'win32'), false);
  assert.equal(model.signsInViaBrowser('Gmail', null, 'darwin'), true, 'on the Mac, Google\'s first Sign in is the browser');
});

test('Continue on Google\'s Sign in asks macOS before anything opens: refused, nothing opens and the browser is not asked again', async () => {
  const calls = [];
  const webSignIn = {
    supports: () => true,
    unlock: async (app, { denied }) => {
      calls.push(['unlock', app]);
      denied.add('chrome'); // as webSignIn.unlock does on a refusal
      return { status: 'denied', browser: 'Chrome', browserId: 'chrome' };
    },
    signIn: async (app, { denied }) => { calls.push(['signIn', app, [...denied]]); return { status: 'cancelled' }; },
    anotherAccount: async (app) => { calls.push(['another', app]); return { opened: true, browser: 'Chrome' }; },
  };
  const { connect } = fakeConnect({ webSignIn });
  assert.deepEqual(await connect.signInUnlock('Gmail'), { status: 'refused', browser: 'Chrome' });
  assert.deepEqual(calls, [['unlock', 'Gmail']], 'nothing opened');
  assert.deepEqual(await connect.signInAnotherAccount('Gmail'), { opened: false, browser: '' }, 'nothing waited on: nothing to open');
  // A wait started later is told Chrome was refused, so the copy never asks again this run; Use another account reaches it.
  const waiting = connect.signInBrowser('Gmail');
  assert.deepEqual(await connect.signInAnotherAccount('Google Meet'), { opened: true, browser: 'Chrome' });
  await waiting;
  assert.deepEqual(calls.slice(1), [['signIn', 'Gmail', ['chrome']], ['another', 'Google Meet']]);
});

test('Sign in here instead: Engelbart\'s window signs Google in, ends the browser wait, and nothing is copied from Chrome after', async () => {
  const fake = fakeGoogle({ browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  const win = fakeWindow('signed-in');
  const open = win.signInWindow.open;
  win.signInWindow.open = async (app) => { fake.hold(); return open(app); }; // signed in there: the window closes once it is held
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn, signInWindow: win.signInWindow });
  const waiting = connect.signInBrowser('Google Docs');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.deepEqual(await connect.signInWindowOpen('Gmail'), { status: 'signed-in' });
  assert.deepEqual(win.opened, ['Gmail'], 'Google in Engelbart\'s window');
  assert.deepEqual(await waiting, { status: 'cancelled' }, 'the browser wait is over');
  assert.equal(fake.webSignIn.isHere('Google Docs'), true, 'one Google sign-in');
  fake.browsers.chrome.profiles[0].signedIn = true; // Chrome signed in later: never read for Google again this run
  const before = fake.calls.keychain.length;
  for (const app of ['Google Docs', 'Gmail', 'Gemini']) assert.equal((await connect.signInCheck(app)).status, 'signed-in', app);
  assert.equal(fake.calls.keychain.length, before, 'macOS not asked about Chrome');
});

test('Google refuses Engelbart\'s window: rejected, and nothing marked signed in', async () => {
  const fake = fakeGoogle({ browsers: {} });
  const win = fakeWindow('rejected');
  const { connect } = fakeConnect({ webSignIn: fake.webSignIn, signInWindow: win.signInWindow });
  assert.deepEqual(await connect.signInWindowOpen('Gmail'), { status: 'rejected' });
  assert.equal(fake.webSignIn.isHere('Gmail'), false);
  assert.notEqual((await connect.signInCheck('Gmail')).status, 'signed-in');
});

test('off the Mac (no importer): Sign in opens Engelbart\'s window, and its check reads Engelbart\'s session', async () => {
  const jar = [];
  const webSignIn = createWebSignIn({ cookieImport: null, getSession: () => ({ cookies: { get: async ({ domain }) => jar.filter((cookie) => cookie.domain.endsWith(domain)) } }), openExternal: async () => {}, pollMs: 1, timeoutMs: 50, sleep: () => new Promise((resolve) => setImmediate(resolve)) });
  const win = fakeWindow('signed-in');
  const { connect } = fakeConnect({ webSignIn, signInWindow: win.signInWindow });
  assert.equal((await connect.signInCheck('ChatGPT')).status, 'signed-out', 'checked, not given up on');
  jar.push({ domain: '.chatgpt.com', name: '__Secure-next-auth.session-token' });
  assert.equal((await connect.signInCheck('ChatGPT')).status, 'signed-in');
  assert.deepEqual(await connect.signInWindowOpen('Google Docs'), { status: 'signed-in' });
  assert.deepEqual(win.opened, ['Google Docs'], 'Google too');
});

test('test mode\'s reset forgets a data root\'s runs and the sign-in answers kept in memory (2026-10-15)', async () => {
  const { connect, state } = fakeConnect({ delayMs: 200 });
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] } } });
  await until(state(started.id), (s) => s.chat.length > 0, 'the run');
  assert.ok(connect.list(ctx.dataRoot).some((one) => one.id === started.id));
  connect.forget(ctx.dataRoot);
  assert.equal(connect.list(ctx.dataRoot).some((one) => one.id === started.id), false, 'its runs are gone from the list');
  assert.equal(connect.has(started.id), false);
});
