'use strict';

// Recent projects from the person's ChatGPT or Claude (2026-10-16, Hudson's Onboarding note, Backend ▸ Projects): when
// their Claude Code and Codex sessions name no project (a new Mac, someone who only ever used the apps), "it should go to
// their ChatGPT or Claude and give it the same prompt it would give Claude Code or Codex to output the JSON with the
// projects. Add an escape measure in the prompt for that though to all the agent to return a null JSON if there is so
// memory." The question is ./prompts.cjs assistantProjectsPrompt; the assistant answers from its memory of the person.
//
// How: only with the person's leave to use their browser's sign-ins (Keychain 'allowed'; ./discover.cjs says when). Their
// ChatGPT and Claude sign-ins are copied from the chosen browser profile into Engelbart's browser (../connect/web-signin.cjs
// signInQuiet), and Engelbart itself, not a model, asks in a hidden window of ../connect/browser.cjs: the new-chat page,
// the question typed into the message box and sent once (the window is opened with `sendOnly`, the question, so nothing
// else can be typed or sent), the answer read from the site's own conversation endpoint (../connect/web-chats.cjs
// readWebChat, the fixed reader the library import uses), then that one chat deleted (deleteWebChat, which checks its
// first message is the question). No agent: ChatGPT and Claude are read only by Engelbart's fixed readers (From Amitav,
// 2026-10-15), an agent turn would add a minute or more, and the question is a fixed text. Never a visible window
// (nothing here calls show, and nobody is asked anything); each assistant is bounded by ASK_TIMEOUT_MS, and both are
// asked at once.
//
// Each assistant's outcome: 'found' (projects), 'none' (it answered null or named none: nothing known, not a failure),
// 'unavailable' (not signed in, or its sign-in did not work here: nothing to ask, not a failure) or 'broke' (the page,
// the send or the answer went wrong, or it answered something that is not the JSON: a failure, with `error`).

const fs = require('node:fs');
const { APPS } = require('../../shared/connect-sources.cjs');
const { readProjects } = require('../../shared/import-flow.cjs');
const { chatIdOf, readWebChat, deleteWebChat, listWebChats } = require('../connect/web-chats.cjs');

const ASSISTANTS = Object.freeze(['ChatGPT', 'Claude']);
const NEW_CHAT = Object.freeze({ ChatGPT: 'https://chatgpt.com/', Claude: 'https://claude.ai/new' });
const SIGN_IN_TIMEOUT_MS = 20_000;
const ASK_TIMEOUT_MS = 150_000;
const SENT_WAIT_MS = 20_000;
const POLL_MS = 3000;
// An answer that is not the JSON is taken as it is once it has stood this many reads (a reply in words, say), not
// waited on to the end: Claude may write a line before it looks in its memory, so one still read is not enough.
const MALFORMED_STILL = 4;

// Signed in, asked of the site itself before anything is typed (a signed-out ChatGPT still takes a message, as a guest's):
// ChatGPT's session token, Claude's organizations. → { signedIn: true | false | null }, null when it could not tell.
const SIGNED_IN = Object.freeze({
  ChatGPT: `
const r = await fetch('/api/auth/session', { credentials: 'include' }).catch(() => null);
if (!r) return { signedIn: null };
if (r.status === 401) return { signedIn: false };
if (!r.ok) return { signedIn: null, status: r.status };
const body = await r.json().catch(() => undefined);
if (body === undefined) return { signedIn: null };
return { signedIn: !!(body && body.accessToken) };`,
  Claude: `
const r = await fetch('/api/organizations', { credentials: 'include' }).catch(() => null);
if (!r) return { signedIn: null };
if (r.status === 401) return { signedIn: false };
if (!r.ok) return { signedIn: null, status: r.status };
const body = await r.json().catch(() => undefined);
if (body === undefined) return { signedIn: null };
return { signedIn: Array.isArray(body) && body.length > 0 };`,
});

// The message box, found by Engelbart's own script (the page's controls as browser_read lists them leave out a box with
// no name, as ChatGPT's may be): ChatGPT's #prompt-textarea, Claude's editor, any other visible editor or textarea. It is
// given a ref (data-eb-ref) the way browser_read gives one, so the browser's own type() (held to `sendOnly`) types into it.
const FIND_COMPOSER = `
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
const picks = ['#prompt-textarea[contenteditable="true"]', '#prompt-textarea', 'div[contenteditable="true"][role="textbox"]', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"]', 'textarea'];
for (const selector of picks) {
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.type === 'password' || el.readOnly || el.disabled) continue;
    const root = document.documentElement;
    let ref = el.getAttribute('data-eb-ref');
    if (!ref) { const next = Number(root.getAttribute('data-eb-next') || '0') + 1; root.setAttribute('data-eb-next', String(next)); ref = 'e' + next; el.setAttribute('data-eb-ref', ref); }
    return { ref, selector };
  }
}
return { ref: null, url: location.href };`;

