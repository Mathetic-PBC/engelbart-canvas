'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { INLINE, expandMentions, expandDoc, imagePaths } = require('../src/main/context/expand-mentions.cjs');

/** A library held in memory: notes carry their text, everything else is a row. */
function sourceOf(rows, images = {}) {
  const reads = [];
  return {
    reads,
    find: (name) => rows.find((row) => row.name.toLowerCase() === name.toLowerCase()) || null,
    read: async (row) => {
      reads.push(row.name);
      if (row.text === undefined) throw new Error('gone');
      return row.text;
    },
    image: (id) => images[id] || null,
  };
}
const note = (name, text) => ({ id: `id-${name}`, name, type: 'md', tags: ['note'], path: `/p/${name}.md`, text });
const expand = async (text, source, seen) => { const result = await expandMentions(text, source, seen); return { ...result, text: result.lines.join('\n') }; };

test('a mentioned note lands under the line that mentions it, once', async () => {
  const source = sourceOf([note('Plan', 'step one\nstep two\n')]);
  const result = await expand('Intro\nSee @[Plan] first.\nThen go.\n\nAgain @[plan].', source);
  assert.equal(result.text, [
    'Intro',
    'See @[Plan] first.',
    '',
    '<file name="Plan" type="md" tags="note" path="/p/Plan.md">',
    'step one',
    'step two',
    '</file>',
    '',
    'Then go.',
    '',
    'Again @[plan].',
  ].join('\n'));
  assert.equal(result.files, 1);
  assert.equal(result.missing, 0);
  assert.deepEqual(source.reads, ['Plan']);
});

test('two mentions on one line give two blocks in the order they are mentioned, and the blank line that follows is not doubled', async () => {
  const source = sourceOf([note('A', 'a'), note('B', 'b')]);
  const result = await expand('- [ ] read @[B] and @[A]\n\nnext', source);
  assert.equal(result.text, [
    '- [ ] read @[B] and @[A]',
    '',
    '<file name="B" type="md" tags="note" path="/p/B.md">',
    'b',
    '</file>',
    '',
    '<file name="A" type="md" tags="note" path="/p/A.md">',
    'a',
    '</file>',
    '',
    'next',
  ].join('\n'));
  assert.equal(result.files, 2);
});

test('a note brings its own mentions with it, and a circle of mentions ends', async () => {
  const source = sourceOf([note('A', 'A says @[B]'), note('B', 'B says @[C] and @[A]'), note('C', 'C says @[Root]'), note('Root', 'never read')]);
  const result = await expand('@[A]\n@[C]', source, new Set(['id-Root']));
  assert.equal(result.text, [
    '@[A]',
    '',
    '<file name="A" type="md" tags="note" path="/p/A.md">',
    'A says @[B]',
    '',
    '<file name="B" type="md" tags="note" path="/p/B.md">',
    'B says @[C] and @[A]',
    '',
    '<file name="C" type="md" tags="note" path="/p/C.md">',
    'C says @[Root]',
    '</file>',
    '</file>',
    '</file>',
    '',
    '@[C]',
  ].join('\n'));
  assert.equal(result.files, 3);
  assert.deepEqual(source.reads, ['A', 'B', 'C']);
});

test('a mention inside code stays text, @bart is not a file, and a mention with no file says so where it stands', async () => {
  const source = sourceOf([note('Plan', 'p')]);
  const result = await expand('type `@[Plan]` to mention\n@bart what about @[Gone] and @[gone]?\n@[bart]', source);
  assert.equal(result.text, [
    'type `@[Plan]` to mention',
    '@bart what about @[Gone] and @[gone]?',
    '',
    '<file name="Gone" missing="true" />',
    '',
    '@[bart]',
  ].join('\n'));
  assert.equal(result.files, 0);
  assert.equal(result.missing, 1);
});

