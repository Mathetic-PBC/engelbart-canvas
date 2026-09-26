import React from 'react';
import { notePickRows } from '../model/notepick.js';
import { isUntitled } from '../model/names.js';
import { KindGlyph } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const NOTE_GLYPH = { type: 'md', tags: ['note'] };

/**
 * The +'s menu beside the document's tabs (2026-09-25): a search over every note in the library, the caret in it from the
 * start, and New note. Nothing is made until New note is picked. ↑/↓ move, Enter picks, Esc closes (clears first).
 * `onPick(row)` opens a note, `onNew(name)` makes one; either may be async and the menu closes once it is done.
 */
export default function NotePicker({ anchor, library, openIds, inRail, onPick, onNew, onClose, onError }) {
  const [ref, placed] = usePlaced(anchor, { gap: 6, cap: 420 });
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const fieldRef = React.useRef(null);
  const rows = notePickRows({ query: q, library, openIds, inRail });
  const at = rows.length ? Math.min(idx, rows.length - 1) : -1;

  // The panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes no focus.
  React.useEffect(() => {
    const timer = setTimeout(() => { if (fieldRef.current) fieldRef.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [placed.visibility]);

  React.useEffect(() => {
    const away = (event) => { if (ref.current && !ref.current.contains(event.target) && !(event.target.closest && event.target.closest('[data-note-plus]'))) onClose(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [onClose, ref]);

  const pick = async (row) => {
    if (!row || busy) return;
    setBusy(true);
    try {
      if (row.kind === 'new') await onNew(row.name);
      else await onPick(row.row);
      onClose();
    } catch (error) {
      setBusy(false);
      if (onError) onError(error);
    }
  };
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); void pick(rows[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) { setQ(''); setIdx(0); } else onClose(); }
  };

  const row = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: 0, borderRadius: 6, textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' };
  return (
    <div ref={ref} data-overlay="1" data-note-picker="1" style={{ ...placed, zIndex: 60, width: 320, boxSizing: 'border-box', padding: 8, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: `rise 160ms ${EASE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', marginBottom: 6, border: `1px solid ${q ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, transition: 'border-color 120ms' }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
        <input
          ref={fieldRef}
          data-note-search="1"
          value={q}
          readOnly={busy}
          onChange={(event) => { setQ(event.target.value); setIdx(0); }}
          onKeyDown={onKey}
          placeholder="Search notes"
          aria-label="Search notes"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '13px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
        />
      </div>
      {rows.map((item, i) => (
        <button key={item.key} type="button" data-note-pick={item.key} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => void pick(item)} onMouseMove={() => { if (idx !== i) setIdx(i); }} style={{ ...row, background: i === at ? '#f2f2f2' : 'transparent' }}>
          {item.kind === 'new'
            ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '16px/1 var(--font-sans)', color: '#4d4d4d' }}>+</span>
            : <KindGlyph item={NOTE_GLYPH} box={16} color="#8f8f8f" />}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.5 var(--font-sans)', color: item.kind === 'note' && isUntitled(item.name) ? '#8f8f8f' : '#171717' }}>
            {item.kind === 'new' ? (item.name ? <>New note <span style={{ color: '#4d4d4d' }}>“{item.name}”</span></> : 'New note') : item.name}
          </span>
          {item.tag && <span style={{ flex: 'none', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{item.tag}</span>}
        </button>
      ))}
    </div>
  );
}
