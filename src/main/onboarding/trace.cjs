'use strict';

// The agent trace (2026-10-13, the workspace: "create a plain UI like https://mathetic.com/bart that shows the prompts,
// input, output, and context for all the agents and dispatching involved in this process"). Every turn of onboarding's
// agents (the project and tool discovery agents, Connect's librarian, surveys, imports, recalls, MEMORY.md and its
// secrets check) is written down as it starts and as it ends: its kind, provider, model and effort, the system prompt,
// the message it was sent (which carries its context blocks), the folders it could read, what it did step by step, and
// what it answered or why it failed. So is the dispatching around them: each job queued with its plan, each step handed
// to the person, each line of a session's log.
//
// Kept on this Mac only, in the data root the agents ran in: <dataRoot>/.connect/trace/<YYYY-MM-DD>.jsonl, one entry a
// line, the newest days kept (MAX_DAYS). A field is cut at MAX_FIELD characters (the middle goes, with a note saying how
// much). The window that shows it (./trace-window.cjs) reads the last entries and is sent each new one.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FIELD = 400_000;
const MAX_MEMORY = 400;
const MAX_DAYS = 14;
const MAX_ACTIVITY = 300;
const MAX_PICTURES = 80;
const MAX_TRANSCRIPT = 200_000;

const cut = (value, max = MAX_FIELD) => {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (text.length <= max) return text;
  const half = Math.floor((max - 80) / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - 2 * half} characters left out of the trace …]\n\n${text.slice(-half)}`;
};

/**
 * `dataRoot()` the data root agents run in now; `notify(entry)` sends an entry to the trace window; `now()` the time.
 * → { turnStarted, turnEnded, event, list, wrap }
 */
function createTrace({ dataRoot, notify = () => {}, now = () => new Date().toISOString() }) {
  const recent = [];

  const dirOf = () => path.join(dataRoot(), '.connect', 'trace');

  function write(entry) {
    try {
      const dir = dirOf();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, `${String(entry.at).slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* the trace is a record, never in the way */ }
  }

  function keep(entry) {
    const at = recent.findIndex((one) => one.id === entry.id);
    if (at >= 0) recent[at] = entry; else recent.push(entry);
    if (recent.length > MAX_MEMORY) recent.splice(0, recent.length - MAX_MEMORY);
    write(entry);
    try { notify(entry); } catch { /* no window */ }
    return entry;
  }

  /** A turn begins → its entry (kept to be ended). */
  function turnStarted({ kind, choice = {}, system = '', message = '', dirs = [], session = null, meta = {} }) {
    const s = meta.session || null;
    const job = meta.job || null;
    return keep({
      id: randomUUID(), type: 'turn', at: now(), ended: null, status: 'running', kind,
      provider: choice.provider || '', model: choice.modelName || choice.model || '', modelId: choice.modelId || '', effort: choice.effort || '',
      label: (job && job.label) || meta.label || kind, sessionId: s ? s.id : meta.sessionId || null, jobId: job ? job.id : null,
      resumed: !!session, agentSession: session || null, dirs: (dirs || []).slice(0, 40),
      system: cut(system), message: cut(message), output: '', error: '', activity: [],
      // A browser agent's (kind browse): the command it ran in the Engelbart terminal, the screenshots it was shown (their
      // files in the session's steps folder), what its terminal printed.
      ...(kind === 'browse' ? { command: '', pictures: [], transcript: '' } : {}),
    });
  }

  /** What the turn is doing now (its CLI's events, already in words). */
  function turnActivity(entry, text) {
    if (!entry || !text) return;
    const last = entry.activity[entry.activity.length - 1];
    if (last && last.text === text) return;
    entry.activity.push({ at: now(), text: String(text).slice(0, 300) });
    if (entry.activity.length > MAX_ACTIVITY) entry.activity.splice(0, entry.activity.length - MAX_ACTIVITY);
  }

  /** A browser agent's command, screenshot or terminal transcript, kept with its turn. */
  function turnBrowse(entry, { command, picture, transcript } = {}) {
    if (!entry) return;
    if (command) entry.command = String(command).slice(0, 4000);
    if (picture && Array.isArray(entry.pictures) && entry.pictures.length < MAX_PICTURES) { entry.pictures.push({ at: now(), file: String(picture) }); keep(entry); }
    if (transcript) entry.transcript = cut(transcript, MAX_TRANSCRIPT);
  }

  function turnEnded(entry, { output = '', error = '', session = null } = {}) {
    if (!entry) return null;
    entry.ended = now();
    entry.status = error ? 'failed' : 'done';
    entry.output = cut(output);
    entry.error = cut(error, 4000);
    if (session) entry.agentSession = session;
    return keep(entry);
  }

  /** Dispatching: { kind: 'dispatch' | 'need' | 'log' | 'start' | …, sessionId, text, detail }. */
  function event({ kind = 'log', sessionId = null, jobId = null, text = '', detail = null }) {
    return keep({ id: randomUUID(), type: 'event', at: now(), kind, sessionId, jobId, text: String(text).slice(0, 2000), detail: detail == null ? null : cut(detail, 60_000) });
  }

  /** The last entries kept, oldest first; with none in memory yet, today's and yesterday's files. */
  function list() {
    if (recent.length) return recent.slice();
    const out = [];
    try {
      const files = fs.readdirSync(dirOf()).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
      for (const name of files.slice(-2)) {
        for (const line of fs.readFileSync(path.join(dirOf(), name), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const at = out.findIndex((one) => one.id === entry.id);
            if (at >= 0) out[at] = entry; else out.push(entry);
          } catch { /* a cut line */ }
        }
      }
      // Old days go.
      for (const name of files.slice(0, Math.max(0, files.length - MAX_DAYS))) fs.rmSync(path.join(dirOf(), name), { force: true });
    } catch { /* none yet */ }
    return out.slice(-MAX_MEMORY);
  }

  /** `agents` ({ turn }) with every turn traced. */
  function wrap(agents) {
    return {
      ...agents,
      async turn(input) {
        const entry = turnStarted(input);
        const onUpdate = (update) => {
          if (update && update.activity) turnActivity(entry, update.activity);
          if (update && (update.command || update.picture || update.transcript)) turnBrowse(entry, update);
          if (input.onUpdate) input.onUpdate(update);
        };
        try {
          const out = await agents.turn({ ...input, onUpdate });
          turnEnded(entry, { output: out && out.text, session: out && out.session });
          return out;
        } catch (error) {
          turnEnded(entry, { error: (error && error.message) || String(error) });
          throw error;
        }
      },
    };
  }

  return { turnStarted, turnActivity, turnBrowse, turnEnded, event, list, wrap };
}

module.exports = { createTrace, cut, MAX_FIELD };
