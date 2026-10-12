'use strict';

// MATH-110 (2026-10-11): macOS's folder access asked for once, on Connect your library's choose screen
// (src/main/connect/folder-access.cjs): which protected folders a run would read, asking about them one at a time, the
// answers kept in <dataRoot>/.connect/folders.json, the PDF scan keeping out of the ones not allowed, and the panel's words.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const folderAccess = require('../src/main/connect/folder-access.cjs');
const { pdfsAtAGlance } = require('../src/main/connect/scan.cjs');
const { LOCAL_PDFS } = require('../src/shared/connect-sources.cjs');

const HOME = '/Users/ada';
const DATA = '/Users/ada/.engelbart';

/**
 * A fake fs: `dirs` the folders that are there, `denied` the ones macOS says no to (EPERM on readdir), `files` path →
 * text. Records every readdir, and how many ran at once.
 */
function fakeFs({ dirs = [], denied = [], files = {}, delayMs = 5 } = {}) {
  const there = new Set(dirs);
  const written = { ...files };
  const calls = [];
  let running = 0, most = 0;
  const missing = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const children = (dir) => [...there].filter((other) => path.dirname(other) === dir).map((other) => path.basename(other));
  return {
    calls,
    written,
    get most() { return most; },
    statSync(file) { if (!there.has(file)) throw missing(file); return { isDirectory: () => true }; },
    readdirSync(dir) { if (!there.has(dir)) throw missing(dir); return children(dir); },
    readFileSync(file) { if (!(file in written)) throw missing(file); return written[file]; },
    writeFileSync(file, text) { written[file] = String(text); },
    mkdirSync() {},
    promises: {
      async readdir(dir) {
        calls.push(dir);
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        running -= 1;
        if (denied.includes(dir)) throw Object.assign(new Error(`EPERM: ${dir}`), { code: 'EPERM' });
        if (!there.has(dir)) throw missing(dir);
        return children(dir);
      },
    },
  };
}

const at = (...parts) => path.join(HOME, ...parts);
const MAC = [at('Desktop'), at('Documents'), at('Downloads'), at('Library'), at('Library', 'CloudStorage'), at('Library', 'CloudStorage', 'GoogleDrive-ada@lab.org'), at('Papers')];
const pdfChoices = (files = true) => ({ sources: { papers: { on: true, apps: [LOCAL_PDFS], folders: [] } }, permissions: { files } });

test('protectedFolders: only those on this Mac, by the names the panel shows', () => {
  const fs = fakeFs({ dirs: MAC });
  assert.deepEqual(folderAccess.protectedFolders({ homeDir: HOME, fs }).map((folder) => [folder.id, folder.name]), [
    ['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Downloads', 'Downloads'],
    [path.join('Library', 'CloudStorage', 'GoogleDrive-ada@lab.org'), 'Google Drive'],
  ], 'no iCloud Drive here, and ~/Papers is not protected');
  assert.deepEqual(['GoogleDrive-a@b.c', 'Dropbox', 'OneDrive-Personal', 'Box-Box'].map(folderAccess.driveName), ['Google Drive', 'Dropbox', 'OneDrive', 'Box']);
});

test('needed(): PDFs ticked with file access → every protected folder here; a repo under ~/Documents → Documents; nothing ticked → none; asked before → not again', () => {
  const fs = fakeFs({ dirs: MAC });
  const ids = (choices) => folderAccess.needed(choices, { homeDir: HOME, dataRoot: DATA, fs }).map((folder) => folder.id);
  assert.deepEqual(ids(pdfChoices()), ['Desktop', 'Documents', 'Downloads', path.join('Library', 'CloudStorage', 'GoogleDrive-ada@lab.org')]);
  assert.deepEqual(folderAccess.needed(pdfChoices(), { homeDir: HOME, dataRoot: DATA, fs }).map((folder) => folder.name), ['Desktop', 'Documents', 'Downloads', 'Google Drive']);
  assert.deepEqual(ids(pdfChoices(false)), [], 'PDFs without file access read only the folders picked');
  assert.deepEqual(ids({ sources: { code: { on: true, apps: [], folders: [at('Documents', 'tutor')] } } }), ['Documents']);
  assert.deepEqual(ids({ sources: { code: { on: true, apps: [], folders: ['~/Documents/tutor', at('Papers', 'x')] } } }), ['Documents'], '~/ paths too, an unprotected one adds nothing');
  assert.deepEqual(ids({ sources: { code: { on: true, apps: [], folders: [at('Documents', 'tutor')] } }, picked: [at('Documents', 'tutor')] }), [], 'a repository chosen in the folder picker needs no asking');
  assert.deepEqual(ids({ sources: {} }), []);
  assert.deepEqual(ids({ sources: { papers: { on: false, apps: [], folders: [] }, notes: { on: true, apps: ['Obsidian'] } }, permissions: { files: true } }), []);
  folderAccess.writeAnswers(DATA, { Documents: 'allowed', Downloads: 'denied' }, { fs });
  assert.deepEqual(ids(pdfChoices()), ['Desktop', path.join('Library', 'CloudStorage', 'GoogleDrive-ada@lab.org')], 'answered either way: not asked again');
});

