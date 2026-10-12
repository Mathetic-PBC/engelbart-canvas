'use strict';

// Connect your library's agents without a model (ENGELBART_CONNECT_FAKE=1, or ENGELBART_BART_FAKE=1), for scripted runs
// and tests: the librarian offers the button an app still needs, waits for a survey when nothing else is left, and asks
// one question per picked source (each option on its own line, with a why; a survey's items as a "multi" with the first
// ticked), handing the source over once answered; a
// survey reports three items; a recall saves a short profile; an import brings in a few notes from the vault, a few
// Claude Code chats or one note per web app through the real tools, so the progress, the staging and the project's notes
// are real; the memory agent drafts MEMORY.md with two planted secrets and the secrets check takes out one of them (the
// shape check takes the other). ENGELBART_CONNECT_FAKE_NEEDS=<app> makes that app's survey ask the person to sign in,
// unless they signed in on the card shown before the run. A search for an app's folder (MATH-117) finds it when the test
// home holds one: a vault (a folder with .obsidian), a Zoom folder of meeting folders with transcripts, folders of PDFs.
// Same shape as ./agents.cjs turn().

const fs = require('node:fs');
const path = require('node:path');
const { shownName, LOCAL_PDFS } = require('../../shared/connect-sources.cjs');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('Stopped.'); error.kind = 'stopped'; reject(error); }, { once: true });
});

const LABELS = { notes: 'Notes', transcripts: 'Meeting transcripts', email: 'Email', chats: 'AI chats', sites: 'Websites', papers: 'Papers', code: 'Code' };

function interviewReply(s, message) {
  const state = s.fakeState || (s.fakeState = { asked: [], offered: [] });
  const last = state.asked[state.asked.length - 1];
  const dispatch = [];
  if (last && !last.answered && message !== 'Start.' && !/^(authorized|signed in|allowed|chose|survey finished)/.test(message)) {
    last.answered = message;
    if (!/Leave it out|skipped/.test(message)) dispatch.push({ source: last.source, apps: [], label: last.label, plan: `Fake import of ${last.label}: ${message}` });
  }
  let waitFor = null;
  for (const [source, choice] of Object.entries(s.choices.sources)) {
    if (!choice.on || state.asked.some((entry) => entry.source === source)) continue;
    const found = (s.found || {})[source] || {};
    const needs = choice.apps.find((app) => found[app] && found[app].needs && !state.offered.includes(app));
    if (needs) {
      state.offered.push(needs);
      const kind = found[needs].needs;
      return { say: `${needs} needs a step from you first.`, ask: null, authorize: { source, app: needs, kind, label: kind === 'connector' || kind === 'signin' ? `Sign in to ${needs}` : kind === 'permission' ? `Allow Engelbart to read ${needs}` : `Choose your ${needs} folder…` }, dispatch, waiting: false, done: false };
    }
    if (choice.apps.some((app) => found[app] && found[app].survey === 'running')) { waitFor = waitFor || source; continue; }
    const label = LABELS[source];
    const surveyed = choice.apps.map((app) => found[app] && found[app].survey && found[app].survey.items).find((items) => Array.isArray(items) && items.length);
    state.asked.push({ source, label });
    // A survey's items come as a "multi" with the first ticked (the librarian's recommendation, MATH-122), that one with
    // a detail (its title, kind, date and where, as the prompt asks for a single item); otherwise a "single" whose first
    // option is the recommended one.
    const options = surveyed ? surveyed.map((item, i) => ({ label: item.label, why: item.why || '', checked: i === 0, ...(i === 0 ? { detail: [item.label, item.kind, item.date, item.where].filter(Boolean).join(' · ') } : {}) })) : [{ label: 'Everything', why: 'all of it' }, { label: 'Only the last 30 days', why: '' }, { label: 'Leave it out', why: '' }];
    return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now.` : 'Let me check a few things.', ask: { source, kind: surveyed ? 'multi' : 'single', title: `What from ${label.toLowerCase()}?`, options }, authorize: null, dispatch, waiting: false, done: false };
  }
  if (waitFor) return { say: `${dispatch.length ? `Bringing in ${dispatch[0].label} now. ` : ''}Looking through your ${LABELS[waitFor].toLowerCase()} now.`, ask: null, authorize: null, dispatch, waiting: true, done: false };
  return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now. That's everything.` : 'That\'s everything.', ask: null, authorize: null, dispatch, waiting: false, done: true };
}

/** The folders under `home`, breadth first, Library and hidden folders passed over, at most a few levels down. */
function foldersUnder(home, depth = 5, readable = null) {
  const out = [];
  let level = [home];
  for (let n = 0; n < depth && level.length; n += 1) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'Library' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (readable && !readable(full)) continue; // a protected folder macOS did not let Engelbart read (MATH-110)
        out.push(full);
        next.push(full);
      }
    }
    level = next;
  }
  return out;
}

const names = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

