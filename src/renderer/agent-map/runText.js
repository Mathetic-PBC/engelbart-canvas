// What the Agent Viewer (../screens/AgentMap.jsx; it was the Agent map) reads off the run log's records
// (src/main/bart/runlog.cjs) and its asks (src/main/agent-map/asks.cjs), and the page it exports: one self-contained HTML
// file, its styles inline and the records' data in it, sections as <details> so it needs no script.

// The agents the Viewer knows (2026-10-12): the list, the detail and Design all name them from here. `agent` is the run
// log's name, `routed` the name an ask is routed to (asks.cjs routedTo). Create (2026-10-13) lists the library rows a run
// kept under its output (createdLines). The run step shows only inside a Build's output. Any other agent shows under its own name (agentInfo).
// No colours (2026-10-13): the Viewer names agents in words only.
export const AGENTS = [
  { agent: 'router', routed: null, name: 'Bart (classifier)', token: '@bart' },
  { agent: 'bart', routed: 'chat', name: 'Chat', token: '@chat' },
  { agent: 'brainstorm', routed: 'brainstorm', name: 'Brainstorm', token: '@brainstorm' },
  { agent: 'discover', routed: 'discover', name: 'Discover', token: '@discover' },
  { agent: 'create', routed: 'create', name: 'Create', token: '@create' },
  { agent: 'build', routed: 'build', name: 'Build', token: '@bart / Build button / panel / post-it' },
  { agent: 'run step', routed: null, name: 'Run step', token: '', inside: 'build' },
];

/** An agent's entry by its run log name or its routed name ('chat' is 'bart'); an unknown one under its own name. */
export function agentInfo(name) {
  const key = String(name == null ? '' : name);
  return AGENTS.find((held) => held.agent === key || held.routed === key) || { agent: key, routed: key, name: key || 'unknown', token: '', unknown: true };
}

// The agents a question line runs, and the ones a Build runs (the list's filter).
export const QUESTION_AGENTS = ['router', 'bart', 'brainstorm', 'discover', 'create'];
export const BUILD_AGENTS = ['build', 'run step'];
export const FILTERS = [['all', 'All'], ['questions', 'Questions'], ['builds', 'Builds']];

/** The runs a filter of the list shows: 'all', 'questions' or 'builds'. */
export function filterRuns(runs, filter) {
  if (filter === 'questions') return runs.filter((run) => QUESTION_AGENTS.includes(run.agent));
  if (filter === 'builds') return runs.filter((run) => BUILD_AGENTS.includes(run.agent));
  return runs;
}

/**
 * A run's name in the list and its header: "@chat", "@bart → @discover" (agentLabel), "@build <title> · turn n",
 * "@build quick", "@run step <title>".
 */
export function runLabel(run) {
  if (!run) return '';
  if (run.agent === 'build') return `${run.kind === 'quick' ? '@build quick' : `@build ${run.title || ''} · turn ${run.turn == null ? '?' : run.turn}`}${run.routedFrom ? ' · via Bart' : ''}`;
  if (run.agent === 'run step') return `@run step ${run.title || ''}`;
  return agentLabel(run);
}

const blockLabel = (key) => (key === 'prompt' ? 'prompt' : key === 'other' ? 'text outside any block' : key === 'reply' ? 'sent this turn (<reply>, or everything again)' : `<${key}>`);

/** A run's context blocks, in the order the agent is sent them, as { key, label, text }. */
export function contextBlocks(record) {
  const c = (record && record.context) || {};
  // A Build turn (its message's blocks, or what a later turn was sent) and a run step (its prompt): as they were kept.
  if (record && BUILD_AGENTS.includes(record.agent)) return Object.entries(c).map(([key, text]) => ({ key, label: blockLabel(key), text: text == null ? '' : String(text) }));
  return [
    ['head', '<engelbart>', c.head],
    ['contextJson', '<context_json>', c.contextJson],
    ['mentionedFiles', '<mentioned_files>', c.mentionedFiles],
    ['documents', 'documents', c.documents],
    ['now', '<stage> / <highlights> (now)', c.now],
    ['conversation', '<conversation>', c.conversation],
    ['extra', 'extra (<path>, <mode>…)', c.extra],
    ['dirs', 'folders granted', Array.isArray(c.dirs) ? c.dirs.join('\n') : c.dirs],
    ['input', 'the router\'s input (line, section, threads, spec above)', c.input],
  ].map(([key, label, text]) => ({ key, label, text: text == null ? '' : String(text) }));
}

