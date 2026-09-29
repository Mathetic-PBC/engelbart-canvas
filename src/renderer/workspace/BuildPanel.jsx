// The workspace's Build panel (2026-09-25 as a modal, design docs/superpowers/specs/2026-09-25-build-workflow-design.md B2;
// a panel since 2026-09-27). It opens above the Build button under the document with no backdrop. It is the top layer:
// post-its it reaches are covered by it, not moved aside (data-cover: main draws them as pictures under it,
// post-its/ProjectPostIts.jsx). What it holds: "Add from library" (a ringed + and a search that comes up over it), the
// attached items, "Automatically clear workspace" (off each time), a line when the code folder leaves something out or
// cannot take a Build, and at the lower right the model chip with the send inside it, drawn as the @bart line's. A
// post-it's Build has a popup of its own (post-its/PostItBuild.jsx).
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import BartPicker from './BartPicker.jsx';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { attachRows } from '../model/rail.js';
import { KindGlyph as Glyph } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import RepositoryRow from './RepositoryRow.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const WIDTH = 420;
const SEND = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="square" aria-hidden="true"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4" /></svg>;
// The sidebar's "Add context" ring (Rail.jsx), for "Add from library" as on the post-it's panel.
const CIRCLE_PLUS = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M9 5.5v7 M5.5 9h7" />
  </svg>
);
const SEARCH = <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>;

const providerOf = (models, key) => Object.keys(models.providers).find((id) => models.providers[id].models[key]) || models.provider;
const rectOf = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
/** Nothing to hang from: the middle of the window, near its top, as the modal was. */
const fallbackAnchor = () => { const x = Math.max(8, ((window.innerWidth || 1200) - WIDTH) / 2), y = Math.round((window.innerHeight || 800) * 0.12); return { left: x, right: x + WIDTH, top: y, bottom: y }; };

