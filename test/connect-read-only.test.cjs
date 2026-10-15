'use strict';

// Read-only agents (From Amitav, 2026-10-15: "ensure agents cant fuck w their shit, but if they poke around and read that
// is fine"): what Engelbart's browser refuses an agent (src/main/connect/browser.cjs), which tools each job gets
// (src/main/connect/tools.cjs toolNamesFor: no browser for ChatGPT, Claude or Overleaf, read by Engelbart's own readers),
// where its browser may go (a survey of Google Drive lists, never opens a document), and that no agent can write a
// script into a page. scripts/smoke-connect-browser.cjs checks the same refusals in a real page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clickRefusal, typeRefusal, pressRefusal, signsOut } = require('../src/main/connect/browser.cjs');
const { IMPORT_TOOLS, TOOLS_FOR, BROWSING, toolNamesFor, browseSitesFor, createImportTools } = require('../src/main/connect/tools.cjs');
const { skillOf } = require('../src/main/connect/skills.cjs');

const button = (name, more = {}) => ({ tag: 'button', role: '', type: 'submit', name, href: '', editable: false, search: false, form: false, formSearch: false, submit: false, ...more });
const field = (name, more = {}) => ({ tag: 'input', role: '', type: 'text', name, href: '', editable: false, search: false, form: false, formSearch: false, submit: false, ...more });

test('a click that only opens or shows is let through; one that could change the account is refused', () => {
  for (const name of ['Open', 'Show more', 'Load more', 'Next', 'More actions', 'Shared with me', 'Starred', 'Recent', 'Editing history', 'Close']) assert.equal(clickRefusal(button(name)), null, name);
  for (const name of ['Delete', 'Move to trash', 'Share', 'Send', 'Rename', 'Move', 'Make a copy', 'Save', 'Download', 'Export', 'Archive', 'New folder', 'Add to Starred', 'Copy link', 'Start a new chat', 'Request access', 'Settings: Turn on']) assert.match(clickRefusal(button(name)), /could change something/, name);
  assert.match(clickRefusal({ ...button('Remove'), tag: 'div', role: 'menuitem' }), /could change something/, 'a menu item, by its name');
  assert.equal(clickRefusal({ ...button('Thesis draft: Delete me'), tag: 'div', role: 'row' }), null, 'a row only selects or opens, whatever the file is called');
  assert.equal(clickRefusal({ ...button('Projects'), tag: 'a', href: 'https://app.example/projects' }), null, 'a link that goes somewhere is reading');
  assert.match(clickRefusal({ ...button('Delete'), tag: 'a', href: '' }), /could change something/, 'a link that is a button in disguise is judged as one');
  assert.match(clickRefusal({ ...button('Sign out'), tag: 'a', href: 'https://app.example/logout' }), /signs out/);
  assert.match(clickRefusal({ ...button('Account'), tag: 'a', href: 'https://accounts.example/Logout?continue=x' }), /signs out/, 'by its address too');
  assert.match(clickRefusal({ ...button('Dark mode'), tag: 'div', role: 'switch' }), /changes a setting/);
  assert.match(clickRefusal(field('Select Thesis draft', { type: 'checkbox' })), /changes a setting/);
  assert.match(clickRefusal(field('Upload', { type: 'file' })), /changes a setting, a selection or a file/);
  assert.match(clickRefusal({ ...button('Theme'), tag: 'select' }), /changes a setting/);
  assert.match(clickRefusal(button('Go on', { submit: true, form: true })), /sends a form/);
  assert.equal(clickRefusal(button('Search', { submit: true, form: true, formSearch: true })), null, 'a search form\'s button searches');
  assert.match(clickRefusal(button('')), /no name/);
  assert.equal(clickRefusal(field('Search in Drive', { search: true })), null, 'clicking into a field only focuses it');
});

test('text goes only into a search box: never an editor, a form\'s field or a password', () => {
  assert.equal(typeRefusal(field('Search in Drive', { search: true, role: 'combobox' })), null);
  assert.equal(typeRefusal(field('Search mail', { type: 'search', search: true })), null);
  assert.match(typeRefusal({ ...field('Message ChatGPT'), tag: 'div', type: '', editable: true }), /editor/);
  assert.match(typeRefusal({ ...field('Write a reply'), tag: 'textarea', type: 'textarea' }), /not a search box/);
  assert.match(typeRefusal(field('Title')), /not a search box/);
  assert.match(typeRefusal(field('Email', { type: 'email', search: true })), /only type into search boxes/);
  assert.match(typeRefusal(field('Password', { type: 'password', search: true })), /password field/);
  assert.match(typeRefusal(button('Go')), /does not take text/);
});

