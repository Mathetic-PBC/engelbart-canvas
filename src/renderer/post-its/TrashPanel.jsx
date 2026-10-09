import React from 'react';
import { createPortal } from 'react-dom';
import { usePlaced } from '../ui/usePlaced.js';
import { errorMessage } from '../api.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const DAY = 24 * 60 * 60 * 1000;

/** How long a thrown-away card has left, in the words the panel uses. */
export function timeLeft(expires, now = Date.now()) {
  const days = Math.ceil((Date.parse(expires) - now) / DAY);
  if (!(days > 1)) return 'deleted within a day';
  return `deleted in ${days} days`;
}

/** A card's first lines as plain words, for the list. */
function preview(text) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]?\]\s*|[-*+]\s+|>\s*)/, '').replace(/\*\*|`|\*/g, '').trim()).filter(Boolean);
  return lines.length ? lines.slice(0, 3).join(' · ') : '';
}

// The trash can, opened (2026-09-22): the workspaces deleted in the switcher (2026-09-30) and the post-its thrown into
// it, newest first, each restorable until main purges it a week after it went in. Library items taken off a workspace
// are not listed: they are still in the library. `trash` (the post-its) is null while the project is not in front.
export default function TrashPanel({ anchor, trash, workspaces, onClose }) {
  const [rows, setRows] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [ref, placed] = usePlaced(anchor, { gap: 8, cap: 420 });
  const load = React.useCallback(() => (trash ? trash.load().then(setRows, (error) => setProblem(errorMessage(error))) : Promise.resolve(setRows(null))), [trash]);
  React.useEffect(() => { void load(); }, [trash && trash.count]); // eslint-disable-line react-hooks/exhaustive-deps
  const spaces = (workspaces && workspaces.rows) || [];
  const bringBack = (id) => workspaces.restore(id).then(() => setProblem(''), (error) => setProblem(errorMessage(error)));
  React.useEffect(() => {
    const away = (event) => { if (ref.current && !ref.current.contains(event.target) && !event.target.closest('[data-trash]')) onClose(); };
    const key = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }; // taken: the workspace's Escape would leave it
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key); };
  }, [onClose, ref]);
  const restore = (id) => trash.restore(id).then(load, (error) => setProblem(errorMessage(error)));
  return createPortal(
    <div ref={ref} data-overlay="1" data-trash-panel="1" role="dialog" aria-label="Trash" style={{ ...placed, zIndex: 80, width: 320, boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
      <div style={{ padding: '8px 10px 6px', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{spaces.length ? 'Workspaces and stickies' : 'Stickies'} in the trash are deleted a week after they’re thrown away.</div>
      {spaces.map((row) => (
        <div key={row.id} data-trashed-workspace={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px 7px 10px', borderRadius: 6 }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" style={{ flex: 'none', fill: 'none', stroke: '#4d4d4d', strokeWidth: 1.3, strokeLinejoin: 'round' }}>
            <path d="M2.5 1.5h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M9 1.5h4.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M2.5 8h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z" />
          </svg>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
            <span style={{ font: '11px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{row.nested ? `Workspace and ${row.nested} inside it · ` : 'Workspace · '}{timeLeft(row.expires)}</span>
          </span>
          <button type="button" className="hov-bd2" data-restore-workspace={row.id} onClick={() => bringBack(row.id)} style={{ flex: 'none', padding: '6px 10px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', cursor: 'pointer', font: '500 12px/1 var(--font-sans)', color: '#171717' }}>Restore</button>
        </div>
      ))}
      {rows && rows.length === 0 && !spaces.length && <div style={{ padding: '6px 10px 10px', font: '13px/1.5 var(--font-sans)', color: '#4d4d4d' }}>No stickies in the trash.</div>}
      {(rows || []).map((row) => (
        <div key={row.id} data-trashed-post-it={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px 7px 10px', borderRadius: 6 }}>
          <span aria-hidden="true" style={{ flex: 'none', width: 14, height: 14, background: '#fff2a0', border: '1px solid #e8d77a' }} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: preview(row.text) ? '#171717' : '#8f8f8f' }}>{preview(row.text) || 'Empty sticky'}</span>
            <span style={{ font: '11px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{timeLeft(row.expires)}</span>
          </span>
          <button type="button" className="hov-bd2" data-restore-post-it={row.id} onClick={() => restore(row.id)} style={{ flex: 'none', padding: '6px 10px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', cursor: 'pointer', font: '500 12px/1 var(--font-sans)', color: '#171717' }}>Restore</button>
        </div>
      ))}
      {problem && <div style={{ padding: '6px 10px', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{problem}</div>}
    </div>,
    document.body,
  );
}