function findRun(s, app) {
  const all = foldersUnder(s.homeDir, 5, s.readable);
  const searched = 'every folder of the home folder but Library and the hidden ones';
  if (app === LOCAL_PDFS) {
    const folders = all.filter((dir) => names(dir).some((entry) => entry.isFile() && /\.pdf$/i.test(entry.name)));
    return { app, signedIn: true, summary: folders.length ? `PDFs in ${folders.length} folders.` : 'No PDFs found.', items: [], folders, searched };
  }
  const folder = app === 'Obsidian'
    ? all.find((dir) => names(dir).some((entry) => entry.isDirectory() && entry.name === '.obsidian'))
    : all.find((dir) => /^zoom$/i.test(path.basename(dir)) && names(dir).some((entry) => entry.isDirectory() && names(path.join(dir, entry.name)).some((file) => file.isFile() && /\.(vtt|txt)$/i.test(file.name))));
  return { app, signedIn: true, summary: folder ? `Found the ${shownName(app)} folder.` : `No ${shownName(app)} folder found.`, items: [], folder: folder || null, searched, notes: !folder && app === 'Zoom' ? 'No recordings on this Mac; cloud recordings at zoom.us/recording.' : null };
}

async function surveyRun({ session: s, job, callTool }, delayMs, signal) {
  const app = job.apps[0];
  await sleep(delayMs, signal);
  if (job.find) return JSON.stringify(findRun(s, app));
  if (String(process.env.ENGELBART_CONNECT_FAKE_NEEDS || '').split(',').includes(app)) {
    let out = await callTool('needs_you', { kind: 'signin', reason: `Sign in to ${shownName(app)}` });
    for (let n = 0; n < 10 && out.status === 'waiting'; n += 1) out = await callTool('wait_for_you', {});
    if (out.status === 'skipped') return JSON.stringify({ app, signedIn: false, summary: `${shownName(app)} was skipped.`, items: [] });
  }
  return JSON.stringify({ app, signedIn: true, summary: `3 things in ${shownName(app)}.`, total: 3, items: [1, 2, 3].map((n) => ({ id: `${app.toLowerCase().replace(/\W+/g, '-')}-${n}`, label: `${shownName(app)} item ${n}`, kind: 'doc', date: '2026-10-0' + n, where: null, why: n === 1 ? 'research' : null })) });
}

async function importRun({ session: s, job, callTool }, delayMs, signal) {
  await sleep(delayMs, signal);
  if (job.source === 'notes' && (!job.apps.length || job.apps.includes('Obsidian'))) {
    const vaults = require('./readers.cjs').obsidianVaults(s.homeDir);
    const folder = s.picked.folders.Obsidian || (s.choices.sources.notes.folders || [])[0] || (vaults[0] && vaults[0].path);
    if (folder) {
      const listed = await callTool('list_note_files', { folder });
      await sleep(delayMs, signal);
      const out = await callTool('import_note_files', { files: listed.files.slice(0, 5), root: folder });
      return `Brought in ${out.added} notes.`;
    }
  }
  if (job.source === 'chats' && s.choices.sources.chats.apps.includes('Claude Code') && (!job.apps.length || job.apps.includes('Claude Code'))) {
    const chats = await callTool('list_chats', { app: 'Claude Code', limit: 3 });
    const out = await callTool('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) });
    return `Brought in ${out.added} chats.`;
  }
  const webApps = (job.apps.length ? job.apps : (s.choices.sources[job.source] || {}).apps || []).filter((app) => app !== 'Obsidian' && app !== 'Claude Code');
  let n = 0;
  for (const app of webApps) { const out = await callTool('add_note', { title: `${shownName(app)}: fake note`, markdown: `A note the fake agent brought in from ${shownName(app)}.`, source: `fake:${app}` }); if (out.added) n += 1; }
  await sleep(delayMs, signal);
  return n ? `Brought in ${n} notes.` : 'Nothing to bring in from the fake agent.';
}

async function recallRun({ job, callTool }, delayMs, signal) {
  await sleep(delayMs, signal);
  const app = job.apps[0];
  await callTool('save_memory', { app, text: `# Research profile\n\nStudies how novices ask for help [stated]. Works with ${app} on study design [inferred].` });
  return `Saved ${app}'s answer.`;
}

const MEMORY_DRAFT = `# Memory

A researcher who studies help-seeking in novice programmers [stated].

## Research
- Why novices skip tests [stated].

## Where their work lives
- Obsidian notes; Claude Code sessions.

password: hunter2
Their OpenAI key, sk-test-0123456789abcdefghij, was pasted in a chat.

## Sources
- The fake recall, ${new Date().toISOString().slice(0, 10)}.`;

function createFakeConnectAgents({ delayMs = 600 } = {}) {
  return {
    async turn({ meta, signal, kind, message }) {
      const what = (meta && meta.kind) || kind;
      if (what === 'survey') return { text: await surveyRun(meta, delayMs, signal), session: null };
      if (what === 'import') return { text: await importRun(meta, delayMs, signal), session: null };
      if (what === 'recall') return { text: await recallRun(meta, delayMs, signal), session: null };
      if (what === 'memory') { await sleep(delayMs, signal); return { text: MEMORY_DRAFT, session: null }; }
      if (what === 'redact') { await sleep(delayMs, signal); const draft = String(message).replace(/^<memory_md>\n|\n<\/memory_md>$/g, ''); return { text: draft.replace('password: hunter2', 'password: [removed]'), session: null }; }
      await sleep(delayMs, signal);
      return { text: JSON.stringify(interviewReply(meta.session, meta.message)), session: 'fake-session' };
    },
  };
}

module.exports = { createFakeConnectAgents, interviewReply, MEMORY_DRAFT };
