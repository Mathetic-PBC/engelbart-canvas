'use strict';

// The Agent map's record of each @bart, @brainstorm and @discover run (2026-10-12; src/main/agent-map/, a window for
// developers only): what the agent was told (its system prompt and each block of context), what each model step was sent,
// the tools it called with their arguments and a piece of each result, what each step said, and what was written. ask.cjs
// calls it at those points when createBart is given one; a copy without test mode is given none, so nothing is kept.
// Since 2026-10-12 each Build turn (../build/manager.cjs, one record a turn, `buildId` naming its Build) and each run step
// after one (../build/run-step.cjs, its runnables as what was written) are recorded the same way.
//
// Kept in <userData>/agent-runs.jsonl, one JSON object a line, the last `maxRuns` runs: a run is written when it starts and
// again when it ends (a later line for the same id wins), and what happens between stays in memory. A system prompt is
// written once, by its hash, on a line of its own ({ prompt, text }); a run names it by `systemHash`. The file is written
// out again, without what was trimmed, when it holds twice as many lines as it keeps.
//
// The log never stands in a run's way: every call returns at once and never throws, and the file is written in the
// background, a failed write forgotten.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const EXCERPT = 2000;
// The tool calls one step keeps; the rest are counted in the step's `toolsDropped` (a Build can call thousands).
const MAX_TOOLS = 1000;
// What `list()` leaves out of a run: the text the map shows only for the run it selects.
const BIG = ['system', 'context', 'steps', 'written'];

const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** A tool result's text, from Claude's content (a string, or blocks of text and images) or Codex's output. */
function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block === 'string' ? block : block && block.type === 'text' ? String(block.text || '') : block && block.type ? `[${block.type}]` : JSON.stringify(block))).join('\n');
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** { size, excerpt }: a result's length and its first 2,000 characters. */
const excerptOf = (content) => { const text = resultText(content); return { size: text.length, excerpt: text.slice(0, EXCERPT) }; };

/**
 * The tool calls one raw stream event adds or completes, as [{ id, name, input?, result? , done? }]; [] for any other event.
 * Claude: an assistant message's tool_use blocks (name and whole input) and a user message's tool_result blocks (by
 * tool_use_id). Codex: command_execution, web_search and mcp_tool_call items, started and completed.
 */
function toolCallsOf(event) {
  if (!isObject(event)) return [];
  const blocks = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
  if (event.type === 'assistant') {
    return blocks.filter((block) => block && block.type === 'tool_use').map((block) => ({ id: String(block.id || ''), name: String(block.name || 'tool'), input: block.input === undefined ? null : block.input }));
  }
  if (event.type === 'user') {
    return blocks.filter((block) => block && block.type === 'tool_result').map((block) => ({ id: String(block.tool_use_id || ''), result: { ...excerptOf(block.content), ...(block.is_error ? { error: true } : {}) }, done: true }));
  }
  if (!/^item\.(started|completed)$/.test(String(event.type)) || !isObject(event.item)) return [];
  const item = event.item, done = event.type === 'item.completed', id = String(item.id || '');
  if (item.type === 'command_execution') {
    return [{ id, name: 'command', input: { command: item.command }, ...(done ? { result: { ...excerptOf(item.aggregated_output), ...(item.exit_code != null ? { exitCode: item.exit_code } : {}), ...(item.status === 'failed' ? { error: true } : {}) }, done } : {}) }];
  }
  if (item.type === 'web_search') {
    const query = item.query || (isObject(item.action) && item.action.query) || '';
    return [{ id, name: 'web_search', input: { query, ...(isObject(item.action) ? { action: item.action } : {}) }, ...(done ? { result: excerptOf(item.result != null ? item.result : ''), done } : {}) }];
  }
  if (item.type === 'mcp_tool_call') {
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* as it came */ } }
    const failed = item.error != null || item.status === 'failed';
    return [{ id, name: `${item.server || 'mcp'}.${item.tool || 'tool'}`, input: args === undefined ? null : args, ...(done ? { result: { ...excerptOf(failed ? (item.error && item.error.message) || item.error : item.result), ...(failed ? { error: true } : {}) }, done } : {}) }];
  }
  return [];
}