test('@brainstorm is a question too, and a card\'s JSON is copied as it stands (2026-09-30)', async () => {
  const source = sourceOf([note('Plan', 'p')]);
  const doc = ['@brainstorm about @[Plan]', 'bart> ```json', 'bart> {"card": "focus"}', 'bart> ```', '@brainstorm picked "Plan"'].join('\n');
  const result = await expand(doc, source);
  assert.equal(result.text, ['@brainstorm about @[Plan]', '', '<file name="Plan" type="md" tags="note" path="/p/Plan.md">', 'p', '</file>', '', 'bart> ```json', 'bart> {"card": "focus"}', 'bart> ```', '@brainstorm picked "Plan"'].join('\n'));
  assert.deepEqual('@Brainstorm `@bart` x'.split(INLINE).filter(Boolean), ['@Brainstorm', ' ', '`@bart`', ' x']);
});

test('@discover is a question too (2026-09-30)', async () => {
  const doc = '@discover about @[Plan]';
  const result = await expand(doc, sourceOf([note('Plan', 'p')]));
  assert.equal(result.text, ['@discover about @[Plan]', '', '<file name="Plan" type="md" tags="note" path="/p/Plan.md">', 'p', '</file>'].join('\n'));
});

test('a note whose file cannot be read is missing, not empty', async () => {
  const result = await expand('@[Lost]', sourceOf([{ id: 'x', name: 'Lost', type: 'md', tags: ['note'], path: '/p/Lost.md' }]));
  assert.equal(result.text, '@[Lost]\n\n<file name="Lost" type="md" tags="note" path="/p/Lost.md" missing="true" />');
  assert.equal(result.missing, 1);
  assert.equal(result.files, 0);
});

test('anything that is not a note is included as where it is, with its summary when it has one', async () => {
  const source = sourceOf([
    { id: 'p', name: 'Attention', type: 'pdf', tags: ['paper'], path: '/lib/attention.pdf', summary: 'We propose the Transformer.\nIt attends.' },
    { id: 'w', name: 'Docs "v2" <beta>', type: 'website', url: 'https://example.com/?a=1&b=2' },
    { id: 'r', name: 'Repo', type: 'folder', tags: ['git'], url: 'https://github.com/x/y', folder_path: '/code/y' },
  ]);
  const result = await expand('@[Attention] @[Docs "v2" <beta>] @[Repo]', source);
  assert.equal(result.text, [
    '@[Attention] @[Docs "v2" <beta>] @[Repo]',
    '',
    '<file name="Attention" type="pdf" tags="paper" path="/lib/attention.pdf" contains="summary">',
    'We propose the Transformer.',
    'It attends.',
    '</file>',
    '',
    '<file name="Docs &quot;v2&quot; &lt;beta>" type="website" url="https://example.com/?a=1&amp;b=2" />',
    '',
    '<file name="Repo" type="folder" tags="git" folder="/code/y" url="https://github.com/x/y" />',
  ].join('\n'));
  assert.equal(result.files, 3);
  assert.deepEqual(source.reads, []);
});

test('a pasted image becomes the path of its file, inline or on a line of its own', async () => {
  const source = sourceOf([], { 'a1b2-c3': '/home/p/assets/a1b2-c3.png' });
  const result = await expand('![Attachment 1](img:a1b2-c3)\n- [ ] fix ![Attachment 1](img:a1b2-c3) and ![Attachment 2](img:nope)', source);
  assert.equal(result.text, '![Attachment 1](/home/p/assets/a1b2-c3.png)\n- [ ] fix ![Attachment 1](/home/p/assets/a1b2-c3.png) and ![Attachment 2](img:nope)');
});

test('imagePaths: a question\'s pasted images become the paths of their files, and nothing else changes (2026-10-02)', () => {
  const source = sourceOf([note('Plan', 'never read')], { 'a1b2-c3': '/home/p/assets/a1b2-c3.png' });
  assert.equal(imagePaths('--opus what is ![Attachment 2](img:a1b2-c3) showing?', source), '--opus what is ![Attachment 2](/home/p/assets/a1b2-c3.png) showing?');
  assert.equal(imagePaths('![Attachment 3](img:nope) gone, `![Attachment 2](img:a1b2-c3)` in code, @[Plan] mentioned', source), '![Attachment 3](img:nope) gone, `![Attachment 2](img:a1b2-c3)` in code, @[Plan] mentioned', 'an image that is gone stays as written; code and mentions are untouched');
  assert.equal(imagePaths('[Attachment 2] typed', source), '[Attachment 2] typed');
});

