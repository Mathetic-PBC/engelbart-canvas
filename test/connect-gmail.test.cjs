'use strict';

// Gmail in Connect your library (2026-10-11): searched, listed, and only the threads the person approves brought in, one
// note a thread, with the same Google sign-in as Google Drive. Never ticked by default, never in MEMORY.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { SOURCES, APPS, webApps } = require('../src/shared/connect-sources.cjs');
const { SIGN_IN_COOKIES, SIGN_IN_PAGES } = require('../src/main/connect/web-signin.cjs');
const { createImportTools, TOOLS_FOR } = require('../src/main/connect/tools.cjs');
const { cleanChoices, memoryJobs } = require('../src/main/connect/session.cjs');
const { detect } = require('../src/main/connect/scan.cjs');
const { SKILLS } = require('../src/main/connect/skills.cjs');
const { importToolLabel } = require('../src/main/connect/agents.cjs');
const prompts = require('../src/main/connect/prompts.cjs');
const gmail = require('../src/main/connect/gmail.cjs');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-gmail-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => { await db.closeAll(); });

// A print view as Gmail draws one (the layout is not documented: this is its usual shape), newest reply last.
const PRINT = `<html><head><title>Gmail - Pilot protocol</title><style>body{font:13px}</style></head><body>
<div class="bodycontainer"><table width=100% cellpadding=0 cellspacing=0 border=0><tr height=14px><td width=143><img src="logo.png" alt="Gmail"></td><td align=right><font size=-1 color=#777><b>Sam Researcher &lt;sam@uni.edu&gt;</b></font></td></tr></table>
<hr><div class="maincontent"><table width=100% cellpadding=0 cellspacing=0 border=0><tr><td><font size=+1><b>Pilot protocol</b></font><br><font size=-1 color=#777>2 messages</font></td></tr></table>
<hr><table width=100% cellpadding=0 cellspacing=0 border=0 class="message"><tr><td><font size=-1><b>Dr. Lee </b>&lt;lee@uni.edu&gt;</font></td><td align=right><font size=-1>Mon, Mar 2, 2026 at 9:10 AM</font></td></tr>
<tr><td colspan=2><font size=-1 class="recipient"><div>To: Sam Researcher &lt;sam@uni.edu&gt;</div></font></td></tr>
<tr><td colspan=2><table width=100% cellpadding=12 cellspacing=0 border=0><tr><td><div style="overflow: hidden;"><font size=-1><div>Hi Sam,</div><div>Here is the draft protocol &amp; the consent form.</div><div>See <a href="https://example.org/irb">the IRB page</a>.</div></font></div></td></tr></table></td></tr>
<tr><td colspan=2><b>protocol-v2.pdf</b><br>212K <a href="https://mail.google.com/mail/u/1/?ui=2&amp;ik=cd6f0fe68b&amp;attid=0.1&amp;disp=safe">View</a> <a href="https://mail.google.com/mail/u/1/?ui=2&amp;attid=0.1&amp;disp=attd">Download</a></td></tr></table>
<hr><table width=100% cellpadding=0 cellspacing=0 border=0 class="message"><tr><td><font size=-1><b>Sam Researcher </b>&lt;sam@uni.edu&gt;</font></td><td align=right><font size=-1>Tue, Mar 3, 2026 at 4:45 PM</font></td></tr>
<tr><td colspan=2><font size=-1 class="recipient"><div>To: Dr. Lee &lt;lee@uni.edu&gt;</div></font></td></tr>
<tr><td colspan=2><table width=100% cellpadding=12 cellspacing=0 border=0><tr><td><div style="overflow: hidden;"><font size=-1><div>Thanks, looks good.<br>One question about recruitment.</div><div class="gmail_quote"><div>On Mon, Mar 2, 2026 at 9:10 AM Dr. Lee wrote:</div><blockquote class="gmail_quote">Hi Sam, Here is the draft protocol</blockquote></div></font></div></td></tr></table></td></tr></table>
</div></div></body></html>`;

const IK = 'cd6f0fe68b';
const thread = (n) => `thread-f:18400000000${String(n).padStart(6, '0')}`;

// A fake browser page: what Gmail's search page answers, and its print views (downloads) recorded.
function fakePage({ rows = [], signedIn = true, html = PRINT } = {}) {
  const page = { opened: [], scripts: [], downloads: [] };
  page.open = async (url) => { page.opened.push(url); return { url: signedIn ? url : 'https://accounts.google.com/ServiceLogin?service=mail', title: 'Gmail' }; };
  page.ensure = page.open;
  page.evaluate = async (script) => { page.scripts.push(script); return { signedIn, ik: IK, threads: rows }; };
  page.download = async (url, dir, { name }) => {
    page.downloads.push(url);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof html === 'function' ? html(url) : html);
    return { path: file, bytes: 1, type: 'text/html' };
  };
  return page;
}

