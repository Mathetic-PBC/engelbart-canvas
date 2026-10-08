'use strict';

// Connect your library (src/main/connect, 2026-10-07; experimental, test mode only): what is read on this Mac, how a
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
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const readers = require('../src/main/connect/readers.cjs');
const notes = require('../src/main/connect/notes.cjs');
const { createImportTools, validateImportTool, chatNote, toolsFor, googleMarkdown, csvTable, IMPORT_TOOLS } = require('../src/main/connect/tools.cjs');
const { createConnect, readReply, readSurvey, cleanChoices, connectChoice } = require('../src/main/connect/session.cjs');
const { createFakeConnectAgents } = require('../src/main/connect/fake.cjs');
const { detect } = require('../src/main/connect/scan.cjs');
const { importToolLabel, writeImportConfig, claudeServers, claudeToolsFor } = require('../src/main/connect/agents.cjs');
const { hostAllowed, hostsFor, fileNameOf } = require('../src/main/connect/browser.cjs');
const { listWebChats, readWebChat } = require('../src/main/connect/web-chats.cjs');
const { createAppleNotes, noteMarkdown } = require('../src/main/connect/apple-notes.cjs');
const { cursorChats, cursorTranscript } = require('../src/main/connect/cursor.cjs');
const { createConnectors } = require('../src/main/connect/connectors.cjs');
const memory = require('../src/main/connect/memory.cjs');
const { SKILLS, skillOf, skillsFor } = require('../src/main/connect/skills.cjs');
const prompts = require('../src/main/connect/prompts.cjs');
const { APPS } = require('../src/shared/connect-sources.cjs');
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
  const found = detect({ homeDir, applications: [apps], signedIn: ['ChatGPT'] }).apps;
  assert.equal(found.Obsidian.found, true);
  assert.equal(found['Claude Code'].found, false);
  assert.deepEqual([found.Granola.found, found.Granola.where], [true, 'on this Mac']);
  assert.deepEqual([found.ChatGPT.found, found.ChatGPT.where], [true, 'signed in in Engelbart']);
  assert.equal(found.Claude.found, false);
  assert.equal(found['Apple Notes'].found, false, 'macOS asks before Notes is read: never ticked by itself');
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
  assert.match(first.where, /held until/);
  assert.equal(notes.stagedNotes(dir).length, 2);
  assert.equal(notes.stagedCount(dir), 2);
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

  // The project made: the staged notes go in, named by their files, and later notes go straight there.
  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'Imported' });
  const flushed = await notes.flushStaged(ctx, dir, project.id, { projects });
  assert.deepEqual(flushed.map((note) => note.name).sort(), ['Idea', 'Other note', 'Why do novices skip tests?']);
  assert.equal(notes.stagedNotes(dir).length, 0);
  projectId = project.id;
  await call('add_note', { title: 'Meeting with Ana', markdown: 'We agreed on twenty participants.', source: 'granola:1' });
  assert.equal((await call('add_note', { title: 'Meeting with Ana', markdown: 'again', source: 'granola:1' })).added, false);
  const rows = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name).sort();
  assert.deepEqual(rows, ['Idea', 'Meeting with Ana', 'Other note', 'Welcome!', 'Why do novices skip tests?']);
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
  assert.deepEqual(reply.ask, { source: 'notes', kind: 'multi', title: 'Which folders?', options: [{ label: 'Research', why: '' }, { label: 'Essays', why: '12 notes' }], placeholder: '' });
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

test('a session with the fake agents: a folder button, a question card, imports in the background, Import, MEMORY.md without its secrets, and the notes into the project', async () => {
  const fresh = fs.mkdtempSync(path.join(homeDir, 'fresh-')); // a home with no Obsidian: the vault comes from the button
  const { connect, snapshots, state } = fakeConnect({ home: fresh });
  await assert.rejects(connect.start({ sources: {} }), /Pick at least one source/);
  const started = await connect.start({ sources: { notes: { on: true, apps: ['Obsidian'] }, sites: { on: true } }, provider: 'openai' });
  assert.deepEqual(started.choice, { provider: 'openai', name: 'Codex', modelName: 'Sol', effort: 'high' }, 'only the provider was chosen; its model is pinned');
  let now = await until(state(started.id), (s) => !s.thinking && s.chat.length, 'the first turn');
  assert.deepEqual(now.chat[0].authorize, { source: 'notes', app: 'Obsidian', kind: 'folder', label: 'Choose your Obsidian folder…' });
  // A folder outside the home folder is refused; the vault copied into it is taken.
  await assert.rejects(connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: vault }), /inside your home folder/);
  fs.cpSync(vault, path.join(fresh, 'Vault'), { recursive: true });
  await connect.authorize(started.id, { app: 'Obsidian', kind: 'folder', path: '~/Vault' });
  now = await until(state(started.id), (s) => !s.thinking && s.chat.some((entry) => entry.ask), 'the notes question');
  assert.deepEqual(now.chat.map((entry) => entry.role), ['agent', 'user', 'agent']);
  assert.deepEqual(now.chat[2].ask.options[0], { label: 'Everything', why: 'all of it' });
  assert.throws(() => connect.answer(started.id, {}), /Say something first/);
  connect.answer(started.id, { picked: ['Everything'], text: 'but not Personal' });
  assert.equal(connect.state(started.id).chat[3].text, 'Everything — but not Personal');
  now = await until(state(started.id), (s) => s.jobs.some((job) => job.kind === 'import' && job.status === 'done'), 'the notes import');
  assert.equal(now.jobs[0].notes, 5, 'the fake brings in five of the vault\'s notes');
  assert.equal(now.staged, 5);
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

  const { project } = await projects.createProjectWithWelcome(ctx, { name: 'From connect' });
  assert.equal(await connect.attachProject(ctx, started.id, project.id), 5);
  assert.equal(connect.state(started.id).staged, 0);
  const names = (await ctx.libraryDb.list()).filter((row) => row.project_id === project.id && row.tags.includes('note')).map((row) => row.name);
  assert.equal(names.length, 6, 'Welcome! and the five notes');
  connect.dismiss(started.id);
  assert.equal(connect.list(ctx.dataRoot).some((s) => s.id === started.id), false);
  fs.rmSync(memory.memoryPath(ctx.dataRoot));
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

