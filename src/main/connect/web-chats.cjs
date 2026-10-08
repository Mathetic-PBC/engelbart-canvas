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

// ChatGPT: the page's own session token, then its conversation list (newest first, 100 a page) or one conversation.
const CHATGPT_LIST = (limit) => `
const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
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
const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!session || !session.accessToken) return { signedIn: false };
const r = await fetch('/backend-api/conversation/' + ${JSON.stringify(id)}, { headers: { Authorization: 'Bearer ' + session.accessToken }, credentials: 'include' });
if (!r.ok) return { signedIn: true, error: 'ChatGPT answered ' + r.status };
return { signedIn: true, conversation: await r.json() };`;

// Claude: the organization that chats, its projects (names for the list), then its conversations or one conversation.
const CLAUDE_ORG = `
const orgs = await fetch('/api/organizations', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
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

/**
 * The chats of a signed-in account, newest first → [{ id, title, date, project }], filtered by `days`, `query` (words in
 * the title or project) and `project` (part of its name). `page` is the job's browser (./browser.cjs tools).
 */
async function listWebChats(page, app, { days = null, query = '', project = '', limit = 200 } = {}) {
  check(app);
  await page.ensure(SITES[app].start);
  const out = await page.evaluate(app === 'ChatGPT' ? CHATGPT_LIST(MAX_LIST) : CLAUDE_LIST(MAX_LIST));
  if (!out || !out.signedIn) throw signedOut(app);
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
async function readWebChat(page, app, id) {
  check(app);
  if (!ID_RE.test(String(id || ''))) throw new Error('Not a conversation id');
  await page.ensure(SITES[app].start);
  const out = await page.evaluate(app === 'ChatGPT' ? CHATGPT_ONE(id) : CLAUDE_ONE(id));
  if (!out || !out.signedIn) throw signedOut(app);
  if (out.error || !out.conversation) throw new Error(out.error || `${app} sent no conversation`);
  const chat = exportChat(app === 'ChatGPT' ? { conversation_id: id, ...out.conversation } : { uuid: id, ...out.conversation });
  if (!chat) throw new Error(`${app}'s conversation could not be read`);
  return { id: String(id), title: chat.title || clip((chat.turns[0] || {}).text, 80) || `${app} chat`, date: chat.updated ? new Date(chat.updated).toISOString() : null, turns: chat.turns };
}

module.exports = { WEB_CHAT_APPS, SITES, listWebChats, readWebChat, CHATGPT_LIST, CLAUDE_LIST, CHATGPT_ONE, CLAUDE_ONE };