test('Enter and Space only search or open; Delete and Backspace only in a search box', () => {
  const search = field('Search', { search: true });
  const composer = { ...field('Message'), tag: 'div', type: '', editable: true };
  const page = { ...button(''), tag: 'body' };
  assert.equal(pressRefusal('Enter', search), null, 'Enter in a search box searches');
  assert.match(pressRefusal('Enter', composer), /would send or write/);
  assert.match(pressRefusal('Enter', { ...field('Write a reply'), tag: 'textarea', type: 'textarea' }), /would send or write/);
  assert.match(pressRefusal('Space', composer), /would send or write/);
  assert.equal(pressRefusal('Space', search), null);
  assert.match(pressRefusal('Enter', button('Delete')), /could change something/, 'Enter on a focused button is a click');
  assert.equal(pressRefusal('Enter', button('Open')), null);
  assert.equal(pressRefusal('Enter', { ...button('Thesis draft'), tag: 'div', role: 'row' }), null, 'Enter on a selected file opens it');
  assert.equal(pressRefusal('Enter', page), null);
  assert.match(pressRefusal('Delete', page), /could delete something/, 'Delete on a selected Drive file would trash it');
  assert.match(pressRefusal('Backspace', { ...button('Thesis draft'), tag: 'div', role: 'row' }), /could delete/);
  assert.equal(pressRefusal('Backspace', search), null);
  for (const key of ['Tab', 'Escape', 'ArrowDown', 'PageDown', 'Home', 'End']) assert.equal(pressRefusal(key, composer), null, key);
  assert.equal(signsOut('https://accounts.google.com/Logout?hl=en'), true);
  assert.equal(signsOut('https://chatgpt.com/auth/logout'), true);
  assert.equal(signsOut('https://app.example/sign-out'), true);
  assert.equal(signsOut('https://drive.google.com/drive/my-drive'), false);
  assert.equal(signsOut('not a url'), false);
});

test('no agent writes a script into a page: browser_eval is gone from every kind', () => {
  assert.equal(IMPORT_TOOLS.some((tool) => tool.name === 'browser_eval'), false);
  for (const [kind, names] of Object.entries(TOOLS_FOR)) assert.equal(names.includes('browser_eval'), false, kind);
});

test('each job gets its own tools: ChatGPT, Claude and Overleaf through their own readers, no browser; Drive browsed', () => {
  const browsing = (names) => names.filter((name) => BROWSING.includes(name));
  for (const app of ['ChatGPT', 'Claude', 'Overleaf']) {
    const names = toolNamesFor('import', { apps: [app] });
    assert.deepEqual(browsing(names), [], app);
  }
  assert.ok(toolNamesFor('import', { apps: ['ChatGPT'] }).includes('import_web_chats'), 'its own reader stays');
  assert.ok(toolNamesFor('import', { apps: ['Overleaf'] }).includes('import_overleaf_projects'));
  assert.deepEqual(browsing(toolNamesFor('import', { apps: ['Google Docs'] })), BROWSING, 'Drive, in the background, is browsed freely (read-only)');
  assert.deepEqual(browsing(toolNamesFor('import', { apps: ['Google Docs'], page: false })), [], 'no browser, no browser tools');
  assert.deepEqual(browsing(toolNamesFor('import', { apps: [], extraSites: ['linear.app'] })), BROWSING, 'a tool Engelbart has no import for, through its site');
  assert.deepEqual(browsing(toolNamesFor('import', { apps: ['Obsidian'] })), [], 'nothing on the web');
  assert.deepEqual(browsing(toolNamesFor('survey', { apps: ['Claude'] })), []);
  assert.deepEqual(browseSitesFor('survey', ['Google Docs']), ['drive.google.com'], 'a survey of Drive stays on its lists');
  assert.deepEqual(browseSitesFor('import', ['Google Docs']), ['drive.google.com', 'docs.google.com'], 'never Gmail or the Google account');
  assert.deepEqual(browseSitesFor('import', ['ChatGPT', 'Claude']), [], 'a fixed reader\'s sites are never browsed');
});

test('the browser tools refuse a page outside the sites the job browses, and say why', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connect-read-only-')));
  const dataRoot = path.join(home, '.engelbart');
  fs.mkdirSync(dataRoot, { recursive: true });
  let at = 'about:blank';
  const opened = [];
  const page = { url: () => at, open: async (url) => { opened.push(url); at = url; return { url, title: '' }; }, read: async () => ({ url: at, text: '', elements: [] }) };
  const session = { dataRoot, homeDir: home, dir: path.join(dataRoot, '.connect', 'ro'), projectId: () => null, apps: ['Google Docs', 'ChatGPT'], browseSites: browseSitesFor('survey', ['Google Docs', 'ChatGPT']) };
  const call = createImportTools({ session, context: async () => ({ dataRoot }), kind: 'survey', page });
  await call('browser_open', { url: 'https://drive.google.com/drive/recent' });
  await assert.rejects(call('browser_open', { url: 'https://docs.google.com/document/d/abc/edit' }), /not one this agent may browse/, 'a survey opens no document');
  await assert.rejects(call('browser_open', { url: 'https://chatgpt.com/' }), /read only with its own tools/);
  await assert.rejects(call('browser_open', { url: 'https://mail.google.com/' }), /not one this agent may browse/);
  at = 'https://chatgpt.com/c/123';
  await assert.rejects(call('browser_read', {}), /read only with its own tools/, 'nor reads one it was taken to');
  assert.deepEqual(opened, ['https://drive.google.com/drive/recent']);
  const only = createImportTools({ session, context: async () => ({ dataRoot }), kind: 'import', page, only: toolNamesFor('import', { apps: ['ChatGPT'] }) });
  await assert.rejects(only('browser_open', { url: 'https://chatgpt.com/' }), /not one of this agent's tools/);
});

test('the skills send no agent to a browser for ChatGPT, Claude, Notion or Overleaf, and tell Granola\'s to only read', () => {
  for (const app of ['ChatGPT', 'Claude', 'Notion', 'Overleaf']) {
    const skill = skillOf(app);
    assert.doesNotMatch(skill, /browser_open|browser_read|fall back to/i, app);
    assert.doesNotMatch(skill, /browser_eval/, app);
  }
  assert.match(skillOf('ChatGPT'), /stop: bring nothing more in/);
  assert.match(skillOf('Granola'), /never switch the workspace or sign out/);
  assert.doesNotMatch(skillOf('Google Docs'), /browser_eval/);
});
