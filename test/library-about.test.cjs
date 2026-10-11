'use strict';

// What each library row knows about itself (2026-10-11, the Library's Phase B): its source, category, date, origin,
// place, turns and length, recorded by the import that brings it in (connect/tools.cjs), told from an older row's file
// once (library.describeRows), and a row still named by its file renamed by what the file says. A note written here can
// only go to the trash; an import made in a project can be removed from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const { createImportTools } = require('../src/main/connect/tools.cjs');
const { pdfTitle } = require('../src/main/context/pdf-kind.cjs');
const { ITEM_SOURCES } = require('../src/shared/connect-sources.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-about-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

const write = (rel, text) => { const file = path.join(homeDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const ABOUT = ['source', 'category', 'item_date', 'origin_url', 'place', 'messages', 'minutes'];
const about = (row) => Object.fromEntries(ABOUT.map((key) => [key, row[key]]));
const none = Object.fromEntries(ABOUT.map((key) => [key, null]));

// A pdf pdf.js can read back: one page of lines, and an Info dictionary when given (as test/pdf-kind.test.cjs makes one).
function makePdf(lines, info = null) {
  const escape = (text) => text.replace(/([\\()])/g, '\\$1');
  const content = `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${lines.map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  if (info) objects.push(`<< ${Object.entries(info).map(([key, value]) => `/${key} (${escape(value)})`).join(' ')} >>`);
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info ? ` /Info ${objects.length} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('the migration adds the columns and keeps every row and every value it had', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-about-migrate-'));
  const opened = await db.openLibraryDb(root);
  const rows = [
    await opened.insert({ id: randomUUID(), name: 'A paper', type: 'pdf', tags: ['paper'], path: '/x/a.pdf', url: 'https://arxiv.org/abs/2401.00001', categorized: 1 }),
    await opened.insert({ id: randomUUID(), name: 'repo', type: 'folder', tags: ['git'], folder_path: '/x/repo', url: 'https://github.com/o/r', github_id: '42', categorized: 1 }),
    await opened.insert({ id: randomUUID(), name: 'Mine', type: 'md', tags: ['note'], path: '/x/Mine.md', project_id: randomUUID() }),
  ];
  await opened.setSummary(rows[0].id, 'What it says', new Date('2026-01-02T03:04:05Z'));
  await opened.setCharCount(rows[2].id, 1234);
  await db.closeDb(path.join(root, 'library.pglite'));
  // The library as it was before Phase B: none of the new columns.
  const raw = new PGlite(path.join(root, 'library.pglite'));
  await raw.waitReady;
  await raw.exec(['source', 'category', 'item_date', 'origin_url', 'place', 'messages', 'minutes', 'titled'].map((column) => `alter table library drop column ${column};`).join('\n'));
  const before = (await raw.query('select * from library order by name')).rows;
  await raw.close();
  assert.equal(before.length, 3);
  assert.ok(!('source' in before[0]));

  const again = await db.openLibraryDb(root);
  const after = await again.list();
  assert.equal(after.length, 3);
  for (const old of before) {
    const now = after.find((row) => row.id === old.id);
    for (const [key, value] of Object.entries(old)) assert.deepEqual(now[key], value instanceof Date ? value.toISOString() : value, `${old.name}: ${key} kept`);
    assert.deepEqual(about(now), none, `${old.name}: the new columns start empty`);
    assert.equal(now.titled, null);
  }
  await db.closeDb(path.join(root, 'library.pglite'));
});

test('a source is one of connect-sources\' apps or engelbart, mac, web, github; anything else is refused', async () => {
  for (const source of ['Zotero', 'Claude', 'PDFs on this Mac', 'Google Docs', 'engelbart', 'mac', 'web', 'github']) assert.ok(ITEM_SOURCES.includes(source), source);
  assert.ok(!ITEM_SOURCES.includes('GitHub'), 'a repository is github, not the app GitHub');
  const insert = (fields) => ctx.libraryDb.insert({ id: randomUUID(), name: 'x', type: 'website', url: `https://example.org/${randomUUID()}`, ...fields });
  await assert.rejects(insert({ source: 'Dropbox' }), /Unknown library source: Dropbox \(one of Obsidian, .*engelbart, mac, web, github\)/);
  await assert.rejects(insert({ source: 'GitHub' }), /Unknown library source: GitHub/);
  await assert.rejects(insert({ category: 'kind' }), /Unknown library category: kind/);
  await assert.rejects(insert({ item_date: '2026-13-01' }), /YYYY or YYYY-MM-DD/);
  await assert.rejects(insert({ origin_url: 'javascript:alert(1)' }), /http\(s\)/);
  await assert.rejects(insert({ messages: -1 }), /non-negative integer/);
  const row = await insert({ source: null, category: null, item_date: '2025' });
  assert.deepEqual([row.source, row.item_date], [null, '2025']);
  // The same check holds where an older row is told about itself.
  await assert.rejects(ctx.libraryDb.fillAbout(row.id, { source: 'Somewhere' }), /Unknown library source/);
});

test('adds from the app say where they came from: a path is mac, an address web, a repository github, a note written here engelbart', async () => {
  const file = write('Docs/plan.md', 'plain\n');
  const md = await library.addItem(ctx, file);
  assert.deepEqual([md.source, md.category], ['mac', null]);
  const page = await library.addItem(ctx, 'https://example.org/about-page');
  assert.deepEqual([page.source, page.category], ['web', null]);
  const repo = await library.addItem(ctx, 'https://github.com/someone/tool');
  assert.deepEqual([repo.source, repo.category], ['github', 'repo']);
  const project = await projects.createProject(ctx, 'About notes');
  const note = await ctx.libraryDb.get((await projects.createNote(ctx, project.id, { name: 'Written here', text: 'x' })).id);
  assert.deepEqual([note.source, note.category], ['engelbart', 'note']);
});

test('an import records what it knows: a chat\'s app, date, project and turns; a Gmail thread\'s messages and last day; a Zotero item\'s collection and year', async () => {
  // A Claude Code session, last written on 2026-10-01.
  const lines = (events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const session = write('.claude/projects/-Users-me-thesis/11111111-1111-4111-8111-111111111111.jsonl', lines([
    { type: 'user', entrypoint: 'cli', cwd: path.join(homeDir, 'thesis'), message: { role: 'user', content: 'Why do novices skip tests?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Mostly time pressure.' }] } },
    { type: 'user', message: { role: 'user', content: 'And then?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Habit.' }] } },
  ]));
  const day = new Date(2026, 9, 1, 12, 0, 0);
  fs.utimesSync(session, day, day);
  // A Zotero mirror with one item in the Transfer collection, known by its DOI.
  const zoteroRoot = path.join(homeDir, 'zotero-mirror');
  fs.mkdirSync(zoteroRoot, { recursive: true });
  fs.writeFileSync(path.join(zoteroRoot, 'collections.json'), JSON.stringify([{ key: 'COLL0001', name: 'Transfer', path: 'Transfer' }]));
  fs.writeFileSync(path.join(zoteroRoot, 'items.json'), JSON.stringify([{ key: 'ITEM0001', title: 'Near and far transfer', year: '2019', date: '2019', doi: '10.1000/transfer.2019', collections: ['COLL0001'], attachments: [] }]));
  // A Gmail print view of two messages.
  const html = `<html><head><title>Gmail - Pilot</title></head><body>
<table class="message"><tr><td><b>Dr. Lee</b> &lt;lee@uni.edu&gt;</td><td align=right>Mon, Mar 2, 2026 at 9:10 AM</td></tr><tr><td>Hi Sam</td></tr></table>
<table class="message"><tr><td><b>Sam</b> &lt;sam@uni.edu&gt;</td><td align=right>Tue, Mar 3, 2026 at 4:45 PM</td></tr><tr><td>Thanks</td></tr></table></body></html>`;
  const page = {
    download: async (url, dir, options) => { fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, options.name); fs.writeFileSync(file, html); return { path: file, type: 'text/html', url }; },
  };
  const tools = (apps, group) => createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', `about-${group}`), projectId: () => null, exports: {}, folders: {}, apps, group, gmailThreads: 0 }, context: async () => ctx, env: {}, page, zotero: { root: () => zoteroRoot } });

  assert.equal((await tools(['Claude Code'], 'chats')('import_chats', { app: 'Claude Code', ids: ['-Users-me-thesis/11111111-1111-4111-8111-111111111111'] })).added, 1);
  const chat = (await ctx.libraryDb.list()).find((row) => row.name === 'Why do novices skip tests?');
  assert.deepEqual(about(chat), { ...none, source: 'Claude Code', category: 'chat', item_date: new Date(day).toISOString().slice(0, 10), place: '~/thesis', messages: 4 });
  assert.equal(chat.titled, library.TITLE_RULES, 'named by its app: the title rules leave it');

  const gmailRun = await tools(['Gmail'], 'email')('import_gmail_threads', { n: 0, ik: 'cd6f0fe68b', threads: [{ id: 'thread-f:1840000000000001', subject: 'Pilot protocol' }] });
  assert.equal(gmailRun.added, 1, JSON.stringify(gmailRun));
  const mail = (await ctx.libraryDb.list()).find((row) => row.name === 'Pilot protocol');
  assert.deepEqual(about(mail), { ...none, source: 'Gmail', category: 'email', item_date: '2026-03-03', messages: 2 });

  const zotero = await tools(['Zotero'], 'papers')('import_zotero_items', { keys: ['ITEM0001'] });
  assert.equal(zotero.added, 1, JSON.stringify(zotero));
  const item = (await ctx.libraryDb.list()).find((row) => row.name === 'Near and far transfer');
  assert.deepEqual(about(item), { ...none, source: 'Zotero', category: 'paper', item_date: '2019', place: 'Transfer' });
  assert.equal(item.url, 'https://doi.org/10.1000/transfer.2019', 'the address it is known by stays in url');

  // A note file read from a chosen Obsidian folder: its app from the folder, its place the vault and the folder in it.
  const vault = path.join(homeDir, 'Vault');
  const idea = write('Vault/Research/Ideas.md', 'An idea.\n');
  const obsidian = createImportTools({ session: { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'about-notes'), projectId: () => null, exports: {}, folders: { Obsidian: vault }, apps: ['Obsidian', 'Notion'], group: 'notes' }, context: async () => ctx, env: {} });
  await obsidian('import_note_files', { files: [idea] });
  const note = (await ctx.libraryDb.list()).find((row) => row.name === 'Ideas');
  assert.deepEqual([note.source, note.category, note.place], ['Obsidian', 'note', 'Vault/Research']);
});

