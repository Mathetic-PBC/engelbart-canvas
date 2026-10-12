'use strict';

// Connect your library (2026-10-07, second build): ChatGPT's and Claude's chats read from the person's own signed-in page,
// so neither export (an email with a link, hours later) is needed: "Instead of telling me to do stuff … do all this stuff
// for me". A script runs in the agent's hidden browser on chatgpt.com or claude.ai (./browser.cjs evaluate) and asks the
// site for what its own page asks it for: the conversation list and one conversation, as JSON. Those are the shapes the
// exports hold, so ./readers.cjs exportChat reads them into turns. If a site changes what it answers, the tool fails and
// the agent falls back to the page itself (./skills.cjs).

const { exportChat } = require('./readers.cjs');

const SITES = {
  ChatGPT: { start: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
  Claude: { start: 'https://claude.ai/recents', origin: 'https://claude.ai' },
};
const WEB_CHAT_APPS = Object.freeze(Object.keys(SITES));
const ID_RE = /^[\w-]{6,80}$/;
const MAX_LIST = 2000;

// Whether the account is signed in is told only by an answer that says so: an ok answer with no session (or no
// organization), or a 401. A 403, a 429, a 5xx, a network error or a body that isn't JSON says nothing either way (a
// test-mode run, 2026-10-12: one failed /api/auth/session read as "signed out" dropped ChatGPT's working sign-in), so the
// script answers { signedIn: null } and the tool asks once more a few seconds later before it gives up, without "signed out".
// ChatGPT: the page's own session token, then its conversation list (newest first, 100 a page) or one conversation.
const CHATGPT_LIST = (limit) => `
const asked = await fetch('/api/auth/session', { credentials: 'include' }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => undefined) : null })).catch(() => ({ status: 0, body: null }));
if (asked.status === 401) return { signedIn: false };
if (asked.status < 200 || asked.status > 299 || asked.body === undefined) return { signedIn: null, status: asked.status };
const session = asked.body;
if (!session || !session.accessToken) return { signedIn: false };
const headers = { Authorization: 'Bearer ' + session.accessToken };
const items = [], seen = new Set();
for (let offset = 0; items.length < ${limit}; ) {
  const r = await fetch('/backend-api/conversations?offset=' + offset + '&limit=100&order=updated', { headers, credentials: 'include' });
  if (!r.ok) return { signedIn: true, error: 'ChatGPT answered ' + r.status, items };
  const page = await r.json();
  const list = (page && page.items) || [];
  let fresh = 0;
  for (const c of list) { if (seen.has(c.id)) continue; seen.add(c.id); fresh += 1; items.push({ id: c.id, title: c.title || '', created: c.create_time, updated: c.update_time, project: c.gizmo_id || c.project_id || null }); }
  offset += list.length;
  if (!list.length || !fresh || (page.total && offset >= page.total)) break;
}
return { signedIn: true, account: (session.user && (session.user.email || session.user.name)) || '', items };`;

const CHATGPT_ONE = (id) => `
const asked = await fetch('/api/auth/session', { credentials: 'include' }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => undefined) : null })).catch(() => ({ status: 0, body: null }));
if (asked.status === 401) return { signedIn: false };
if (asked.status < 200 || asked.status > 299 || asked.body === undefined) return { signedIn: null, status: asked.status };
const session = asked.body;
if (!session || !session.accessToken) return { signedIn: false };
const r = await fetch('/backend-api/conversation/' + ${JSON.stringify(id)}, { headers: { Authorization: 'Bearer ' + session.accessToken }, credentials: 'include' });
if (!r.ok) return { signedIn: true, error: 'ChatGPT answered ' + r.status };
return { signedIn: true, conversation: await r.json() };`;

// Claude: the organization that chats, its projects (names for the list), then its conversations or one conversation.
const CLAUDE_ORG = `
const asked = await fetch('/api/organizations', { credentials: 'include' }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => undefined) : null })).catch(() => ({ status: 0, body: null }));
if (asked.status === 401) return { signedIn: false };
if (asked.status < 200 || asked.status > 299 || asked.body === undefined) return { signedIn: null, status: asked.status };
const orgs = asked.body;
if (!Array.isArray(orgs) || !orgs.length) return { signedIn: false };
const org = orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];`;

const CLAUDE_LIST = (limit) => `${CLAUDE_ORG}
const projects = await fetch('/api/organizations/' + org.uuid + '/projects', { credentials: 'include' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
const names = new Map((Array.isArray(projects) ? projects : []).map((p) => [p.uuid, p.name]));
const items = [], seen = new Set();
for (let offset = 0; items.length < ${limit}; ) {
  const r = await fetch('/api/organizations/' + org.uuid + '/chat_conversations?limit=100&offset=' + offset, { credentials: 'include' });
  if (!r.ok) return { signedIn: true, error: 'Claude answered ' + r.status, items };
  const list = await r.json();
  const rows = Array.isArray(list) ? list : (list && list.data) || [];
  let fresh = 0; // a site that ignores offset sends the same list again: stop there
  for (const c of rows) { if (seen.has(c.uuid)) continue; seen.add(c.uuid); fresh += 1; items.push({ id: c.uuid, title: c.name || '', created: c.created_at, updated: c.updated_at, project: (c.project && c.project.name) || names.get(c.project_uuid) || null }); }
  offset += rows.length;
  if (rows.length < 100 || !fresh) break;
}
return { signedIn: true, account: org.name || '', items };`;

const CLAUDE_ONE = (id) => `${CLAUDE_ORG}
const r = await fetch('/api/organizations/' + org.uuid + '/chat_conversations/' + ${JSON.stringify(id)} + '?tree=True&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
if (!r.ok) return { signedIn: true, error: 'Claude answered ' + r.status };
return { signedIn: true, conversation: await r.json() };`;

// The memory question's chat, deleted once its answer is kept (2026-10-12): what each site's own Delete calls. ChatGPT
// hides it (PATCH {"is_visible": false} with the page's session token, as its sidebar's Delete does); Claude deletes it
// (DELETE on the organization's chat_conversations/<uuid>, as claude.ai's own Delete and the community's bulk-delete
// scripts do). One id, given by the caller; never a list.
const CHATGPT_DELETE = (id) => `
const asked = await fetch('/api/auth/session', { credentials: 'include' }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => undefined) : null })).catch(() => ({ status: 0, body: null }));
if (asked.status === 401) return { signedIn: false };
if (asked.status < 200 || asked.status > 299 || asked.body === undefined) return { signedIn: null, status: asked.status };
const session = asked.body;
if (!session || !session.accessToken) return { signedIn: false };
const r = await fetch('/backend-api/conversation/' + ${JSON.stringify(id)}, { method: 'PATCH', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ is_visible: false }) });
if (!r.ok) return { signedIn: true, error: 'ChatGPT answered ' + r.status };
return { signedIn: true, deleted: true };`;

const CLAUDE_DELETE = (id) => `${CLAUDE_ORG}
const r = await fetch('/api/organizations/' + org.uuid + '/chat_conversations/' + ${JSON.stringify(id)}, { method: 'DELETE', credentials: 'include' });
if (!r.ok) return { signedIn: true, error: 'Claude answered ' + r.status };
return { signedIn: true, deleted: true };`;

const DAY_MS = 86_400_000;
const timeOf = (value) => (typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value) || 0);
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