function toolsWith({ days = null, page = fakePage(), session = {}, kind = 'import', added = () => {} } = {}) {
  const base = { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'gmail-test'), projectId: () => null, exports: {}, folders: {}, get days() { return days; }, gmailThreads: 0 };
  const full = Object.assign(base, session);
  return { call: createImportTools({ session: full, context: async () => ctx, env: {}, page, kind, added }), page, session: full };
}

const mdFiles = () => {
  const out = [];
  const walk = (dir) => { for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (file.endsWith('.md')) out.push(file); } };
  walk(path.join(ctx.dataRoot, 'assets', 'md'));
  return out;
};

test('Gmail is the Email group\'s one app, reached on the web with Google\'s sites and mail.google.com; cleanChoices keeps it', () => {
  const ids = SOURCES.map((source) => source.id);
  assert.equal(ids.indexOf('email'), ids.indexOf('transcripts') + 1, 'right after Meeting transcripts');
  assert.deepEqual(SOURCES.find((source) => source.id === 'email'), { id: 'email', label: 'Email', apps: ['Gmail'] });
  assert.equal(APPS.Gmail.reach, 'web');
  assert.ok(APPS.Gmail.sites.includes('mail.google.com') && APPS.Gmail.sites.includes('accounts.google.com'));
  assert.equal(APPS.Gmail.start, 'https://mail.google.com/mail/');
  assert.deepEqual(webApps(['Gmail', 'Obsidian']), ['Gmail']);
  const choices = cleanChoices({ sources: { email: { on: true, apps: ['Gmail'] } } }, homeDir);
  assert.equal(choices.sources.email.on, true);
  assert.deepEqual(choices.sources.email.apps, ['Gmail']);
});

test('Gmail uses Google Drive\'s sign-in (the same cookie and page), and the scan finds it only when Engelbart\'s browser holds it', () => {
  assert.deepEqual(SIGN_IN_COOKIES.Gmail, SIGN_IN_COOKIES['Google Docs']);
  assert.equal(SIGN_IN_PAGES.Gmail, SIGN_IN_PAGES['Google Docs']);
  const signedOut = detect({ homeDir, applications: [] });
  assert.deepEqual([signedOut.apps.Gmail.found, signedOut.apps.Gmail.where, signedOut.apps.Gmail.signedIn], [false, 'Sign in to add', false]);
  const signedIn = detect({ homeDir, applications: [], signedIn: ['Gmail'] });
  assert.deepEqual([signedIn.apps.Gmail.found, signedIn.apps.Gmail.where, signedIn.apps.Gmail.signedIn], [true, 'signed in to Engelbart', true]);
});

test('Gmail is never ticked to start with, even when found; ticking it adds its consent line and nothing else', async () => {
  const m = await model();
  const found = { apps: { Gmail: { found: true }, 'Google Docs': { found: true } } };
  const start = m.initialPicks(found);
  assert.equal(start.apps.email.Gmail, false);
  assert.equal(start.apps.notes['Google Docs'], true, 'Drive, found, is ticked as before');
  assert.equal(start.picks.email, false);
  assert.ok(m.NEVER_TICKED.includes('Gmail'));
  assert.equal(m.gmailConsent(start, 'Claude Code'), '');
  const ticked = m.tickRow(m.initialPicks({ apps: { Gmail: { found: true } } }), 'email', 'Gmail', true);
  assert.deepEqual(Object.entries(ticked.apps).flatMap(([id, rows]) => Object.entries(rows).filter(([, on]) => on).map(([row]) => `${id}:${row}`)), ['email:Gmail'], 'ticking Gmail ticks nothing else');
  assert.equal(m.gmailConsent(ticked, 'Claude Code'), 'Gmail: the threads you approve, including what other people wrote in them, are read by Claude Code to sort and bring them in.');
  assert.ok(m.consentFor(ticked).includes('Gmail'));
  assert.deepEqual(m.choicesOf({ picks: ticked.picks, apps: ticked.apps }).sources.email, { on: true, apps: ['Gmail'], folders: [], repos: [] });
});