test('ask(): one folder at a time, in order; readdir ok → allowed, EPERM → denied; the answers kept in folders.json', async () => {
  const fs = fakeFs({ dirs: MAC, denied: [at('Downloads')] });
  const answers = await folderAccess.ask(['Desktop', 'Documents', 'Downloads', 'Nope'], { homeDir: HOME, dataRoot: DATA, fs, now: () => new Date('2026-10-11T12:00:00Z') });
  assert.deepEqual(answers, { Desktop: 'allowed', Documents: 'allowed', Downloads: 'denied' }, 'a folder not on this Mac is left out');
  assert.deepEqual(fs.calls, [at('Desktop'), at('Documents'), at('Downloads')], 'in the order asked');
  assert.equal(fs.most, 1, 'never two at once: macOS shows its prompts one after another');
  const saved = JSON.parse(fs.written[path.join(DATA, '.connect', 'folders.json')]);
  assert.deepEqual(saved, { asked: { Desktop: { answer: 'allowed', at: '2026-10-11T12:00:00.000Z' }, Documents: { answer: 'allowed', at: '2026-10-11T12:00:00.000Z' }, Downloads: { answer: 'denied', at: '2026-10-11T12:00:00.000Z' } } });
  assert.deepEqual(folderAccess.readAnswers(DATA, { fs }), answers);
  assert.deepEqual(folderAccess.needed(pdfChoices(), { homeDir: HOME, dataRoot: DATA, fs }).map((folder) => folder.name), ['Google Drive'], 'the panel does not come back for them');
  // EACCES is a no too.
  const other = fakeFs({ dirs: MAC });
  other.promises.readdir = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.deepEqual(await folderAccess.ask(['Desktop'], { homeDir: HOME, dataRoot: DATA, fs: other }), { Desktop: 'denied' });
});

test('guard: a protected folder not allowed is not readable, a picked folder inside it is; the home folder and unprotected ones are', () => {
  const fs = fakeFs({ dirs: MAC });
  const access = folderAccess.guard({ homeDir: HOME, answers: { Desktop: 'allowed', Documents: 'denied' }, picked: [at('Documents', 'Papers')], fs });
  assert.deepEqual([HOME, at('Papers'), at('Desktop', 'x'), at('Documents'), at('Documents', 'y'), at('Documents', 'Papers', 'z'), at('Downloads'), at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'a')].map(access.readable),
    [true, true, true, false, false, true, false, false], 'Downloads never asked about counts as not allowed; iCloud Drive is guarded even when not here');
  assert.deepEqual(access.allowed.map((folder) => folder.name), ['Desktop']);
  assert.deepEqual(access.blocked.map((folder) => folder.name), ['Documents', 'Downloads', 'Google Drive']);
});