function check(app) {
  if (!SITES[app]) throw new Error(`app must be one of ${WEB_CHAT_APPS.join(', ')}`);
}

function signedOut(app) {
  const error = new Error(`Not signed in to ${app} in Engelbart's browser. Call needs_you with kind "signin", then try again.`);
  error.code = 'SIGNED_OUT';
  return error;
}

const RETRY_MS = 3000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The script's answer, asked once more after a pause when it couldn't tell whether the account is signed in. */
async function ask(page, app, script, { sleep = wait, retryMs = RETRY_MS } = {}) {
  let out = await page.evaluate(script);
  if (out && out.signedIn === false) throw signedOut(app);
  if (!out || out.signedIn === null || out.signedIn === undefined) {
    await sleep(retryMs);
    out = await page.evaluate(script);
    if (out && out.signedIn === false) throw signedOut(app);
    if (!out || !out.signedIn) {
      const status = out && out.status ? ` (it answered ${out.status})` : '';
      const error = new Error(`${app} didn't say whether you're signed in${status}, twice. This is not a sign-out: reload the page and try again, or read the page itself.`);
      error.code = 'UNSURE';
      throw error;
    }
  }
  return out;
}

/**
 * The chats of a signed-in account, newest first → [{ id, title, date, project }], filtered by `days`, `query` (words in
 * the title or project) and `project` (part of its name). `page` is the job's browser (./browser.cjs tools).
 */
