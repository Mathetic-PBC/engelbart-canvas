'use strict';

// Connect your library's agents without a model (ENGELBART_CONNECT_FAKE=1, or ENGELBART_BART_FAKE=1), for scripted runs
// and tests: the librarian offers the button an app still needs, waits for a survey when nothing else is left, and asks
// one question per picked source (each option on its own line, with a why), handing the source over once answered; a
// survey reports three items; a recall saves a short profile; an import brings in a few notes from the vault, a few
// Claude Code chats or one note per web app through the real tools, so the progress, the staging and the project's notes
// are real; the memory agent drafts MEMORY.md with two planted secrets and the secrets check takes out one of them (the
// shape check takes the other). ENGELBART_CONNECT_FAKE_NEEDS=<app> makes that app's survey ask the person to sign in,
// unless they signed in on the card shown before the run.
// Same shape as ./agents.cjs turn().

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('Stopped.'); error.kind = 'stopped'; reject(error); }, { once: true });
});

const LABELS = { notes: 'Notes', transcripts: 'Meeting transcripts', chats: 'AI chats', sites: 'Websites', papers: 'Papers', code: 'Code' };

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
    const options = surveyed ? [{ label: 'Everything', why: '' }, ...surveyed.map((item) => ({ label: item.label, why: item.why || '' }))] : [{ label: 'Everything', why: 'all of it' }, { label: 'Only the last 30 days', why: '' }, { label: 'Leave it out', why: '' }];
    return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now.` : 'Let me check a few things.', ask: { source, kind: surveyed ? 'multi' : 'single', title: `What from ${label.toLowerCase()}?`, options }, authorize: null, dispatch, waiting: false, done: false };
  }
  if (waitFor) return { say: `${dispatch.length ? `Bringing in ${dispatch[0].label} now. ` : ''}Looking through your ${LABELS[waitFor].toLowerCase()} now.`, ask: null, authorize: null, dispatch, waiting: true, done: false };
  return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now. That's everything.` : 'That\'s everything.', ask: null, authorize: null, dispatch, waiting: false, done: true };
}

async function surveyRun({ session: s, job, callTool }, delayMs, signal) {
  const app = job.apps[0];
  await sleep(delayMs, signal);
  // Signed in on the card shown before the run (session.cjs signInsFirst): nothing to ask again.
  const signedInFirst = !!(s && s.needs.some((need) => need.app === app && need.upfront && need.outcome === 'done'));
  if (!signedInFirst && String(process.env.ENGELBART_CONNECT_FAKE_NEEDS || '').split(',').includes(app)) {
    let out = await callTool('needs_you', { kind: 'signin', reason: `Sign in to ${app}` });
    for (let n = 0; n < 10 && out.status === 'waiting'; n += 1) out = await callTool('wait_for_you', {});
    if (out.status === 'skipped') return JSON.stringify({ app, signedIn: false, summary: `${app} was skipped.`, items: [] });
  }
  return JSON.stringify({ app, signedIn: true, summary: `3 things in ${app}.`, total: 3, items: [1, 2, 3].map((n) => ({ id: `${app.toLowerCase().replace(/\W+/g, '-')}-${n}`, label: `${app} item ${n}`, kind: 'doc', date: '2026-10-0' + n, where: null, why: n === 1 ? 'research' : null })) });
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
  for (const app of webApps) { const out = await callTool('add_note', { title: `${app}: fake note`, markdown: `A note the fake agent brought in from ${app}.`, source: `fake:${app}` }); if (out.added) n += 1; }
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