test('gmail_search: the period from the session as newer_than (1y, 6m, none), at most 50 threads, ids without their "#"', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: `#${thread(i)}`, subject: `Thread ${i}`, people: 'Dr. Lee, me', date: 'Mar 2' }));
  for (const [days, words] of [[365, 'pilot protocol newer_than:1y'], [182, 'pilot protocol newer_than:6m'], [null, 'pilot protocol']]) {
    const { call, page } = toolsWith({ days, page: fakePage({ rows }) });
    const out = await call('gmail_search', { n: 1, query: 'pilot protocol' });
    assert.equal(page.opened[0], `https://mail.google.com/mail/u/1/#search/${encodeURIComponent(words)}`);
    assert.equal(out.n, 1);
    assert.equal(out.ik, IK);
    assert.equal(out.threads.length, 50, 'limit is capped at 50');
    assert.equal(out.threads[0].id, thread(0), 'the "#" is taken off');
    assert.deepEqual(Object.keys(out.threads[0]), ['id', 'subject', 'people', 'date', 'imported']);
  }
  const { call } = toolsWith({ page: fakePage({ rows }) });
  assert.equal((await call('gmail_search', { n: 0, query: 'irb', limit: 500 })).threads.length, 50);
  assert.equal((await call('gmail_search', { n: 0, query: 'irb', limit: 3 })).threads.length, 3);
  await assert.rejects(call('gmail_search', { n: 0, query: '   ' }), /never an empty search/);
  await assert.rejects(call('gmail_search', { n: 0, query: 'newer_than:1y' }), /never an empty search/);
  await assert.rejects(call('gmail_search', { n: 1.5, query: 'irb' }), /n must be/);
  await assert.rejects(toolsWith({ page: fakePage({ signedIn: false }) }).call('gmail_search', { n: 0, query: 'irb' }), (error) => error.code === 'SIGNED_OUT');
});

test('gmail_accounts: each place in the sign-in order until a sign-in page or an address seen before', async () => {
  const accounts = ['a@uni.edu', 'b@gmail.com', 'a@uni.edu'];
  const page = { opened: [] };
  page.open = async (url) => { page.opened.push(url); return { url, title: 'Gmail' }; };
  page.evaluate = async () => { const n = page.opened.length - 1; return { signedIn: true, address: accounts[n], ik: `ik0000${n}`, path: `/mail/u/${n}/` }; };
  const { call } = toolsWith({ page, kind: 'survey' });
  assert.deepEqual(await call('gmail_accounts', {}), { accounts: [{ n: 0, address: 'a@uni.edu' }, { n: 1, address: 'b@gmail.com' }] });
  assert.deepEqual(page.opened, ['https://mail.google.com/mail/u/0/', 'https://mail.google.com/mail/u/1/', 'https://mail.google.com/mail/u/2/']);
  await assert.rejects(toolsWith({ page: fakePage({ signedIn: false }) }).call('gmail_accounts', {}), (error) => error.code === 'SIGNED_OUT');
  assert.ok(TOOLS_FOR.survey.includes('gmail_accounts') && TOOLS_FOR.survey.includes('gmail_search') && !TOOLS_FOR.survey.includes('import_gmail_threads'));
  await assert.rejects(toolsWith({ kind: 'survey' }).call('import_gmail_threads', { n: 0, ik: IK, threads: [] }), /A survey brings nothing in/);
});

test('import_gmail_threads: the exact print view, one note a thread (subject, people and dates, messages in order, attachment names only), never twice', async () => {
  const titles = [];
  const { call, page, session } = toolsWith({ added: (kind, n, title) => titles.push(title) });
  const before = new Set(mdFiles());
  const out = await call('import_gmail_threads', { n: 1, ik: IK, threads: [{ id: thread(7), subject: 'Pilot protocol' }] });
  assert.equal(out.added, 1);
  assert.deepEqual(page.downloads, [`https://mail.google.com/mail/u/1/?ik=${IK}&view=pt&search=all&permthid=${thread(7)}`]);
  assert.deepEqual(titles, ['Pilot protocol']);
  assert.equal(session.gmailThreads, 1, 'counted on the session');
  const written = mdFiles().filter((file) => !before.has(file));
  assert.equal(written.length, 1);
  const text = fs.readFileSync(written[0], 'utf8');
  assert.match(text, /^\*Gmail · Mon, Mar 2, 2026 at 9:10 AM–Tue, Mar 3, 2026 at 4:45 PM · Dr\. Lee, Sam Researcher\*/m);
  const lee = text.indexOf('**Dr. Lee**, Mon, Mar 2, 2026 at 9:10 AM'), sam = text.indexOf('**Sam Researcher**, Tue, Mar 3, 2026 at 4:45 PM');
  assert.ok(lee >= 0 && sam > lee, 'messages oldest first, each under its sender and date');
  assert.match(text, /Here is the draft protocol & the consent form\./);
  assert.match(text, /\[the IRB page\]\(https:\/\/example\.org\/irb\)/);
  assert.match(text, /Thanks, looks good\.\nOne question about recruitment\./, 'line breaks kept');
  assert.equal((text.match(/Here is the draft protocol/g) || []).length, 1, 'the quoted earlier message is left out of the reply');
  assert.doesNotMatch(text, /To: /, 'recipients are not the message');
  assert.match(text, /Attachments \(not brought in\): protocol-v2\.pdf\n?$/);
  assert.doesNotMatch(text, /attid=/, 'no attachment links');
  assert.equal(page.downloads.some((url) => /attid=/.test(url)), false, 'attachments are never downloaded');

  const again = await call('import_gmail_threads', { n: 1, ik: IK, threads: [{ id: thread(7), subject: 'Pilot protocol' }] });
  assert.deepEqual([again.added, again.skipped], [0, [{ id: thread(7), why: 'brought in before' }]]);
  assert.equal(page.downloads.length, 1, 'not downloaded again');
  const search = await toolsWith({ page: fakePage({ rows: [{ id: `#${thread(7)}`, subject: 'Pilot protocol' }] }) }).call('gmail_search', { n: 1, query: 'pilot' });
  assert.equal(search.threads[0].imported, true);
});

