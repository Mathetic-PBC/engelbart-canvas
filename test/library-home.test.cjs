'use strict';

// What the all-projects screen stands on: workspace character counts, the two derived "who holds
// what" calls, adding by address or path, and the peek.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// A file outside the home directory: /etc/hosts on a Mac; Windows keeps its hosts file in its system folder.
const OUTSIDE = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts') : '/etc/hosts';
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');
const { buildCatalog } = require('../src/main/context/catalog.cjs');
const { readHtmlMeta, createDescriber, createRemoteFileLister } = require('../src/main/store/page-meta.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-home-')));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

const metaOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

test('a workspace keeps its character count: on save, measured when it never had one, and after an outside edit', async () => {
  const project = await projects.createProject(ctx, 'Counts');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Draft' });
  assert.equal(workspace.chars, 0);
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'twelve chars');
  const dir = projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir;
  assert.equal(metaOf(dir).chars, 12);
  assert.equal((await projects.loadProject(ctx, project.id)).workspaces[0].chars, 12);

  // Saved before the count existed: nothing stored, the file is measured, and nothing is written for it.
  const { chars, ...legacy } = metaOf(dir);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(legacy));
  assert.equal(chars, 12);
  assert.equal((await projects.loadProject(ctx, project.id)).workspaces[0].chars, 12);
  assert.equal(projects.recountWorkspaces(ctx), 0);
  assert.equal(metaOf(dir).chars, undefined);

  // An agent writes workspace.md from a terminal: the sweep's recount brings the stored count back.
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'abc');
  fs.writeFileSync(path.join(dir, 'workspace.md'), 'written outside');
  assert.equal(projects.recountWorkspaces(ctx), 1);
  assert.equal(metaOf(dir).chars, 15);
  assert.equal(projects.flattenWorkspaces(project.dir)[0].chars, 15);
});

test('who holds what: both directions agree with each other and with the catalog', async () => {
  const a = await projects.createProject(ctx, 'Alpha');
  const b = await projects.createProject(ctx, 'Beta');
  const outer = await projects.createWorkspace(ctx, a.id, { name: 'Outer' });
  const inner = await projects.createWorkspace(ctx, a.id, { name: 'Inner', parentId: outer.id });
  const other = await projects.createWorkspace(ctx, b.id, { name: 'Elsewhere' });
  const note = await projects.createNote(ctx, a.id, { name: 'Made in Alpha' });
  const paper = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Shared paper', type: 'website', tags: ['paper'], url: 'https://arxiv.org/abs/1706.03762' });
  const loose = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Held by nobody', type: 'website', url: 'https://example.org/loose' });
  await projects.setWorkspaceContext(ctx, a.id, inner.id, [paper.id]);
  await projects.setWorkspaceContext(ctx, b.id, other.id, [paper.id, note.id]);

  const forPaper = await library.projectsForLibraryItem(ctx, paper.id);
  assert.deepEqual(forPaper.map((p) => [p.name, p.origin, p.workspaces.map((w) => w.path)]).sort(), [['Alpha', false, ['Outer/Inner']], ['Beta', false, ['Elsewhere']]]);
  const forNote = await library.projectsForLibraryItem(ctx, note.id);
  assert.deepEqual(forNote.map((p) => [p.name, p.origin, p.workspaces.length]).sort(), [['Alpha', true, 0], ['Beta', false, 1]], 'the project a note was made in holds it without any workspace attaching it');
  assert.deepEqual(await library.projectsForLibraryItem(ctx, loose.id), []);
  await assert.rejects(library.projectsForLibraryItem(ctx, randomUUID()), /Unknown library item/);

  const inAlpha = await library.libraryForProject(ctx, a.id);
  assert.deepEqual(inAlpha.map((row) => [row.name, row.origin, row.workspaces]).sort(), [['Made in Alpha', true, []], ['Shared paper', false, ['Outer/Inner']]]);
  // The invariant: an item is in a project's list exactly when the project is in the item's list.
  for (const project of [a, b]) {
    const held = new Set((await library.libraryForProject(ctx, project.id)).map((row) => row.id));
    for (const row of [note, paper, loose]) {
      assert.equal(held.has(row.id), (await library.projectsForLibraryItem(ctx, row.id)).some((p) => p.id === project.id), `${row.name} / ${project.name}`);
    }
  }
  // …and the catalog, which is written from the same rule, lists the same entries.
  const record = projects.projectRecords(ctx).find((p) => p.id === a.id);
  const catalog = buildCatalog(record, projects.flattenWorkspaces(record.dir), await ctx.libraryDb.list(), 'now');
  assert.deepEqual(catalog.entries.map((entry) => entry.id).sort(), inAlpha.map((row) => row.id).sort());
  assert.deepEqual(catalog.workspaces.map((w) => [w.path, w.chars]), [['Outer', 0], ['Outer/Inner', 0]]);
});