test('the inline tokens are the editor\'s own', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  // A library mention by id, `@[Name](lib:<id>)` (MATH-21), and a file in a library folder, `@[Name](lib:<id>:<path>)`
  // (MATH-22, which a document's @ menu writes), are read here too since MATH-22.
  assert.equal(INLINE.source, model.INLINE.source);
  assert.equal(INLINE.flags, model.INLINE.flags);
});

test('a library mention is its item by id; a file in a library folder is where it is, its folder mentioned (MATH-22)', async () => {
  const rows = [{ id: 'r-1', name: 'Renamed Paper', type: 'pdf', tags: ['paper'], path: '/p/paper.pdf' }, { id: 'f-1', name: 'Papers', type: 'folder', tags: [], folder_path: '/home/papers' }];
  const files = { 'f-1\nsub dir/Smith (2024) #2.pdf': { folder: 'Papers', path: '/home/papers/sub dir/Smith (2024) #2.pdf', exists: true, dir: false, type: 'pdf' } };
  const source = {
    ...sourceOf(rows),
    get: (id) => rows.find((row) => row.id === id) || null,
    file: (folderId, rel) => files[`${folderId}\n${rel}`] || { folder: 'Papers', path: `/home/papers/${rel}`, exists: false },
  };
  const seen = new Set();
  const result = await expand('See @[Old Name](lib:r-1) and @[Smith (2024) #2.pdf](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf), again @[x](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf).\nGone @[Old.pdf](lib:f-1:Old.pdf)', source, seen);
  assert.equal(result.text, [
    'See @[Old Name](lib:r-1) and @[Smith (2024) #2.pdf](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf), again @[x](lib:f-1:sub%20dir/Smith%20%282024%29%20%232.pdf).',
    '',
    '<file name="Renamed Paper" type="pdf" tags="paper" path="/p/paper.pdf" />',
    '',
    '<file name="Smith (2024) #2.pdf" type="pdf" folder="Papers" path="/home/papers/sub dir/Smith (2024) #2.pdf" />',
    '',
    'Gone @[Old.pdf](lib:f-1:Old.pdf)',
    '',
    '<file name="Old.pdf" folder="Papers" path="/home/papers/Old.pdf" missing="true" />',
  ].join('\n'));
  assert.ok(seen.has('r-1') && seen.has('f-1'), 'the item and the folder are mentioned');
  assert.ok(seen.has('file:f-1:sub dir/Smith (2024) #2.pdf') && seen.has('file:f-1:Old.pdf'), 'each file once, by its path');
  assert.deepEqual({ files: result.files, missing: result.missing }, { files: 2, missing: 1 });
});

/* ------------------------------------------------------------- with the store */

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-expand-'));
const layout = ensureHome(homeDir);
let ctx;
let project;
let other;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  other = await projects.createProject(ctx, 'Other'); // created first: its rows come first in the library
  project = await projects.createProject(ctx, 'Here');
});
test.after(async () => { await db.closeAll(); });

test('expandDoc: a workspace document under its name, with this project\'s note where another project has one of the same name', async () => {
  await projects.createNote(ctx, other.id, { name: 'Plan', text: 'the other project\'s plan' });
  const plan = await projects.createNote(ctx, project.id, { name: 'Plan', text: 'this project\'s plan\n\n' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, '\nRead @[Plan].\n\n');
  const result = await expandDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id });
  const planRow = await ctx.libraryDb.get(plan.id);
  assert.equal(result.text, [
    '# Agents',
    '',
    'Read @[Plan].',
    '',
    `<file name="Plan" type="md" tags="note" path="${planRow.path}">`,
    'this project\'s plan',
    '</file>',
  ].join('\n'));
  assert.deepEqual({ chars: result.chars, files: result.files, missing: result.missing }, { chars: result.text.length, files: 1, missing: 0 });
});

