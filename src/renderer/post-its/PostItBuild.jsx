// A post-it's Build popup (Claude Design "Post-it Quick Task", 2026-09-27; Hudson's tweaks in design/post-it-quick-task/
// TWEAKS.md). It opens from the card's Build button, beside the card and over it and any other card it reaches (it is a
// covering panel: main draws those cards as pictures under it). It holds the model and effort grid, and along its foot
// what is chosen, Context (the library, in a popout of its own beside this one) and the send. Sending starts the post-it
// as a quick task. The model chosen is remembered for the next post-it.
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { attachRows } from '../model/rail.js';
import { usePlaced } from '../ui/usePlaced.js';
import { KIND } from '../ui/Icons.jsx';
import GithubPane from '../workspace/GithubPane.jsx';
import ModelGrid, { EASE, choiceLabel, useBeside } from './ModelGrid.jsx';

const WIDTH = 420;
const CONTEXT_WIDTH = 290;
const REMEMBERED = 'engelbart.postIt.build'; // { provider, model, effort, efforts }

const read = () => { try { return JSON.parse(localStorage.getItem(REMEMBERED) || 'null'); } catch { return null; } };
const write = (value) => { try { localStorage.setItem(REMEMBERED, JSON.stringify(value)); } catch { /* a convenience only */ } };

/** What was chosen last, if the models file still offers it; else the default provider's default. */
export function startingChoice(models, held = read()) {
  if (held && models.providers[held.provider] && models.providers[held.provider].models[held.model] && models.providers[held.provider].efforts.includes(held.effort)) {
    return { provider: held.provider, model: held.model, effort: held.effort };
  }
  const step = models.providers[models.provider].ladder[0];
  return { provider: models.provider, model: step.model, effort: step.effort };
}

export const SEND_ARROW = <span style={{ display: 'block', lineHeight: 1, transform: 'translateY(-.5px)' }}>↑</span>;
export const sendStyle = (ready) => ({ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, border: 0, borderRadius: '50%', background: ready ? '#0070f3' : '#eaeaea', color: ready ? '#fff' : '#8f8f8f', font: '500 14px/30px var(--font-sans)', cursor: ready ? 'pointer' : 'default', transition: 'opacity 120ms, background 160ms' });
const CIRCLE_PLUS = <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" style={{ display: 'block', flex: 'none', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }}><circle cx="9" cy="9" r="7.5" /><path d="M9 5.5v7 M5.5 9h7" /></svg>;
const SEARCH = <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>;
const FOLDER = <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round' }}><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>;
const menuRow = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms', font: '400 14px/1.5 var(--font-sans)', color: '#171717' };

/**
 * Context (the design's popout): a search over the library whose rows are picked and unpicked (a ✓, no circles), then
 * a link or path, files from disk, or a repository from GitHub, added to the library and picked at once.
 */