test('pdfsAtAGlance with Documents denied never lists or reads anything under ~/Documents; a folder picked inside it is still read', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-folders-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (rel) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '%PDF-1.4\n%%EOF\n'); return file; };
  put('Documents/Research/smith2019.pdf');
  put('Documents/Picked/jones2020.pdf');
  put('Downloads/2310.01234v2.pdf');
  put('Papers/mark2004.pdf');
  const documents = path.join(home, 'Documents');
  const picked = path.join(documents, 'Picked');
  // Every path the scan touches, by whichever fs call it makes.
  const touched = [];
  const spies = ['readdirSync', 'statSync', 'openSync', 'existsSync', 'accessSync'].map((name) => {
    const real = fs[name];
    fs[name] = function spy(file, ...rest) { touched.push(String(file)); return real.call(this, file, ...rest); };
    return () => { fs[name] = real; };
  });
  let glance, alsoPicked;
  try {
    const access = folderAccess.guard({ homeDir: home, answers: { Documents: 'denied', Downloads: 'allowed' } });
    glance = pdfsAtAGlance([], { homeDir: home, everywhere: true, access });
    const withPick = folderAccess.guard({ homeDir: home, answers: { Documents: 'denied', Downloads: 'allowed' }, picked: [picked] });
    alsoPicked = pdfsAtAGlance([picked], { homeDir: home, everywhere: true, access: withPick });
  } finally { spies.forEach((undo) => undo()); }
  assert.deepEqual(glance.lookedIn.sort(), ['~/Downloads', '~/Papers']);
  assert.deepEqual(glance.folders.map((entry) => entry.folder).sort(), ['~/Downloads', '~/Papers']);
  assert.deepEqual(glance.notAllowed, ['Documents']);
  assert.deepEqual(alsoPicked.folders.map((entry) => entry.folder).sort(), ['~/Documents/Picked', '~/Downloads', '~/Papers']);
  const inside = touched.filter((file) => file.startsWith(documents + path.sep) && !(file === picked || file.startsWith(picked + path.sep)));
  assert.deepEqual(inside, [], 'nothing under ~/Documents but the picked folder');
  assert.ok(touched.some((file) => file.startsWith(picked + path.sep)), 'the picked folder was read');
});

test('the panel names only the folders that are there, joined with "and"; the PDFs row while and after macOS asks', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
  const fs = fakeFs({ dirs: MAC });
  const panel = model.folderPanel(folderAccess.needed(pdfChoices(), { homeDir: HOME, dataRoot: '/nowhere', fs }));
  assert.equal(panel.folders, 'Desktop, Documents, Downloads and Google Drive');
  assert.deepEqual(panel.names, ['Desktop', 'Documents', 'Downloads', 'Google Drive']);
  assert.equal(panel.title, 'Let Engelbart read your folders?');
  assert.equal(panel.lead, 'Engelbart looks here for papers, documents and repos related to your project. Without this, files saved on your Mac are left out.');
  assert.equal(panel.note, 'macOS will ask once for each folder.');
  assert.equal(panel.ask, 'Choose Allow on each.');
  assert.equal(panel.tip, 'macOS only asks once. You can change it later in System Settings → Privacy & Security → Files and Folders.');
  const repos = model.folderPanel([{ id: 'Documents', name: 'Documents' }], { papers: false });
  assert.equal(repos.title, 'Let Engelbart read your Documents?');
  assert.equal(repos.lead, 'Engelbart looks here for repos related to your project. Without this, repos saved in it are left out.');
  assert.deepEqual([repos.note, repos.ask], ['macOS will ask once.', 'Choose Allow.']);
  assert.equal(model.folderPanel([]), null);
  assert.equal(model.rowTip(LOCAL_PDFS), panel.tip, 'the PDFs row\'s tooltip says it too');
  const folders = [{ id: 'Desktop', name: 'Desktop' }, { id: 'Documents', name: 'Documents' }, { id: 'Downloads', name: 'Downloads' }];
  assert.deepEqual(model.folderAccessLabel({ folders, asking: true }), { text: 'Waiting for macOS…', tone: 'busy' });
  assert.deepEqual(model.folderAccessLabel({ folders, answers: { Desktop: 'allowed', Documents: 'allowed', Downloads: 'allowed' } }), { text: '✓ Desktop, Documents, Downloads', tone: 'ok' });
  assert.deepEqual(model.folderAccessLabel({ folders, answers: { Desktop: 'allowed', Documents: 'allowed', Downloads: 'denied' } }), { text: '✓ Desktop, Documents · Downloads not allowed', tone: 'ok' });
  assert.deepEqual(model.folderAccessLabel({ folders, answers: { Desktop: 'denied', Documents: 'denied', Downloads: 'denied' } }), { text: 'Desktop, Documents and Downloads not allowed', tone: 'muted' });
  assert.equal(model.folderAccessLabel({ folders }), null);
  // The folders chosen in the folder picker go with the choices.
  assert.deepEqual(model.choicesOf({ picks: { papers: true }, apps: {}, folders: { papers: ['/Users/ada/Documents/P'] }, picked: ['/Users/ada/Documents/P'] }).picked, ['/Users/ada/Documents/P']);
  assert.equal('picked' in model.choicesOf({ picks: {}, apps: {} }), false);
});
