// The "@" mention menu (Goal Canvas.dc.html lines 366–378, mentionStyle at line 1065).
import { kindOf } from '../ui/Icons.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

export default function MentionMenu({ items, index, x, y, onPick }) {
  return (
    <div data-mention-menu="1" data-overlay="1" style={{ position: 'fixed', left: x || 0, top: y || 0, zIndex: 60, minWidth: 280, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
      <div style={{ padding: '6px 10px 6px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>Mention a source in this topic</div>
      {items.map((m, i) => {
        const kind = kindOf(m);
        return (
          <div key={m.id || m.name} onMouseDown={(e) => { e.preventDefault(); onPick(m); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: i === index ? '#f2f2f2' : 'transparent' }}>
            <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', font: '500 12px/1 var(--font-sans)' }}>{kind.glyph}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{m.name}</span>
            <span style={{ flex: 'none', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{kind.label}</span>
          </div>
        );
      })}
      {!items.length && <div style={{ padding: '7px 10px', font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>nothing matches</div>}
    </div>
  );
}