test('what search reads inside (MATH-29): the project\'s pdf texts, notes, md files and workspace documents, each cut at 500,000 characters; nothing of another project\'s; never on the library rows', async () => {
  const mine = await projects.createProject(ctx, 'Bodies');
  const theirs = await projects.createProject(ctx, 'Other bodies');
  const draft = await projects.createWorkspace(ctx, mine.id, { name: 'Draft' });
  const nested = await projects.createWorkspace(ctx, mine.id, { name: 'Nested', parentId: draft.id });
  const blank = await projects.createWorkspace(ctx, mine.id, { name: 'Blank' });
  const elsewhere = await projects.createWorkspace(ctx, theirs.id, { name: 'Elsewhere' });
  const write = (pid, id, text) => projects.writeDoc(ctx, pid, { kind: 'workspace', workspaceId: id }, text);
  await write(mine.id, draft.id, 'A phrase only the draft holds.');
  await write(mine.id, nested.id, 'Deeper down, a nested plan.');
  await write(theirs.id, elsewhere.id, 'Their workspace.');

  const note = await projects.createNote(ctx, mine.id, { name: 'Field notes', text: 'Observed in the lab: Late Interaction.' });
  const huge = await projects.createNote(ctx, mine.id, { name: 'Huge', text: `${'é'.repeat(300_000)}${'x'.repeat(300_000)}` });
  const gone = await projects.createNote(ctx, mine.id, { name: 'Deleted outside', text: 'soon gone' });
  fs.rmSync(path.join(mine.dir, 'Deleted outside.md'));
  const theirNote = await projects.createNote(ctx, theirs.id, { name: 'Their note', text: 'not yours' });
  const readme = path.join(homeDir, 'README.md');
  fs.writeFileSync(readme, '# Outside md\nAdded from disk.');
  const outsideHome = path.join(os.tmpdir(), `engelbart-outside-${process.pid}.md`);
  fs.writeFileSync(outsideHome, 'outside the home directory');
  const insert = (name, more) => ctx.libraryDb.insert({ id: randomUUID(), name, ...more });
  const md = await insert('README.md', { type: 'md', path: readme });
  const far = await insert('Far.md', { type: 'md', path: outsideHome, project_id: mine.id });
  const paper = await insert('Swept paper', { type: 'pdf', path: path.join(homeDir, 'swept.pdf'), project_id: mine.id });
  const scan = await insert('A scan', { type: 'pdf', path: path.join(homeDir, 'scan.pdf'), project_id: mine.id });
  const unswept = await insert('Not swept yet', { type: 'pdf', path: path.join(homeDir, 'unswept.pdf'), project_id: mine.id });
  const longPaper = await insert('Long paper', { type: 'pdf', path: path.join(homeDir, 'long.pdf'), project_id: mine.id });
  const theirPaper = await insert('Their paper', { type: 'pdf', path: path.join(homeDir, 'their.pdf'), project_id: theirs.id });
  const site = await insert('A page', { type: 'website', url: 'https://example.org/page', project_id: mine.id });
  await ctx.libraryDb.setText(paper.id, 'Text the sweep read from a PDF.', 1);
  await ctx.libraryDb.setText(scan.id, '', 1);
  await ctx.libraryDb.setText(longPaper.id, 'y'.repeat(600_000), 1);
  await ctx.libraryDb.setText(theirPaper.id, 'their text', 1);
  await projects.setWorkspaceContext(ctx, mine.id, draft.id, [md.id]); // held by being in a workspace, not by origin

  const bodies = await library.bodiesForProject(ctx, mine.id);
  assert.deepEqual(Object.keys(bodies).sort(), ['items', 'workspaces']);
  assert.equal(bodies.items[paper.id], 'Text the sweep read from a PDF.');
  assert.equal(bodies.items[note.id], 'Observed in the lab: Late Interaction.', 'as written: the renderer lowercases');
  assert.equal(bodies.items[md.id], '# Outside md\nAdded from disk.', 'an md from disk the project holds');
  assert.equal(library.MAX_BODY_CHARS, 500_000);
  assert.equal(bodies.items[longPaper.id], 'y'.repeat(500_000));
  assert.equal(bodies.items[huge.id], `${'é'.repeat(300_000)}${'x'.repeat(200_000)}`, 'cut at characters, not bytes');
  for (const [left, why] of [[scan, 'empty text'], [unswept, 'not swept'], [gone, 'file gone'], [far, 'outside home'], [site, 'no text'], [theirPaper, 'another project'], [theirNote, 'another project']]) {
    assert.equal(left.id in bodies.items, false, `${left.name}: ${why}`);
  }
  assert.deepEqual(bodies.workspaces, { [draft.id]: 'A phrase only the draft holds.', [nested.id]: 'Deeper down, a nested plan.' }, 'nested ones too; an empty one and another project\'s are left out');
  assert.equal(blank.id in bodies.workspaces, false);

  const other = await library.bodiesForProject(ctx, theirs.id);
  assert.deepEqual(other, { items: { [theirNote.id]: 'not yours', [theirPaper.id]: 'their text' }, workspaces: { [elsewhere.id]: 'Their workspace.' } });

  // The rows the renderer is sent are as they were.
  const before = Object.keys(await ctx.libraryDb.get(paper.id)).sort();
  for (const listed of [(await library.listLibrary(ctx)).find((r) => r.id === paper.id), (await library.libraryForProject(ctx, mine.id)).find((r) => r.id === paper.id)]) {
    for (const field of ['text', 'body', 'bodies']) assert.equal(field in listed, false, field);
  }
  assert.deepEqual(Object.keys((await library.listLibrary(ctx)).find((r) => r.id === paper.id)).sort(), before);
  await assert.rejects(library.bodiesForProject(ctx, 'not-a-project'), /project/);
  await assert.rejects(ctx.libraryDb.textsFor('x', 10), /ids must be an array/);
  assert.deepEqual(await ctx.libraryDb.textsFor([], 10), new Map());
  fs.rmSync(outsideHome, { force: true });
  for (const row of [md, far, paper, scan, unswept, longPaper, theirPaper, site]) await ctx.libraryDb.remove(row.id); // pdfs with no file would be left due for recategorize
});

test('the all-projects list carries each card: recent workspaces newest first with their text, and what the project holds', async () => {
  const project = await projects.createProject(ctx, 'Cards');
  const names = ['One', 'Two', 'Three', 'Four', 'Five'];
  const made = [];
  for (const name of names) made.push(await projects.createWorkspace(ctx, project.id, { name }));
  for (const [index, workspace] of made.entries()) {
    await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, `**${workspace.name}** body`);
    const file = path.join(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir, 'workspace.md');
    fs.utimesSync(file, new Date(2026, 0, 1 + index), new Date(2026, 0, 1 + index));
  }
  const note = await projects.createNote(ctx, project.id, { name: 'Card note' });
  const card = (await projects.listProjects(ctx)).find((p) => p.id === project.id);
  assert.equal(card.workspaceCount, 5);
  assert.deepEqual(card.recent.map((w) => w.name), ['Five', 'Four', 'Three', 'Two']);
  assert.equal(card.recent[0].text, '**Five** body');
  assert.equal(card.recent[0].chars, 13);
  assert.deepEqual(card.libraryIds, [note.id]);
});

