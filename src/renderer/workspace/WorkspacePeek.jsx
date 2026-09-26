// The peek of a mentioned workspace (2026-09-25): hovering `@[Name](ws:<id>)` shows where that workspace stands without
// leaving this one — whether Bart is working or waiting there, when it was last written in, and the last
// lines of its document (the end of a document is where it grows; lines are not dated one by one, so "last written" is
// the document's end, not a diff). A click on the mention goes there; only one workspace is ever open.
import React from 'react';
import DocPreview from '../ui/DocPreview.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { ago } from '../model/nav.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const TAIL = 8;

/** `peek.info(id)` → { name, above, bart: 'waiting' | 'running' | null, editedAt } | null; `peek.read(id)` → its text. */
export default function WorkspacePeek({ id, name, anchor, peek }) {
  const [ref, placed] = usePlaced(anchor, { gap: 8, cap: 440 });
  const info = peek ? peek.info(id) : null;
  const [text, setText] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    setText(null);
    if (peek && info) peek.read(id).then((read) => { if (live) setText(read || ''); }).catch(() => { if (live) setText(''); });
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const edited = info && info.editedAt ? ago(info.editedAt) : '';
  return (
    <div ref={ref} data-overlay="1" data-hover="1" data-ws-peek={id} style={{ ...placed, zIndex: 50, width: 360, boxSizing: 'border-box', padding: '14px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', pointerEvents: 'none', animation: `rise 160ms ${EASE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>
          {info && info.above.length ? `Workspace · ${info.above.join(' / ')}` : 'Workspace'}
        </span>
      </div>
      <div style={{ marginTop: 8, font: '500 14.5px/1.4 var(--font-sans)', color: '#171717', overflowWrap: 'anywhere', textWrap: 'pretty' }}>{info ? info.name : name}</div>
      {!info && <div style={{ marginTop: 6, font: '12.5px/1.6 var(--font-sans)', color: '#8f8f8f' }}>This workspace is gone.</div>}
      {info && info.bart && (
        <div data-ws-peek-bart={info.bart} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 7, font: '12.5px/1.5 var(--font-sans)', color: info.bart === 'waiting' ? '#0070f3' : '#4d4d4d' }}>
          <span style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: info.bart === 'waiting' ? '#0070f3' : 'transparent', border: info.bart === 'waiting' ? 0 : '1.5px dashed #8f8f8f', boxSizing: 'border-box' }} />
          {info.bart === 'waiting' ? 'Bart answered — waiting for you' : 'Bart is working here'}
        </div>
      )}
      {info && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eaeaea' }}>
          {text == null ? <div style={{ height: 18 }} />
            : text.trim() ? <DocPreview text={text} tail={TAIL} size={12.5} />
              : <div style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing written yet.</div>}
        </div>
      )}
      {info && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eaeaea', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>
          {edited ? `Edited ${edited === 'now' ? 'just now' : `${edited} ago`} · ` : ''}Click to go there
        </div>
      )}
    </div>
  );
}
