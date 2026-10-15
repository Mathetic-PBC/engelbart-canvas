'use strict';

// What an @discover run is doing, told as its trace (2026-10-15, David's mockup): the steps grouped by the part of the
// trace they belong to (Starting papers, Papers they cite, Newer papers that cite them, then the reading and the web),
// each line saying what came back, by title: "Found “…” in your library", "Picked “…”, the closest of 25", "Listed the
// 41 papers “…” cites". ./activity.cjs labels a step by what it was asked; this reads the paper tools' own answers
// (./papers.cjs, JSON we write), and of those only titles, ids and counts. A web page is named by its host, as there.
//
// It reads the same raw events as ./activity.cjs (Claude Code's stream-json, `codex exec --json`), pairs each call with its
// result by id, and gives back the whole story each time it changes: { groups: [{ key, title, lines: [{ text, now }] }],
// latest, now, last }: `latest` the key of the part the newest step is in, `now` the line still waiting for its result, if
// any, `last` the newest step's line.

const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
// A title as a line names it: the part before a colon, or up to a question mark, when that part says enough
// ("SWE-agent", "How Do AI Agents Do Human Work?").
const named = (title) => { const text = String(title || '').replace(/\s+/g, ' ').trim(); const head = text.split(/:\s|(?<=\?)\s/)[0]; return `“${clip(head.length >= 4 ? head : text, 60)}”`; };
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const host = (url) => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

const GROUPS = { start: 'Starting papers', cites: 'Papers they cite', cited: 'Newer papers that cite them', read: 'Reading the papers', web: 'Essays and posts', files: 'Your notes and files' };
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i;
const ARXIV_BARE_RE = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const DOI_RE = /(10\.\d{4,9}\/[^\s?#]+)/i;
const WORK_RE = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i;
const MAX_LINES = 30; // a group's, its newest kept

const titleKey = (title) => String(title || '').toLowerCase().replace(/\.pdf$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const arxivOf = (text) => { const m = String(text || '').match(ARXIV_RE) || String(text || '').match(ARXIV_BARE_RE); return m ? m[1].toLowerCase() : null; };
const doiOf = (text) => { const m = String(text || '').match(DOI_RE); return m ? m[1].toLowerCase() : null; };

/** The library's entries (./context.cjs catalogEntries) → whether a paper record is one of them. */
function libraryMatcher(entries = []) {
  const arxiv = new Set(), dois = new Set(), titles = new Set();
  for (const entry of entries || []) {
    if (!entry) continue;
    for (const where of [entry.url, entry.path]) { const a = arxivOf(where), d = doiOf(where); if (a) arxiv.add(a); if (d) dois.add(d); }
    const key = titleKey(entry.name);
    if (key.length >= 8) titles.add(key);
  }
  return (record) => !!record && ((record.arxiv && arxiv.has(arxivOf(record.arxiv))) || (record.doi && (dois.has(String(record.doi).toLowerCase()) || (/^10\.48550\/arxiv\./i.test(record.doi) && arxiv.has(String(record.doi).replace(/^10\.48550\/arxiv\./i, '').toLowerCase())))) || titles.has(titleKey(record.title)));
}

/** A tool result's text: Claude's content (a string, or text blocks), Codex's `{ content: [...] }`. */
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block === 'string' ? block : block && block.type === 'text' ? String(block.text || '') : '')).join('\n');
  if (isObject(content) && Array.isArray(content.content)) return textOf(content.content);
  return '';
}
const jsonOf = (text) => { try { const value = JSON.parse(text); return isObject(value) ? value : null; } catch { return null; } };

/**
 * One raw event → the calls it starts and the results it brings, as [{ id, tool, input }] | [{ id, result, error }].
 * `tool`: a paper tool's own name (resolve, references…), 'web_fetch', 'web_search' or 'read'; other tools are left out.
 */