test('the backfill reads each import\'s head line once: a chat with a project, Gmail, Google Drive, Overleaf; other rows by what they are', async () => {
  const assets = path.join(ctx.dataRoot, 'assets');
  const keep = async (name, text, extra = {}) => {
    const id = randomUUID();
    const dir = path.join(assets, 'md', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, text);
    return ctx.libraryDb.insert({ id, name, type: 'md', tags: [], path: file, ...extra });
  };
  const chat = await keep('Old chat', '*Claude · 2025-10-06 · Transfer study*\n\n**You:** Q one\n\n**Claude:** A one\n\n**You:** Q two\n\n**Claude:** A two\n');
  const bare = await keep('Old ChatGPT', '*ChatGPT · 2025-09-01*\n\n**You:** Hi\n\n**ChatGPT:** Hello\n');
  const mail = await keep('Old thread', '*Gmail · Mon, Mar 2, 2026 at 9:10 AM–Tue, Mar 3, 2026 at 4:45 PM · Dr. Lee, Sam*\n\n**Dr. Lee**, Mon\n\nHi\n');
  const drive = await keep('Old doc', '*Google Drive · https://drive.google.com/open?id=abcdefghijk*\n\nBody\n');
  const overleaf = await keep('Old tex', '*Overleaf · https://www.overleaf.com/project/0123456789abcdef01234567*\n\n```latex\n\\begin{document}\n```\n');
  const other = await keep('Old notion', '*Notion · 2025-01-01*\n\nNot an app whose head line is read\n');
  const pdfDir = path.join(assets, 'pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });
  const savedId = randomUUID();
  fs.writeFileSync(path.join(pdfDir, `${savedId}.pdf`), makePdf(['Saved']));
  const saved = await ctx.libraryDb.insert({ id: savedId, name: 'Saved paper', type: 'pdf', tags: [], path: path.join(pdfDir, `${savedId}.pdf`), url: 'https://example.org/saved.pdf', categorized: 1 });
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'org/tool', type: 'website', tags: ['git'], url: 'https://github.com/org/tool' });
  const onMac = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Given name', type: 'csv', tags: [], path: write('Data/runs.csv', 'a,b\n') });
  const project = await projects.createProject(ctx, 'Backfill');
  const notesDir = path.join(project.dir);
  const own = await ctx.libraryDb.insert({ id: randomUUID(), name: 'My note', type: 'md', tags: ['note'], path: path.join(notesDir, 'My note.md'), project_id: project.id });
  fs.writeFileSync(own.path, 'mine\n');
  const edited = (await ctx.libraryDb.get(chat.id)).last_edited;

  await library.describeRows(ctx, {});
  const now = async (row) => about(await ctx.libraryDb.get(row.id));
  assert.deepEqual(await now(chat), { ...none, source: 'Claude', category: 'chat', item_date: '2025-10-06', place: 'Transfer study', messages: 4 });
  assert.deepEqual(await now(bare), { ...none, source: 'ChatGPT', category: 'chat', item_date: '2025-09-01', messages: 2 });
  assert.deepEqual(await now(mail), { ...none, source: 'Gmail', category: 'email', item_date: '2026-03-03' });
  assert.deepEqual(await now(drive), { ...none, source: 'Google Docs', category: 'note', origin_url: 'https://drive.google.com/open?id=abcdefghijk' });
  assert.deepEqual(await now(overleaf), { ...none, source: 'Overleaf', category: 'paper', origin_url: 'https://www.overleaf.com/project/0123456789abcdef01234567' });
  assert.deepEqual(await now(other), none, 'Notion is no chat app: unknown');
  assert.equal((await now(saved)).source, 'web');
  assert.deepEqual([(await now(repo)).source, (await now(repo)).category], ['github', 'repo']);
  assert.equal((await now(onMac)).source, 'mac');
  assert.deepEqual([(await now(own)).source, (await now(own)).category], ['engelbart', 'note']);
  const after = await ctx.libraryDb.get(chat.id);
  assert.deepEqual([after.name, after.last_edited, after.titled], ['Old chat', edited, library.TITLE_RULES], 'its name kept, not an edit, done once');
  // Once: a second pass finds nothing due, and a value recorded at import is never overwritten.
  await ctx.libraryDb.fillAbout(chat.id, { source: 'ChatGPT', place: 'Elsewhere' });
  assert.deepEqual([(await ctx.libraryDb.get(chat.id)).source, (await ctx.libraryDb.get(chat.id)).place], ['Claude', 'Transfer study']);
  assert.ok(!(await ctx.libraryDb.untitled(library.TITLE_RULES)).some((row) => row.id === chat.id));
});

