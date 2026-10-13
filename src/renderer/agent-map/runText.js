// What the Agent map (../screens/AgentMap.jsx) reads off a run record (src/main/bart/runlog.cjs), and the page it exports:
// one self-contained HTML file, its styles inline and the runs' data in it, sections as <details> so it needs no script.

// The agents a question line runs, and the ones a Build runs (the list's filter).
export const QUESTION_AGENTS = ['bart', 'brainstorm', 'discover'];
export const BUILD_AGENTS = ['build', 'run step'];
export const FILTERS = [['all', 'All'], ['questions', 'Questions'], ['builds', 'Builds']];

/** The runs a filter of the list shows: 'all', 'questions' or 'builds'. */
export function filterRuns(runs, filter) {
  if (filter === 'questions') return runs.filter((run) => QUESTION_AGENTS.includes(run.agent));
  if (filter === 'builds') return runs.filter((run) => BUILD_AGENTS.includes(run.agent));
  return runs;
}

/** A run's name in the list and its header: "@bart", "@build <title> · turn n", "@build quick", "@run step <title>". */
export function runLabel(run) {
  if (!run) return '';
  if (run.agent === 'build') return run.kind === 'quick' ? '@build quick' : `@build ${run.title || ''} · turn ${run.turn == null ? '?' : run.turn}`;
  if (run.agent === 'run step') return `@run step ${run.title || ''}`;
  return `@${run.agent}`;
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

/** "model · effort" for the list: the last step's, which is where it ended up. */
export const modelLabel = (run) => [run.model, run.effort].filter(Boolean).join(' · ') || (run.status === 'running' ? 'starting' : 'no model run');

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