/**
 * → { start, step, event, output, note, finish, amend, find, list, get, flush }. `file`: the JSONL file (null keeps nothing on disk);
 * `onChange(record)`: each change to a run, the record without its big fields (as list() gives it); `maxRuns`: how many
 * runs are kept.
 */
function createRunLog({ file = null, onChange = () => {}, maxRuns = 300, now = Date.now } = {}) {
  const runs = new Map(); // id → record, oldest first
  const prompts = new Map(); // hash → text
  const written = new Set(); // the hashes the file holds
  let lines = 0;
  let queue = Promise.resolve();

  const safe = (fn) => (...args) => { try { return fn(...args); } catch { return undefined; } };
  const later = (work) => { queue = queue.then(work).catch(() => {}); };

  // What is on disk from earlier: the last line of each run wins.
  if (file) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        let value = null;
        try { value = JSON.parse(line); } catch { continue; }
        if (isObject(value) && typeof value.prompt === 'string' && typeof value.text === 'string') { prompts.set(value.prompt, value.text); written.add(value.prompt); }
        else if (isObject(value) && isObject(value.run) && typeof value.run.id === 'string') { runs.delete(value.run.id); runs.set(value.run.id, value.run); }
      }
      // A run the app quit in the middle of never finished.
      for (const record of runs.values()) if (record.status === 'running') record.status = 'stopped';
      while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
    } catch { /* no file yet */ }
  }

  const summary = (record) => {
    const out = {};
    for (const [key, value] of Object.entries(record)) if (!BIG.includes(key)) out[key] = value;
    const last = record.steps && record.steps.length ? record.steps[record.steps.length - 1] : null;
    if (last) { out.model = last.model; out.effort = last.effort; }
    out.stepCount = record.steps ? record.steps.length : 0;
    out.toolCount = (record.steps || []).reduce((sum, step) => sum + step.tools.length, 0);
    const dropped = (record.steps || []).reduce((sum, step) => sum + (step.toolsDropped || 0), 0);
    if (dropped) out.toolsDropped = dropped;
    return out;
  };
  const changed = (record) => { try { onChange(summary(record)); } catch { /* the map's problem, never the run's */ } };

  // The whole file again, holding only what is kept.
  const rewrite = () => {
    const keep = [...runs.values()];
    const used = new Set(keep.map((record) => record.systemHash).filter(Boolean));
    const text = [...[...used].filter((hash) => prompts.has(hash)).map((hash) => JSON.stringify({ prompt: hash, text: prompts.get(hash) })), ...keep.map((record) => JSON.stringify({ run: record }))].join('\n');
    written.clear(); for (const hash of used) written.add(hash);
    lines = used.size + keep.length;
    later(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, text ? `${text}\n` : '', { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    });
  };
  const save = (record) => {
    if (!file) return;
    if (lines + 2 > maxRuns * 2) { rewrite(); return; }
    let text = '';
    if (record.systemHash && !written.has(record.systemHash) && prompts.has(record.systemHash)) {
      text += `${JSON.stringify({ prompt: record.systemHash, text: prompts.get(record.systemHash) })}\n`;
      written.add(record.systemHash); lines += 1;
    }
    text += `${JSON.stringify({ run: record })}\n`; lines += 1;
    later(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, text, { mode: 0o600 });
    });
  };

  const current = (id) => { const record = runs.get(id); return record && record.steps.length ? record.steps[record.steps.length - 1] : null; };

  return {
    /** A run whose context is built. `run.system` is kept once, by hash. */
    start: safe((run) => {
      if (!isObject(run) || !run.id) return;
      const { system = '', ...rest } = run;
      const systemHash = hashOf(system);
      prompts.set(systemHash, String(system));
      const record = { status: 'running', at: now(), steps: [], ...rest, id: String(run.id), systemHash };
      runs.delete(record.id); runs.set(record.id, record);
      while (runs.size > maxRuns) runs.delete(runs.keys().next().value);
      save(record);
      changed(record);
    }),
    /** A model step begins: what it runs on and the whole message it is sent. */
    step: safe((id, { model = '', name = '', effort = '', input = '' } = {}) => {
      const record = runs.get(id);
      if (!record) return;
      record.steps.push({ model, name, effort, input: String(input), at: now(), tools: [], output: null, escalated: false });
      changed(record);
    }),
    /** A raw event from the CLI's stream: the tool calls it starts or completes go to the current step. */
    event: safe((id, raw) => {
      const step = current(id);
      if (!step) return;
      const calls = toolCallsOf(raw);
      if (!calls.length) return;
      for (const call of calls) {
        const found = call.id ? step.tools.find((tool) => tool.id === call.id) : null;
        if (found) {
          if (call.input !== undefined && found.input == null) found.input = call.input;
          if (call.result) { found.result = call.result; found.ms = now() - found.at; }
        } else if (call.name && step.tools.length >= MAX_TOOLS) {
          if (!call.done) step.toolsDropped = (step.toolsDropped || 0) + 1; // a completed one was counted when it started
        } else if (call.name) {
          step.tools.push({ id: call.id, name: call.name, input: call.input === undefined ? null : call.input, at: now(), ...(call.result ? { result: call.result, ms: 0 } : {}) });
        }
      }
      changed(runs.get(id));
    }),
    /** A step's end: what the model said, and whether it asked to move up. */
    output: safe((id, { raw = '', escalated = false } = {}) => {
      const step = current(id);
      if (!step) return;
      step.output = String(raw);
      step.escalated = !!escalated;
      step.ms = now() - step.at;
      changed(runs.get(id));
    }),
    /** Fields of a run learnt after it started (a run step's prompt, known once its stored commands are tried). */
    note: safe((id, fields) => {
      const record = runs.get(id);
      if (!record || !isObject(fields)) return;
      for (const [key, value] of Object.entries(fields)) if (!['id', 'steps', 'system', 'systemHash', 'status', 'at'].includes(key)) record[key] = value;
      changed(record);
    }),
    /**
     * The run's end: 'done', 'failed' or 'stopped', the lines written (a run step: its runnables), the error, how long it
     * took, and a Build turn's `ending` (needs-you, escalated, review, conflict).
     */
    finish: safe((id, { status = 'done', written: wrote = null, error = null, ms = null, ending } = {}) => {
      const record = runs.get(id);
      if (!record) return;
      record.status = status;
      if (ending !== undefined) record.ending = ending;
      record.written = Array.isArray(wrote) ? wrote : null;
      record.error = error ? String(error) : null;
      record.ms = ms != null ? ms : now() - record.at;
      save(record);
      changed(record);
    }),
    /**
     * Fields set on a run after it ended: the router's record learns where its line went (`handedTo`) and the agent the
     * person picked instead (`corrected`). Only plain fields; a run's steps and prompt stay as they were.
     */
    amend: safe((id, patch = {}) => {
      const record = runs.get(id);
      if (!record || !isObject(patch)) return;
      for (const [key, value] of Object.entries(patch)) if (!['id', 'steps', 'systemHash', 'system'].includes(key)) record[key] = value;
      save(record);
      changed(record);
    }),
    /** The newest run for which `test(record)` holds, without its big fields; null when none does. */
    find: (test) => { for (const record of [...runs.values()].reverse()) { try { if (test(record)) return summary(record); } catch { /* not this one */ } } return null; },
    /** Every run, newest first, without its big fields. */
    list: () => [...runs.values()].reverse().map(summary),
    /** One run whole, its system prompt in place. */
    get: (id) => {
      const record = runs.get(id);
      if (!record) return null;
      return JSON.parse(JSON.stringify({ ...record, system: prompts.get(record.systemHash) || '' }));
    },
    /** Resolves when what was queued for the file is written (tests). */
    flush: () => queue,
  };
}

module.exports = { createRunLog, toolCallsOf, resultText, EXCERPT, MAX_TOOLS };