test('the retitle pass renames only a row still named by its file: a pdf by its Title or first line, an md by its first # heading', async () => {
  const pdfWithTitle = write('Papers/smith2020.pdf', '');
  fs.writeFileSync(pdfWithTitle, makePdf(['Some first line'], { Title: 'Learning to Learn' }));
  const pdfFirstLine = write('Papers/scan_0042.pdf', '');
  fs.writeFileSync(pdfFirstLine, makePdf(['A Study of Transfer', 'Ana Author']));
  const pdfWordTitle = write('Papers/draft3.pdf', '');
  fs.writeFileSync(pdfWordTitle, makePdf(['Real Heading Here'], { Title: 'Microsoft Word - draft3.docx' }));
  const given = write('Papers/given.pdf', '');
  fs.writeFileSync(given, makePdf(['Ignored'], { Title: 'Ignored too' }));
  assert.equal(await pdfTitle(pdfWithTitle), 'Learning to Learn');
  assert.equal(await pdfTitle(pdfFirstLine), 'A Study of Transfer');
  assert.equal(await pdfTitle(pdfWordTitle), 'Real Heading Here', 'a Title that only names its file is no title');

  const add = (file, name = null) => library.addItem(ctx, file, name ? { name } : {});
  const a = await add(pdfWithTitle);
  const b = await add(pdfFirstLine);
  const c = await add(pdfWordTitle);
  const d = await add(given, 'The name I gave');
  const md = await add(write('Docs/meeting-notes.md', '---\ntags: x\n---\n\n```\n# not this\n```\n# Kickoff with Ana\n\nText\n'));
  const mdNone = await add(write('Docs/scratch.md', 'no heading here\n'));
  const mdGiven = await add(write('Docs/other.md', '# Its heading\n'), 'Kept as I named it');
  const gone = await add(write('Docs/gone.md', '# Gone\n'));
  fs.rmSync(gone.path);
  const project = await projects.createProject(ctx, 'Retitle');
  const noteId = (await projects.createNote(ctx, project.id, { name: 'note-stem', text: '# A heading in a note\n' })).id;
  const before = await ctx.libraryDb.get(a.id);
  assert.equal(before.name, 'smith2020');

  // A pdf with nobody here to read it stays due, as recategorize leaves one.
  const unread = await library.describeRows(ctx, {});
  assert.ok(unread.due >= 3);
  assert.equal((await ctx.libraryDb.get(a.id)).name, 'smith2020');

  const report = await library.describeRows(ctx, { pdfTitle });
  const name = async (row) => (await ctx.libraryDb.get(typeof row === 'string' ? row : row.id)).name;
  assert.equal(await name(a), 'Learning to Learn');
  assert.equal(await name(b), 'A Study of Transfer');
  assert.equal(await name(c), 'Real Heading Here');
  assert.equal(await name(d), 'The name I gave', 'a name someone gave is kept');
  assert.equal(await name(md), 'Kickoff with Ana', 'the first # heading outside a code block');
  assert.equal(await name(mdNone), 'scratch.md', 'no heading: kept');
  assert.equal(await name(mdGiven), 'Kept as I named it');
  assert.equal(await name(noteId), 'note-stem', 'a note written here is named by its file, renamed with it');
  assert.ok(report.renamed.some((entry) => entry.id === a.id && entry.from === 'smith2020' && entry.to === 'Learning to Learn'));
  const after = await ctx.libraryDb.get(a.id);
  assert.deepEqual([after.last_edited, after.summary, after.titled], [before.last_edited, before.summary, library.TITLE_RULES], 'only name and titled written');
  assert.equal((await ctx.libraryDb.get(gone.id)).titled, null, 'a file that is not there stays due');
  // A name someone gives later is never taken back: the row is done.
  await ctx.libraryDb.rename(a.id, 'smith2020');
  await library.describeRows(ctx, { pdfTitle });
  assert.equal(await name(a), 'smith2020');
});