async function listWebChats(page, app, { days = null, query = '', project = '', limit = 200, sleep, retryMs } = {}) {
  check(app);
  await page.ensure(SITES[app].start);
  const out = await ask(page, app, app === 'ChatGPT' ? CHATGPT_LIST(MAX_LIST) : CLAUDE_LIST(MAX_LIST), { sleep, retryMs });
  if (out.error && !(out.items || []).length) throw new Error(`${out.error}. Fall back to reading the page.`);
  const since = Number.isFinite(days) && days > 0 ? Date.now() - days * DAY_MS : 0;
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = String(project || '').toLowerCase();
  const rows = [];
  for (const item of out.items || []) {
    if (!item || !ID_RE.test(String(item.id || ''))) continue;
    const updated = timeOf(item.updated || item.created);
    if (since && updated && updated < since) continue;
    const row = { id: String(item.id), title: clip(item.title || 'Untitled', 160), date: updated ? new Date(updated).toISOString() : null, project: item.project ? clip(item.project, 80) : null };
    if (words.length && !words.every((word) => `${row.title} ${row.project || ''}`.toLowerCase().includes(word))) continue;
    if (wanted && !(row.project || '').toLowerCase().includes(wanted)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { account: out.account || '', total: (out.items || []).length, chats: rows.slice(0, Math.min(Math.max(1, Math.round(limit) || 200), MAX_LIST)) };
}

/** One conversation read into turns → { id, title, date, turns: [{ role, text }] }. */
async function readWebChat(page, app, id, { sleep, retryMs } = {}) {
  check(app);
  if (!ID_RE.test(String(id || ''))) throw new Error('Not a conversation id');
  await page.ensure(SITES[app].start);
  const out = await ask(page, app, app === 'ChatGPT' ? CHATGPT_ONE(id) : CLAUDE_ONE(id), { sleep, retryMs });
  if (out.error || !out.conversation) throw new Error(out.error || `${app} sent no conversation`);
  const chat = exportChat(app === 'ChatGPT' ? { conversation_id: id, ...out.conversation } : { uuid: id, ...out.conversation });
  if (!chat) throw new Error(`${app}'s conversation could not be read`);
  return { id: String(id), title: chat.title || clip((chat.turns[0] || {}).text, 80) || `${app} chat`, date: chat.updated ? new Date(chat.updated).toISOString() : null, turns: chat.turns };
}

// A chat's id in its address: chatgpt.com/c/<id> (also inside a GPT or a project, /g/<gizmo>/c/<id>), claude.ai/chat/<uuid>.
const CHAT_ADDRESS = {
  ChatGPT: /^https:\/\/chatgpt\.com\/(?:g\/[\w-]+\/)?c\/([\w-]{6,80})(?:[/?#]|$)/,
  Claude: /^https:\/\/claude\.ai\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i,
};

/** The chat a ChatGPT or Claude address shows → its id, or null (a new-chat page, another site, another app). */
function chatIdOf(app, url) {
  const match = CHAT_ADDRESS[app] && CHAT_ADDRESS[app].exec(String(url || ''));
  return match ? match[1] : null;
}

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * Deletes the one chat Engelbart opened to ask its memory question (2026-10-12): `id` only, and only when its first message
 * is the question (`question`, the start of what was sent), so no other chat is ever touched → { deleted: true }, or throws.
 */
async function deleteWebChat(page, app, id, { question = '', sleep, retryMs } = {}) {
  check(app);
  if (!ID_RE.test(String(id || ''))) throw new Error('Not a conversation id');
  const chat = await readWebChat(page, app, id, { sleep, retryMs });
  const first = chat.turns.find((turn) => turn.role === 'user');
  const opening = squash(question).slice(0, 80);
  if (!opening || !first || !squash(first.text).startsWith(opening)) throw new Error('that chat is not the question Engelbart sent, so it was left as it is');
  const out = await ask(page, app, app === 'ChatGPT' ? CHATGPT_DELETE(id) : CLAUDE_DELETE(id), { sleep, retryMs });
  if (out.error || !out.deleted) throw new Error(out.error || `${app} did not delete it`);
  return { deleted: true };
}

module.exports = { WEB_CHAT_APPS, SITES, listWebChats, readWebChat, deleteWebChat, chatIdOf, CHATGPT_LIST, CLAUDE_LIST, CHATGPT_ONE, CLAUDE_ONE, CHATGPT_DELETE, CLAUDE_DELETE };
