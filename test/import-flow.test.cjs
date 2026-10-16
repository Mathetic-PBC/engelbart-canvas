'use strict';

// Import your context's decisions (src/shared/import-flow.cjs): which provider runs onboarding, the browsers offered,
// the discovery agents' replies made safe, the manual scopes, and the plan each import agent is handed.

const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../src/shared/import-flow.cjs');

const p = (id, extra) => ({ id, installed: true, signedIn: true, subscription: null, since: null, ...extra });

test('both subscribed: the person is always asked, the one picked before suggested (2026-10-13, second round)', () => {
  const both = [p('anthropic', { subscription: 'max' }), p('openai', { subscription: 'pro' })];
  assert.deepEqual(flow.chooseProvider(both), { pick: null, ask: true, choices: ['anthropic', 'openai'], setup: false, suggested: null });
  assert.deepEqual(flow.chooseProvider(both, 'openai'), { pick: null, ask: true, choices: ['anthropic', 'openai'], setup: false, suggested: 'openai' });
  assert.equal(flow.chooseProvider(both, 'nobody').suggested, null);
});

test('one subscribed: that one, whichever is older', () => {
  const out = flow.chooseProvider([p('anthropic', { since: 1 }), p('openai', { subscription: 'plus', since: 9 })]);
  assert.equal(out.pick, 'openai');
  assert.equal(out.ask, false);
});

test('neither subscribed: the one used longest', () => {
  assert.equal(flow.chooseProvider([p('anthropic', { since: 500 }), p('openai', { since: 100 })]).pick, 'openai');
  assert.equal(flow.chooseProvider([p('anthropic', { since: 100 }), p('openai', { since: null })]).pick, 'anthropic');
});

test('a provider not signed in or not installed does not count; none at all asks for setup', () => {
  assert.equal(flow.chooseProvider([p('anthropic', { subscription: 'max', signedIn: false }), p('openai')]).pick, 'openai');
  assert.equal(flow.chooseProvider([p('anthropic', { installed: false }), p('openai', { signedIn: false })]).setup, true);
  assert.equal(flow.chooseProvider([]).setup, true);
});

test('browsers: only installed ones, the default first', () => {
  assert.deepEqual(flow.orderBrowsers(['opera', 'safari', 'chrome'], 'opera'), ['opera', 'safari', 'chrome']);
  assert.deepEqual(flow.orderBrowsers(['opera', 'chrome'], 'safari'), ['chrome', 'opera']);
  assert.equal(flow.browserIdOfName('Google Chrome'), 'chrome');
  assert.equal(flow.browserIdOfName('Safari'), 'safari');
  assert.equal(flow.browserIdOfName('Arc'), 'arc');
  assert.equal(flow.browserIdOfName('Comet'), 'comet');
  assert.equal(flow.browserIdOfName('Something else'), null);
});

test('the catalog holds every picker app once, and browser history', () => {
  assert.equal(new Set(flow.CATALOG_IDS).size, flow.CATALOG_IDS.length);
  assert.ok(flow.CATALOG_IDS.includes('GitHub'));
  assert.ok(flow.CATALOG_IDS.includes(flow.LOCAL_FOLDERS));
  assert.ok(flow.CATALOG_IDS.includes(flow.SITES));
  assert.equal(flow.catalogTool('Google Docs').name, 'Google Drive');
  assert.equal(flow.catalogTool('Obsidian').local, true);
  assert.equal(flow.catalogTool('Notion').local, false);
});

test('project discovery: 1-5 projects, unique ids, short titles, fences tolerated', () => {
  const reply = '```json\n{"projects":[{"title":"Engelbart context import","description":"Designing onboarding","recent":"Today","folder":"/Users/x/engelbart"},{"title":"Engelbart context import"},{"title":""},{"title":"' + 'x'.repeat(200) + '"},{"title":"A"},{"title":"B"},{"title":"C"}]}\n```';
  const out = flow.readProjects(reply);
  assert.equal(out.projects.length, 5);
  assert.equal(new Set(out.projects.map((project) => project.id)).size, 5);
  assert.equal(out.projects[0].folder, '/Users/x/engelbart');
  assert.ok(out.projects[2].title.length <= 80);
  assert.equal(flow.readProjects('no json here'), null);
  assert.equal(flow.readProjects('{"projects":[]}'), null);
});

test('tool discovery: every catalog tool answered; local finds stay; extras deduplicated', () => {
  const known = { Obsidian: { used: true, method: 'local', evidence: 'a vault' }, Notion: { used: true, method: 'cookie', evidence: 'signed in' } };
  const out = flow.readTools('{"tools":[{"id":"Obsidian","used":false},{"id":"Notion","used":false,"evidence":"no pages"},{"id":"Bogus","used":true}],"additional":[{"name":"Linear","website":"https://linear.app","used":true},{"name":"notion"},{"name":"Figma","website":"javascript:alert(1)"}]}', known);
  assert.equal(out.tools.length, flow.CATALOG_IDS.length);
  assert.equal(out.tools.find((tool) => tool.id === 'Obsidian').used, true);
  assert.equal(out.tools.find((tool) => tool.id === 'Notion').used, false);
  // Linear is a catalog tool since 2026-10-16: named among the others, it answers for itself there.
  assert.deepEqual(out.additional.map((tool) => tool.name), ['Figma']);
  assert.equal(out.tools.find((tool) => tool.id === 'Linear').used, true);
  assert.equal(out.additional[0].website, '');
  const fallback = flow.readTools('garbage', known);
  assert.equal(fallback.tools.find((tool) => tool.id === 'Notion').used, true);
});