test('remove-from-project: an import onboarding kept as a note (a head line, before 2026-10-08) can be removed; a note written here is refused', async () => {
  const project = await projects.createProject(ctx, 'Removal');
  const imported = await projects.createNote(ctx, project.id, { name: 'Onboarded chat', text: '*Claude · 2026-09-30 · Thesis*\n\n**You:** Q\n\n**Claude:** A\n' });
  const mine = await projects.createNote(ctx, project.id, { name: 'Written here', text: '*Claude · 2026-09-30*\n\nLooks like a chat, but I wrote it.\n' });
  // Both were written by createNote, which today marks them engelbart; the onboarding one is from before 2026-10-08,
  // when such a note was what onboarding wrote, with no source.
  await db.closeDb(ctx.libraryDb.dir);
  const direct = new PGlite(ctx.libraryDb.dir);
  await direct.waitReady;
  await direct.query("update library set source = null, category = null, titled = null, created = '2026-10-01T12:00:00Z' where id = $1", [imported.id]);
  await direct.query('update library set source = null, category = null, titled = null where id = $1', [mine.id]);
  await direct.close();
  ctx.libraryDb = await db.openLibraryDb(ctx.dataRoot);

  await library.describeRows(ctx, {});
  assert.deepEqual([(await ctx.libraryDb.get(imported.id)).source, (await ctx.libraryDb.get(imported.id)).place], ['Claude', 'Thesis']);
  assert.equal((await ctx.libraryDb.get(mine.id)).source, 'engelbart', 'written after 2026-10-08: the person\'s own, whatever it begins with');
  assert.deepEqual(await projects.removeFromProject(ctx, project.id, [imported.id]), { removed: 1 });
  await assert.rejects(projects.removeFromProject(ctx, project.id, [mine.id]), /Made in this project, so it goes to the trash instead of being removed \(only what was brought in from elsewhere can be removed\): Written here/);
  // A row made here whose source is unknown is refused too.
  await ctx.libraryDb.insert({ id: randomUUID(), name: 'Unknown origin', type: 'website', url: 'https://example.org/unknown', project_id: project.id });
  const unknown = (await ctx.libraryDb.list()).find((row) => row.name === 'Unknown origin');
  await assert.rejects(projects.removeFromProject(ctx, project.id, [unknown.id]), /Made in this project.*Unknown origin/);
});