/** The search that comes up over "Add from library": a field with the caret in it, and its rows. ↑/↓ move, Enter picks, Esc clears then closes. */
function Lookup({ anchor, placeholder, rowsFor, onPick, onClose, glyph }) {
  const [ref, placed] = usePlaced(anchor, { gap: 6, cap: 360 });
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const fieldRef = React.useRef(null);
  const rows = rowsFor(q);
  const at = rows.length ? Math.min(idx, rows.length - 1) : -1;
  // The panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes no focus.
  React.useEffect(() => {
    const timer = setTimeout(() => { if (fieldRef.current) fieldRef.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [placed.visibility]);
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); if (at >= 0) onPick(rows[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) { setQ(''); setIdx(0); } else onClose(); }
  };
  return createPortal(
    <div ref={ref} data-overlay="1" data-cover="1" data-build-lookup="1" style={{ ...placed, zIndex: 60, width: 320, boxSizing: 'border-box', padding: 8, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: `rise 160ms ${EASE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', marginBottom: rows.length ? 6 : 0, border: `1px solid ${q ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, transition: 'border-color 120ms' }}>
        {SEARCH}
        <input ref={fieldRef} data-build-lookup-search="1" value={q} onChange={(event) => { setQ(event.target.value); setIdx(0); }} onKeyDown={onKey} placeholder={placeholder} aria-label={placeholder} spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '13px/1.5 var(--font-sans)', color: '#171717' }} />
      </div>
      {rows.map((item, i) => (
        <button key={item.key} type="button" data-build-lookup-row={item.key} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(item)} onMouseMove={() => { if (idx !== i) setIdx(i); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: 0, borderRadius: 6, background: i === at ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' }}>
          <Glyph item={item.row || glyph} box={16} color="#8f8f8f" />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.5 var(--font-sans)', color: '#171717' }}>{item.name}</span>
          {item.tag && <span style={{ flex: 'none', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{item.tag}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** A ringed + and its words, as the sidebar's "Add context". */
const AddButton = React.forwardRef(function AddButton({ label, open, onClick, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className="hov-wash" onClick={onClick} aria-expanded={open} {...rest} style={{ display: 'inline-flex', alignItems: 'center', gap: 9, padding: '5px 10px 5px 6px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', color: open ? '#171717' : '#8f8f8f', cursor: 'pointer', font: '14px/1.5 var(--font-sans)', transition: 'background 120ms, color 120ms' }}>
      {CIRCLE_PLUS}
      <span>{label}</span>
    </button>
  );
});

function Chip({ item, glyph, onRemove, ...rest }) {
  return (
    <span {...rest} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 6px 3px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>
      <Glyph item={glyph || item} box={14} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
      <button type="button" className="hov-ink" aria-label={`Leave ${item.name} out`} onClick={onRemove} style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '14px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
    </span>
  );
}

/**
 * `anchor` { left, right, top, bottom }: the Build button it opens above. `onStart({ provider, model, effort, attach,
 * clear })` starts it; the panel closes itself only on Esc, ×, or a press elsewhere in the window (never while it is
 * sending).
 */
export default function BuildPanel({ projectId, workspaceId, title, anchor, library, inRail, onClose, onStart }) {
  const [models, setModels] = React.useState(null);
  const [choice, setChoice] = React.useState(null); // { provider, model, effort }
  const [pre, setPre] = React.useState(null);
  const [attached, setAttached] = React.useState([]);
  const [clear, setClear] = React.useState(false); // "Automatically clear workspace": off every time (2026-09-27)
  const [lookup, setLookup] = React.useState(null); // { kind: 'library', anchor } while the search is up
  const [picker, setPicker] = React.useState(null); // the chip's rect while the selector is open
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [repositoryRevision, setRepositoryRevision] = React.useState(0);
  React.useEffect(() => api.onRepositoryChanged(event => {
    if (event.projectId === projectId && (!event.workspaceId || event.workspaceId === workspaceId)) { setPre(null); setRepositoryRevision(n => n + 1); }
  }), [projectId, workspaceId]);
  const chipRef = React.useRef(null);
  const libraryRef = React.useRef(null);
  const [ref, placed] = usePlaced(anchor || fallbackAnchor(), { gap: 8 });

  React.useEffect(() => {
    let live = true;
    api.buildModels().then((value) => {
      if (!live) return;
      setModels(value);
      const start = value.providers[value.provider].ladder[0];
      setChoice({ provider: value.provider, model: start.model, effort: start.effort });
    }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [projectId, workspaceId]);
  React.useEffect(() => {
    let live = true;
    setPre(null); setError('');
    api.buildPreflight(projectId, workspaceId).then((value) => { if (live) setPre(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [projectId, workspaceId, repositoryRevision]);

  const send = async () => {
    if (!choice || busy || !pre || !pre.ok) return;
    setBusy(true);
    setError('');
    try {
      await onStart({ ...choice, expectedRepoId: pre.repoId, attach: attached.map((row) => row.id), clear });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const startHistory = async () => {
    setBusy(true);
    setError('');
    try { setPre(await api.buildInit(projectId, workspaceId)); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        if (lookup || document.querySelector('[data-repository-chooser]')) return; // nested menu owns Escape
        event.preventDefault(); event.stopPropagation();
        if (picker) setPicker(null); else if (!busy) onClose();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // A press anywhere else in the window closes what is open over the panel, or else the panel itself; the Build button
  // (data-build-doc) toggles it on its own.
  React.useEffect(() => {
    const away = (event) => {
      const target = event.target;
      const inside = (selector) => !!(target && target.closest && target.closest(selector));
      if (picker && !inside('[data-bart-picker]') && !(chipRef.current && chipRef.current.contains(target))) setPicker(null);
      if (lookup && !inside('[data-build-lookup]') && !(libraryRef.current && libraryRef.current.contains(target))) setLookup(null);
      if (!busy && !inside('[data-build-panel], [data-bart-picker], [data-build-lookup], [data-build-doc], [data-repository-chooser]')) onClose();
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [picker, lookup, busy, onClose]);

  const openPicker = () => { if (picker) setPicker(null); else setPicker(rectOf(chipRef.current)); };
  const openLookup = (kind, element) => { setPicker(null); setLookup((now) => (now && now.kind === kind ? null : { kind, anchor: rectOf(element) })); };
  const entry = models && choice ? models.providers[choice.provider] : null;
  const chosen = entry ? entry.models[choice.model] : null;
  const ready = !!(choice && pre && pre.ok && !busy);
  const problem = pre && !pre.ok ? pre.problems[0].message : '';
  const note = pre && pre.ok && pre.dirty ? `${pre.dirty} uncommitted ${pre.dirty === 1 ? 'file' : 'files'} left out` : '';
  const line = error || problem || note;
  const heading = 'Build';
  const named = title;
  const libraryRows = (query) => attachRows({ query, library, taken: attached.map((row) => row.id), inRail });

  return createPortal(
    <>
      <div ref={ref} data-overlay="1" data-cover="1" data-build-panel="1" role="dialog" aria-label={heading} style={{ ...placed, zIndex: 55, width: `min(${WIDTH}px, calc(100vw - 16px))`, boxSizing: 'border-box', padding: '14px 16px 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', gap: 10, animation: `rise 160ms ${EASE}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ font: '600 15px/1.4 var(--font-sans)', color: '#171717' }}>{heading}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '15px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{named}</span>
          <button type="button" className="hov-ink" onClick={() => { if (!busy) onClose(); }} aria-label="Close" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
        </div>
        <RepositoryRow projectId={projectId} workspaceId={workspaceId} label="Build in" disabled={busy} />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, margin: '0 0 0 -6px' }}>
          <AddButton ref={libraryRef} label="Add from library" open={!!(lookup && lookup.kind === 'library')} onClick={(event) => openLookup('library', event.currentTarget)} data-build-attach="1" aria-haspopup="dialog" />
        </div>
        {attached.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {attached.map((row) => <Chip key={row.id} item={row} data-build-attached={row.id} onRemove={() => setAttached((now) => now.filter((held) => held.id !== row.id))} />)}
          </div>
        )}
        {(line || (pre && !pre.ok && pre.canInit)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span data-build-note="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.5 var(--font-sans)', color: error || problem ? '#e70022' : '#8f8f8f' }}>{line}</span>
            {pre && !pre.ok && pre.canInit && <button type="button" className="bart-text" data-build-init="1" disabled={busy} onClick={startHistory} style={{ color: '#171717' }}>Start history</button>}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 }}>
          {(
            <label style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 8, font: '13px/1.4 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" data-build-clear="1" checked={clear} onChange={(event) => setClear(event.target.checked)} style={{ margin: 0, accentColor: '#171717', cursor: 'pointer' }} />
              Automatically clear workspace
            </label>
          )}
          {/* The model chip with the send inside it, as on an @bart line (DocEditor's chip). */}
          <span style={{ flex: 'none', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '2px 2px 2px 12px', border: `1px solid ${picker ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 999, background: '#fff' }}>
            <button ref={chipRef} type="button" data-build-chip="1" onClick={openPicker} aria-haspopup="dialog" aria-expanded={!!picker} disabled={!chosen} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: 0, border: 0, background: 'transparent', cursor: chosen ? 'pointer' : 'default', font: '13px/1 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'nowrap' }}>
              {chosen ? `${chosen.name} ${EFFORT_LABELS[choice.effort] || choice.effort}` : '…'}
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 10, height: 12, font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}><span style={{ position: 'relative', top: picker ? 3 : -3 }}>{picker ? '⌃' : '⌄'}</span></span>
            </button>
            <button type="button" data-build-send="1" aria-label="Send" disabled={!ready} onClick={send} style={{ flex: 'none', width: 26, height: 26, padding: 0, border: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ready ? '#0070f3' : '#eaeaea', color: ready ? '#fff' : '#8f8f8f', cursor: ready ? 'pointer' : 'default', transition: 'background 160ms' }}>{SEND}</button>
          </span>
        </div>
      </div>
      {lookup && lookup.kind === 'library' && (
        <Lookup
          anchor={lookup.anchor}
          placeholder="Search the library"
          rowsFor={libraryRows}
          onPick={(item) => { setAttached((now) => (now.some((row) => row.id === item.row.id) ? now : [...now, item.row])); setLookup(null); }}
          onClose={() => setLookup(null)}
        />
      )}
      {picker && models && choice && (
        <BartPicker
          models={models}
          current={choice}
          anchor={picker}
          hover={false}
          cover
          onPick={(pick) => setChoice({ provider: providerOf(models, pick.model), model: pick.model, effort: pick.effort })}
          onEnter={() => {}}
          onLeave={() => {}}
        />
      )}
    </>,
    document.body,
  );
}