// The site sent the window to its sign-in page (checked 2026-10-16 on claude.ai signed out: /new goes to /logout, then
// /login, and /api/organizations answers 403, not 401, so the page's address is what tells).
function atSignIn(url) {
  try {
    const { hostname, pathname } = new URL(String(url));
    return /^auth[0-9]*\.openai\.com$/.test(hostname) || /^\/(?:auth\/)?(?:login|logout|log-in|signin|sign-in)\b/i.test(pathname);
  } catch { return false; }
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

class RouteError extends Error {
  constructor(outcome, message) { super(message); this.outcome = outcome; }
}

/**
 * An assistant's answer → { kind: 'projects', projects } | { kind: 'none' } (null, {"projects": null} or no projects) |
 * { kind: 'empty' } (no text) | { kind: 'malformed' } (anything else). A fence or quotes around it are taken off first.
 */
function readAnswer(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!raw) return { kind: 'empty' };
  if (/^["'`*_]*null["'`*_]*\.?$/i.test(raw)) return { kind: 'none' };
  let value;
  try { value = JSON.parse(raw); } catch {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { kind: 'malformed' };
    try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return { kind: 'malformed' }; }
  }
  if (value === null) return { kind: 'none' };
  if (!value || typeof value !== 'object' || !('projects' in value)) return { kind: 'malformed' };
  if (value.projects === null || (Array.isArray(value.projects) && value.projects.length === 0)) return { kind: 'none' };
  const read = readProjects(JSON.stringify(value));
  return read ? { kind: 'projects', projects: read.projects } : { kind: 'malformed' };
}

/** The assistant's last answer after the question in a chat read by readWebChat, or ''. */
function answerIn(chat, question) {
  const turns = (chat && chat.turns) || [];
  const asked = turns.findIndex((turn) => turn.role === 'user' && squash(turn.text).startsWith(squash(question).slice(0, 80)));
  const after = asked >= 0 ? turns.slice(asked + 1) : [];
  const last = after.filter((turn) => turn.role === 'assistant').pop();
  return last ? String(last.text || '').trim() : '';
}

/**
 * `webSignIn` (../connect/web-signin.cjs), `agentBrowser` (../connect/browser.cjs createAgentBrowser), `log(text, detail)`
 * the trace; timings for tests. → { ask({ apps, question, signal }) → [{ app, outcome, projects?, error?, answer? }] }
 */
function createAssistantProjects({ webSignIn, agentBrowser, log = () => {}, sleep = wait, signInTimeoutMs = SIGN_IN_TIMEOUT_MS, askTimeoutMs = ASK_TIMEOUT_MS, sentWaitMs = SENT_WAIT_MS, pollMs = POLL_MS, now = () => Date.now() }) {
  /** The question asked in `page` (a window of `app`'s sites, `sendOnly` the question) → readAnswer's answer. */
  async function askIn(page, app, question, { signal, deadline }) {
    const stopped = () => !!(signal && signal.aborted);
    const stop = () => { if (stopped()) throw new RouteError('broke', 'Stopped.'); };
    let id = null;
    try {
      await page.open(NEW_CHAT[app]);
      stop();
      const signedOut = () => new RouteError('unavailable', `Not signed in to ${app} in Engelbart's browser`);
      if (atSignIn(page.url())) throw signedOut();
      let signed = await page.evaluate(SIGNED_IN[app]).catch(() => null);
      if (!signed || signed.signedIn === null || signed.signedIn === undefined) { await sleep(pollMs); signed = await page.evaluate(SIGNED_IN[app]).catch(() => null); }
      if ((signed && signed.signedIn === false) || atSignIn(page.url())) throw signedOut();
      if (!signed || !signed.signedIn) throw new RouteError('broke', `${app} didn't say whether you're signed in`);
      stop();
      const box = await page.evaluate(FIND_COMPOSER);
      if (!box || !box.ref) throw new RouteError('broke', `${app}'s message box wasn't found`);
      await page.type(box.ref, question);
      // Its Send button when the page shows one (pressing it is the one send the window allows), else Enter in the box.
      const shown = await page.read({ maxChars: 500 }).catch(() => null);
      const send = shown && (shown.elements || []).find((el) => /^send\b/i.test(String(el.name || '')) && !el.disabled && /button/.test(String(el.role || '')));
      if (send) await page.click(send.ref);
      else await page.press('Enter');
      // Sent: the page moves to the new chat's address. If it never does, the chat the question opened is looked for in
      // the account's newest chats (its first message is the question), so a question sent is always found and deleted.
      const sentBy = now() + sentWaitMs;
      while (!id && now() < sentBy && !stopped()) { id = chatIdOf(app, page.url()); if (!id) await sleep(Math.min(500, pollMs)); }
      if (!id && !stopped()) {
        const recent = await listWebChats(page, app, { limit: 5 }).catch(() => ({ chats: [] }));
        for (const chat of recent.chats || []) {
          if (chat.date && now() - Date.parse(chat.date) > 15 * 60_000) continue;
          const read = await readWebChat(page, app, chat.id).catch(() => null);
          const first = read && read.turns.find((turn) => turn.role === 'user');
          if (first && squash(first.text).startsWith(squash(question).slice(0, 80))) { id = chat.id; break; }
        }
      }
      stop();
      if (!id) throw new RouteError('broke', `The question wasn't sent to ${app}`);
      log(`Asked ${app} about the person's projects`, { app, chat: id });
      // The answer, read from the site's own endpoint until it stands (two reads alike) and is the JSON or null; one that
      // isn't is taken once it has stood MALFORMED_STILL reads.
      let last = null, still = 0;
      while (now() < deadline && !stopped()) {
        let chat = null;
        try { chat = await readWebChat(page, app, id); } catch (error) { if (error && error.code === 'SIGNED_OUT') throw new RouteError('unavailable', `Not signed in to ${app} in Engelbart's browser`); }
        const text = answerIn(chat, question);
        still = text && text === last ? still + 1 : 0;
        last = text;
        if (text && still >= 1) {
          const answer = readAnswer(text);
          if (answer.kind !== 'malformed' || still >= MALFORMED_STILL) return { ...answer, text };
        }
        await sleep(pollMs);
      }
      stop();
      if (last) return { ...readAnswer(last), text: last };
      throw new RouteError('broke', `${app} didn't answer in ${Math.round(askTimeoutMs / 1000)} seconds`);
    } finally {
      if (id) {
        try { await deleteWebChat(page, app, id, { question }); log(`Deleted the question from ${app}'s chats`, { app }); } catch (error) { log(`Couldn't delete the question from ${app}'s chats: ${(error && error.message) || error}`, { app }); }
      }
    }
  }

  /** One assistant asked → { app, outcome, projects?, error? } */
  async function askOne(app, question, signal) {
    if (!webSignIn || !agentBrowser || !NEW_CHAT[app]) return { app, outcome: 'unavailable' };
    let signedIn = null;
    try { signedIn = await Promise.race([Promise.resolve().then(() => webSignIn.signInQuiet(app)), wait(signInTimeoutMs).then(() => null)]); } catch { signedIn = null; }
    if (!signedIn || !signedIn.signedIn) { log(`Not asking ${app}: not signed in to it in the chosen browser`, { app }); return { app, outcome: 'unavailable' }; }
    if (signal && signal.aborted) return { app, outcome: 'broke', error: 'Stopped.' };
    const job = { id: `discover-projects-${app.toLowerCase()}-${now()}`, label: `Asking ${app} about your projects`, sites: (APPS[app] && APPS[app].sites) || [], sendOnly: question };
    const page = agentBrowser.tools(job);
    const deadline = now() + askTimeoutMs;
    try {
      const answer = await askIn(page, app, question, { signal, deadline });
      if (answer.kind === 'projects') {
        // An assistant can't see this Mac: a folder it names is kept only when it is there.
        const projects = answer.projects.map((project) => ({ ...project, folder: project.folder && fs.existsSync(project.folder) ? project.folder : '', evidence: project.evidence || `From ${app}'s memory` }));
        return { app, outcome: 'found', projects };
      }
      if (answer.kind === 'none') return { app, outcome: 'none' };
      return { app, outcome: 'broke', error: answer.kind === 'empty' ? `${app} sent an empty answer` : `${app} did not answer as asked`, answer: String(answer.text || '').slice(0, 300) };
    } catch (error) {
      return { app, outcome: error instanceof RouteError ? error.outcome : 'broke', error: String((error && error.message) || error).slice(0, 300) };
    } finally {
      try { agentBrowser.close(job.id); } catch { /* gone */ }
    }
  }

  /** Every assistant in `apps` asked at once. */
  async function ask({ apps = ASSISTANTS, question, signal = null } = {}) {
    const wanted = apps.filter((app) => ASSISTANTS.includes(app));
    return Promise.all(wanted.map((app) => askOne(app, question, signal)));
  }

  return { ask };
}

/**
 * The projects several answers named, in `order`'s order, one per title (the first kept), at most `max`, none already
 * in `existing` (their Engelbart projects' names) unless that leaves none.
 */
function mergeProjects(lists, { existing = [], max = 5 } = {}) {
  const key = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const have = new Set(existing.map(key));
  const seen = new Set(), ids = new Set(), all = [], fresh = [];
  for (const list of lists) {
    for (const project of list || []) {
      const k = key(project.title);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      let id = project.id;
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      const row = { ...project, id };
      all.push(row);
      if (!have.has(k)) fresh.push(row);
    }
  }
  return (fresh.length ? fresh : all).slice(0, max);
}

module.exports = { createAssistantProjects, readAnswer, answerIn, mergeProjects, atSignIn, ASSISTANTS, NEW_CHAT, FIND_COMPOSER, SIGNED_IN, ASK_TIMEOUT_MS, SIGN_IN_TIMEOUT_MS };
