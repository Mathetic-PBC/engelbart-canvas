'use strict';

// The summary sweep. While the app is open it looks at the library table once a minute (the
// conditions are about half-hours, so a shorter beat buys nothing), and again right after launch
// and after the computer wakes. A note is dispatched to the summarizer when it has not been
// edited for 30 minutes and either
//   1. it has no summary ("Null > 30 mins": file + system prompt in, summary out), or
//   2. its summary is older than its last edit ("Not null > 30 mins": file + system prompt +
//      current summary in, summary out).
// Before dispatching, the file has to be longer than 1000 characters; a shorter note keeps (or
// returns to) a null summary, since reading it costs less than reading about it. A note is an md
// tagged `note`; an md added from outside is not swept. A PDF (every row of type pdf, tagged paper
// or not) follows the same clock by its file's modification time, with one difference: if it prints an "Abstract"
// section, that text is its summary, no model runs, and the length rule does not apply; a PDF
// without one is summarized from its extracted text. Images and every other type stay null. Writing a summary sets summary and summary_edited
// and nothing else. Afterwards every project's .context/catalog.json is brought up to date.

const fs = require('node:fs');
const path = require('node:path');
const { writeJson, DIR_MODE } = require('../store/home.cjs');
const projects = require('../store/projects.cjs');
const { writeCatalogs } = require('./catalog.cjs');
const { loadSystemPrompt } = require('./summarizer.cjs');
const { extractAbstract, extractText } = require('./pdf-text.cjs');

const MINUTE = 60_000;
const DEFAULTS = { quietMs: 30 * MINUTE, minChars: 1000, intervalMs: MINUTE, firstDelayMs: 5_000, perSweep: 5 };