function callsOf(event) {
  if (!isObject(event)) return [];
  const blocks = isObject(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
  const claudeTool = (name) => { const paper = /^mcp__papers__(\w+)$/.exec(String(name || '')); return paper ? paper[1] : { WebFetch: 'web_fetch', WebSearch: 'web_search', Read: 'read' }[name] || null; };
  if (event.type === 'assistant') return blocks.filter((block) => block && block.type === 'tool_use' && claudeTool(block.name)).map((block) => ({ id: String(block.id || ''), tool: claudeTool(block.name), input: isObject(block.input) ? block.input : {} }));
  if (event.type === 'user') return blocks.filter((block) => block && block.type === 'tool_result').map((block) => ({ id: String(block.tool_use_id || ''), result: textOf(block.content), error: !!block.is_error }));
  if (!/^item\.(started|completed)$/.test(String(event.type)) || !isObject(event.item)) return [];
  const item = event.item, done = event.type === 'item.completed', id = String(item.id || '');
  if (item.type === 'mcp_tool_call' && item.server === 'papers') {
    if (done) return [{ id, result: textOf(item.result), error: item.error != null || item.status === 'failed' }];
    let input = item.arguments;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
    return [{ id, tool: String(item.tool || ''), input: isObject(input) ? input : {} }];
  }
  if (item.type === 'web_search' && done) {
    const action = isObject(item.action) ? item.action : {};
    if (action.type === 'open_page' && action.url) return [{ id, tool: 'web_fetch', input: { url: action.url } }, { id, result: '', error: false }];
    const query = item.query || action.query;
    return query ? [{ id, tool: 'web_search', input: { query } }, { id, result: '', error: false }] : [];
  }
  return [];
}

/** → { take(event) → the story when it changed, else null; story() }. `entries`: the library, to say "in your library". */
function createTrace({ entries = [] } = {}) {
  const inLibrary = libraryMatcher(entries);
  const records = new Map(); // id (W…, arXiv id, DOI) → { title }
  const groups = [], open = new Map(); // call id → { line, call }
  let traced = null, found = null; // the trace's part the last references/citations call was in; the last search's results
  let lastLine = null; // the line the last call began on: a lookup right after a check joins it

  const know = (record) => {
    if (!isObject(record) || !record.title) return;
    for (const key of [record.id, record.arxiv && arxivOf(record.arxiv), record.doi && String(record.doi).toLowerCase(), record.doi && /^10\.48550\/arxiv\./i.test(record.doi) ? String(record.doi).replace(/^10\.48550\/arxiv\./i, '').toLowerCase() : null]) if (key) records.set(String(key), record);
  };
  const recordFor = (ref) => {
    const text = String(ref || '').trim(), work = WORK_RE.exec(text);
    return records.get(work ? work[1].toUpperCase() : null) || records.get(arxivOf(text)) || records.get(doiOf(text)) || null;
  };
  const nameOf = (ref) => { const record = recordFor(ref); return record ? named(record.title) : `“${clip(ref, 32)}”`; };
  const group = (key) => {
    let at = groups.find((one) => one.key === key);
    if (!at) { at = { key, title: GROUPS[key], lines: [] }; groups.push(at); }
    return at;
  };
  let latest = null; // the part the newest step is in: the one still going
  const add = (key, line) => { latest = key; const at = group(key); at.lines.push(line); if (at.lines.length > MAX_LINES) at.lines.shift(); return line; };

  // Lookups after the trace has begun are checks of what it turned up: run together, they are one line.
  const checkText = (titles, done) => {
    const shown = titles.length > 3 ? [...titles.slice(0, 2), `${titles.length - 2} more`] : titles;
    const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
    return `${done ? 'Checked' : 'Checking'} whether ${list} ${done || titles.length > 1 ? 'fit' : 'fits'}`;
  };

  function start({ id, tool, input }) {
    const given = isObject(input) ? input : {};
    if (tool === 'search') {
      const words = given.by === 'words';
      return { line: add(traced || 'start', { text: words ? `Searching papers for “${clip(given.query, 40)}”` : 'Searching for papers close to your problem', now: true }), call: { tool, words, query: given.query } };
    }
    if (tool === 'resolve') {
      const label = recordFor(given.query) ? nameOf(given.query) : `“${clip(given.query, 40)}”`;
      if (traced) {
        // One line for a run of lookups: the last line of this part, while it is a check.
        const at = group(traced), last = at.lines[at.lines.length - 1];
        if (last && last.check && last === lastLine) { latest = traced; last.check.push(label); last.waiting += 1; last.now = true; last.text = checkText(last.check, false); return { line: last, call: { tool, check: true, label } }; }
        const line = add(traced, { text: checkText([label], false), now: true, check: [label], waiting: 1 });
        return { line, call: { tool, check: true, label } };
      }
      return { line: add('start', { text: `Looking up ${label}`, now: true }), call: { tool } };
    }
    if (tool === 'references') { traced = 'cites'; return { line: add('cites', { text: `Listing the papers ${nameOf(given.id)} cites`, now: true }), call: { tool } }; }
    if (tool === 'citations') { traced = 'cited'; return { line: add('cited', { text: `Finding newer papers that cite ${nameOf(given.id)}`, now: true }), call: { tool } }; }
    if (tool === 'related') return { line: add(traced || 'start', { text: `Finding papers near ${nameOf(given.id)}`, now: true }), call: { tool } };
    if (tool === 'author_works') return { line: add(traced || 'start', { text: `Listing the works of ${clip(given.author, 40)}`, now: true }), call: { tool } };
    if (tool === 'web_fetch') {
      const record = recordFor(given.url), paper = record || arxivOf(given.url) || doiOf(given.url) || /\.pdf(?:$|[?#])/i.test(String(given.url || ''));
      return { line: add(paper ? 'read' : 'web', { text: record ? `Reading ${named(record.title)}` : `Reading ${host(given.url)}`, now: true }), call: { tool, record } };
    }
    if (tool === 'web_search') return { line: add('web', { text: `Searching the web for “${clip(given.query, 40)}”`, now: true }), call: { tool } };
    // A pdf read from disk is a paper (a web fetch keeps one as a file): the reading, not the person's files.
    if (tool === 'read') {
      const file = String(given.file_path || ''), pdf = /\.pdf$/i.test(file);
      return { line: add(pdf ? 'read' : 'files', { text: pdf && /webfetch-/i.test(file) ? 'Reading a pdf it downloaded' : `Reading ${clip(file.split('/').pop() || 'a file', 40)}`, now: true }), call: { tool } };
    }
    return null;
  }

  function finish({ line, call }, { result, error }) {
    const out = error ? null : jsonOf(result);
    // resolve answers { found, paper }; the lists { of, results }.
    const paper = out && isObject(out.paper) ? out.paper : null;
    if (out) { know(paper); know(out.of); for (const record of Array.isArray(out.results) ? out.results : []) know(record); }
    const past = (text) => text.replace(/^Searching/, 'Searched').replace(/^Looking up/, 'Looked up').replace(/^Listing/, 'Listed').replace(/^Finding/, 'Looked for').replace(/^Reading/, 'Read');
    if (call.check) {
      line.waiting -= 1;
      if (paper && paper.title) { const n = line.check.indexOf(call.label); if (n >= 0) line.check[n] = named(paper.title); }
      if (line.waiting <= 0) { line.now = false; line.text = checkText(line.check, true); } else line.text = checkText(line.check, false);
      return;
    }
    line.now = false;
    const failed = (text) => text.replace(/^Searching/, 'Couldn’t search').replace(/^Looking up/, 'Couldn’t look up').replace(/^Listing/, 'Couldn’t list').replace(/^Finding/, 'Couldn’t find').replace(/^Reading/, 'Couldn’t read');
    if (!out) { line.text = error ? failed(line.text) : past(line.text); return; }
    if (call.tool === 'search') {
      const results = Array.isArray(out.results) ? out.results : [];
      found = { ids: results.map((record) => record.id), total: results.length };
      line.text = call.words ? `Searched papers for “${clip(call.query, 40)}”: ${plural(results.length, 'result')}` : results.length ? 'Searched for papers close to your problem' : 'Searched for papers close to your problem: none came back';
      return;
    }
    if (call.tool === 'resolve') {
      if (out.found === false) { line.text = line.text.replace(/^Looking up/, 'Found nothing for'); return; }
      if (!paper || !paper.title) { line.text = past(line.text); return; }
      const rank = found ? found.ids.indexOf(paper.id) : -1;
      line.text = inLibrary(paper) ? `Found ${named(paper.title)} in your library`
        : rank >= 0 ? `Picked ${named(paper.title)}, the ${rank ? `${ordinal(rank + 1)} closest` : 'closest'} of ${found.total}`
          : `Looked up ${named(paper.title)}`;
      return;
    }
    const of = out.of && out.of.title ? named(out.of.title) : null;
    const count = Number(out.total) || (Array.isArray(out.results) ? out.results.length : 0);
    if (call.tool === 'references' && of) { line.text = count ? `Listed the ${plural(count, 'paper')} ${of} cites` : `${of} cites no paper OpenAlex knows`; return; }
    if (call.tool === 'citations' && of) { line.text = count ? `Found ${count === 1 ? '1 newer paper that cites' : `${count} newer papers that cite`} ${of}` : `No paper cites ${of} yet`; return; }
    if (call.tool === 'related' && of) { line.text = `Found ${plural(Array.isArray(out.results) ? out.results.length : 0, 'paper')} near ${of}`; return; }
    if (call.tool === 'author_works') { line.text = out.found === false ? `Found no author called ${clip(out.author, 40)}` : `Listed the works of ${clip(out.author && out.author.name, 40) || 'the author'}`; return; }
    line.text = past(line.text);
  }

  const story = () => {
    const lines = groups.flatMap((at) => at.lines);
    const now = [...lines].reverse().find((line) => line.now);
    return { groups: groups.map((at) => ({ key: at.key, title: at.title, lines: at.lines.map((line) => ({ text: line.text, now: !!line.now })) })), latest, now: now ? now.text : null, last: lastLine ? lastLine.text : null };
  };
  return {
    take(event) {
      let changed = false;
      for (const one of callsOf(event)) {
        if (one.tool) {
          const begun = start(one);
          if (begun) { open.set(one.id, begun); lastLine = begun.line; changed = true; }
        } else if (open.has(one.id)) {
          finish(open.get(one.id), one);
          open.delete(one.id);
          changed = true;
        }
      }
      return changed ? story() : null;
    },
    story,
  };
}

module.exports = { createTrace, callsOf, libraryMatcher, named, GROUPS };
