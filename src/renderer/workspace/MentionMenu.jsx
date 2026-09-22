// The "@" mention menu (Add - Mention.dc.html, 2026-09-22): a 400px list with Bart, Task and Note on top, then the page
// open in the Browser, then the library (model/rail.js mentionRows); something the library does not hold yet carries a
// +. It hangs under the caret, or above it when the line is near the bottom of the window, and scrolls past a dozen rows.
import React from 'react';
import { KindGlyph } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

// A row of the menu, from model/rail.js; a library row itself (an editor that has no list of its own) is drawn as its kind.
function Glyph({ m }) {
  if (m.kind === 'verb') return <KindGlyph kind={m.glyph} item={m} box={18} color="#4d4d4d" />;
  if (m.kind === 'fresh') return <KindGlyph kind={/^https?:/i.test(m.input || '') ? 'website' : 'md'} item={m} box={18} color="#4d4d4d" />;
  return <KindGlyph item={m.row || m} box={18} color="#4d4d4d" />;
}

export default function MentionMenu({ items, index, anchor, onPick, onHover }) {
  const [ref, placed] = usePlaced(anchor, { cap: 420 });
  // The keyboard's row stays in view when the list scrolls.
  React.useLayoutEffect(() => { const row = ref.current && ref.current.querySelector('[data-on="1"]'); if (row) row.scrollIntoView({ block: 'nearest' }); }, [index, ref]);
  if (!items.length) return null;
  return (
    <div ref={ref} data-mention-menu="1" data-overlay="1" style={{ ...placed, zIndex: 60, width: 400, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
      {items.map((m, i) => (
        <div
          key={m.key || m.id || m.name}
          data-on={i === index ? 1 : 0}
          data-mention-row={m.key || m.id}
          onMouseDown={(e) => { e.preventDefault(); onPick(m); }}
          onMouseMove={() => { if (onHover && i !== index) onHover(i); }} // moved onto, not appeared under: the keyboard's row stays put
          style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, boxSizing: 'border-box', padding: '0 10px', borderRadius: 6, cursor: 'pointer', background: i === index ? '#f2f2f2' : 'transparent' }}
        >
          <Glyph m={m} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '14px/1.4 var(--font-sans)', color: '#171717' }}>{m.name}</span>
          {m.kind === 'fresh' && <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>}
        </div>
      ))}
    </div>
  );
}