test('an existing user\'s session puts notes straight into their project; Stop ends every agent and MEMORY.md is not written', async () => {
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

test('the window\'s model, and the onboarding flow with Connect your library in place of Add to your library and Custom instructions', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const found = { apps: { Obsidian: { found: true }, 'Claude Code': { found: true }, ChatGPT: { found: true } }, sites: { found: true }, github: { found: false } };
  const start = model.initialPicks(found);
  assert.deepEqual(start.picks, { notes: true, transcripts: false, chats: true, sites: true, papers: false, code: false });
  assert.deepEqual(start.open, { notes: true });
  assert.equal(model.subOf('notes', { on: true, apps: start.apps }), '1 of 6');
  assert.equal(model.subOf('code', { on: true, apps: {}, repos: ['a/b'], folders: ['/x', '/y'] }), '1 repo · 2 folders');
  assert.deepEqual(model.permissionsFor(model.pickedApps(start.picks, start.apps)), { web: ['ChatGPT'], recall: ['ChatGPT'], connectors: [], notes: false });
  assert.deepEqual(model.permissionsFor(['Granola', 'Apple Notes', 'Claude']), { web: ['Claude'], recall: ['Claude'], connectors: ['Granola'], notes: true });
  const sent = model.choicesOf({ picks: start.picks, apps: start.apps, folders: { papers: ['/p'] }, repos: ['a/b'], custom: ' skip drafts ', permissions: { files: false, recall: false }, provider: 'openai', projectId: 'p1' });
  assert.deepEqual(sent.sources.notes, { on: true, apps: ['Obsidian'], folders: [], repos: [] });
  assert.deepEqual(sent.permissions, { files: false, browser: true, recall: false, notes: false });
  assert.deepEqual([sent.computer, sent.provider, sent.projectId, sent.custom], [false, 'openai', 'p1', 'skip drafts']);
  assert.equal(model.statusOf({ status: 'done', notes: 3, items: 2 }).text, '✓ 5 added');
  assert.deepEqual(model.statusOf({ status: 'waiting', notes: 0, items: 0 }), { text: 'needs you', done: false, waiting: true });
  assert.equal(model.statusOf({ kind: 'survey', status: 'running' }).text, 'looking…');
  assert.equal(model.statusOf({ kind: 'recall', status: 'done' }).text, '✓ remembered');
  assert.equal(model.allEnded([{ status: 'done' }, { status: 'queued' }]), false);
  assert.equal(model.needView({ app: 'ChatGPT', kind: 'signin' }).action, 'Open the sign-in window');
  assert.equal(model.needView({ app: 'Granola', kind: 'connector' }).action, 'Sign in to Granola');
  assert.equal(model.memoryLine({ status: 'saved', removed: 2 }).text, 'Saved · 2 secrets masked');
  assert.deepEqual(model.dockLine({ needs: [{ app: 'ChatGPT', kind: 'signin' }], jobs: [] }), { tone: 'warn', short: 'Needs you', text: 'ChatGPT needs you to sign in' });
  assert.deepEqual(model.dockLine({ needs: [], done: true, jobs: [{ status: 'running', notes: 0, items: 0 }, { status: 'done', notes: 1, items: 0 }], memory: { status: 'waiting' } }), { tone: 'busy', short: 'Importing 1/2', text: 'Importing · 1 of 2 done' });
  assert.deepEqual(model.dockLine({ needs: [], done: true, jobs: [{ status: 'done', notes: 4, items: 1 }], memory: { status: 'saved' }, counts: { notes: 4, items: 1 } }), { tone: 'done', short: 'Library', text: 'Library connected · 5 added · MEMORY.md saved' });

  const flow = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/onboarding.js')).href);
  // "replace steps 3 and 4 with this, since it will essentially be the same"
  assert.deepEqual(flow.flowOf('new', { connect: true }), ['welcome', 'tools', 'connect', 'create', 'context']);
  assert.deepEqual(flow.flowOf('new', { connect: true, tools: false }), ['welcome', 'connect', 'create', 'context']);
  assert.deepEqual(flow.flowOf('new'), ['welcome', 'tools', 'import', 'instructions', 'create', 'context'], 'outside test mode: as before');
  assert.deepEqual(flow.forward('new', { step: 'tools', sub: 0 }, { connect: true }), { step: 'connect', sub: 0 });
  assert.deepEqual(flow.forward('new', { step: 'connect', sub: 0 }, { connect: true }), { step: 'create', sub: 0 });
  assert.deepEqual(flow.pagerOf('new', 'connect', { connect: true }), { count: 5, index: 2 });
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