test('import_gmail_threads refuses bad ids and keys, more than 50 a call, past 300 a session, and a sign-in page', async () => {
  const { call, page } = toolsWith();
  const bad = await call('import_gmail_threads', { n: 0, ik: IK, threads: [{ id: '18f3a9c2b1d0e4f5', subject: 'hex' }, { id: 'thread-f:12a', subject: 'x' }, { id: '#thread-f:123', subject: 'x' }] });
  assert.equal(bad.added, 0);
  assert.deepEqual(bad.skipped.map((entry) => entry.why), ['not a Gmail thread id', 'not a Gmail thread id', 'not a Gmail thread id']);
  assert.equal(page.downloads.length, 0);
  await assert.rejects(call('import_gmail_threads', { n: 0, ik: 'Not-A-Key!', threads: [] }), /ik must be/);
  await assert.rejects(call('import_gmail_threads', { n: 12, ik: IK, threads: [] }), /n must be/);
  const many = Array.from({ length: 51 }, (_, i) => ({ id: thread(100 + i), subject: `T${i}` }));
  await assert.rejects(call('import_gmail_threads', { n: 0, ik: IK, threads: many }), /At most 50 threads a call/);
  const full = toolsWith({ session: { gmailThreads: 290 } });
  await assert.rejects(full.call('import_gmail_threads', { n: 0, ik: IK, threads: many.slice(0, 11) }), /At most 300 Gmail threads a session, and 290 came in already: bring in 10 more at most/);
  assert.equal(full.page.downloads.length, 0);
  const signIn = '<html><head><title>Gmail</title></head><body><form action="https://accounts.google.com/ServiceLogin"><input id="identifierId"></form></body></html>';
  await assert.rejects(toolsWith({ page: fakePage({ html: signIn }) }).call('import_gmail_threads', { n: 0, ik: IK, threads: [{ id: thread(500), subject: 'x' }] }), (error) => error.code === 'SIGNED_OUT');
});

test('a print view whose messages cannot be found is kept whole; one that mentions Google\'s sign-in in a message is not a sign-in page', () => {
  const plain = gmail.readThread('<html><title>Gmail - Odd</title><body><p>First line<br>second line</p><p>Report.docx</p></body></html>');
  assert.equal(plain.subject, 'Odd');
  assert.deepEqual(plain.messages, [{ sender: '', date: '', text: 'First line\nsecond line\n\nReport.docx' }]);
  assert.match(gmail.gmailThreadNote(plain), /^\*Gmail\*\n\nFirst line\nsecond line/);
  const alert = PRINT.replace('Thanks, looks good.', 'Sign in at https://accounts.google.com/ServiceLogin to check.');
  assert.equal(gmail.gmailSignedOut(alert), false);
  assert.equal(gmail.gmailPeriod(365), ' newer_than:1y');
  assert.equal(gmail.gmailPeriod(182), ' newer_than:6m');
  assert.equal(gmail.gmailPeriod(null), '');
  assert.throws(() => gmail.printUrl(0, IK, '18f3a9c2b1d0e4f5'), /Not a Gmail thread id/);
});

