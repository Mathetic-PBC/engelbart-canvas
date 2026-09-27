import React from 'react';
import { createRoot } from 'react-dom/client';
import DocEditor from '../workspace/DocEditor.jsx';
import { useFit } from './face.jsx';
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
  const [crumple, setCrumple] = React.useState(null); // { scale, width, height } while it nears the trash
  const [noted, setNoted] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [build, setBuild] = React.useState(null); // the card's latest quick task: { id, status, final } (2026-09-25)
  const editor = React.useRef(null), held = React.useRef(null), suppressClick = React.useRef(false);
  const box = React.useRef(null), fit = React.useRef(null);
  const revision = React.useRef(0);
  React.useEffect(() => {
    api.ready().then((ready) => { setCard(ready); setBuild(ready.build || null); }).catch((e) => setError(e.message));
    const offs = [
      api.onBuildState((state) => setBuild(state || null)),
      api.onTrash(setOverTrash),
      api.onCrumple((value) => setCrumple(value && value.scale < 1 ? value : null)),
      api.onCancel(() => { held.current = null; setOverTrash(false); setCrumple(null); document.body.classList.remove('moving'); }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
  React.useEffect(() => { if (card?.fresh) editor.current?.focusStart(); }, [card?.id]);
  useFit({ boxRef: box, fitRef: fit, text: card ? card.text : null, grow: api.grow });

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
  // Copy (lower left, 2026-09-22): the card's markdown as written, to paste wherever it belongs.
  const copy = () => {
    api.copy(card ? card.text : '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, (e) => setError(e.message));
  };
  const toNote = () => {
    api.toNote().then(() => { setNoted(true); setTimeout(() => setNoted(false), 1600); }, (e) => setError(e.message));
  };
  // Build (2026-09-25): the window's Build dialog opens with this card's text as a quick task. Once there is one, its state
  // shows beside the button; a click on it opens the task in the window (Review, Accept, Discard, Run as big task).
  const askBuild = () => { api.build().catch((e) => setError(e.message)); };
  const working = build && ['setting-up', 'queued', 'running', 'accepting'].includes(build.status);
  const stateWord = !build || build.status === 'discarded' ? '' : build.status === 'accepted' ? 'Merged' : working ? 'Building…' : build.status === 'escalated' ? 'Too big' : build.status === 'failed' ? 'Failed' : 'Review';

  // Crumpling: the card's view shrinks around it (main), and the face is drawn at its full size, scaled into it.
  const faceStyle = crumple ? { right: 'auto', bottom: 'auto', width: crumple.width, height: crumple.height, transform: `scale(${crumple.scale})`, transformOrigin: '0 0' } : undefined;
  return <div className="post-card" data-trash={overTrash ? '1' : '0'} data-crumpled={crumple ? '1' : '0'} onPointerDownCapture={down} onPointerMove={move} onPointerUp={end} onPointerCancel={(e) => end(e, true)} onLostPointerCapture={(e) => end(e, true)} onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } }}>
    <div className="postit-face" style={faceStyle}>
      <div className="postit-head" />
      <div className="postit-body" ref={box}>
        <div className="postit-fit" ref={fit}>
          {card && <DocEditor ref={editor} compact docKey={card.id} text={card.text} onChange={change} onOpenLink={(url) => api.openLink(url).catch((e) => setError(e.message))} onCopyText={api.copy} />}
        </div>
        {card && !card.text && <span className="post-placeholder">Write something…</span>}
      </div>
      <div className="postit-foot">
        <button type="button" data-copy-post-it="1" className="postit-btn postit-copy" aria-label="Copy" title="Copy this post-it" onClick={copy}>
          {copied
            ? <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5 6 10.5 11.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M9.5 2.5V2.2c0-.7-.5-1.2-1.2-1.2H3.2C2.5 1 2 1.5 2 2.2v5.1c0 .7.5 1.2 1.2 1.2h.3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {stateWord && <button type="button" data-post-it-build-state={build.status} className="postit-btn postit-note" title="Open this quick task" onClick={() => api.openBuild(build.id).catch((e) => setError(e.message))} style={{ fontWeight: 400 }}>{stateWord}</button>}
          {!working && <button type="button" data-build-post-it="1" className="postit-btn postit-note" title="Hand this to a coding agent as a quick task" disabled={!card || !card.text.trim()} onClick={askBuild}>Build</button>}
          <button type="button" data-note-post-it="1" className="postit-btn postit-note" title="Copy this into a new note" onClick={toNote}>{noted ? 'Opened' : '+Note'}</button>
        </span>
      </div>
      {error && <div role="alert" className="post-error">Couldn’t save: {error}</div>}
      <button type="button" data-resize-post-it="1" className="post-resize" aria-label="Resize post-it" title="Drag to resize" onKeyDown={(event) => {
        // Keyboard resize shares the native geometry path.
        const dx = event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0;
        const dy = event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0;
        if (!dx && !dy) return;
        event.preventDefault();
        api.gesture({ phase: 'begin', kind: 'resize', x: 0, y: 0 });
        api.gesture({ phase: 'end', kind: 'resize', x: dx, y: dy });
      }}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 10 10 3M7 10l3-3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg></button>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<Card />);