function ContextPopout({ style, library, inRail, picked, onToggle, onAdded, onClose }) {
  const [q, setQ] = React.useState('');
  const [view, setView] = React.useState('menu'); // 'menu' | 'github'
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const fieldRef = React.useRef(null);
  React.useEffect(() => {
    if (style.visibility === 'hidden') return undefined;
    const timer = setTimeout(() => { if (fieldRef.current && view === 'menu') fieldRef.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [style.visibility, view]);
  const rows = attachRows({ query: q, library, inRail });
  // Picked rows stay listed while nothing is typed, even when they are not among the recent ones.
  const shown = q.trim() ? rows : [...picked.filter((row) => !rows.some((held) => held.row.id === row.id)).map((row) => ({ key: row.id, row, name: row.name })), ...rows];
  const run = async (work) => {
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const add = () => { const input = value.trim(); if (input && !busy) void run(async () => { onAdded([await api.addLibraryItem(input)]); setValue(''); }); };
  const disk = () => run(async () => {
    const added = [], problems = [];
    for (const file of (await api.pickLibraryPaths()) || []) {
      try { added.push(await api.addLibraryItem(file)); } catch (failure) { problems.push(errorMessage(failure)); }
    }
    if (added.length) onAdded(added);
    if (problems.length) throw new Error(problems.join(' · '));
  });
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) setQ(''); else onClose(); } };
  return (
    <div data-overlay="1" data-cover="1" data-ctx-pop="1" onKeyDown={onKey} style={{ ...style, zIndex: 60, boxSizing: 'border-box', padding: 10, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2, animation: `rise 140ms ${EASE}` }}>
      {view === 'github' ? (
        <GithubPane library={library} inRail={inRail} busy={busy} onBack={() => { setView('menu'); setError(''); }} onPick={({ repo, row }) => run(async () => { onAdded([row || await api.addLibraryItem(repo.url)]); setView('menu'); })} />
      ) : (<>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', marginBottom: 4, border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'text' }}>
          {SEARCH}
          <input ref={fieldRef} data-ctx-search="1" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search" aria-label="Search the library" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, outline: 'none', background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717' }} />
        </label>
        <div style={{ maxHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {shown.map((item) => {
            const on = picked.some((row) => row.id === item.row.id);
            return (
              <button key={item.key} type="button" className="hov-wash" data-ctx-row={item.row.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onToggle(item.row)} style={{ ...menuRow, gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: on ? 500 : 400 }}>{item.name}</span>
                <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '500 12px/1 var(--font-sans)', color: '#171717' }}>{on ? '✓' : ''}</span>
              </button>
            );
          })}
          {!shown.length && <div style={{ padding: '7px 10px', font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing in the library matches.</div>}
        </div>
        <div style={{ height: 1, background: '#eaeaea', margin: '6px 0 8px' }} />
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', marginBottom: 4, border: `1px solid ${error ? '#e70022' : '#eaeaea'}`, borderRadius: 6, background: '#fafafa' }}>
          <input value={value} readOnly={busy} onChange={(event) => { setValue(event.target.value); setError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder="Upload URL or path" aria-label="Upload URL or path" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, outline: 'none', background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }} />
        </div>
        <button type="button" className="hov-wash" disabled={busy} onClick={disk} style={menuRow}>{FOLDER}<span style={{ flex: 1, minWidth: 0 }}>Choose from disk…</span></button>
        <button type="button" className="hov-wash" disabled={busy} onClick={() => { setError(''); setView('github'); }} style={menuRow}>
          <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><span style={{ display: 'flex', width: 13, height: 13 }}>{KIND.git.glyph}</span></span>
          <span style={{ flex: 1, minWidth: 0 }}>Add from GitHub…</span>
        </button>
      </>)}
      {error && <div style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</div>}
    </div>
  );
}

/**
 * `anchor` { left, right, top, bottom } is the card's Build button in the window; `quick` { postItId, text }.
 * `onStart({ provider, model, effort, attach })` sends it; `onLibraryChanged()` after Context added something.
 */
export default function PostItBuild({ projectId, quick, anchor, library, inRail, workspaces = [], hereId, onClose, onStart, onLibraryChanged }) {
  const [workspaceId, setWorkspaceId] = React.useState(hereId || '');
  const [models, setModels] = React.useState(null);
  const [choice, setChoice] = React.useState(null);
  const [efforts, setEfforts] = React.useState(() => (read() || {}).efforts || {});
  const [pre, setPre] = React.useState(null);
  const [picked, setPicked] = React.useState([]); // library rows for Context
  const [ctxOpen, setCtxOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [ref, placed] = usePlaced(anchor, { gap: 8, align: 'end' });
  const ctxStyle = useBeside(ref, CONTEXT_WIDTH, ctxOpen);

  React.useEffect(() => {
    let live = true;
    api.buildModels().then((value) => { if (live) { setModels(value); setChoice(startingChoice(value)); } }).catch((e) => { if (live) setError(errorMessage(e)); });
    api.buildPreflight(projectId).then((value) => { if (live) setPre(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [projectId]);

  const choose = (next) => {
    setChoice(next);
    const kept = { ...efforts, [next.model]: next.effort };
    setEfforts(kept);
    write({ ...next, efforts: kept });
  };
  const ready = !!(choice && pre && pre.ok && !busy && workspaceId && quick && quick.text.trim());
  const send = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try { await onStart({ ...choice, workspaceId, attach: picked.map((row) => row.id) }); } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  const startHistory = async () => {
    setBusy(true); setError('');
    try { setPre(await api.buildInit(projectId)); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (ctxOpen) setCtxOpen(false); else if (!busy) onClose(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  React.useEffect(() => {
    const away = (event) => {
      if (busy || (event.target && event.target.closest && event.target.closest('[data-post-it-build], [data-ctx-pop]'))) return;
      onClose();
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [busy, onClose]);

  const problem = error || (pre && !pre.ok ? pre.problems[0].message : '');
  const nCtx = picked.length;
  return createPortal(
    <>
      <div ref={ref} data-overlay="1" data-cover="1" data-post-it-build={quick.postItId} role="dialog" aria-label="Build" style={{ ...placed, zIndex: 55, width: WIDTH, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 10, overflow: placed.maxHeight != null ? 'auto' : 'visible', animation: `rise 160ms ${EASE}` }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px 0', font: '12px/1.5 var(--font-sans)', color: '#666' }}>
          Workspace
          <select aria-label="Build destination workspace" data-build-destination="1" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} disabled={busy} style={{ flex: 1, minWidth: 0, padding: '4px 6px', border: '1px solid #eaeaea', borderRadius: 5, background: '#fff', color: '#171717', font: 'inherit' }}>
            {!workspaceId && <option value="">Choose workspace</option>}
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{[...(workspace.above || []), workspace.name].join(' / ')}</option>)}
          </select>
        </label>
        {models && choice ? <ModelGrid models={models} choice={choice} efforts={efforts} onChoose={choose} /> : <div style={{ height: 180 }} />}
        <div style={{ height: 1, background: '#eaeaea' }} />
        {problem && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px 0' }}>
            <span data-build-note="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{problem}</span>
            {pre && !pre.ok && pre.canInit && <button type="button" className="bart-text" data-build-init="1" disabled={busy} onClick={startHistory} style={{ color: '#171717' }}>Start history</button>}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, padding: '8px 8px 8px 18px' }}>
          <span data-build-choice="1" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '12px/1.3 var(--font-sans)', color: '#4d4d4d' }}>{choiceLabel(models, choice)}</span>
          <button type="button" data-build-context="1" onClick={() => setCtxOpen((open) => !open)} aria-expanded={ctxOpen} aria-label="Add context from the library" title="Add context from the library" className="hov-wash"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minWidth: 30, height: 30, padding: '0 10px 0 8px', border: 0, borderRadius: 999, background: ctxOpen ? '#f2f2f2' : 'transparent', color: ctxOpen || nCtx ? '#171717' : '#4d4d4d', cursor: 'pointer', font: '500 12px/1 var(--font-sans)', transition: 'background 120ms' }}>
            {CIRCLE_PLUS}<span>Context</span>{nCtx > 0 && <span style={{ color: '#8f8f8f' }}>· {nCtx}</span>}
          </button>
          <button type="button" data-build-send="1" aria-label="Build" disabled={!ready} onClick={send} className={ready ? 'hov-dim' : undefined} style={sendStyle(ready)}>{SEND_ARROW}</button>
        </div>
      </div>
      {ctxOpen && (
        <ContextPopout
          style={ctxStyle}
          library={library}
          inRail={inRail}
          picked={picked}
          onToggle={(row) => setPicked((now) => (now.some((held) => held.id === row.id) ? now.filter((held) => held.id !== row.id) : [...now, row]))}
          onAdded={(rows) => { setPicked((now) => [...now, ...rows.filter((row) => !now.some((held) => held.id === row.id))]); if (onLibraryChanged) onLibraryChanged(); }}
          onClose={() => setCtxOpen(false)}
        />
      )}
    </>,
    document.body,
  );
}