test('a project named after a directory the data root keeps for itself is still a project', async () => {
  const made = await projects.createProjectWithWelcome(ctx, { name: 'test' });
  assert.equal(made.project.slug, 'test-project');
  assert.ok((await projects.listProjects(ctx)).some((project) => project.id === made.project.id && project.name === 'test'));
  assert.equal((await projects.renameProject(ctx, (await projects.createProject(ctx, 'Seedling')).id, 'seed')).slug, 'seed-project');
});

test('adding: one resolver for addresses and paths, files linked where they are, the same thing refused the second time', async () => {
  const resolve = (input) => library.resolveAddition(input, { homeDir });
  // the type is what the thing is (an address is a website); what it is for is a tag, told from the address alone
  assert.deepEqual(resolve(' arxiv:2310.05292v3 '), { type: 'website', tags: ['paper'], name: 'arXiv 2310.05292', url: 'https://arxiv.org/abs/2310.05292' });
  assert.deepEqual(resolve('https://arxiv.org/pdf/2310.05292.pdf'), { type: 'website', tags: ['paper'], name: 'arXiv 2310.05292', url: 'https://arxiv.org/abs/2310.05292' });
  assert.deepEqual(resolve('https://doi.org/10.1145/3544548.3580919'), { type: 'website', tags: ['paper'], name: 'doi 10.1145/3544548.3580919', url: 'https://doi.org/10.1145/3544548.3580919' });
  assert.deepEqual(resolve('https://github.com/mqo00/hypocompass/tree/main/backend'), { type: 'website', tags: ['git'], name: 'mqo00/hypocompass', url: 'https://github.com/mqo00/hypocompass' });
  assert.deepEqual(resolve('"https://www.inkandswitch.com/embark/"'), { type: 'website', tags: [], name: 'inkandswitch.com/embark', url: 'https://www.inkandswitch.com/embark/' });
  assert.throws(() => resolve('notes/today.md'), /starts with/);
  assert.throws(() => resolve(OUTSIDE), /home directory/);
  assert.throws(() => resolve('~/missing.pdf'), /Nothing is at that path/);

  const files = path.join(homeDir, 'files');
  fs.mkdirSync(path.join(files, 'clone', '.git'), { recursive: true });
  fs.mkdirSync(path.join(files, 'tables'));
  for (const name of ['Attention.pdf', 'rows.csv', 'events.NDJSON', 'report.html', 'old.htm', 'plain.md', 'plain.txt']) fs.writeFileSync(path.join(files, name), 'x');
  // a file is its format and nothing is guessed from it: a pdf is a pdf, not a paper; nothing is a dataset
  assert.deepEqual(resolve('~/files/Attention.pdf'), { type: 'pdf', tags: [], name: 'Attention', path: path.join(files, 'Attention.pdf') });
  assert.deepEqual(['rows.csv', 'events.NDJSON', 'report.html', 'old.htm', 'plain.md'].map((name) => resolve(path.join(files, name)).type), ['csv', 'jsonl', 'html', 'html', 'md']);
  assert.deepEqual([resolve(path.join(files, 'clone')), resolve(path.join(files, 'tables'))], [{ type: 'folder', tags: ['git'], name: 'clone', folder_path: path.join(files, 'clone') }, { type: 'folder', tags: [], name: 'tables', folder_path: path.join(files, 'tables') }]);
  assert.match(resolve(path.join(files, 'report.html')).url, /^file:\/\//);
  assert.deepEqual(resolve(path.join(files, 'plain.md')), { type: 'md', tags: [], name: 'plain.md', path: path.join(files, 'plain.md') }, 'an md from outside is an md; only a note written in Engelbart is tagged note');
  assert.throws(() => resolve(path.join(files, 'plain.txt')), /does not know what a \.txt is/);

  const describe = async () => ({ title: '  Embark:\n Dynamic documents ', description: 'Travel planning as a document.' });
  const identifyRepo = async (owner, name) => ({ id: '1000596606', fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`, description: 'A repository.' });
  const page = await library.addItem(ctx, 'https://www.inkandswitch.com/embark/', { describe });
  assert.deepEqual([page.name, page.summary, page.project_id], ['Embark: Dynamic documents', 'Travel planning as a document.', null]);
  // 2026-09-22: adding what the library already holds is an error that names the row, and nothing is asked or written
  const rowsBefore = (await ctx.libraryDb.list()).length;
  await assert.rejects(library.addItem(ctx, 'https://www.inkandswitch.com/embark/', { describe: async () => { throw new Error('asked twice'); } }), (error) => error.code === 'EXISTS' && error.message === 'Already in the library as “Embark: Dynamic documents”' && error.row.id === page.id);
  assert.equal((await ctx.libraryDb.list()).length, rowsBefore);
  // one page, however its address is spelled: scheme, www., a trailing slash, a #fragment
  for (const spelling of ['http://inkandswitch.com/embark', 'https://www.inkandswitch.com/embark#top', 'https://INKANDSWITCH.com/embark//']) {
    await assert.rejects(library.addItem(ctx, spelling), /Already in the library as “Embark: Dynamic documents”/, spelling);
  }
  const query = await library.addItem(ctx, 'https://www.inkandswitch.com/embark/?part=2');
  assert.notEqual(query.id, page.id, 'a query can be another page');
  const named = await library.addItem(ctx, 'https://example.org/named', { describe, name: '  My   name for it ' });
  assert.deepEqual([named.name, named.summary], ['My name for it', 'Travel planning as a document.'], 'a name given with the add wins over the page title; the description is still the summary');
  const repo = await library.addItem(ctx, 'git@github.com:mqo00/hypocompass.git', { describe, identifyRepo });
  assert.deepEqual([repo.name, repo.summary, repo.github_id], ['mqo00/hypocompass', 'A repository.', '1000596606'], 'a repository is named by GitHub and known by its id');
  const offline = await library.addItem(ctx, 'https://example.org/offline', { describe: async () => { throw new Error('no network'); } });
  assert.deepEqual([offline.name, offline.summary], ['example.org/offline', null]);
  assert.deepEqual([page.type, page.tags, repo.type, repo.tags], ['website', [], 'website', ['git']]);
  const pdf = await library.addItem(ctx, path.join(files, 'Attention.pdf'));
  assert.equal(fs.existsSync(pdf.path) && pdf.path === path.join(files, 'Attention.pdf'), true, 'linked, not copied');
  await assert.rejects(library.addItem(ctx, '~/files/Attention.pdf'), /Already in the library as “Attention”/, 'the same file by another spelling');
  assert.deepEqual([pdf.type, pdf.tags, pdf.categorized], ['pdf', [], null], 'nobody read it, so it says nothing about being a paper and is still due');
});

test('adding categorizes at once: a row says which rules it has had, and a pdf that could not be read is left due', async () => {
  const files = path.join(homeDir, 'pdfs');
  fs.mkdirSync(files);
  for (const name of ['paper.pdf', 'invoice.pdf', 'locked.pdf']) fs.writeFileSync(path.join(files, name), 'x');
  const looked = [];
  const inspectPdf = async (file) => { looked.push(path.basename(file)); if (/locked/.test(file)) throw new Error('unreadable'); return /paper/.test(file) ? ['paper'] : []; };
  const paper = await library.addItem(ctx, path.join(files, 'paper.pdf'), { inspectPdf });
  assert.deepEqual([paper.type, paper.tags, paper.categorized], ['pdf', ['paper'], library.CATEGORY_RULES]);
  const invoice = await library.addItem(ctx, path.join(files, 'invoice.pdf'), { inspectPdf });
  assert.deepEqual([invoice.tags, invoice.categorized], [[], library.CATEGORY_RULES], 'read, and not a paper');
  const locked = await library.addItem(ctx, path.join(files, 'locked.pdf'), { inspectPdf });
  assert.deepEqual([locked.tags, locked.categorized], [[], null], 'a pdf that cannot be read is still added, and is due');
  await assert.rejects(library.addItem(ctx, path.join(files, 'paper.pdf'), { inspectPdf }), /Already in the library/);
  assert.deepEqual(looked, ['paper.pdf', 'invoice.pdf', 'locked.pdf'], 'the row that exists is not read again');
  const link = await library.addItem(ctx, 'https://doi.org/10.1145/1234567.1234568');
  assert.deepEqual([link.tags, link.categorized], [['paper'], library.CATEGORY_RULES], 'an address needs no reading');
  // one set of rules: what + Add tells from an address is what re-categorizing tells from it
  for (const input of ['arxiv:2310.05292', 'https://doi.org/10.1145/3544548.3580919', 'git@github.com:o/r.git', 'https://example.org/page']) {
    const found = library.resolveAddition(input, { homeDir });
    assert.deepEqual(library.addressTags(found.url), found.tags, input);
  }
});

test('an installed library is re-categorized by the rules + Add uses: every row, once, read from the thing itself, and never re-summarized', async () => {
  const base = path.join(homeDir, 'installed');
  fs.mkdirSync(path.join(base, 'became-a-repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(base, 'plain-folder'));
  for (const name of ['attention.pdf', 'receipt.pdf', 'corrupt.pdf', 'stuck.pdf']) fs.writeFileSync(path.join(base, name), 'x');
  // what the SQL conversion leaves behind for a library from before the rules: types are right, tags are only what the old type said
  const was = {
    pdfPaper: { name: 'attention', type: 'pdf', path: path.join(base, 'attention.pdf') },
    pdfOther: { name: 'receipt', type: 'pdf', path: path.join(base, 'receipt.pdf') },
    pdfCorrupt: { name: 'corrupt', type: 'pdf', path: path.join(base, 'corrupt.pdf') },
    pdfStuck: { name: 'stuck', type: 'pdf', path: path.join(base, 'stuck.pdf') },
    pdfAway: { name: 'on another disk', type: 'pdf', path: path.join(base, 'away.pdf') },
    arxivAsWebsite: { name: 'arXiv 2310.05292', type: 'website', url: 'https://arxiv.org/abs/2310.05292' }, // the old seed: an arXiv address typed website
    githubAsWebsite: { name: 'a repo saved as a link', type: 'website', url: 'https://github.com/o/saved-as-link' },
    gitlab: { name: 'group/tool', type: 'website', tags: ['git'], url: 'https://gitlab.example.org/group/tool' }, // known to be a repository from how it was spelled when added
    folderNowRepo: { name: 'became-a-repo', type: 'folder', folder_path: path.join(base, 'became-a-repo') },
    folderPlain: { name: 'plain-folder', type: 'folder', folder_path: path.join(base, 'plain-folder') },
    cloneAway: { name: 'o/unmounted', type: 'folder', tags: ['git'], folder_path: path.join(base, 'unmounted') },
    page: { name: 'A page', type: 'website', url: 'https://example.org/a-page' },
    csv: { name: 'rows.csv', type: 'csv', path: path.join(base, 'rows.csv') },
  };
  const ids = {};
  for (const [key, row] of Object.entries(was)) {
    ids[key] = (await ctx.libraryDb.insert({ id: randomUUID(), ...row })).id;
    await ctx.libraryDb.setSummary(ids[key], `What ${row.name} is about.`, new Date('2026-09-10T00:00:00Z'));
  }
  const note = await projects.createNote(ctx, (await projects.createProject(ctx, 'Installed')).id, { name: 'An installed note', text: 'body' });
  const untouched = async () => Object.fromEntries((await ctx.libraryDb.list()).map((row) => [row.id, [row.name, row.summary, row.summary_edited, row.last_edited, row.char_count, row.path, row.url, row.folder_path]]));
  const before = await untouched();

  const looked = [];
  // (pdfs the tests above left due are read here too, as they would be at the next launch; only this test's are counted)
  const inspectPdf = (file) => { if (file.startsWith(base)) looked.push(path.basename(file)); if (/stuck/.test(file)) return new Promise(() => {}); if (/corrupt/.test(file)) return Promise.reject(new Error('not a pdf')); return Promise.resolve(/attention/.test(file) ? ['paper'] : []); };
  const report = await library.recategorize(ctx, { inspectPdf, inspectTimeoutMs: 30 });
  const now = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([key, id]) => { const row = await ctx.libraryDb.get(id); return [key, [row.type, row.tags, row.categorized]]; })));
  const R = library.CATEGORY_RULES;
  assert.deepEqual(now, {
    pdfPaper: ['pdf', ['paper'], R],
    pdfOther: ['pdf', [], R],
    pdfCorrupt: ['pdf', [], R], // there, and not readable as a pdf: settled, so it is not parsed at every launch
    pdfStuck: ['pdf', [], R], // a reader that never answers cannot hold the library shut
    pdfAway: ['pdf', [], null], // not there to read: left due, for the launch when the disk is back
    arxivAsWebsite: ['website', ['paper'], R],
    githubAsWebsite: ['website', ['git'], R],
    gitlab: ['website', ['git'], R], // a tag is never taken away: the spelling that showed it is no longer on the row
    folderNowRepo: ['folder', ['git'], R],
    folderPlain: ['folder', [], R],
    cloneAway: ['folder', ['git'], R],
    page: ['website', [], R],
    csv: ['csv', [], R],
  });
  assert.equal((await ctx.libraryDb.get(note.id)).categorized, R, 'a note is settled without being looked at');
  assert.deepEqual(await untouched(), before, 'names, summaries, summary_edited, last_edited, counts and locations are exactly as they were');
  assert.deepEqual(looked.sort(), ['attention.pdf', 'corrupt.pdf', 'receipt.pdf', 'stuck.pdf']);
  assert.deepEqual([report.changed.map((row) => row.name).sort(), report.due], [['a repo saved as a link', 'arXiv 2310.05292', 'attention', 'became-a-repo'], 1]);

  // once: nothing is read or written again, until the rules change or the missing file is back
  looked.length = 0;
  const again = await library.recategorize(ctx, { inspectPdf, inspectTimeoutMs: 30 });
  assert.deepEqual([looked, again.changed, again.due], [[], [], 1]);
  fs.writeFileSync(path.join(base, 'away.pdf'), 'x');
  await library.recategorize(ctx, { inspectPdf: async () => ['paper'] });
  assert.deepEqual([(await ctx.libraryDb.get(ids.pdfAway)).tags, (await ctx.libraryDb.get(ids.pdfAway)).categorized], [['paper'], R]);

  // without anyone to read pdfs (a script, a test), everything else is still categorized and pdfs stay due
  const unread = await ctx.libraryDb.insert({ id: randomUUID(), name: 'unread', type: 'pdf', path: path.join(base, 'receipt.pdf') });
  const late = await ctx.libraryDb.insert({ id: randomUUID(), name: 'late link', type: 'website', url: 'https://arxiv.org/abs/1706.03762' });
  await library.recategorize(ctx, {});
  assert.deepEqual([(await ctx.libraryDb.get(unread.id)).categorized, (await ctx.libraryDb.get(late.id)).tags], [null, ['paper']]);
  await ctx.libraryDb.remove(unread.id);
});

test('the peek: an md\'s text, a data file\'s first lines, a clone\'s files, a remote repository asked once, and who holds the item', async () => {
  const project = await projects.createProject(ctx, 'Peeks');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
  const note = await projects.createNote(ctx, project.id, { name: 'Peeked', text: '# Title\n- [ ] a task' });
  await projects.setWorkspaceContext(ctx, project.id, workspace.id, [note.id]);
  const seen = await library.previewItem(ctx, note.id);
  assert.equal(seen.text, '# Title\n- [ ] a task');
  assert.deepEqual(seen.heldBy.map((p) => [p.name, p.origin, p.workspaces.map((w) => w.name)]), [['Peeks', true, ['Reading']]]);

  const files = path.join(homeDir, 'peek');
  fs.mkdirSync(path.join(files, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(files, 'repo', 'src'));
  fs.writeFileSync(path.join(files, 'repo', 'README.md'), '');
  fs.writeFileSync(path.join(files, 'data.csv'), Array.from({ length: 30 }, (_, i) => `row,${i}`).join('\n'));
  const data = await library.addItem(ctx, path.join(files, 'data.csv'));
  assert.deepEqual((await library.previewItem(ctx, data.id)).lines.length, 12);
  fs.writeFileSync(path.join(files, 'outside.md'), '# From outside');
  const outside = await library.addItem(ctx, path.join(files, 'outside.md'));
  assert.deepEqual([outside.type, outside.tags, (await library.previewItem(ctx, outside.id)).text], ['md', [], '# From outside']);
  const clone = await library.addItem(ctx, path.join(files, 'repo'));
  assert.deepEqual((await library.previewItem(ctx, clone.id)).files, ['src/', 'README.md']);

  let asked = 0;
  const listRemoteFiles = createRemoteFileLister({ fetch: async (url) => { asked += 1; assert.equal(url, 'https://api.github.com/repos/o/r/contents'); return { ok: true, json: async () => [{ name: 'z.py', type: 'file' }, { name: 'docs', type: 'dir' }] }; } });
  const remote = await library.addItem(ctx, 'https://github.com/o/r');
  for (let i = 0; i < 2; i += 1) assert.deepEqual([(await library.previewItem(ctx, remote.id, { listRemoteFiles })).owner, (await library.previewItem(ctx, remote.id, { listRemoteFiles })).files], ['o', ['docs/', 'z.py']]);
  assert.equal(asked, 1);
});

test('a page describes itself: title, description, entities; anything that is not html says nothing', async () => {
  assert.deepEqual(readHtmlMeta('<html><head><title>Ink &amp; Switch\n</title><meta content="Tools for &#39;thought&#39;" name="description"></head>'), { title: 'Ink & Switch', description: "Tools for 'thought'" });
  assert.deepEqual(readHtmlMeta('<meta property="og:title" content="Only OG"><meta property="og:description" content=\'Second best\'>'), { title: 'Only OG', description: 'Second best' });
  const describe = createDescriber({ fetch: async (url) => ({ ok: true, headers: { get: () => (url.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8') }, text: async () => '<title>T</title>' }) });
  assert.deepEqual(await describe({ type: 'website', url: 'https://example.org/' }), { title: 'T', description: '' });
  assert.equal(await describe({ type: 'website', url: 'https://example.org/a.pdf' }), null);
  await assert.rejects(describe({ type: 'website', url: 'ftp://example.org/' }), /http/);

  const { createRepoIdentifier } = require('../src/main/store/page-meta.cjs');
  const identifyRepo = createRepoIdentifier({ fetch: async (url) => { assert.equal(url, 'https://api.github.com/repos/mqo00/hypocompass'); return { ok: true, json: async () => ({ id: 1000596606, full_name: 'mqo00/hypocompass', html_url: 'https://github.com/mqo00/hypocompass', description: null }) }; } });
  assert.deepEqual(await identifyRepo('mqo00', 'hypocompass'), { id: '1000596606', fullName: 'mqo00/hypocompass', url: 'https://github.com/mqo00/hypocompass', description: '' });
  await assert.rejects(createRepoIdentifier({ fetch: async () => ({ ok: false, status: 404 }) })('Mathetic-PBC', 'engelbart-canvas'), /404/);
  await assert.rejects(createRepoIdentifier({ fetch: async () => ({ ok: true, json: async () => ({ id: 'nope' }) }) })('a', 'b'), /id/);
});

/* One repository, one row: the address and the clone on disk meet through the clone's own remote. */

function fakeClone(dir, remote, { name = 'origin', worktreeOf } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (worktreeOf) { fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(worktreeOf, '.git', 'worktrees', 'wt')}\n`); return dir; }
  fs.mkdirSync(path.join(dir, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote ? `[remote "${name}"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n` : ''}[branch "main"]\n\tremote = ${name}\n`);
  return dir;
}

test('a clone says where it came from: every remote spelling becomes one address, and a token in it is never kept', () => {
  const { canonicalRemote, readCloneRemote } = library;
  for (const spelling of ['https://github.com/Mathetic-PBC/engelbart-canvas.git', 'git@github.com:Mathetic-PBC/engelbart-canvas.git', 'ssh://git@github.com/Mathetic-PBC/engelbart-canvas', 'git://github.com/Mathetic-PBC/engelbart-canvas.git/', 'https://hudson:ghp_secret@github.com/Mathetic-PBC/engelbart-canvas.git']) {
    assert.equal(canonicalRemote(spelling), 'https://github.com/Mathetic-PBC/engelbart-canvas', spelling);
  }
  assert.equal(canonicalRemote('git@gitlab.example.org:group/sub/tool.git'), 'https://gitlab.example.org/group/sub/tool');
  assert.deepEqual([canonicalRemote('/srv/git/local.git'), canonicalRemote('file:///srv/git/local.git'), canonicalRemote('')], [null, null, null]);

  const base = path.join(homeDir, 'remotes');
  assert.equal(readCloneRemote(fakeClone(path.join(base, 'plain'), 'git@github.com:o/plain.git')), 'https://github.com/o/plain');
  assert.equal(readCloneRemote(fakeClone(path.join(base, 'upstream-only'), 'https://github.com/o/fork.git', { name: 'upstream' })), 'https://github.com/o/fork', 'no origin: the first remote');
  assert.equal(readCloneRemote(fakeClone(path.join(base, 'no-remote'), null)), null);
  assert.equal(readCloneRemote(fakeClone(path.join(base, 'worktree'), null, { worktreeOf: path.join(base, 'plain') })), 'https://github.com/o/plain', 'a worktree reads the repository it belongs to');
  assert.equal(readCloneRemote(path.join(base, 'missing')), null);
});

// GitHub as the tests know it: repositories by id, and the names that currently lead to each.
function fakeGitHub(repos) {
  const asked = [];
  const identifyRepo = async (owner, name) => {
    asked.push(`${owner}/${name}`);
    const hit = repos.find((repo) => repo.names.some((known) => known.toLowerCase() === `${owner}/${name}`.toLowerCase()));
    if (!hit) throw new Error('The address answered 404'); // private, gone, or offline: all look the same from here
    return { id: String(hit.id), fullName: hit.names[0], url: `https://github.com/${hit.names[0]}`, description: hit.description || '' };
  };
  return { identifyRepo, asked };
}

test('a repository is its GitHub id: the address then the clone, the clone then the address, a rename, a reused name', async () => {
  const base = path.join(homeDir, 'repos');
  const hub = fakeGitHub([
    { id: 101, names: ['Acme/Widgets'], description: 'From GitHub.' },
    { id: 102, names: ['acme/gears'] },
    { id: 103, names: ['acme/cogs', 'acme/old-cogs'] }, // renamed: the old name still leads here
  ]);
  const { identifyRepo } = hub;

  // address first, clone second: one row, which gains the folder; the add itself is refused (2026-09-22)
  const byUrl = await library.addItem(ctx, 'https://github.com/acme/widgets', { identifyRepo });
  assert.deepEqual([byUrl.github_id, byUrl.name, byUrl.url, byUrl.summary, byUrl.folder_path], ['101', 'Acme/Widgets', 'https://github.com/Acme/Widgets', 'From GitHub.', null], 'named and addressed the way GitHub spells it');
  const clone = fakeClone(path.join(base, 'widgets-checkout'), 'git@github.com:acme/widgets.git');
  await assert.rejects(library.addItem(ctx, clone, { identifyRepo }), (error) => error.code === 'EXISTS' && error.row.id === byUrl.id);
  const linked = await ctx.libraryDb.get(byUrl.id);
  assert.equal(linked.folder_path, clone);
  assert.deepEqual([byUrl.type, byUrl.tags, linked.type, linked.tags], ['website', ['git'], 'folder', ['git']], 'a repository known only by its address is a website; once it has a folder it is a folder');
  await assert.rejects(library.addItem(ctx, clone, { identifyRepo }), /Already in the library as “Acme\/Widgets”/);
  assert.equal((await ctx.libraryDb.get(byUrl.id)).last_edited, linked.last_edited, 'nothing left to fill in');

  // clone first: the row is made with id, address and folder
  const second = fakeClone(path.join(base, 'gears'), 'https://github.com/acme/gears.git');
  const byFolder = await library.addItem(ctx, second, { identifyRepo });
  assert.deepEqual([byFolder.github_id, byFolder.name, byFolder.url, byFolder.folder_path], ['102', 'acme/gears', 'https://github.com/acme/gears', second]);
  assert.deepEqual([byFolder.type, byFolder.tags], ['folder', ['git']]);
  await assert.rejects(library.addItem(ctx, 'git@github.com:acme/gears.git', { identifyRepo }), (error) => error.row.id === byFolder.id);

  // renamed on GitHub: the row was added under the old name, the clone's remote says the new one. Same id, same row,
  // and the row follows the rename (its name too, because nobody had renamed it by hand).
  const old = await library.addItem(ctx, 'https://github.com/acme/old-cogs', { identifyRepo: async () => ({ id: '103', fullName: 'acme/old-cogs', url: 'https://github.com/acme/old-cogs', description: '' }) });
  const cogs = fakeClone(path.join(base, 'cogs'), 'https://github.com/acme/cogs.git');
  await assert.rejects(library.addItem(ctx, cogs, { identifyRepo }), /Already in the library as “acme\/cogs”/, 'the error names the row as it is now called');
  const renamed = await ctx.libraryDb.get(old.id);
  assert.deepEqual([renamed.id, renamed.github_id, renamed.url, renamed.name, renamed.folder_path], [old.id, '103', 'https://github.com/acme/cogs', 'acme/cogs', cogs]);

  // a name someone else took over: same address as a row, different id, so a different repository and a second row
  const before = await library.addItem(ctx, 'https://github.com/acme/reused', { identifyRepo: async () => ({ id: '104', fullName: 'acme/reused', url: 'https://github.com/acme/reused', description: '' }) });
  const after = await library.addItem(ctx, 'https://github.com/acme/reused', { identifyRepo: async () => ({ id: '999', fullName: 'acme/reused', url: 'https://github.com/acme/reused', description: '' }) });
  assert.notEqual(after.id, before.id);
  assert.equal(after.github_id, '999');

  // the database holds the line too: one row per id
  await assert.rejects(ctx.libraryDb.insert({ id: randomUUID(), name: 'dup', type: 'website', tags: ['git'], url: 'https://github.com/x/dup', github_id: '101' }), /unique|duplicate/i);
  await assert.rejects(ctx.libraryDb.insert({ id: randomUUID(), name: 'bad', type: 'website', tags: ['git'], github_id: '12ab' }), /github id/i);
});

test('GitHub cannot be asked (private, offline): the address stands in for the id, and the id is taken up the first time it is known', async () => {
  const base = path.join(homeDir, 'private');
  const silent = async () => { throw new Error('The address answered 404'); };
  const byUrl = await library.addItem(ctx, 'https://github.com/Mathetic-PBC/secret', { identifyRepo: silent });
  assert.deepEqual([byUrl.github_id, byUrl.name], [null, 'Mathetic-PBC/secret']);
  const clone = fakeClone(path.join(base, 'secret'), 'git@github.com:mathetic-pbc/secret.git');
  await assert.rejects(library.addItem(ctx, clone, { identifyRepo: silent }), (error) => error.row.id === byUrl.id);
  const linked = await ctx.libraryDb.get(byUrl.id);
  assert.deepEqual([linked.folder_path, linked.github_id], [clone, null], 'matched by address, without case');

  // a clone added before remotes were read has neither url nor id: the address still finds it, and now it has all three
  const legacyDir = fakeClone(path.join(base, 'legacy'), 'https://github.com/acme/legacy.git');
  const legacy = await ctx.libraryDb.insert({ id: randomUUID(), name: 'legacy', type: 'folder', tags: ['git'], folder_path: legacyDir });
  await assert.rejects(library.addItem(ctx, 'https://github.com/acme/legacy', { identifyRepo: async () => ({ id: '105', fullName: 'acme/legacy', url: 'https://github.com/acme/legacy', description: '' }) }), /Already in the library as “legacy”/);
  const found = await ctx.libraryDb.get(legacy.id);
  assert.deepEqual([found.url, found.github_id, found.name], ['https://github.com/acme/legacy', '105', 'legacy'], 'a name given by hand is kept');

  // the clone moved: adding it from its new place replaces a folder that is no longer there
  const moved = path.join(base, 'secret-moved');
  fs.renameSync(clone, moved);
  await assert.rejects(library.addItem(ctx, moved, { identifyRepo: silent }), /Already in the library/);
  assert.equal((await ctx.libraryDb.get(byUrl.id)).folder_path, moved);

  // a repository that is not on GitHub has no id and is known by its address
  // (group/tool was made by the re-categorizing test above; this one is new)
  const lab = await library.addItem(ctx, 'git@gitlab.example.org:group/lathe.git', { identifyRepo: async () => { throw new Error('asked GitHub about a repository that is not there'); } });
  assert.deepEqual([lab.type, lab.tags, lab.url, lab.github_id], ['website', ['git'], 'https://gitlab.example.org/group/lathe', null]);
  await assert.rejects(library.addItem(ctx, 'git@gitlab.example.org:group/tool.git'), /Already in the library as “group\/tool”/, 'the one the library holds is refused by its address');
});

test('a project\'s code directory is a clone the library already knows about: found on add and on hover, read from disk', async () => {
  const code = fakeClone(path.join(homeDir, 'code', 'canvas'), 'https://github.com/Mathetic-PBC/engelbart-canvas.git');
  fs.writeFileSync(path.join(code, 'package.json'), '{}');
  fs.mkdirSync(path.join(code, 'src'));
  // added by address before any project works in a clone of it
  const row = await library.addItem(ctx, 'https://github.com/mathetic-pbc/engelbart-canvas');
  assert.equal(row.folder_path, null);
  await projects.createProject(ctx, { name: 'Canvas', directory: code });
  const listRemoteFiles = async () => { throw new Error('the network was asked although the clone is on disk'); };
  const seen = await library.previewItem(ctx, row.id, { listRemoteFiles });
  assert.deepEqual([seen.files, seen.folder, seen.owner], [['src/', 'package.json'], path.join('~', 'code', 'canvas'), 'mathetic-pbc']);
  assert.equal((await ctx.libraryDb.get(row.id)).folder_path, code, 'and the row remembers it');

  // added by address when the project is already there: linked at once, and nobody is asked to describe it
  const other = fakeClone(path.join(homeDir, 'code', 'tool'), 'git@github.com:acme/tool.git');
  await projects.createProject(ctx, { name: 'Tool', directory: other });
  const added = await library.addItem(ctx, 'https://github.com/acme/tool', { identifyRepo: async () => ({ id: '106', fullName: 'acme/tool', url: 'https://github.com/acme/tool', description: 'One request: id and description.' }) });
  assert.deepEqual([added.folder_path, added.summary, added.github_id, added.type], [other, 'One request: id and description.', '106', 'folder']);

  fs.rmSync(other, { recursive: true });
  // the clone is deleted: the row stays in the library with its id and address, says its folder is missing, and the peek goes back to asking
  const gone = await library.previewItem(ctx, added.id, { listRemoteFiles: async () => ['README.md'] });
  assert.deepEqual([gone.files, gone.folder, gone.folderMissing], [['README.md'], null, '~/code/tool']);
  const kept = await ctx.libraryDb.get(added.id);
  assert.deepEqual([kept.github_id, kept.url, kept.folder_path], ['106', 'https://github.com/acme/tool', other], 'nothing is removed, and the path is kept for the day the folder comes back');
});

/* The workspace sidebar (2026-09-22): what the Save button and the search ask, pictures from disk, the trash. */

test('lookup: what an address or a path would be, and the row that already is it, without adding or asking the network', async () => {
  const files = path.join(homeDir, 'lookups');
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, 'figure.PNG'), 'x');
  fs.writeFileSync(path.join(files, 'shot.heic'), 'x');
  const before = (await ctx.libraryDb.list()).length;
  const fresh = await library.lookupItem(ctx, 'https://example.org/never-added');
  assert.deepEqual([fresh.row, fresh.found.type, fresh.found.url, fresh.error], [null, 'website', 'https://example.org/never-added', null]);
  const page = await library.addItem(ctx, 'https://example.org/looked-up');
  const held = await library.lookupItem(ctx, 'https://example.org/looked-up');
  assert.equal(held.row.id, page.id);
  const repo = await library.addItem(ctx, 'https://github.com/looked/up');
  assert.equal((await library.lookupItem(ctx, 'git@github.com:Looked/Up.git')).row.id, repo.id, 'a repository by any spelling of its address');
  assert.match((await library.lookupItem(ctx, path.join(files, 'missing.pdf'))).error, /Nothing is at that path/);
  // a picture on disk is its own type, linked where it is
  const picture = await library.lookupItem(ctx, path.join(files, 'figure.PNG'));
  assert.deepEqual([picture.row, picture.found.type, picture.found.path], [null, 'image', path.join(files, 'figure.PNG')]);
  const heic = await library.addItem(ctx, path.join(files, 'shot.heic'));
  assert.deepEqual([heic.type, heic.tags, heic.path], ['image', [], path.join(files, 'shot.heic')]);
  assert.equal((await ctx.libraryDb.list()).length, before + 3, 'looking up adds nothing');
});

