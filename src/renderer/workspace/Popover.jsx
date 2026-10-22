// Hover card for an @[mention] (Goal Canvas.dc.html lines 380–387, popStyle at line 1077): under the mention, or above
// it when there is no room below (2026-09-22). A citation's too (2026-10-21).
import { kindOf } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

// A citation's card (model/cite.js citationCard; 2026-10-21, David: "we need to improve this ui"): whose words and when,
// where they are, and the quote under them, set off by a rule; "cuts against this" beside the label for one that does.
const CITE_BOX = { width: 300, padding: '11px 14px 12px' };
const CITE_HEAD = { display: 'flex', alignItems: 'baseline', gap: 10, font: '500 12px/1.4 var(--font-sans)', color: '#4d4d4d' };
const CITE_WHERE = { marginLeft: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400, color: '#8f8f8f' };
const CITE_QUOTE = { marginTop: 8, padding: '1px 0 1px 10px', borderLeft: '2px solid #d6d6d6', font: '13px/1.6 var(--font-sans)', color: '#171717', textWrap: 'pretty' };

export default function Popover({ item, anchor }) {
  const [ref, placed] = usePlaced(anchor, { gap: 8 });
  if (!item) return null;
  if (item.quote != null) {
    return (
      <div ref={ref} data-overlay="1" data-hover="1" style={{ ...placed, zIndex: 50, ...CITE_BOX, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
        <div style={CITE_HEAD}>
          <span style={{ flex: 'none' }}>{item.label}{item.counter ? <span style={{ color: '#8f8f8f', fontWeight: 400 }}> · cuts against this</span> : null}</span>
          <span style={CITE_WHERE}>{item.where}</span>
        </div>
        <div style={CITE_QUOTE}>{item.quote}</div>
      </div>
    );
  }
  const kind = kindOf(item);
  return (
    <div ref={ref} data-overlay="1" data-hover="1" style={{ ...placed, zIndex: 50, width: 330, padding: '14px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
      <div style={{ font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>{kind.label}</div>
      <div style={{ marginTop: 8, font: '500 14.5px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{item.title || item.name}</div>
      <div style={{ marginTop: 6, font: '12.5px/1.7 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{item.summary || ''}</div>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eaeaea', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{item.facts || ''}</div>
    </div>
  );
}