function createSweeper(options) {
  const { getContext, summarize, now = () => Date.now(), log = () => {} } = options;
  const config = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([key, value]) => key in DEFAULTS && value != null)) };
  const retry = new Map(); // row id → { attempts, at }
  const papers = new Map(); // paper id → { modified, nothing }: PDFs already found to hold no abstract and no usable text
  let pausedUntil = 0; // the provider itself is unavailable: nothing is dispatched before this
  let timer = null;
  let soon = null;
  let running = null;
  let spentUsd = 0;
  let last = null;
  let inFlight = null; // AbortController of the dispatch under way

  // One model call for one row, under the shared limits. `stillCurrent` says whether the source
  // changed while the summary was being written; if it did the result is dropped and the row settles again.
  async function dispatch(ctx, row, text, report, stillCurrent) {
    const waiting = retry.get(row.id);
    if ((waiting && waiting.at > now()) || pausedUntil > now() || report.dispatched >= config.perSweep) { report.pending.push(row.name); return; }
    report.dispatched += 1;
    const readAt = new Date(now());
    inFlight = new AbortController();
    try {
      const { summary, meta } = await summarize({ name: row.name, text, currentSummary: row.summary || null, systemPrompt: loadSystemPrompt(ctx.dataRoot), signal: inFlight.signal });
      if (!(await stillCurrent())) { report.discarded.push(row.name); return; }
      await ctx.libraryDb.setSummary(row.id, summary, readAt);
      retry.delete(row.id);
      if (meta && typeof meta.costUsd === 'number') spentUsd += meta.costUsd;
      report.summarized.push({ name: row.name, updated: row.summary != null, ...meta });
    } catch (error) {
      const kind = error && error.kind ? error.kind : 'failed';
      if (kind === 'unavailable') pausedUntil = now() + 10 * MINUTE;
      const attempts = (waiting ? waiting.attempts : 0) + 1;
      retry.set(row.id, { attempts, at: now() + Math.min(8 * 60, kind === 'too-long' ? 24 * 60 : 5 * 2 ** (attempts - 1)) * MINUTE });
      report.failed.push({ name: row.name, kind, message: String((error && error.message) || error).slice(0, 300) });
    } finally {
      inFlight = null;
    }
  }

  async function considerNote(ctx, row, report) {
    let text;
    try { text = fs.readFileSync(row.path, 'utf8'); } catch { report.missing.push(row.name); return; }
    if (text.length !== row.char_count) await ctx.libraryDb.setCharCount(row.id, text.length);
    if (text.length <= config.minChars) {
      if (row.summary != null) { await ctx.libraryDb.setSummary(row.id, null); report.cleared.push(row.name); } else report.short.push(row.name);
      return;
    }
    await dispatch(ctx, row, text, report, async () => { const fresh = await ctx.libraryDb.get(row.id); return !!fresh && fresh.last_edited === row.last_edited; });
  }

  // A PDF is "edited" when its file changes. If it prints an Abstract, that text is the summary and no
  // model runs, whatever its length; only a PDF without one goes through the same dispatch as a note.
  async function considerPaper(ctx, row, report) {
    if (!/\.pdf$/i.test(row.path)) return;
    let modified;
    try { modified = fs.statSync(row.path).mtimeMs; } catch { report.missing.push(row.name); return; }
    if (now() - modified < config.quietMs) return; // changed within the last 30 minutes
    if (row.summary != null && row.summary_edited && Date.parse(row.summary_edited) >= modified) return; // summarized since it last changed
    const known = papers.get(row.id);
    if (known && known.modified === modified && known.nothing) return; // no abstract and no usable text; looked at already
    if (report.extracted >= config.perSweep) { report.pending.push(row.name); return; }
    report.extracted += 1;
    const readAt = new Date(now());
    let abstract = null;
    try { abstract = await extractAbstract(row.path); } catch (error) { report.failed.push({ name: row.name, kind: 'unreadable', message: String((error && error.message) || error).slice(0, 300) }); papers.set(row.id, { modified, nothing: true }); return; }
    if (abstract) {
      await ctx.libraryDb.setSummary(row.id, abstract, readAt);
      report.abstracts.push(row.name);
      return;
    }
    let text = '';
    try { text = await extractText(row.path); } catch { text = ''; }
    if (text.length <= config.minChars) { // scanned, or nearly empty: nothing to summarize
      if (row.summary != null) { await ctx.libraryDb.setSummary(row.id, null); report.cleared.push(row.name); }
      papers.set(row.id, { modified, nothing: true });
      return;
    }
    await dispatch(ctx, row, text, report, async () => { try { return fs.statSync(row.path).mtimeMs === modified; } catch { return false; } });
  }

  async function sweepOnce() {
    const ctx = await getContext();
    const report = { at: new Date(now()).toISOString(), dispatched: 0, extracted: 0, summarized: [], abstracts: [], cleared: [], short: [], pending: [], discarded: [], missing: [], failed: [], catalogs: [] };
    for (const row of await ctx.libraryDb.uncountedNotes()) {
      try { await ctx.libraryDb.setCharCount(row.id, fs.readFileSync(row.path, 'utf8').length); } catch { /* the file is gone */ }
    }
    projects.recountWorkspaces(ctx);
    for (const row of await ctx.libraryDb.summaryCandidates(new Date(now() - config.quietMs), config.minChars)) await considerNote(ctx, row, report);
    for (const row of await ctx.libraryDb.papersWithFiles()) await considerPaper(ctx, row, report);
    report.catalogs = await writeCatalogs(ctx, { now: () => new Date(now()) });
    const interesting = report.summarized.length || report.abstracts.length || report.cleared.length || report.failed.length || report.discarded.length || report.catalogs.length;
    if (interesting || !last) {
      last = { ...report, providerPausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, spentUsdThisRun: Number(spentUsd.toFixed(4)) };
      try {
        fs.mkdirSync(path.join(ctx.dataRoot, '.context'), { recursive: true, mode: DIR_MODE });
        writeJson(path.join(ctx.dataRoot, '.context', 'status.json'), last);
      } catch { /* status is best effort */ }
      log(last);
    }
    return report;
  }

  function sweep() {
    if (!running) running = sweepOnce().catch((error) => { log({ error: String((error && error.message) || error) }); return null; }).finally(() => { running = null; });
    return running;
  }

  return {
    sweep,
    start() {
      if (timer) return;
      soon = setTimeout(() => { soon = null; void sweep(); }, config.firstDelayMs);
      timer = setInterval(() => { void sweep(); }, config.intervalMs);
      if (timer.unref) timer.unref();
    },
    sweepSoon(delayMs = 1500) {
      if (soon) clearTimeout(soon);
      soon = setTimeout(() => { soon = null; void sweep(); }, delayMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = null; soon = null;
      if (inFlight) inFlight.abort();
      if (running) await running;
    },
    status: () => last,
  };
}

module.exports = { createSweeper, DEFAULTS };