test('MEMORY.md is never told about Gmail jobs, and its agent is told to leave Gmail notes alone', () => {
  const job = (kind, source, apps, extra = {}) => ({ kind, source, apps, label: `${source} ${apps.join(',')}`, status: 'done', notes: 3, items: 0, summary: 'did it', error: '', titles: ['A title'], ...extra });
  const s = {
    choices: { sources: { email: { on: true, apps: ['Gmail'] }, notes: { on: true, apps: ['Obsidian'] } } },
    jobs: [job('import', 'email', ['Gmail']), job('import', 'email', []), job('survey', 'email', ['Gmail']), job('import', 'notes', ['Obsidian']), job('survey', 'notes', ['Google Docs']), job('import', 'notes', ['Gmail', 'Obsidian'])],
  };
  const { imports, surveys } = memoryJobs(s);
  assert.deepEqual(imports.map((entry) => entry.label), ['notes Obsidian']);
  assert.deepEqual(surveys.map((entry) => entry.app), ['Google Docs']);
  assert.match(prompts.MEMORY_SYSTEM_PROMPT, /source starts with "gmail:"/);
  assert.match(prompts.MEMORY_SYSTEM_PROMPT, /"\*Gmail · "/);
});

test('the librarian, the skill and the tools know Gmail\'s rules', () => {
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /Source ids: notes, transcripts, email, chats, sites, papers, code\./);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /Email \(Gmail\): never brought in whole, and nothing of it comes in without the person's yes/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /12 threads with Dr\. Lee about the protocol/);
  assert.match(prompts.INTERVIEW_SYSTEM_PROMPT, /the plan holds the account's n and ik/);
  assert.match(prompts.IMPORT_SYSTEM_PROMPT, /gmail_accounts, gmail_search, import_gmail_threads/);
  assert.match(SKILLS.Gmail, /Never assume n 0/);
  assert.match(SKILLS.Gmail, /never an empty search or the period alone/);
  assert.match(SKILLS.Gmail, /never download attachments/);
  assert.equal(importToolLabel('import_gmail_threads', { threads: [{}, {}] }), 'Bringing in 2 email threads');
});

test('the search page\'s script reads each shown row: its id without "#", subject, people and date; hidden rows are left out', async () => {
  const el = (attrs = {}, { text = '', kids = {}, shown = true, row = null } = {}) => ({
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null), innerText: text, textContent: text,
    checkVisibility: () => shown, closest: () => row, querySelectorAll: (sel) => kids[sel] || [], querySelector: (sel) => (kids[sel] || [])[0] || null,
  });
  const rowOf = (people, date) => el({}, { kids: { '[email]': people.map(([name, email]) => el({ name, email })), 'td.xW span[title], td.xW [title]': [el({ title: date })] } });
  const spans = [
    el({ 'data-thread-id': '#thread-f:1001' }, { text: 'Pilot  protocol', row: rowOf([['Dr. Lee', 'lee@uni.edu'], ['me', 'sam@uni.edu']], 'Mon, Mar 2, 2026, 9:10 AM') }),
    el({ 'data-thread-id': '#thread-f:1002' }, { text: 'Inbox row behind the search', shown: false, row: rowOf([], '') }),
    el({ 'data-thread-id': '#thread-f:1003' }, { text: 'IRB', row: rowOf([['IRB office', 'irb@uni.edu']], 'Feb 1') }),
  ];
  const document = { title: 'Search results - sam@uni.edu - Gmail', querySelectorAll: () => spans, querySelector: () => null, body: { innerText: '' } };
  const location = { hostname: 'mail.google.com', hash: '#search/pilot' };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const out = await new AsyncFunction('document', 'location', 'window', gmail.SEARCH_SCRIPT(50))(document, location, { GLOBALS: [0, 1, 2, 3, 4, 5, 6, 7, 8, IK] });
  assert.deepEqual(out, { signedIn: true, ik: IK, hash: '#search/pilot', none: false, threads: [
    { id: 'thread-f:1001', subject: 'Pilot protocol', people: 'Dr. Lee, me', date: 'Mon, Mar 2, 2026, 9:10 AM' },
    { id: 'thread-f:1003', subject: 'IRB', people: 'IRB office', date: 'Feb 1' },
  ] });
  const account = await new AsyncFunction('document', 'location', 'window', gmail.ACCOUNT_SCRIPT)(document, { hostname: 'mail.google.com', pathname: '/mail/u/1/' }, { GLOBALS: [0, 1, 2, 3, 4, 5, 6, 7, 8, IK] });
  assert.deepEqual(account, { signedIn: true, address: 'sam@uni.edu', ik: IK, path: '/mail/u/1/' });
});