test('expandDoc: a note is not included in itself, and a note only another project holds is still found', async () => {
  await projects.createNote(ctx, other.id, { name: 'Elsewhere', text: 'from the other project' });
  const loop = await projects.createNote(ctx, project.id, { name: 'Loop', text: 'I mention @[Loop] and @[Elsewhere].' });
  const result = await expandDoc(ctx, project.id, { kind: 'note', id: loop.id });
  assert.match(result.text, /^# Loop\n\nI mention @\[Loop\] and @\[Elsewhere\]\.\n\n<file name="Elsewhere" type="md" tags="note" path="[^"]+">\nfrom the other project\n<\/file>$/);
  assert.equal(result.files, 1);
});

test('expandDoc: a pasted image is its file on disk', async () => {
  const image = await projects.saveImage(ctx, project.id, { bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', name: 'Attachment 1' });
  const shot = await projects.createNote(ctx, project.id, { name: 'Shot', text: `![Attachment 1](img:${image.id})` });
  const result = await expandDoc(ctx, project.id, { kind: 'note', id: shot.id });
  const row = await ctx.libraryDb.get(image.id);
  assert.equal(result.text, `# Shot\n\n![Attachment 1](${row.path})`);
  assert.ok(fs.existsSync(row.path));
});

test('a mentioned workspace is included as a note is: its document, under its current name, once (2026-09-25)', async () => {
  const workspaces = {
    w1: { name: 'Agents renamed', path: '/p/Agents/workspace.md', text: 'plan it\nsee @[Plan]' },
  };
  const source = { ...sourceOf([note('Plan', 'step one')]), workspace: async (id) => workspaces[id] || null };
  const result = await expand('Look at @[Agents](ws:w1) then @[Agents](ws:w1) and @[Gone](ws:w2).', source);
  assert.equal(result.text, [
    'Look at @[Agents](ws:w1) then @[Agents](ws:w1) and @[Gone](ws:w2).',
    '',
    '<file name="Agents renamed" type="workspace" path="/p/Agents/workspace.md">',
    'plan it',
    'see @[Plan]',
    '',
    '<file name="Plan" type="md" tags="note" path="/p/Plan.md">',
    'step one',
    '</file>',
    '</file>',
    '',
    '<file name="Gone" type="workspace" missing="true" />',
  ].join('\n'));
  assert.deepEqual({ files: result.files, missing: result.missing }, { files: 2, missing: 1 });
});

test('expandDoc: a workspace mentioned from another is read from disk; one that mentions itself is not included in itself', async () => {
  const here = await projects.createWorkspace(ctx, project.id, { name: 'Here' });
  const there = await projects.createWorkspace(ctx, project.id, { name: 'There' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: there.id }, 'what there holds');
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: here.id }, `Me @[Here](ws:${here.id}), then @[Old name](ws:${there.id}).`);
  const result = await expandDoc(ctx, project.id, { kind: 'workspace', workspaceId: here.id });
  const sep = path.sep === '/' ? '\\/' : '\\\\'; // the path as this platform writes it
  assert.match(result.text, new RegExp(`^# Here\\n\\nMe @\\[Here\\]\\(ws:[\\w-]+\\), then @\\[Old name\\]\\(ws:[\\w-]+\\)\\.\\n\\n<file name="There" type="workspace" path="[^"]+${sep}There${sep}workspace\\.md">\\nwhat there holds\\n<\\/file>$`));
  assert.deepEqual({ files: result.files, missing: result.missing }, { files: 1, missing: 0 });
});

test('Copy reads a Build\'s line as what its card says, not as an id (2026-09-25)', async () => {
  const store = require('../src/main/build/store.cjs');
  const project = await projects.createProject(ctx, 'Copy builds');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Plan' });
  store.writeTask(projects.findProject(ctx, project.id), { id: '0123456789', title: 'Plan', status: 'review', messages: [] });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Do it.\nbuild> 0123456789\nbuild> abcdefabcd');
  const out = await expandDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id });
  assert.equal(out.body, 'Do it.\nBuild "Plan" (review)\nbuild> abcdefabcd', 'a Build this project does not hold stays as written');
});
