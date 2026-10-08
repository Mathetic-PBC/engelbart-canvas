'use strict';

// What an @bart run is doing, while it does it (2026-09-20). Both CLIs print one JSON event per
// line as they work (claude: --output-format stream-json; codex: --json). Each event becomes at
// most one update: a short label ("Reading src/main/ipc.cjs"), or the answer's text so far. The
// labels are made here from known fields only: a tool's output, a file's content and the model's
// reasoning never leave this module. The shapes were read off real runs of Claude Code 2.1.278 and
// codex-cli 0.155.0; an event that is not recognised is no update, never an error.
//
// The text so far is a preview, held by the renderer outside the document. Only the finished
// answer is written into the document (./reply.cjs), so autosave and undo never see half of one.

const path = require('node:path');
const { bodyLines } = require('./reply.cjs');

const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const quoted = (value) => { const text = clip(value, 40); return text ? ` for “${text}”` : ''; };

/** A path as the person knows it: relative to a directory the agent was granted, otherwise the file's name. */
function pathLabeller(dirs = []) {
  return (file) => {
    const full = String(file || '');
    if (!full) return 'a file';
    const tail = (text) => (text.length > 48 ? `…${text.slice(-47)}` : text);
    if (!path.isAbsolute(full)) return tail(full.replace(/^\.\//, '')); // already relative to where the agent stands
    for (const dir of dirs) {
      const inside = path.relative(dir, full);
      if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) return tail(inside);
    }
    return path.basename(full);
  };
}

function host(url) { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } }

// @discover's paper tools (./papers.cjs), by the tool's own name: what it was asked, never what came back.
function paperTool(tool, input) {
  const given = input && typeof input === 'object' ? input : {};
  if (tool === 'resolve') return `Looking up${quoted(given.query).replace(/^ for/, '')}`;
  if (tool === 'references') return `Reading what${quoted(given.id).replace(/^ for/, '')} cites`;
  if (tool === 'citations') return `Reading what cites${quoted(given.id).replace(/^ for/, '')}`;
  if (tool === 'author_works') return `Listing the works of${quoted(given.author).replace(/^ for/, '')}`;
  if (tool === 'related') return `Finding papers near${quoted(given.id).replace(/^ for/, '')}`;
  if (tool === 'search') return `Searching papers${quoted(given.query)}`;
  return 'Looking papers up';
}

// A Build's tools for putting things in the library (2026-10-07; ../build/engelbart-tools.cjs).
function engelbartTool(tool, input, short) {
  const given = input && typeof input === 'object' ? input : {};
  if (tool === 'save_file') return `Saving${quoted(given.name).replace(/^ for/, '')} to Engelbart`;
  if (tool === 'duplicate_file') return `Duplicating ${given.item && /^\//.test(given.item) ? short(given.item) : 'an item'} in Engelbart`;
  if (tool === 'move_file_into_engelbart') return `Moving ${short(given.path)} into Engelbart`;
  return 'Saving to Engelbart';
}

function claudeTool(name, input, short) {
  const given = input && typeof input === 'object' ? input : {};
  const paper = String(name || '').match(/^mcp__papers__(\w+)$/);
  if (paper) return paperTool(paper[1], given);
  const own = String(name || '').match(/^mcp__engelbart__(\w+)$/);
  if (own) return engelbartTool(own[1], given, short);
  if (name === 'Agent' || name === 'Task') return `Handing${quoted(given.description).replace(/^ for/, '')} to a subagent`;
  if (name === 'Read') return `Reading ${short(given.file_path)}`;
  if (name === 'Grep') return `Searching code${quoted(given.pattern)}`;
  if (name === 'Glob') return `Listing ${clip(given.pattern, 40) || 'files'}`;
  if (name === 'WebSearch') return `Searching the web${quoted(given.query)}`;
  if (name === 'WebFetch') return `Reading ${host(given.url)}`;
  // A Build's tools (2026-09-25); @bart never has these.
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return `Editing ${short(given.file_path || given.notebook_path)}`;
  if (name === 'Write') return `Writing ${short(given.file_path)}`;
  if (name === 'Bash') return commandLabel(given.command, short);
  return `Using ${clip(name, 24)}`;
}

/** One Claude Code stream-json event → { activity, log } | { textStart } | { delta } | null. */
function claudeUpdate(event, short) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    const tool = event.message.content.find((block) => block && block.type === 'tool_use'); // whole input; the stream_event form has none yet
    return tool ? { activity: claudeTool(tool.name, tool.input, short), log: true } : null;
  }
  if (event.type !== 'stream_event' || !event.event) return null;
  const inner = event.event;
  if (inner.type === 'content_block_start' && inner.content_block) {
    if (inner.content_block.type === 'thinking') return { activity: 'Thinking' };
    if (inner.content_block.type === 'text') return { textStart: true };
  }
  if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') return { delta: String(inner.delta.text || '') };
  return null;
}

