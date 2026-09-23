import React from 'react';
import { createRoot } from 'react-dom/client';
import DocEditor from '../workspace/DocEditor.jsx';
import StickyNoteArt from './StickyNoteArt.jsx';
import '../tokens/typography.css';
import '@fontsource/source-code-pro/400.css';
import './card.css';

const api = window.postItAPI;

// Element hit testing treats the whole editable line as text. Test the actual glyph
// rectangles instead, leaving the whitespace beside and below a line draggable.
function hitsText(x, y) {
  const caret = document.caretRangeFromPoint(x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const node = caret.startContainer;
  for (const offset of [caret.startOffset - 1, caret.startOffset]) {
    if (offset < 0 || offset >= node.length) continue;
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + 1);
    if ([...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return true;
  }
  return false;
}

function Card() {
  const [card, setCard] = React.useState(null);
  const [error, setError] = React.useState('');
  const [overTrash, setOverTrash] = React.useState(false);
  const editor = React.useRef(null), held = React.useRef(null), suppressClick = React.useRef(false);
  const revision = React.useRef(0);
  React.useEffect(() => {
    api.ready().then(setCard).catch((e) => setError(e.message));
    const offTrash = api.onTrash(setOverTrash);
    const offCancel = api.onCancel(() => { held.current = null; setOverTrash(false); document.body.classList.remove('moving'); });
    return () => { offTrash(); offCancel(); };
  }, []);
  React.useEffect(() => { if (card?.fresh) editor.current?.focusStart(); }, [card?.id]);

  const change = (text) => {
    setCard((current) => ({ ...current, text }));
    const rev = ++revision.current;
    // Send every edit immediately. Main owns the write queue, including at quit.
    api.edit(text).then(() => { if (revision.current === rev) setError(''); }, (e) => setError(e.message));
  };
  const message = (event, phase, kind) => api.gesture({ phase, kind, x: event.screenX, y: event.screenY });
  const down = (event) => {
    if (event.button !== 0 || !card) return;
    const resizing = !!event.target.closest('[data-resize-post-it]');
    if (!resizing && (event.target.closest('button,a,input,textarea,[data-act],img') || hitsText(event.clientX, event.clientY))) return;
    // Preserve the scroll bar's native behavior when the note overflows.
    if (!resizing && event.target.scrollHeight > event.target.clientHeight && event.clientX > event.target.getBoundingClientRect().right - 12) return;
    event.preventDefault();
    held.current = { pointer: event.pointerId, x: event.screenX, y: event.screenY, moved: false, kind: resizing ? 'resize' : 'drag' };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    message(event, 'begin', held.current.kind);
  };
  const move = (event) => {
    const current = held.current;
    if (!current || event.pointerId !== current.pointer) return;
    if (Math.hypot(event.screenX - current.x, event.screenY - current.y) >= 4) current.moved = true;
    if (current.moved) { document.body.classList.add('moving'); message(event, 'move', current.kind); }
  };
  const end = (event, cancelled = false) => {
    const current = held.current;
    if (!current || event.pointerId !== current.pointer) return;
    held.current = null;
    suppressClick.current = current.moved;
    message(event, cancelled ? 'cancel' : 'end', current.kind);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('moving');
    if (!current.moved && !cancelled && current.kind === 'drag') editor.current?.focusEnd();
  };

  return <div className="post-card" data-trash={overTrash ? '1' : '0'} onPointerDownCapture={down} onPointerMove={move} onPointerUp={end} onPointerCancel={(e) => end(e, true)} onLostPointerCapture={(e) => end(e, true)} onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } }}>
    <StickyNoteArt className="post-paper" />
    <div className="post-content">
      {card && <DocEditor ref={editor} compact docKey={card.id} text={card.text} onChange={change} onOpenLink={(url) => api.openLink(url).catch((e) => setError(e.message))} onCopyText={api.copy} />}
      {card && !card.text && <span className="post-placeholder">Write something…</span>}
    </div>
    {error && <div role="alert" className="post-error">Couldn’t save: {error}</div>}
    <button data-resize-post-it="1" className="post-resize" aria-label="Resize post-it" title="Drag to resize" onKeyDown={(event) => {
      // Keyboard resize shares the native geometry path.
      const dx = event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0;
      const dy = event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      api.gesture({ phase: 'begin', kind: 'resize', x: 0, y: 0 });
      api.gesture({ phase: 'end', kind: 'resize', x: dx, y: dy });
    }}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 10 10 3M7 10l3-3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg></button>
  </div>;
}

createRoot(document.getElementById('root')).render(<Card />);
