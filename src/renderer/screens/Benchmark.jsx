import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { parseLines, parseLine, inlineHtml, highlight, isMarked, listMark, fenceShown, esc } from '../model/doc.js';

// The Agent Viewer's Benchmark tab (2026-10-13; src/main/agent-map/benchmark.cjs): every Chat question in the notes, by
// note, in document order: the question across the top, the answer the note keeps (Old) beside the same question asked
// again under Chat's prompt now (New), and a note under the two, saved as it is typed. Run asks every question with no new
// answer yet, three at a time, and reads Stop while anything runs; Run again asks one. Plain on purpose: no counts, times,
// scores or summary.
// Runs (2026-10-14, David's): the new answers are kept by run, a tab each across the top, oldest first, with "+ New run"
// after them, which starts an empty one. Only the newest is asked into; an earlier one shows its answers as they were, with
// its notes, and has no Run or Run again. Export (2026-10-14) saves the run shown as one page: each question, its Old and New
// answers and the note, by note, with the same entries as JSON at its end.

const FONT = '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace';
const RULE = '1px solid #ddd';
const NOTE_SAVE_MS = 500;
const S = {
  root: { flex: 1, overflowY: 'auto', padding: '8px 14px 40px' },
  top: { display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 8px' },
  runs: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, margin: '0 0 10px', borderBottom: RULE, paddingBottom: 6 },
  run: (on) => ({ font: FONT, background: on ? '#111' : '#fff', color: on ? '#fff' : '#111', border: RULE, padding: '1px 8px', cursor: 'pointer' }),
  button: { font: FONT, background: '#fff', border: RULE, padding: '1px 6px', cursor: 'pointer', color: '#111' },
  link: { font: FONT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#0050c0', textDecoration: 'underline' },
  dim: { color: '#777' },
  group: { margin: '14px 0 4px', fontWeight: 600 },
  entry: { borderTop: RULE, padding: '8px 0 10px' },
  question: { display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 },
  columns: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 },
  label: { color: '#777', marginBottom: 2 },
  answer: { font: '14px/1.6 var(--font-sans, system-ui)', color: '#4d4d4d', background: '#fafafa', padding: '6px 12px', borderLeft: '2px solid #dcdcdc', overflowWrap: 'anywhere' },
  error: { color: '#a00' },
  note: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, font: FONT, border: RULE, padding: 4, minHeight: 44, resize: 'vertical' },
};

/** An answer's text as HTML, drawn as the document draws an answer's lines: headings, bullets and numbers, code blocks, inline marks. */
export function answerHtml(text) {
  const lines = String(text || '').split('\n');
  const ps = parseLines(lines);
  return lines.map((line, i) => {
    const p = ps[i];
    if (p.type === 'fence') return p.open ? `<div style="margin-top:6px;color:#8f8f8f;font:12px/1.6 var(--font-sans, system-ui)">${esc(fenceShown(p) || ' ')}</div>` : '<div style="height:6px"></div>';
    if (p.type === 'code') return `<div style="background:#fff;border:1px solid #eaeaea;border-width:0 1px;padding:0 10px;font:13px/1.6 var(--font-mono, ui-monospace, monospace);color:#171717;white-space:pre-wrap">${highlight(line, p.lang) || '<br>'}</div>`;
    const q = parseLine(line);
    if (q.type === 'h') return `<div style="font:600 ${[17, 16, 15][q.level - 1]}px/1.5 var(--font-sans, system-ui);color:#171717;padding-top:6px">${inlineHtml(q.text)}</div>`;
    if (isMarked(q.type)) return `<div style="display:flex;gap:8px;padding:2px 0 2px ${q.depth * 18}px"><span style="flex:none;color:#8f8f8f">${esc(listMark(q))}</span><span style="flex:1;min-width:0">${inlineHtml(q.text)}</span></div>`;
    if (!line.trim()) return '<div style="height:8px"></div>';
    return `<div>${inlineHtml(line)}</div>`;
  }).join('');
}

/** An answer drawn (answerHtml) in its grey box. */
export function AnswerView({ text }) {
  return <div style={S.answer} dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />;
}

/** What New shows: nothing until it is asked, Running… while it runs, the answer, or why it failed. */
function NewAnswer({ value }) {
  if (!value) return null;
  if (value.running) return <div style={S.dim}>Running…</div>;
  if (typeof value.answer === 'string') return <AnswerView text={value.answer} />;
  if (typeof value.error === 'string') return <div style={S.error}>{value.error}</div>;
  return null;
}