test('manual scopes: what each kind needs before it is ready', () => {
  assert.equal(flow.scopeKind('Obsidian'), 'folders');
  assert.equal(flow.scopeKind('Gmail'), 'email');
  assert.equal(flow.scopeKind('Overleaf'), 'drafts');
  assert.equal(flow.scopeKind('Claude'), 'chats');
  const scope = flow.emptyScope('Gmail');
  assert.equal(flow.scopeReady(scope), false);
  scope.people.push('lee@example.edu');
  assert.equal(flow.scopeReady(scope), true);
  const folders = flow.emptyScope(flow.LOCAL_FOLDERS);
  folders.note = 'my papers';
  assert.equal(flow.scopeReady(folders), false);
  assert.equal(flow.scopeOptions('Overleaf', [{ id: 'a', title: 'Study' }]).length, 2);
});

test('the plan keeps the agent to the projects picked, and a manual import to its exact scope', () => {
  const projects = [{ id: 'a', title: 'Requirements study', description: 'How novices describe requirements' }];
  const auto = flow.importPlan({ app: 'Google Docs', mode: 'auto', projects, roles: ['Researcher'], work: 'CS education' });
  assert.match(auto, /only what pertains to these projects/);
  assert.match(auto, /Requirements study: How novices/);
  assert.match(auto, /Never install a plugin/);
  // A connector app (2026-10-16) is read through its own tools, not a browser.
  assert.match(flow.importPlan({ app: 'Notion', mode: 'auto', projects }), /through Notion's own tools \(its connector\)/);
  const manual = flow.importPlan({ app: 'Gmail', mode: 'manual', projects, scope: { kind: 'email', folders: [], items: [], people: ['lee@example.edu'], note: '', labels: [] } });
  assert.match(manual, /read only email with these people: lee@example.edu/);
  assert.doesNotMatch(manual, /Never install/);
});

test('the plan of a browser agent sends it to the person\'s own browser, never to install anything', () => {
  const plan = flow.importPlan({ app: 'Google Docs', mode: 'auto', projects: [{ title: 'Study', description: 'A study' }], roles: [], work: '', browser: 'Chrome' });
  assert.match(plan, /in the person's own Chrome/);
  assert.match(plan, /Never install a plugin or an extension/);
  assert.doesNotMatch(flow.importPlan({ app: 'Google Docs', mode: 'auto', projects: [{ title: 'Study' }], roles: [], work: '' }), /own Chrome/);
  assert.equal(flow.isWebApp('Google Docs'), true);
  assert.equal(flow.isWebApp('Obsidian'), false);
});

// From Amitav (2026-10-15): one tools screen, the categories with the agents' finds added to them.

test('Gmail is paused ("Get rid of Gmail and Calendar imports for now"): no Email category, not in the catalog', () => {
  assert.equal(flow.GROUPS.some((group) => group.id === 'email'), false);
  assert.equal(flow.CATALOG_IDS.includes('Gmail'), false);
  assert.equal(flow.groupOfApp('Gmail'), null);
});

test('an Other category, last, holds what fits no other', () => {
  const other = flow.GROUPS[flow.GROUPS.length - 1];
  // Linear is Other's own app since 2026-10-16 ("just Linear should by default be in the 'Other' category").
  assert.deepEqual({ id: other.id, label: other.label, apps: [...other.apps] }, { id: 'other', label: 'Other', apps: ['Linear'] });
  assert.ok(flow.GROUP_IDS.includes('other'));
});

test('tool discovery: every extra tool gets a category the picker has (else Other); calendars and mail are left out', () => {
  const reply = JSON.stringify({ tools: [], additional: [
    { name: 'Asana', website: 'https://asana.com', used: true, category: 'code' },
    { name: 'Figma', used: true, category: 'design' },
    { name: 'Readwise', used: true, category: 'Notes' },
    { name: 'Google Calendar', used: true, category: 'other' },
    { name: 'Calendly', used: true },
    { name: 'Cal.com', used: true },
    { name: 'Outlook', used: true, category: 'email' },
    { name: 'Superhuman Mail', used: true },
    { name: 'Fantastical', used: true },
  ] });
  const out = flow.readTools(reply, {});
  assert.deepEqual(out.additional.map((tool) => [tool.name, tool.category]), [['Asana', 'code'], ['Figma', 'other'], ['Readwise', 'notes']]);
});

test('the plan keeps a background run to what the person specified too, not only a manual one', () => {
  const projects = [{ id: 'a', title: 'Requirements study' }, { id: 'b', title: 'Memex' }];
  const scope = { kind: 'documents', folders: [], items: [], people: [], labels: [], projects: ['Memex'], note: 'Only the pages about the Memex' };
  const plan = flow.importPlan({ app: 'Notion', mode: 'auto', projects, scope });
  assert.match(plan, /For this source, only these of the projects: Memex\./);
  assert.match(plan, /In their words, what to bring in from it: Only the pages about the Memex/);
});
