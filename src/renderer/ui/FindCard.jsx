import React from 'react';

// ⌘F's card (the design's "Find on stage"), for the Stage and, since 2026-10-16, the middle canvas's document: at the top
// right of what is searched, the query, where the match in front is among all of them, previous, next, close. Enter and
// ⇧Enter step; Escape closes. `found` is { matches, active } (active counts from 1), or null before anything was asked.
// `label` names the field for a screen reader; `place` moves the card (the pane beside keeps its × in sight).

const EASE = 'cubic-bezier(.25,.1,.25,1)';

export default function FindCard({ inputRef, text, found, onText, onStep, onClose, label = 'Find on this page', place = null }) {
  const small = { width: 24, height: 24, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#4d4d4d' };
  const none = text && found && !found.matches;
  return (
    <div data-find-bar="1" data-overlay="1" style={{ position: 'absolute', top: 10, right: 14, left: 14, maxWidth: 360, marginLeft: 'auto', zIndex: 30, display: 'flex', alignItems: 'center', gap: 4, height: 34, boxSizing: 'border-box', padding: '0 4px 0 12px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, animation: `rise 160ms ${EASE}`, ...place }}>
      <input
        ref={inputRef}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}
        aria-label={label}
        spellCheck={false}
        style={{ flex: 1, width: 'auto', minWidth: 60, padding: 0, border: 0, background: 'transparent', font: '13px/1.4 var(--font-sans)', color: '#171717' }}
      />
      <span data-find-count="1" style={{ flex: 'none', textAlign: 'right', font: '11px/1 var(--font-mono)', color: none ? '#e70022' : '#8f8f8f' }}>{text && found ? (found.matches ? `${found.active} of ${found.matches}` : '0 matches') : ''}</span>
      <span style={{ flex: 'none', width: 1, height: 16, margin: '0 4px', background: '#eaeaea' }} />
      <button type="button" className="hov-ink-wash" onClick={() => onStep(-1)} aria-label="Previous match" title="⇧⏎" style={small}>↑</button>
      <button type="button" className="hov-ink-wash" onClick={() => onStep(1)} aria-label="Next match" title="⏎" style={small}>↓</button>
      <button type="button" className="hov-ink-wash" onClick={onClose} aria-label="Close find" title="esc" style={{ ...small, color: '#8f8f8f' }}>×</button>
    </div>
  );
}