/** One question: across the top, Old and New beside each other, the note under them. */
export function BenchmarkEntry({ entry, note, onNote, onRunOne, live = true }) {
  return (
    <div style={S.entry} data-key={entry.key}>
      <div style={S.question}>
        <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', fontWeight: 600 }}>{entry.question}</div>
        {live && <button type="button" style={S.link} disabled={!!(entry.new && entry.new.running)} onClick={() => onRunOne(entry.key)}>Run again</button>}
      </div>
      <div style={S.columns}>
        <div><div style={S.label}>Old</div><AnswerView text={entry.old} /></div>
        <div><div style={S.label}>New</div><NewAnswer value={entry.new} /></div>
      </div>
      <textarea style={S.note} value={note} onChange={(event) => onNote(entry.key, event.target.value)} />
    </div>
  );
}

/** When a run was started, short: "Oct 14, 3:02 PM". */
export function runWhen(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The tab's list as drawn from what main gave: the runs as tabs, then Run (or Stop) on the newest run, then each note's
 * questions under its name.
 */
export function BenchmarkList({ data, notes = {}, onRun, onStop, onRunOne, onNote, onPick = () => {}, onNew = () => {}, onExport = () => {}, said = '', error = '' }) {
  const groups = (data && data.groups) || [];
  const runs = (data && data.runs) || [];
  const live = !data || data.live !== false;
  return (
    <div style={S.root}>
      {runs.length > 0 && (
        <div style={S.runs} role="tablist">
          {runs.map((run) => (
            <button key={run.id} type="button" role="tab" aria-selected={run.id === data.current} data-run={run.id} style={S.run(run.id === data.current)} onClick={() => onPick(run.id)} title={runWhen(run.at)}>
              {run.name}{runWhen(run.at) ? ` · ${runWhen(run.at)}` : ''}
            </button>
          ))}
          <button type="button" style={S.link} disabled={!!(data && data.running)} onClick={onNew}>+ New run</button>
        </div>
      )}
      <div style={S.top}>
        {data && data.running
          ? <button type="button" style={S.button} onClick={onStop}>Stop</button>
          : live ? <button type="button" style={S.button} disabled={!groups.length} onClick={onRun}>Run</button> : <span style={S.dim}>Kept as it was answered.</span>}
        <button type="button" style={S.button} disabled={!groups.length} onClick={onExport}>Export</button>
        {said ? <span style={S.dim}>{said}</span> : null}
        {error ? <span style={S.error}>{error}</span> : null}
      </div>
      {!data ? <div style={S.dim}>Loading…</div> : !groups.length ? <div style={S.dim}>No Chat questions in the notes.</div> : groups.map((group) => (
        <div key={group.rel}>
          <div style={S.group}>{group.name}</div>
          {group.entries.map((entry) => (
            <BenchmarkEntry key={entry.key} entry={entry} note={entry.key in notes ? notes[entry.key] : entry.note} onNote={onNote} onRunOne={onRunOne} live={live} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Each change main sends ({ run, key, new, running }) put into the list: only that entry's New, when it is in the run shown,
 * and whether anything runs.
 */
export function applyChange(data, change) {
  if (!data || !change) return data;
  if (change.run && data.current && change.run !== data.current) return { ...data, running: !!change.running };
  return {
    ...data,
    running: !!change.running,
    groups: data.groups.map((group) => (group.entries.some((entry) => entry.key === change.key)
      ? { ...group, entries: group.entries.map((entry) => (entry.key === change.key ? { ...entry, new: change.new || {} } : entry)) }
      : group)),
  };
}

const PAGE_STYLE = 'body{font:14px/1.5 system-ui,sans-serif;color:#171717;max-width:1200px;margin:24px auto;padding:0 16px}h1{font-size:20px}h2{font-size:16px;margin:28px 0 6px}.dim{color:#777}.entry{border-top:1px solid #ddd;padding:10px 0 12px}.q{font-weight:600;white-space:pre-wrap;margin-bottom:6px}.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.label{color:#777;font:12px/1.4 ui-monospace,Menlo,monospace;margin-bottom:2px}.answer{color:#4d4d4d;background:#fafafa;padding:6px 12px;border-left:2px solid #dcdcdc;overflow-wrap:anywhere}.error{color:#a00}.note{margin-top:6px;padding:4px 8px;border:1px solid #ddd;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,monospace}code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#efefef;padding:0 3px;border-radius:3px}';

/**
 * The run shown, as one page to save (2026-10-14): its name and when it ran, then by note each question, its Old and New
 * answers and the note (`notes`: what is typed and not saved yet, ahead of what is kept), and the same as JSON at the end.
 */
export function benchmarkPage(data, notes = {}, exported = new Date().toISOString()) {
  const run = ((data && data.runs) || []).find((one) => one.id === data.current) || null;
  const title = `Chat benchmark: ${run ? run.name : 'answers'}`;
  const noteOf = (entry) => (entry.key in notes ? notes[entry.key] : entry.note) || '';
  const newHtml = (value) => {
    if (value && typeof value.answer === 'string') return `<div class="answer">${answerHtml(value.answer)}</div>`;
    if (value && typeof value.error === 'string') return `<div class="error">${esc(value.error)}</div>`;
    return `<div class="dim">${value && value.running ? 'Still running when exported.' : 'Not asked in this run.'}</div>`;
  };
  const groups = (data && data.groups) || [];
  const body = groups.map((group) => `<h2>${esc(group.name)}</h2>${group.entries.map((entry) => `<div class="entry"><div class="q">${esc(entry.question)}</div><div class="cols"><div><div class="label">Old</div><div class="answer">${answerHtml(entry.old)}</div></div><div><div class="label">New</div>${newHtml(entry.new)}</div></div>${noteOf(entry).trim() ? `<div class="note">${esc(noteOf(entry))}</div>` : ''}</div>`).join('')}`).join('');
  const json = JSON.stringify({ run: run ? { id: run.id, name: run.name, at: run.at } : null, exported, entries: groups.flatMap((group) => group.entries.map((entry) => ({ note: group.rel, question: entry.question, old: entry.old, new: entry.new && typeof entry.new.answer === 'string' ? entry.new.answer : null, error: entry.new && typeof entry.new.error === 'string' ? entry.new.error : null, notes: noteOf(entry) }))) }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><h1>${esc(title)}</h1><div class="dim">${run && runWhen(run.at) ? `Run ${esc(runWhen(run.at))}. ` : ''}Exported from Engelbart's Agent Viewer, ${esc(exported)}.</div>${body}<script type="application/json" id="chat-benchmark">${json}</script></body></html>`;
}

export default function Benchmark() {
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const timers = useRef(new Map()); // run and key → its save waiting
  const typed = useRef({});
  const shown = useRef(null); // the run shown

  const show = useCallback((value) => { shown.current = value && value.current; setData(value); }, []);
  // The notes waiting to be saved are saved now (a tab switched, or closed).
  const flush = useCallback(() => {
    for (const [slot, timer] of timers.current) {
      clearTimeout(timer);
      const [run, key] = JSON.parse(slot);
      void api.saveChatBenchmarkNote(key, typed.current[slot], run).catch(() => {});
    }
    timers.current.clear();
  }, []);

  useEffect(() => {
    let live = true;
    api.chatBenchmark().then((value) => { if (live) show(value); }).catch((reason) => setError(errorMessage(reason)));
    const off = api.onChatBenchmark((change) => setData((current) => applyChange(current, change)));
    return () => { live = false; off(); flush(); };
  }, [show, flush]);

  const onNote = useCallback((key, text) => {
    const run = shown.current, slot = JSON.stringify([run, key]);
    typed.current[slot] = text;
    setNotes((current) => ({ ...current, [key]: text }));
    clearTimeout(timers.current.get(slot));
    timers.current.set(slot, setTimeout(() => {
      timers.current.delete(slot);
      api.saveChatBenchmarkNote(key, text, run).catch((reason) => setError(errorMessage(reason)));
    }, NOTE_SAVE_MS));
  }, []);
  const onPick = useCallback((id) => {
    if (id === shown.current) return;
    flush(); setNotes({}); setError(''); setSaid('');
    api.chatBenchmark(id).then(show).catch((reason) => setError(errorMessage(reason)));
  }, [flush, show]);
  const onNew = useCallback(() => {
    flush(); setNotes({}); setError(''); setSaid('');
    api.newChatBenchmarkRun().then((id) => api.chatBenchmark(id)).then(show).catch((reason) => setError(errorMessage(reason)));
  }, [flush, show]);
  const onRun = useCallback(() => { setError(''); api.runChatBenchmark(null, shown.current).catch((reason) => setError(errorMessage(reason))); }, []);
  const onStop = useCallback(() => { api.stopChatBenchmark().catch((reason) => setError(errorMessage(reason))); }, []);
  const onRunOne = useCallback((key) => { setError(''); api.runChatBenchmark(key, shown.current).catch((reason) => setError(errorMessage(reason))); }, []);

  const onExport = useCallback(async () => {
    if (!data) return;
    setError(''); setSaid('');
    try {
      const run = (data.runs || []).find((one) => one.id === data.current);
      const saved = await api.exportAgentRuns(benchmarkPage(data, notes), `chat-benchmark-${run ? run.id : 'answers'}-${new Date().toISOString().slice(0, 10)}`);
      setSaid(saved ? `Saved ${saved}` : 'Not saved.');
    } catch (reason) { setError(errorMessage(reason)); }
  }, [data, notes]);

  return <BenchmarkList data={data} notes={notes} onRun={onRun} onStop={onStop} onRunOne={onRunOne} onNote={onNote} onPick={onPick} onNew={onNew} onExport={onExport} said={said} error={error} />;
}
