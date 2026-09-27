// The Build dialog (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md B2, B23): which model and
// effort (the @bart selector, listing Build's models), library items to attach that the workspace does not mention, a
// line when the code folder leaves something out or cannot take a Build, and the round blue send. Bare on purpose: Hudson
// redraws it in Claude Design. A post-it's quick task opens the same dialog with the card's text.
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import BartPicker from './BartPicker.jsx';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { searchRows } from '../model/rail.js';
import { KindGlyph as Glyph } from '../ui/Icons.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const SEND = <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="square" aria-hidden="true"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4" /></svg>;

const providerOf = (models, key) => Object.keys(models.providers).find((id) => models.providers[id].models[key]) || models.provider;

export default function BuildModal({ projectId, title, quick = null, library, inRail, onClose, onStart }) {
  const [models, setModels] = React.useState(null);
  const [choice, setChoice] = React.useState(null); // { provider, model, effort }
  const [pre, setPre] = React.useState(null);
  const [attached, setAttached] = React.useState([]);
  const [q, setQ] = React.useState('');
  const [picker, setPicker] = React.useState(null); // the chip's rect while the selector is open
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const chipRef = React.useRef(null);
  const boxRef = React.useRef(null);

  React.useEffect(() => {
    let live = true;
    api.buildModels().then((value) => {
      if (!live) return;
      setModels(value);
      const start = value.providers[value.provider].ladder[0];
      setChoice({ provider: value.provider, model: start.model, effort: start.effort });
    }).catch((e) => { if (live) setError(errorMessage(e)); });
    api.buildPreflight(projectId).then((value) => { if (live) setPre(value); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [projectId]);

  const send = async () => {
    if (!choice || busy || !pre || !pre.ok) return;
    setBusy(true);
    setError('');
    try {
      await onStart({ ...choice, attach: attached.map((row) => row.id) });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const startHistory = async () => {
    setBusy(true);
    setError('');
    try { setPre(await api.buildInit(projectId)); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (picker) setPicker(null); else onClose(); }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // A press outside the selector closes it (the chip toggles it itself).
  React.useEffect(() => {
    if (!picker) return undefined;
    const away = (event) => { if (!event.target.closest('[data-bart-picker]') && !(chipRef.current && chipRef.current.contains(event.target))) setPicker(null); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [picker]);

  const openPicker = () => {
    if (picker) { setPicker(null); return; }
    const r = chipRef.current.getBoundingClientRect();
    setPicker({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  };
  const entry = models && choice ? models.providers[choice.provider] : null;
  const chosen = entry ? entry.models[choice.model] : null;
  const results = q.trim() ? searchRows({ query: q, library, inRail, found: undefined }).filter((r) => r.kind === 'item' && !attached.some((row) => row.id === r.row.id)).slice(0, 6) : [];
  const ready = !!(choice && pre && pre.ok && !busy);
  const problem = pre && !pre.ok ? pre.problems[0].message : '';
  const note = pre && pre.ok && pre.dirty ? `${pre.dirty} uncommitted ${pre.dirty === 1 ? 'file' : 'files'} left out` : '';

  return createPortal(
    <div data-overlay="1" data-build-modal="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 55, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 24px 24px', background: 'rgba(255,255,255,.35)' }}>
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label="Build" style={{ width: 'min(520px, 100%)', boxSizing: 'border-box', padding: '16px 18px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', gap: 12, animation: `rise 160ms ${EASE}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ font: '600 15px/1.4 var(--font-sans)', color: '#171717' }}>{quick ? 'Quick task' : 'Build'}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '15px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{title}</span>
          <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
        </div>
        {quick && <div data-build-quick-text="1" style={{ maxHeight: 120, overflow: 'auto', padding: '8px 10px', borderRadius: 8, background: '#fafafa', font: '13.5px/1.55 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'pre-wrap' }}>{quick.text}</div>}
        <div>
          <button ref={chipRef} type="button" className="bart-chip" data-build-chip="1" onClick={openPicker} aria-haspopup="dialog" aria-expanded={!!picker} disabled={!chosen} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, padding: '0 12px', border: `1px solid ${picker ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 999, background: '#fff', cursor: chosen ? 'pointer' : 'default', font: '13px/1 var(--font-sans)', color: '#4d4d4d' }}>
            {chosen ? `${entry.name} · ${chosen.name} ${EFFORT_LABELS[choice.effort] || choice.effort}` : '…'}
            <span style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{picker ? '⌃' : '⌄'}</span>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: `1px solid ${q ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 8, background: '#fff' }}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Attach from the library" aria-label="Attach from the library" data-build-attach-search="1" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717' }} />
          </div>
          {results.map((r) => (
            <button key={r.key} type="button" className="hov-wash" data-build-attach-result={r.row.id} onClick={() => { setAttached((now) => [...now, r.row]); setQ(''); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
              <Glyph item={r.row} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '14px/1.5 var(--font-sans)', color: '#171717' }}>{r.name}</span>
              <span style={{ flex: 'none', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{r.tag}</span>
            </button>
          ))}
          {attached.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {attached.map((row) => (
                <span key={row.id} data-build-attached={row.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 6px 3px 8px', border: '1px solid #eaeaea', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>
                  <Glyph item={row} box={14} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                  <button type="button" className="hov-ink" aria-label={`Leave ${row.name} out`} onClick={() => setAttached((now) => now.filter((held) => held.id !== row.id))} style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '14px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 }}>
          <span data-build-note="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.5 var(--font-sans)', color: error || problem ? '#e70022' : '#8f8f8f' }}>{error || problem || note}</span>
          {pre && !pre.ok && pre.canInit && <button type="button" className="bart-text" data-build-init="1" disabled={busy} onClick={startHistory} style={{ color: '#171717' }}>Start history</button>}
          <button type="button" data-build-send="1" aria-label="Send" disabled={!ready} onClick={send} style={{ flex: 'none', width: 28, height: 28, padding: 0, border: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: ready ? '#0070f3' : '#eaeaea', color: ready ? '#fff' : '#8f8f8f', cursor: ready ? 'pointer' : 'default', transition: 'background 160ms' }}>{SEND}</button>
        </div>
      </div>
      {picker && models && choice && (
        <BartPicker
          models={models}
          current={choice}
          anchor={picker}
          onPick={(pick) => setChoice({ provider: providerOf(models, pick.model), model: pick.model, effort: pick.effort })}
          onEnter={() => {}}
          onLeave={() => {}}
        />
      )}
    </div>,
    document.body,
  );
}
