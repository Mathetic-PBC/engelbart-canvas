// The "@" mention menu (Add - Mention.dc.html, 2026-09-22): a 400px list with Bart and Note on top, then the page
// open in the Browser, then the project's other workspaces, then the library (model/rail.js mentionRows); something the library does not hold yet carries a
// +. It hangs under the caret, or above it when the line is near the bottom of the window, and scrolls past a dozen rows.
// A library folder (MATH-22) carries a › and opens in place when picked: a row back up, "Mention this folder", then what
// it holds (model/rail.js folderRows); a row that only says something (loading, how many more) is grey and not picked.
// A long name is cut in the middle, so its end and extension show (model/rail.js nameParts); the row's title is the whole.
import React from 'react';
import { KindGlyph } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { isFolderRow, nameParts } from '../model/rail.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const ONE_LINE = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

// A row's name: its start gives way first, its end stays.
function Name({ m }) {
  const { head, tail } = m.kind === 'note' ? { head: m.name, tail: '' } : nameParts(m.name);
  return (
    <span data-name="1" style={{ flex: 1, minWidth: 0, display: 'flex', font: '14px/1.4 var(--font-sans)', color: m.kind === 'note' ? '#8f8f8f' : '#171717' }}>
      <span style={{ ...ONE_LINE, flex: '0 1 auto', minWidth: 0 }}>{head}</span>
      {tail && <span style={{ flex: 'none', whiteSpace: 'pre' }}>{tail}</span>}
    </span>
  );
}

// A row of the menu, from model/rail.js; a library row itself (an editor that has no list of its own) is drawn as its kind.
function Glyph({ m }) {
  if (m.kind === 'back') return <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '14px/1 var(--font-sans)', color: '#4d4d4d' }}>←</span>;
  if (m.kind === 'note') return <span style={{ flex: 'none', width: 18, height: 18 }} />;
  if (m.kind === 'self' || (m.kind === 'entry' && m.dir)) return <KindGlyph kind="folder" item={{ type: 'folder' }} box={18} color="#4d4d4d" />;
  if (m.kind === 'entry') return <KindGlyph item={{ type: m.type || 'pdf', tags: [] }} box={18} color="#4d4d4d" />;
  if (m.kind === 'workspace') return <KindGlyph kind="workspace" item={{ type: 'workspace' }} box={18} color="#4d4d4d" />;
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
          title={m.kind === 'note' ? undefined : m.name}
          onMouseDown={(e) => { e.preventDefault(); if (m.kind !== 'note') onPick(m); }}
          onMouseMove={() => { if (onHover && i !== index) onHover(i); }} // moved onto, not appeared under: the keyboard's row stays put
          style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32, boxSizing: 'border-box', padding: '0 10px', borderRadius: 6, cursor: m.kind === 'note' ? 'default' : 'pointer', background: i === index && m.kind !== 'note' ? '#f2f2f2' : 'transparent' }}
        >
          <Glyph m={m} />
          <Name m={m} />
          {m.kind === 'back' && m.hint && <span style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{m.hint}</span>}
          {(isFolderRow(m) || (m.kind === 'entry' && m.dir)) && <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>›</span>}
          {m.kind === 'workspace' && m.above.length > 0 && <span style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{m.above.join(' / ')}</span>}
          {m.kind === 'fresh' && <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>}
        </div>
      ))}
    </div>
  );
}
