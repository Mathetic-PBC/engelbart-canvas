'use strict';

// Connect your library's agents without a model (ENGELBART_CONNECT_FAKE=1, or ENGELBART_BART_FAKE=1), for scripted runs
// and tests: the librarian asks one question per picked source (or offers the button an app still needs) and hands the
// source over once answered; an import brings in a few notes from the vault or a few Claude Code chats through the real
// tools, so the progress, the staging and the project's notes are real. Same shape as ./agents.cjs turn().

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('Stopped.'); error.kind = 'stopped'; reject(error); }, { once: true });
});

function interviewReply(s, message) {
  const state = s.fakeState || (s.fakeState = { asked: [], offered: [] });
  const last = state.asked[state.asked.length - 1];
  const dispatch = [];
  if (last && !last.answered && message !== 'Start.' && !/^connected |^chose /.test(message)) {
    last.answered = message;
    if (!/Leave it out|skipped/.test(message)) dispatch.push({ source: last.source, apps: [], label: last.label, plan: `Fake import of ${last.label}: ${message}` });
  }
  for (const [source, choice] of Object.entries(s.choices.sources)) {
    if (!choice.on || state.asked.some((entry) => entry.source === source)) continue;
    const found = (s.found || {})[source] || {};
    const needs = choice.apps.find((app) => found[app] && found[app].needs && !state.offered.includes(app));
    if (needs) {
      state.offered.push(needs);
      const kind = found[needs].needs === 'signin' ? 'signin' : found[needs].needs === 'file' ? 'file' : 'folder';
      return { say: `${needs} needs a step from you first.`, ask: null, connect: { source, app: needs, kind, label: kind === 'signin' ? `Sign in to ${needs}` : `Choose ${needs}…` }, dispatch, done: false };
    }
    const label = { notes: 'Notes', transcripts: 'Meeting transcripts', chats: 'AI chats', sites: 'Websites', papers: 'Papers', code: 'Code' }[source];
    state.asked.push({ source, label });
    return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now.` : 'Let me check a few things.', ask: { source, kind: 'single', title: `What from ${label.toLowerCase()}?`, options: ['Everything', 'Only the last 30 days', 'Leave it out'] }, connect: null, dispatch, done: false };
  }
  return { say: dispatch.length ? `Bringing in ${dispatch[0].label} now. That's everything.` : 'That\'s everything.', ask: null, connect: null, dispatch, done: true };
}

async function importRun({ session: s, job, callTool }, delayMs, signal) {
  await sleep(delayMs, signal);
  if (job.source === 'notes') {
    const vaults = require('./readers.cjs').obsidianVaults(s.homeDir);
    const folder = s.picked.folders.Obsidian || (s.choices.sources.notes.folders || [])[0] || (vaults[0] && vaults[0].path);
    if (!folder) return 'No vault to read.';
    const listed = await callTool('list_note_files', { folder });
    await sleep(delayMs, signal);
    const out = await callTool('import_note_files', { files: listed.files.slice(0, 5), root: folder });
    return `Brought in ${out.added} notes.`;
  }
  if (job.source === 'chats' && s.choices.sources.chats.apps.includes('Claude Code')) {
    const chats = await callTool('list_chats', { app: 'Claude Code', limit: 3 });
    const out = await callTool('import_chats', { app: 'Claude Code', ids: chats.map((chat) => chat.id) });
    return `Brought in ${out.added} chats.`;
  }
  await sleep(delayMs, signal);
  return 'Nothing to bring in from the fake agent.';
}

function createFakeConnectAgents({ delayMs = 600 } = {}) {
  return {
    async turn({ meta, signal }) {
      if (meta && meta.kind === 'import') return { text: await importRun(meta, delayMs, signal), session: null };
      await sleep(delayMs, signal);
      return { text: JSON.stringify(interviewReply(meta.session, meta.message)), session: 'fake-session' };
    },
  };
}

module.exports = { createFakeConnectAgents, interviewReply };
