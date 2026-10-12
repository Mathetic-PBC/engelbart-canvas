'use strict';

// Connect your library shows the 'Google Docs' source as Google Drive (2026-10-10): it reaches the person's whole Drive.
// The id stays 'Google Docs' wherever it is a key (picks, sessions, skills, sign-ins); only what is shown goes through
// shownName, and the row carries Drive's logo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { APPS, SOURCES, SHOWN_NAMES, shownName } = require('../src/shared/connect-sources.cjs');
const { SKILLS } = require('../src/main/connect/skills.cjs');
const { SIGN_IN_COOKIES, SIGN_IN_PAGES } = require('../src/main/connect/web-signin.cjs');
const prompts = require('../src/main/connect/prompts.cjs');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);

test('shownName: Google Docs is shown as Google Drive, every other app as itself', () => {
  assert.equal(shownName('Google Docs'), 'Google Drive');
  for (const app of ['Obsidian', 'Notion', 'Google Meet', 'ChatGPT', 'GitHub', 'Something new']) assert.equal(shownName(app), app);
  assert.deepEqual(SHOWN_NAMES, { 'Google Docs': 'Google Drive' });
  // The id is unchanged wherever it is a key.
  assert.ok(APPS['Google Docs'] && !APPS['Google Drive']);
  assert.ok(SOURCES.find((source) => source.id === 'notes').apps.includes('Google Docs'));
  assert.ok(SIGN_IN_COOKIES['Google Docs'] && SIGN_IN_PAGES['Google Docs']);
  assert.match(SKILLS['Google Docs'], /^# Google Drive and Docs/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /'Google Docs' in <choices> and <found> is the person's Google Drive: Docs, Sheets, Slides and uploaded files\. Call it Google Drive\./);
});

test('the model says Google Drive where the person reads it, and keeps picks under Google Docs', async () => {
  const m = await model();
  const start = m.initialPicks({ apps: { Obsidian: { found: true } } });
  const ticked = m.tickRow(start, 'notes', 'Google Docs', true);
  assert.equal(ticked.apps.notes['Google Docs'], true, 'stored under the id');
  assert.equal('Google Drive' in ticked.apps.notes, false);
  assert.equal(m.subOf('notes', ticked), 'Obsidian, Google Drive');
  const sent = m.choicesOf({ picks: ticked.picks, apps: ticked.apps });
  assert.ok(sent.sources.notes.apps.includes('Google Docs'), 'sent to main by id');

  for (const kind of ['signin', 'connector', 'permission', 'folder', 'code']) {
    const view = m.needView({ app: 'Google Docs', kind });
    assert.doesNotMatch(JSON.stringify(view), /Google Docs/, kind);
  }
  assert.match(m.needView({ app: 'Google Docs', kind: 'signin' }).title, /Google Drive/);

  // A row of "Bringing everything in", as main labels it now and as a session saved before this change did.
  for (const label of ['Notes: Google Drive', 'Notes: Google Docs']) {
    const row = m.workRow({ kind: 'import', source: 'notes', apps: ['Google Docs'], label, status: 'running' });
    assert.equal(row.title, 'Google Drive');
    assert.equal(row.sub, 'Notes', label);
  }
  assert.equal(m.workRow({ kind: 'import', source: 'notes', apps: ['Obsidian', 'Google Docs'], label: 'Notes: Obsidian, Google Drive' }).title, 'Obsidian and Google Drive');
  assert.equal(m.rowTip('Google Docs'), 'Docs, Sheets, Slides and files');
  assert.equal(m.rowTip('Notion'), '');
  const panel = m.signInPanel(ticked, 'Chrome', [{ id: 'notes', app: 'Google Docs' }]);
  assert.equal(panel.title, 'Use your Chrome sign-ins for Google Drive?');
  assert.deepEqual(panel.rows, [{ id: 'notes', app: 'Google Docs' }], 'rows keep the id');
  assert.doesNotMatch(m.rowLabel('Google Docs', { connectors: {} }).text, /Google Docs/);
});

test('the choose screen: a Google Drive row with Drive\'s logo, toggled by its id', async () => {
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text' }, logLevel: 'silent' });
  const filename = path.join(__dirname, '__connect-library-shown.cjs');
  const loaded = new Module(filename, module);
  loaded.paths = module.paths;
  const previousWindow = global.window;
  global.window = { engelbartAPI: {} };
  try { loaded._compile(bundled.outputFiles[0].text, filename); }
  finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
  const { LOGOS } = loaded.exports;
  const drive = fs.readFileSync(path.join(__dirname, '../design/assets/logos/google-drive.svg'), 'utf8');
  assert.equal(LOGOS['Google Docs'], drive, 'the Drive logo');
  assert.match(drive, /<title>Google Drive<\/title>/);
  assert.equal(LOGOS['Google Drive'], undefined, 'keyed by id');
  // Square, like its neighbours, so it sits in the 14px box the same way.
  const [, , w, h] = drive.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.equal(w, h);
  for (const colour of ['#0F9D58', '#00AC47', '#4285F4', '#2684FC', '#FFBA00']) assert.ok(drive.includes(colour), colour);

  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');
  assert.doesNotMatch(source, /googledocs\.svg/, 'the Docs logo is no longer imported');
  assert.ok(fs.existsSync(path.join(__dirname, '../design/assets/logos/googledocs.svg')), 'but kept in the folder');
});