test('the trash takes a row off a workspace whatever put it there, and linking it again brings it back; nothing is deleted', async () => {
  const project = await projects.createProject(ctx, 'Sidebar');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Elsewhere' });
  const a = await library.addItem(ctx, 'https://example.org/a-link');
  const b = await library.addItem(ctx, 'https://example.org/b-link');
  const note = await projects.createNote(ctx, project.id, { name: 'Made here', workspaceId: workspace.id });
  let seen = await projects.linkToWorkspace(ctx, project.id, workspace.id, [a.id, b.id, a.id]);
  assert.deepEqual([seen.context, seen.removed], [[a.id, b.id], []], 'once each, in the order given');
  await projects.linkToWorkspace(ctx, project.id, other.id, [a.id]);
  seen = await projects.unlinkFromWorkspace(ctx, project.id, workspace.id, a.id);
  assert.deepEqual([seen.context, seen.removed], [[b.id], [a.id]]);
  // a note made in the workspace was never in its context: the trash still takes it off, by remembering it
  seen = await projects.unlinkFromWorkspace(ctx, project.id, workspace.id, note.id);
  assert.deepEqual([seen.context, seen.removed], [[b.id], [a.id, note.id]]);
  assert.deepEqual((await projects.loadProject(ctx, project.id)).workspaces.find((w) => w.id === workspace.id).removed, [a.id, note.id], 'the tree carries it to the rail');
  assert.ok(await ctx.libraryDb.get(a.id), 'the library keeps the row');
  assert.deepEqual(projects.findWorkspace(ctx, project.id, other.id).workspace.context, [a.id], 'other workspaces keep it');
  seen = await projects.linkToWorkspace(ctx, project.id, workspace.id, [note.id]);
  assert.deepEqual([seen.context, seen.removed], [[b.id, note.id], [a.id]], 'brought back: in context, no longer removed');
  await assert.rejects(projects.linkToWorkspace(ctx, project.id, workspace.id, ['not-an-id']), /library id is invalid/);
});
