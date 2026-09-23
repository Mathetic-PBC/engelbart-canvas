// Hover card for an @[mention] (Goal Canvas.dc.html lines 380–387, popStyle at line 1077): under the mention, or above
// it when there is no room below (2026-09-22).
import { kindOf } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

export default function Popover({ item, anchor }) {
  const [ref, placed] = usePlaced(anchor, { gap: 8 });
  if (!item) return null;
  const kind = kindOf(item);
  return (
    <div ref={ref} data-overlay="1" style={{ ...placed, zIndex: 50, width: 330, padding: '14px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
      <div style={{ font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>{kind.label}</div>
      <div style={{ marginTop: 8, font: '500 14.5px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{item.title || item.name}</div>
      <div style={{ marginTop: 6, font: '12.5px/1.7 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{item.summary || ''}</div>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eaeaea', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{item.facts || ''}</div>
    </div>
  );
}