export const tokens = (text) => Math.round(String(text || '').length / 4);
export const sizeLabel = (text) => { const n = String(text || '').length; return `${n.toLocaleString('en-US')} chars · ~${tokens(text).toLocaleString('en-US')} tok`; };
export const json = (value) => { if (value == null) return ''; if (typeof value === 'string') return value; try { return JSON.stringify(value, null, 2); } catch { return String(value); } };
export const firstWords = (text, n = 9) => { const words = String(text || '').trim().split(/\s+/).filter(Boolean); return words.length ? words.slice(0, n).join(' ') + (words.length > n ? ' …' : '') : '(empty line)'; };
export const writtenText = (record) => (Array.isArray(record && record.written) ? record.written.map((line) => (typeof line === 'string' ? line : json(line))).join('\n') : '');

export function timeLabel(at, now = Date.now()) {
  if (!at) return '';
  const date = new Date(at), today = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return today ? time : `${date.toISOString().slice(0, 10)} ${time}`;
}
export const msLabel = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`);

/**
 * A run's agent as the runs list names it (2026-10-12): the internal 'bart' is @chat; a router's record says where it
 * sent the line ("@bart → @discover", "@bart → Build"), and a run Bart handed over or the person corrected says so, as
 * does one Bart could not route ("· Bart failed to route": the classifier failed, and the line went to its fallback).
 */
export function agentLabel(run) {
  const word = (agent) => (agent === 'build' ? 'Build' : `@${agent === 'bart' ? 'chat' : agent}`);
  if (run.agent === 'router') {
    const to = run.handedTo && /^build:/.test(run.handedTo) ? 'Build' : run.pick ? word(run.pick) : '…';
    return `@bart → ${to}${run.corrected ? ` (corrected to ${word(run.corrected)})` : ''}${run.by === 'rule' ? ` · rule: ${run.rule || '?'}` : run.sure != null ? ` · sure ${run.sure}` : ''}`;
  }
  return `${word(run.agent)}${run.routedBy === 'error' ? ' · Bart failed to route' : run.routedFrom ? ' · via Bart' : ''}${run.corrected ? ` · corrected from Bart` : ''}`;
}
/** "model · effort" for the list: the last step's, which is where it ended up. */
export const modelLabel = (run) => [run.model, run.effort].filter(Boolean).join(' · ') || (run.status === 'running' ? 'starting' : 'no model run');

/** The library rows a Create run kept, one a line ("Name · type · path"), then what it skipped; '(none)' when it kept nothing. */
export function createdLines(record) {
  const rows = Array.isArray(record && record.created) ? record.created : [];
  const skipped = Array.isArray(record && record.skipped) ? record.skipped : [];
  return [
    ...(rows.length ? rows.map((row) => [row.name, row.type, row.path].filter(Boolean).join(' · ')) : ['(none)']),
    ...skipped.map((why) => `skipped: ${why}`),
  ].join('\n');
}

/** A section's text, as `c` copies it: 'system', 'context', 'steps' or 'written'. */
export function sectionText(record, section) {
  if (!record) return '';
  if (section === 'system') return String(record.system || '');
  if (section === 'context') return contextBlocks(record).filter((block) => block.text).map((block) => `===== ${block.label} (${sizeLabel(block.text)}) =====\n${block.text}`).join('\n\n');
  if (section === 'steps') {
    return (record.steps || []).map((step, n) => [
      `===== step ${n + 1}: ${step.name || step.model} (${step.model}) at ${step.effort}${step.escalated ? ' · escalated' : ''} =====`,
      '--- input ---', step.input,
      ...(step.tools || []).flatMap((tool) => [`--- tool: ${tool.name} ---`, json(tool.input), ...(tool.result ? [`--- result (${tool.result.size} chars${tool.result.error ? ', error' : ''}) ---`, tool.result.excerpt] : ['--- no result yet ---'])]),
      ...(step.toolsDropped ? [`--- ${step.toolsDropped} more tool calls, not kept ---`] : []),
      '--- output ---', step.output == null ? '(running)' : step.output,
    ].join('\n')).join('\n\n');
  }
  if (section === 'written') return writtenText(record);
  return '';
}

const escape = (text) => String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pre = (text) => `<pre>${escape(text)}</pre>`;
const details = (summary, body, open = false) => `<details${open ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;

function runHtml(record) {
  const head = `${escape(runLabel(record))}${record.buildId ? ` · Build ${escape(record.buildId)}` : ''}${record.ending ? ` · ${escape(record.ending)}` : ''} · ${escape(modelLabel({ ...record, ...lastStep(record) }))} · ${escape(record.status)} · ${escape(record.projectName || '')}${record.workspaceName ? ` / ${escape(record.workspaceName)}` : ''} · ${escape(new Date(record.at).toISOString())}${record.ms != null ? ` · ${escape(msLabel(record.ms))}` : ''}`;
  const steps = (record.steps || []).map((step, n) => details(
    `step ${n + 1}: ${escape(step.name || step.model)} <span class="dim">(${escape(step.model)}) · ${escape(step.effort)}${step.ms != null ? ` · ${escape(msLabel(step.ms))}` : ''}</span>${step.escalated ? ' <b>escalated</b>' : ''}`,
    details(`input <span class="dim">${escape(sizeLabel(step.input))}</span>`, pre(step.input))
      + `<div class="sub">tool calls (${(step.tools || []).length}${step.toolsDropped ? `, and ${step.toolsDropped} more not kept` : ''})</div>`
      + (step.tools || []).map((tool) => details(`${escape(tool.name)} <span class="dim">${tool.ms != null ? escape(msLabel(tool.ms)) : 'running'}${tool.result ? ` · ${tool.result.size} chars` : ''}${tool.result && tool.result.error ? ' · error' : ''}</span>`, `<div class="sub">arguments</div>${pre(json(tool.input))}${tool.result ? `<div class="sub">result (first 2,000 characters)</div>${pre(tool.result.excerpt)}` : ''}`)).join('')
      + details(`output <span class="dim">${escape(sizeLabel(step.output))}</span>`, pre(step.output == null ? '(running)' : step.output), true),
    true,
  )).join('');
  return `<section><h2>${escape(firstWords(record.question, 16))}</h2><div class="dim">${head}</div>`
    + (record.error ? `<div class="error">${escape(record.error)}</div>` : '')
    + details(`1 System prompt <span class="dim">${escape(sizeLabel(record.system))}</span>`, pre(record.system))
    + details('2 Context', contextBlocks(record).map((block) => details(`${escape(block.label)} <span class="dim">${escape(sizeLabel(block.text))}</span>`, pre(block.text))).join(''))
    + details(`3 Steps (${(record.steps || []).length})`, steps, true)
    + details('4 Written', pre(writtenText(record)), true)
    + '</section>';
}

function lastStep(record) {
  const steps = record.steps || [];
  const last = steps[steps.length - 1];
  return last ? { model: last.model, effort: last.effort } : {};
}

const STYLE = 'body{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;margin:16px;max-width:1200px}h1{font-size:14px;margin:0 0 8px}h2{font-size:13px;margin:0 0 2px}section{border-top:1px solid #ccc;padding:10px 0}details{margin:3px 0 3px 12px}summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;border:1px solid #e3e3e3;padding:6px;margin:3px 0;max-height:none}.dim{color:#777}.sub{color:#555;margin:4px 0 0 12px}.error{color:#a00;border:1px solid #e6b8b8;padding:4px;margin:4px 0}';

/** The exported page: `records` (whole runs), its title. */
export function exportPage(records, title = 'Agent runs') {
  const data = JSON.stringify(records).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>${STYLE}</style></head><body><h1>${escape(title)}</h1><div class="dim">Exported from Engelbart's Agent map, ${escape(new Date().toISOString())}. ${records.length} run${records.length === 1 ? '' : 's'}.</div>${records.map(runHtml).join('')}<script type="application/json" id="agent-runs">${data}</script></body></html>`;
}

/* ------------------------------------------------------------------ asks (2026-10-12, the Agent Viewer) */

/** The asks a filter of the list shows: 'all', 'questions' or 'builds' (asks.cjs `kind`). */
export function filterAsks(asks, filter) {
  if (filter === 'questions') return asks.filter((ask) => ask.kind !== 'build');
  if (filter === 'builds') return asks.filter((ask) => ask.kind === 'build');
  return asks;
}

/** An ask's row: the line as typed, on one line, its pictures left out; "—" when there is nothing. */
export function askText(text) {
  const line = String(text == null ? '' : text).replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return line || '—';
}

/** An ask's time: HH:MM today, its date on any other day. */
export function askTime(at, now = Date.now()) {
  if (!at) return '';
  const date = new Date(at), pad = (n) => String(n).padStart(2, '0');
  if (new Date(now).toDateString() === date.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What section 2 says when the router did not pick: "Typed directly (@chat)", "(--build)", "(Build button)"… */
export function viaLabel(via, routedTo) {
  if (via === '--build') return 'Typed directly (--build)';
  if (via === 'button') return 'Typed directly (Build button)';
  if (via === 'panel') return 'Typed directly (Build panel)';
  if (via === 'post-it') return 'Typed directly (post-it)';
  const info = agentInfo(routedTo);
  return `Typed directly (${info.unknown ? info.name : info.token})`;
}

/** The parts of the router's model input (route.cjs routeInput): { workspace, section, threads, specAbove, line }. */
export function routerInputParts(input) {
  const text = String(input || ''), part = (tag) => { const m = text.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`)); return m ? m[1] : null; };
  return { workspace: part('workspace'), section: part('section'), threads: part('threads'), specAbove: part('spec_above'), line: part('line') };
}

/** The card a Brainstorm run wrote (its fenced JSON block), as { type, title, items, say }, or null. */
export function cardOf(record) {
  const text = writtenText(record) || ((record && record.steps) || []).map((step) => step.output || '').pop() || '';
  const fenced = text.match(/```[a-z]*\n([\s\S]*?)\n```/), body = fenced ? fenced[1] : text;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let card = null;
  try { card = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!card || typeof card !== 'object' || !card.card) return null;
  const group = card[card.card] && typeof card[card.card] === 'object' ? card[card.card] : {};
  const items = Array.isArray(group.items) ? group.items.map((item) => [item.title, item.type ? `(${item.type})` : ''].filter(Boolean).join(' ')) : [];
  return { type: String(card.card), title: String(group.title || card.title || (Array.isArray(group.items) && group.items[0] && group.items[0].title) || ''), items, say: typeof card.say === 'string' ? card.say : '' };
}

/** A card drawn as text. */
export const cardText = (card) => (card ? [`┌ card: ${card.type}${card.title ? ` · ${card.title}` : ''}`, ...(card.say ? [`│ ${card.say}`] : []), ...card.items.map((item) => `│ - ${item}`), '└'].join('\n') : '');

const stepLabel = (step, n) => `step ${n + 1}: ${step.name || step.model || '?'}${step.model && step.name && step.model !== step.name ? ` (${step.model})` : ''}${step.effort ? ` · ${step.effort}` : ''}${step.ms != null ? ` · ${msLabel(step.ms)}` : ''}${step.escalated ? ' · escalated' : ''}`;

/** A count of tokens, short: 940, 1.1k, 50k. */
export const tokShort = (n) => (n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);
const tok = (text) => `${tokShort(tokens(text))} tok`;
/** Text on one line, cut to `n` characters. */
export const oneLine = (text, n = 80) => { const line = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return line.length > n ? `${line.slice(0, n - 1)}…` : line; };

const argString = (value) => (Array.isArray(value) ? value.map(String).join(' ') : typeof value === 'string' ? value : '');
const COMMAND_KEYS = ['command', 'cmd'];
const ARG_KEYS = ['command', 'cmd', 'file_path', 'path', 'url', 'pattern', 'query', 'notebook_path', 'description', 'prompt'];

/**
 * A tool call's argument summary for its row (2026-10-13): Bash the command's first 80 characters, Read the path,
 * Grep and Glob the pattern (and where), WebFetch the URL; any other the first of its usual arguments. → { text, command }
 * where `command` says it is a command (drawn in monospace).
 */
export function toolArg(tool) {
  const input = tool && tool.input;
  if (typeof input === 'string') return { text: oneLine(input), command: false };
  const held = input && typeof input === 'object' ? input : {};
  const name = String((tool && tool.name) || '');
  const pick = (keys) => { for (const key of keys) { const value = argString(held[key]); if (value) return { key, value }; } return null; };
  let found = null;
  if (name === 'Bash') found = pick(COMMAND_KEYS);
  else if (name === 'Read') found = pick(['file_path', 'path']);
  else if (name === 'Grep' || name === 'Glob') {
    const pattern = argString(held.pattern), where = argString(held.path);
    found = pattern ? { key: 'pattern', value: where ? `${pattern} in ${where}` : pattern } : pick(['path']);
  } else if (name === 'WebFetch') found = pick(['url']);
  if (!found) found = pick(ARG_KEYS);
  if (!found) { const first = Object.values(held).map(argString).find(Boolean); found = first ? { key: '', value: first } : null; }
  return found ? { text: oneLine(found.value), command: COMMAND_KEYS.includes(found.key) } : { text: '', command: false };
}

/** What a tool call's row shows when opened: its arguments and its result, together. */
function toolText(tool) {
  const result = tool.result;
  return [
    'arguments', json(tool.input) || '(none)', '',
    result ? `result · ${Number(result.size || 0).toLocaleString('en-US')} chars${result.error ? ' · error' : ''}${String(result.excerpt || '').length < Number(result.size || 0) ? ' (first 2,000)' : ''}` : 'no result yet',
    ...(result ? [result.excerpt == null ? '' : String(result.excerpt)] : []),
  ].join('\n');
}

/** A step's tool calls: one row each, its name, argument summary, time and result size; opened, its arguments and result. */
function toolNodes(step) {
  const tools = (step.tools || []).map((tool) => {
    const arg = toolArg(tool);
    return {
      label: tool.name, arg: arg.text, command: arg.command, tool: true, text: toolText(tool),
      dim: [tool.ms != null ? msLabel(tool.ms) : 'running', tool.result ? `${Number(tool.result.size || 0).toLocaleString('en-US')} chars` : '', tool.result && tool.result.error ? 'error' : ''].filter(Boolean).join(' · '),
    };
  });
  return step.toolsDropped ? [...tools, { label: `${step.toolsDropped} more tool calls, not kept`, plain: true }] : tools;
}

/** A step's raw output: open once the step has finished, the one thing in the Viewer that opens on its own. */
const outputNode = (step) => ({ label: 'raw output', dim: sizeLabel(step.output), text: step.output == null ? '(running)' : step.output, ...(step.output != null ? { open: true } : {}) });

const promptNode = (record) => ({ label: `System prompt${record.promptSource ? ` (${record.promptSource})` : ''}`, dim: sizeLabel(record.system), text: String(record.system || '') });
const blockNodes = (record) => contextBlocks(record).filter((block) => block.text).map((block) => ({ label: block.label, dim: sizeLabel(block.text), text: block.text }));

/** An ask's records sorted out: the router's, the asks it handed over, a Build's turns and its run steps. */
export function pipelineOf(ask) {
  const records = (ask && ask.records ? ask.records : []).filter(Boolean);
  const at = (record) => record.at || 0;
  const router = records.find((record) => record.agent === 'router') || null;
  const turns = records.filter((record) => record.agent === 'build').sort((a, b) => (a.turn || 0) - (b.turn || 0) || at(a) - at(b));
  const runSteps = records.filter((record) => record.agent === 'run step').sort((a, b) => (a.turn || 0) - (b.turn || 0) || at(a) - at(b));
  const runs = records.filter((record) => !['router', 'build', 'run step'].includes(record.agent)).sort((a, b) => at(a) - at(b));
  return { router, turns, runSteps, runs, agent: agentInfo(ask ? ask.routedTo : null) };
}

/**
 * Where the line was typed, in names (2026-10-13): "Engelbart / oct-12", "Engelbart / note Ideas in oct-12",
 * "Engelbart / a highlight in <paper>, page 3". `ask.names` is what the main process found ({ project, workspace, note,
 * paper }, agentMap:ask); the records' own names fill in for it. No id: the project's id is never shown.
 */
export function whereLabel(ask, first = {}) {
  const place = (ask && ask.place) || {};
  const names = (ask && ask.names) || {};
  const ref = place.ref || null;
  const project = names.project || first.projectName || '';
  const workspace = names.workspace || first.workspaceName || '';
  let spot = '';
  if (ref && ref.kind === 'note') spot = `note${names.note ? ` ${names.note}` : ''}${workspace ? ` in ${workspace}` : ''}`;
  else if (ref && ref.kind === 'mark') spot = `a highlight${names.paper ? ` in ${names.paper}` : ''}${ref.page ? `, page ${ref.page}` : ''}`;
  else spot = workspace || (ref ? 'workspace' : '');
  return [project, spot].filter(Boolean).join(' / ');
}

/** "Haiku low" for a step: its name and effort. */
const modelShort = (step) => (step ? [step.name || step.model, step.effort].filter(Boolean).join(' ') : '');
const toolCount = (record) => (record.steps || []).reduce((n, step) => n + (step.tools || []).length + (step.toolsDropped || 0), 0);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What the router did, short: { to, parts } where parts are "sure 0.85", "Haiku low", "3.4 s" (or "rule: x"). */
function routerShort(router) {
  const step = (router.steps || [])[0];
  const to = router.handedTo && /^build:/.test(router.handedTo) ? 'Build' : agentInfo(router.corrected || router.pick || 'chat').name;
  const parts = [
    router.by === 'rule' ? `rule: ${router.rule || '?'}` : router.sure != null ? `sure ${router.sure}` : '',
    router.by === 'rule' ? '' : modelShort(step),
    router.ms != null ? msLabel(router.ms) : '',
  ].filter(Boolean);
  return { to, parts, failed: router.status === 'failed' };
}

/** Section 4's one line: "turn 1 · 14 tools · running", "6 tools · done · 18 s". */
function outputSummary(ask, { turns, runs }) {
  if (ask.routedTo === 'build') {
    const turn = turns[turns.length - 1];
    if (!turn) return ask.status === 'running' ? 'not started' : 'nothing run';
    return [`turn ${turn.turn == null ? '?' : turn.turn}`, plural(toolCount(turn), 'tool'), turn.status || ask.status, turn.status !== 'running' && turn.ms != null ? msLabel(turn.ms) : ''].filter(Boolean).join(' · ');
  }
  if (!runs.length) return ask.status === 'running' ? 'not started' : 'nothing run';
  const last = runs[runs.length - 1];
  const tools = runs.reduce((n, run) => n + toolCount(run), 0);
  return [runs.length > 1 ? plural(runs.length, 'run') : '', plural(tools, 'tool'), last.status || ask.status, last.status !== 'running' && last.ms != null ? msLabel(last.ms) : ''].filter(Boolean).join(' · ');
}

/** Section 3's one line: "system 1.1k tok · context 50k tok (most in documents, 42k)". */
function inputSummary(record) {
  if (!record) return 'nothing sent yet';
  const blocks = contextBlocks(record).filter((block) => block.text);
  const total = blocks.reduce((n, block) => n + tokens(block.text), 0);
  const largest = blocks.reduce((best, block) => (!best || tokens(block.text) > tokens(best.text) ? block : best), null);
  return [record.system ? `system ${tok(record.system)}` : '', blocks.length ? `context ${tokShort(total)} tok${blocks.length > 1 && largest ? ` (most in ${largest.label}, ${tokShort(tokens(largest.text))})` : ''}` : 'no context'].filter(Boolean).join(' · ');
}

/**
 * The ask's pipeline on one line (2026-10-13), under its header: "you → Bart: Build (0.85 · Haiku low · 3.4 s) → Build
 * turn 1 · 14 tools · running", or with nothing routed "you → Chat (typed directly) → 6 tools · done".
 */
export function pipelineLine(ask) {
  if (!ask) return '';
  const parts = pipelineOf(ask);
  const { router, agent } = parts;
  const out = outputSummary(ask, parts);
  if (router) {
    const short = routerShort(router);
    const how = short.parts.map((part) => part.replace(/^sure /, '')).join(' · ');
    return `you → Bart: ${short.to}${how ? ` (${how})` : ''} → ${agent.name}${/^turn /.test(out) ? ' ' : ' · '}${out}`;
  }
  const unrouted = [...parts.runs, ...parts.turns].some((record) => record.routedBy === 'error');
  return `you → ${agent.name} (${unrouted ? 'Bart failed to route' : 'typed directly'}) → ${out}`;
}

/**
 * The right side's four sections for an ask with its records whole (asks.cjs askOf), as plain data both the Viewer and
 * the export draw: [{ key, title, summary, nodes }], each node { label, dim?, arg?, command?, tool?, text?, plain?, error?,
 * open?, children? }. Each section starts closed and shows its `summary`; nothing inside opens on its own but the raw
 * output of a finished step (2026-10-13).
 */
export function askSections(ask) {
  if (!ask) return [];
  const pipeline = pipelineOf(ask);
  const { router, turns, runSteps, runs, agent } = pipeline;
  const first = router || runs[0] || turns[0] || runSteps[0] || {};
  const place = ask.place || {};
  // 1 Input: the line as typed, where, its id, and what the router saw.
  const where = whereLabel(ask, first);
  const lineNo = place.line != null ? `line ${place.line + 1}` : '';
  const typed = place.text != null ? place.text : first.question || '';
  const input = [
    { label: 'The line as typed', text: typed },
    { label: 'Where', plain: true, dim: [where || '—', lineNo].filter(Boolean).join(' · ') },
    { label: 'id', plain: true, dim: String(ask.id || '') },
  ];
  if (router) {
    const parts = routerInputParts(router.context && router.context.input);
    const threads = Array.isArray(router.threads) ? router.threads : [];
    const threadText = threads.length ? threads.map((thread) => `@${thread.agent}, ${thread.up} lines up: ${JSON.stringify(thread.question)}`).join('\n') : '(none)';
    input.push({
      label: 'What Bart (classifier) saw', children: [
        parts.section != null ? { label: 'section', dim: sizeLabel(parts.section), text: parts.section } : { label: 'section', plain: true, dim: `${(router.sectionSize || 0).toLocaleString('en-US')} chars (not kept: a rule picked, so no model was sent it)` },
        { label: 'threads', dim: `${threads.length} · ${sizeLabel(threadText)}`, text: threadText },
        { label: 'spec above', plain: true, dim: router.specAbove ? 'yes' : 'no' },
        ...(router.context && router.context.input ? [{ label: 'everything it was sent', dim: sizeLabel(router.context.input), text: router.context.input }] : []),
      ],
    });
  }
  const inputSum = [oneLine(askText(typed), 60), [where ? (where.split(' / ').pop() || where) : '', lineNo].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  // 2 Bart (classifier) output.
  let classified, classifiedSum;
  if (router) {
    const step = (router.steps || [])[0];
    const short = routerShort(router);
    const picked = router.handedTo && /^build:/.test(router.handedTo) ? 'Build' : agentInfo(router.pick || 'chat').name;
    const corrected = router.corrected ? `changed to ${agentInfo(router.corrected).name}` : '';
    classified = [
      { label: `Picked ${picked}`, plain: true, dim: [router.sure != null ? `sure ${router.sure}` : '', router.by === 'rule' ? `rule: ${router.rule || '?'}` : step ? `model: ${step.name || step.model} · ${step.effort}` : 'model', router.ms != null ? msLabel(router.ms) : '', router.unread ? 'reply not read: chat' : ''].filter(Boolean).join(' · ') },
      ...(corrected ? [{ label: corrected, plain: true }] : []),
      ...(router.handedTo ? [{ label: 'handed to', plain: true, dim: router.handedTo }] : []),
      ...(router.error ? [{ label: 'error', error: router.error }] : []),
      ...(step && step.output != null ? [outputNode(step)] : []),
    ];
    classifiedSum = [short.to, ...short.parts, router.error ? 'error' : ''].filter(Boolean).join(' · ');
  } else {
    // Bart failed to route the line (Workspace routeLine, `by: 'error'`): no router record, and its agent is the fallback.
    const unrouted = [...runs, ...turns].find((record) => record.routedBy === 'error');
    classified = unrouted
      ? [{ label: `Bart (classifier) failed: sent to ${agentInfo(ask.routedTo).name} as the fallback, not Bart's pick`, plain: true }, ...(unrouted.routeError ? [{ label: 'error', error: unrouted.routeError }] : [])]
      : [{ label: viaLabel(ask.via, ask.routedTo), plain: true }];
    classifiedSum = unrouted ? `failed · sent to ${agentInfo(ask.routedTo).name}` : ['--build', 'button', 'panel', 'post-it'].includes(ask.via) ? viaLabel(ask.via, ask.routedTo).replace(/^Typed/, 'typed') : 'typed directly';
  }
  // 3 <Agent> input, 4 <Agent> output.
  let agentIn = [], agentOut = [];
  const failed = [...runs, ...turns, ...runSteps].filter((record) => record.error && (record.status === 'failed' || record.status === 'stopped'));
  if (ask.routedTo === 'build') {
    const firstTurn = turns[0];
    if (firstTurn) agentIn.push(promptNode(firstTurn), { label: `turn ${firstTurn.turn || 1}: context`, dim: tok(blockNodes(firstTurn).map((node) => node.text).join('')), children: blockNodes(firstTurn) });
    for (const turn of turns.slice(1)) agentIn.push({ label: `turn ${turn.turn}: what it was sent`, children: blockNodes(turn) });
    agentOut = turns.map((turn) => ({
      label: `turn ${turn.turn == null ? '?' : turn.turn}`, dim: [modelLabel({ ...turn, ...lastOf(turn) }), plural(toolCount(turn), 'tool'), turn.status, turn.ending ? `ending: ${turn.ending}` : ''].filter(Boolean).join(' · '),
      children: [...(turn.error ? [{ label: 'error', error: turn.error }] : []), ...(turn.steps || []).flatMap((step) => [...toolNodes(step), outputNode(step)])],
    }));
    for (const run of runSteps) {
      const runnables = Array.isArray(run.written) ? run.written : [];
      agentOut.push({
        label: `Run step${run.turn != null ? ` (after turn ${run.turn})` : ''}`, dim: run.status, children: [
          ...(run.error ? [{ label: 'error', error: run.error }] : []),
          ...(run.steps || []).flatMap((step) => toolNodes(step)),
          { label: 'runnables', text: runnables.length ? runnables.map((item) => `${item.name}: ${item.status}${item.passed ? ' · passed' : ''}${item.error ? `\n  last error: ${item.error}` : ''}`).join('\n') : '(none yet)' },
        ],
      });
    }
  } else {
    runs.forEach((run, n) => {
      const again = runs.length > 1 ? ` (run ${n + 1}${n ? ', asked again' : ''})` : '';
      agentIn.push(promptNode(run), { label: `context${again}`, dim: tok(blockNodes(run).map((node) => node.text).join('')), children: blockNodes(run) }, ...(run.steps || []).map((step, k) => ({ label: stepLabel(step, k), dim: sizeLabel(step.input), text: step.input })));
      const card = run.agent === 'brainstorm' ? cardOf(run) : null;
      agentOut.push({
        label: `${agentInfo(run.agent).name}${again}`, dim: [plural(toolCount(run), 'tool'), run.status, run.ms != null ? msLabel(run.ms) : ''].filter(Boolean).join(' · '),
        children: [
          ...(run.steps || []).map((step, k) => ({ label: stepLabel(step, k), children: [...toolNodes(step), outputNode(step)] })),
          ...(card ? [{ label: 'the card it wrote', text: cardText(card) }] : []),
          ...(run.agent === 'create' ? [{ label: 'kept in the library', dim: `${(run.created || []).length} rows`, text: createdLines(run) }] : []),
          { label: 'what was written', dim: sizeLabel(writtenText(run)), text: writtenText(run) },
        ],
      });
    });
  }
  if (failed.length) agentOut.unshift(...failed.map((record) => ({ label: record.status === 'stopped' ? 'Stopped' : 'Failed', error: record.error })));
  if (!agentIn.length) agentIn.push({ label: ask.status === 'running' ? 'Not started yet' : 'Nothing was run', plain: true });
  if (!agentOut.length) agentOut.push({ label: ask.status === 'running' ? 'Running…' : 'Nothing was written', plain: true });
  return [
    { key: '1', title: '1 Input', summary: inputSum, nodes: input },
    { key: '2', title: `2 ${AGENTS[0].name}`, summary: classifiedSum, nodes: classified },
    { key: '3', title: `3 ${agent.name} input`, summary: inputSummary(ask.routedTo === 'build' ? turns[0] : runs[0]), nodes: agentIn },
    { key: '4', title: `4 ${agent.name} output`, summary: [failed.length ? (failed[0].status === 'stopped' ? 'stopped' : 'failed') : '', outputSummary(ask, pipeline)].filter(Boolean).join(' · '), nodes: agentOut },
  ];
}

function lastOf(record) {
  const steps = record.steps || [];
  const last = steps[steps.length - 1];
  return last ? { model: last.model, effort: last.effort } : {};
}

/** An ask's sections as plain text (`c` copies the open section). */
export function nodesText(nodes, depth = 0) {
  const pad = '  '.repeat(depth);
  return (nodes || []).map((node) => [
    `${pad}${node.error ? `! ${node.label}: ${node.error}` : node.label}${node.arg ? ` ${node.arg}` : ''}${node.dim ? ` (${node.dim})` : ''}`,
    ...(node.text != null && node.text !== '' ? [String(node.text)] : []),
    ...(node.children ? [nodesText(node.children, depth + 1)] : []),
  ].join('\n')).join('\n');
}

const nodeHtml = (node) => {
  if (node.error) return `<div class="error">${escape(node.label)}: ${escape(node.error)}</div>`;
  const head = `${escape(node.label)}${node.arg ? ` ${node.command ? `<code>${escape(node.arg)}</code>` : escape(node.arg)}` : ''}${node.dim ? ` <span class="dim">${escape(node.dim)}</span>` : ''}`;
  if (node.plain) return `<div class="sub">${head}</div>`;
  return details(head, `${node.text != null ? pre(node.text) : ''}${(node.children || []).map(nodeHtml).join('')}`, !!node.open);
};

/** The exported page of one ask: its four sections, every record of it whole in the page's data. */
export function exportAsk(ask) {
  const records = (ask && ask.records) || [];
  const title = `Agent Viewer · ${askText(ask && ask.text)}`;
  const data = JSON.stringify(ask).replace(/</g, '\\u003c');
  const sections = askSections(ask).map((section) => details(`${escape(section.title)}${section.summary ? ` <span class="dim">${escape(section.summary)}</span>` : ''}`, section.nodes.map(nodeHtml).join(''), true)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>${STYLE}</style></head><body><h1>${escape(title)}</h1><div class="dim">Exported from Engelbart's Agent Viewer, ${escape(new Date().toISOString())}. ${escape(pipelineLine(ask))} · ${records.length} record${records.length === 1 ? '' : 's'}.</div><section>${sections}</section>${records.map(runHtml).join('')}<script type="application/json" id="agent-ask">${data}</script></body></html>`;
}
