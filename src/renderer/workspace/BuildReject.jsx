// Reject (2026-09-29; it replaced Discard's "second click within four seconds"): a Build card's Reject asks here before
// its code changes, its copy of the code and its branch are deleted. Escape or a click outside cancels.
import React from 'react';
import { createPortal } from 'react-dom';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const button = { minHeight: 34, padding: '9px 16px', borderRadius: 8, cursor: 'pointer', font: '500 13px/1 var(--font-sans)' };

export default function BuildReject({ title, onConfirm, onClose }) {
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { onClose(); }
  };
  return createPortal(
    <div data-overlay="1" data-build-reject="1" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,.25)' }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="build-reject-title" style={{ width: 'min(400px, 100%)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 6, padding: 20, background: '#fff', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,.18)', animation: `rise 160ms ${EASE}` }}>
        <h3 id="build-reject-title" style={{ margin: 0, font: '600 16px/1.4 var(--font-sans)', color: '#171717' }}>Reject this Build?</h3>
        {title && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{title}</div>}
        <div style={{ font: '14px/1.6 var(--font-sans)', color: '#4d4d4d' }}>This deletes its code changes and its branch. It can't be undone.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="hov-ink" onClick={onClose} disabled={busy} autoFocus style={{ ...button, border: '1px solid #e5e5e5', background: '#fff', color: '#4d4d4d' }}>Cancel</button>
          <button type="button" data-build-reject-confirm="1" onClick={confirm} disabled={busy} className="hov-dim" style={{ ...button, border: 0, background: '#e70022', color: '#fff', opacity: busy ? 0.6 : 1 }}>{busy ? 'Deleting…' : 'Delete changes'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