const READERS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'bat', 'less', 'wc']);
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack']);
const LISTERS = new Set(['ls', 'find', 'fd', 'tree']);

/** Codex reads through the shell. Only the first command's name and one argument are shown. */
function commandLabel(command, short) {
  let text = String(command || '').trim();
  const wrapped = text.match(/^\S*(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (wrapped) text = wrapped[2];
  const words = text.split(/\s*(?:\||&&|;)\s*/)[0].split(/\s+/).map((word) => word.replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const name = path.basename(words[0] || '');
  const plain = words.slice(1).filter((word) => !word.startsWith('-'));
  if (READERS.has(name)) return `Reading ${short(plain[plain.length - 1])}`;
  if (SEARCHERS.has(name)) return `Searching code${quoted(plain[0])}`;
  if (LISTERS.has(name)) return 'Listing files';
  return name ? `Running ${clip(name, 24)}` : 'Running a command';
}

/** One `codex exec --json` event → { activity, log } | { text } | null. Codex sends a message whole, not in pieces. */
function codexUpdate(event, short) {
  const item = event && typeof event === 'object' && /^item\.(started|completed)$/.test(event.type) ? event.item : null;
  if (!item || typeof item !== 'object') return null;
  const started = event.type === 'item.started';
  if (item.type === 'command_execution') return started ? { activity: commandLabel(item.command, short), log: true } : null;
  if (item.type === 'web_search') {
    const query = item.query || (item.action && item.action.query);
    if (query) return { activity: `Searching the web${quoted(query)}`, log: true };
    return started ? { activity: 'Searching the web' } : null;
  }
  if (item.type === 'reasoning') return { activity: 'Thinking' };
  // @discover's paper tools (2026-09-30): `arguments` arrives as an object or as its JSON.
  if (item.type === 'mcp_tool_call') {
    if (!started) return null;
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { activity: item.server === 'papers' ? paperTool(item.tool, args) : item.server === 'engelbart' ? engelbartTool(item.tool, args, short) : `Using ${clip(item.tool, 24)}`, log: true };
  }
  // A Build's patch (2026-09-25): the first file it touches names it.
  if (item.type === 'file_change' && !started) { const first = Array.isArray(item.changes) && item.changes[0]; return { activity: `Editing ${first ? short(first.path) : 'files'}`, log: true }; }
  if (item.type === 'agent_message' && !started) return { text: String(item.text || '') };
  return null;
}

/** Bytes → whole lines → events. A line that is not JSON (a shell banner, a warning) is passed over. */
function eventReader(onEvent) {
  let rest = '';
  return (chunk) => {
    rest += String(chunk);
    const lines = rest.split('\n');
    rest = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      let event = null;
      try { event = JSON.parse(text); } catch { continue; }
      try { onEvent(event); } catch { /* showing progress never fails a run */ }
    }
  };
}

// "ESCALATE: <why>" is the agent talking to the harness (./ask.cjs), not an answer: it is never previewed.
const toHarness = (text) => { const head = text.trimStart().slice(0, 9); return head.length > 0 && 'ESCALATE:'.startsWith(head); };

/**
 * Updates → progress messages, the text at most once per interval: { activity, log? } when what it
 * is doing changes, { lines } as the answer grows (whole, flattened as the final answer will be).
 */
function createFeed({ onProgress = () => {}, intervalMs = 100 } = {}) {
  let text = '', sent = '', activity = '', timer = null;
  const say = (label, log) => { if (label && label !== activity) { activity = label; onProgress(log ? { activity: label, log: true } : { activity: label }); } };
  const flush = () => {
    timer = null;
    if (text === sent || toHarness(text)) return;
    sent = text;
    if (text.trim()) say('Writing');
    onProgress({ lines: text.trim() ? bodyLines(text) : [] });
  };
  return {
    take(update) {
      if (!update) return;
      if (update.activity) say(update.activity, update.log);
      if (update.textStart) text = '';
      if (typeof update.delta === 'string') text += update.delta;
      if (typeof update.text === 'string') text = update.text;
      if (text !== sent && !timer) timer = setTimeout(flush, intervalMs);
    },
    /** A new turn (the first, or one step up): nothing of the last one is kept. */
    reset() { if (timer) clearTimeout(timer); timer = null; text = ''; sent = ''; activity = ''; },
    end() { if (timer) clearTimeout(timer); timer = null; },
  };
}

module.exports = { pathLabeller, claudeUpdate, codexUpdate, commandLabel, paperTool, eventReader, createFeed };
