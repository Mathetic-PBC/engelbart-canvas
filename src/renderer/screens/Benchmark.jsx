import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { parseLines, parseLine, inlineHtml, highlight, isMarked, listMark, fenceShown } from '../model/doc.js';

// The Agent Viewer's Benchmark tab (2026-10-13; src/main/agent-map/benchmark.cjs): every Chat question in the notes, by
// note, in document order: the question across the top, the answer the note keeps (Old) beside the same question asked
// again under Chat's prompt now (New), and a note under the two, saved as it is typed. Run asks every question with no new
// answer yet, three at a time, and reads Stop while anything runs; Run again asks one. Plain on purpose: no counts, times,
// scores or summary.

const FONT = '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace';
const RULE = '1px solid #ddd';
const NOTE_SAVE_MS = 500;
const S = {
  root: { flex: 1, overflowY: 'auto', padding: '8px 14px 40px' },
  top: { display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 8px' },
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

/** An answer's text drawn as the document draws an answer's lines: headings, bullets and numbers, code blocks, inline marks. */
export function AnswerView({ text }) {
  const lines = String(text || '').split('\n');
  const ps = parseLines(lines);
  return (
    <div style={S.answer}>
      {lines.map((line, i) => {
        const p = ps[i];
        if (p.type === 'fence') return p.open ? <div key={i} style={{ marginTop: 6, color: '#8f8f8f', font: '12px/1.6 var(--font-sans, system-ui)' }}>{fenceShown(p) || ' '}</div> : <div key={i} style={{ height: 6 }} />;
        if (p.type === 'code') return <div key={i} style={{ background: '#fff', border: '1px solid #eaeaea', borderWidth: '0 1px', padding: '0 10px', font: '13px/1.6 var(--font-mono, ui-monospace, monospace)', color: '#171717', whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: highlight(line, p.lang) || '<br>' }} />;
        const q = parseLine(line);
        if (q.type === 'h') return <div key={i} style={{ font: `600 ${[17, 16, 15][q.level - 1]}px/1.5 var(--font-sans, system-ui)`, color: '#171717', paddingTop: 6 }} dangerouslySetInnerHTML={{ __html: inlineHtml(q.text) }} />;
        if (isMarked(q.type)) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, padding: `2px 0 2px ${q.depth * 18}px` }}>
              <span style={{ flex: 'none', color: '#8f8f8f' }}>{listMark(q)}</span>
              <span style={{ flex: 1, minWidth: 0 }} dangerouslySetInnerHTML={{ __html: inlineHtml(q.text) }} />
            </div>
          );
        }
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
        return <div key={i} dangerouslySetInnerHTML={{ __html: inlineHtml(line) }} />;
      })}
    </div>
  );
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
export function BenchmarkEntry({ entry, note, onNote, onRunOne }) {
  return (
    <div style={S.entry} data-key={entry.key}>
      <div style={S.question}>
        <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', fontWeight: 600 }}>{entry.question}</div>
        <button type="button" style={S.link} disabled={!!(entry.new && entry.new.running)} onClick={() => onRunOne(entry.key)}>Run again</button>
      </div>
      <div style={S.columns}>
        <div><div style={S.label}>Old</div><AnswerView text={entry.old} /></div>
        <div><div style={S.label}>New</div><NewAnswer value={entry.new} /></div>
      </div>
      <textarea style={S.note} value={note} onChange={(event) => onNote(entry.key, event.target.value)} />
    </div>
  );
}

/** The tab's list as drawn from what main gave: Run (or Stop) at the top, then each note's questions under its name. */
export function BenchmarkList({ data, notes = {}, onRun, onStop, onRunOne, onNote, error = '' }) {
  const groups = (data && data.groups) || [];
  return (
    <div style={S.root}>
      <div style={S.top}>
        {data && data.running
          ? <button type="button" style={S.button} onClick={onStop}>Stop</button>
          : <button type="button" style={S.button} disabled={!groups.length} onClick={onRun}>Run</button>}
        {error ? <span style={S.error}>{error}</span> : null}
      </div>
      {!data ? <div style={S.dim}>Loading…</div> : !groups.length ? <div style={S.dim}>No Chat questions in the notes.</div> : groups.map((group) => (
        <div key={group.rel}>
          <div style={S.group}>{group.name}</div>
          {group.entries.map((entry) => (
            <BenchmarkEntry key={entry.key} entry={entry} note={entry.key in notes ? notes[entry.key] : entry.note} onNote={onNote} onRunOne={onRunOne} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Each change main sends ({ key, new, running }) put into the list: only that entry's New, and whether anything runs. */
export function applyChange(data, change) {
  if (!data || !change) return data;
  return {
    ...data,
    running: !!change.running,
    groups: data.groups.map((group) => (group.entries.some((entry) => entry.key === change.key)
      ? { ...group, entries: group.entries.map((entry) => (entry.key === change.key ? { ...entry, new: change.new || {} } : entry)) }
      : group)),
  };
}

export default function Benchmark() {
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const timers = useRef(new Map());
  const typed = useRef({});

  useEffect(() => {
    let live = true;
    api.chatBenchmark().then((value) => { if (live) setData(value); }).catch((reason) => setError(errorMessage(reason)));
    const off = api.onChatBenchmark((change) => setData((current) => applyChange(current, change)));
    const pending = timers.current;
    return () => {
      live = false; off();
      // A note still waiting to be saved is saved as the tab closes.
      for (const [key, timer] of pending) { clearTimeout(timer); void api.saveChatBenchmarkNote(key, typed.current[key]).catch(() => {}); }
      pending.clear();
    };
  }, []);

  const onNote = useCallback((key, text) => {
    typed.current[key] = text;
    setNotes((current) => ({ ...current, [key]: text }));
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => {
      timers.current.delete(key);
      api.saveChatBenchmarkNote(key, text).catch((reason) => setError(errorMessage(reason)));
    }, NOTE_SAVE_MS));
  }, []);
  const onRun = useCallback(() => { setError(''); api.runChatBenchmark().catch((reason) => setError(errorMessage(reason))); }, []);
  const onStop = useCallback(() => { api.stopChatBenchmark().catch((reason) => setError(errorMessage(reason))); }, []);
  const onRunOne = useCallback((key) => { setError(''); api.runChatBenchmark(key).catch((reason) => setError(errorMessage(reason))); }, []);

  return <BenchmarkList data={data} notes={notes} onRun={onRun} onStop={onStop} onRunOne={onRunOne} onNote={onNote} error={error} />;
}
