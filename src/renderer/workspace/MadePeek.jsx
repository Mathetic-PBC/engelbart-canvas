// The peek of a file @create made (2026-10-15, David): hovering its row's name or icon shows the file in a card under it,
// as its frame would (DocEditor.madeBodyHtml), without opening anything. The picture's box is a fixed size, so the card is
// placed once and does not move when the image comes in.
import React from 'react';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

/** `body`: the file drawn as its frame draws it (HTML from DocEditor). Its name and Saved are on the row just above. */
export default function MadePeek({ name, body, anchor }) {
  const [ref, placed] = usePlaced(anchor, { gap: 8 });
  return (
    <div ref={ref} data-overlay="1" data-hover="1" data-made-peek-card={name} className="made-frame" style={{ ...placed, zIndex: 50, width: 380, boxSizing: 'border-box', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', overflow: 'hidden', pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
      <div className="made-peek-body" style={{ height: 240, overflow: 'hidden', background: '#fff' }} dangerouslySetInnerHTML={{ __html: body }} />
      <div style={{ padding: '8px 12px', borderTop: '1px solid #eaeaea', background: '#fafafa', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Click to open in the Stage</div>
    </div>
  );
}
