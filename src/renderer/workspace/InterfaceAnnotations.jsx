import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { pageAddress, targetLabel } from '../../shared/interface-annotations.cjs';
import './interface-annotations.css';

const label = (anchor) => targetLabel(anchor.element);

export function annotationPosition(bounds, slot, popup) {
  const gap = 8, width = Math.max(0, Math.min(300, slot.width - gap * 2));
  const sx = bounds ? slot.width / bounds.viewportWidth : 1, sy = bounds ? slot.height / bounds.viewportHeight : 1;
  const target = bounds ? { x: slot.left + bounds.x * sx, y: slot.top + bounds.y * sy, h: bounds.h * sy } : { x: slot.left + gap, y: slot.top + gap, h: 0 };
  const below = target.y + target.h + gap, above = target.y - popup.height - gap;
  const top = below + popup.height <= slot.bottom - gap ? below : above >= slot.top + gap ? above : below;
  return {
    left: Math.max(slot.left + gap, Math.min(target.x, slot.right - width - gap)),
    top: Math.max(slot.top + gap, Math.min(top, slot.bottom - popup.height - gap)),
    width, maxHeight: Math.max(0, slot.height - gap * 2),
  };
}

// Reuse Stage's existing data-overlay/snapshot mechanism; note text never enters
// the website. The browser slot stays the same size, including while composing.
function Composer({ bounds, slotRef, children, onKeyDown }) {
  const ref = React.useRef(null);
  const [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const place = () => {
      if (!slotRef.current || !ref.current) return;
      const next = annotationPosition(bounds, slotRef.current.getBoundingClientRect(), ref.current.getBoundingClientRect());
      setPosition((old) => old && Object.keys(next).every((key) => old[key] === next[key]) ? old : next);
    };
    const observer = new ResizeObserver(place);
    observer.observe(ref.current); if (slotRef.current) observer.observe(slotRef.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); place();
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [bounds, slotRef]);
  React.useEffect(() => { if (position) ref.current?.querySelector('textarea')?.focus({ preventScroll: true }); }, [!!position]);
  return createPortal(<div ref={ref} role="dialog" aria-label="Add annotation" data-overlay="1" className="interface-annotations ia-composer"
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={onKeyDown}>{children}</div>, document.body);
}

export default function InterfaceAnnotations({ projectId, tabId, url, loading, mode = 'browse', slotRef, onClose, onSelect, onNavigate, onAsk }) {
  const selecting = mode === 'select';
  const [notes, setNotes] = React.useState([]);
  const [picked, setPicked] = React.useState(null);
  const [bounds, setBounds] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [body, setBody] = React.useState('');
  const [intent, setIntent] = React.useState('ask');
  const [editing, setEditing] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState({ resolutions: {}, unavailable: 0 });
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const input = React.useRef(null), alive = React.useRef(true);
  const sending = React.useRef(false);
  const scope = React.useMemo(() => ({ projectId, url }), [projectId, url]);
  const note = notes.find((n) => n.id === selected);
  const command = React.useCallback((message) => api.browserAnnotate(tabId, message), [tabId]);
  const fail = (e) => { if (alive.current) setError(errorMessage(e)); };
  const marks = (list) => command({ type: 'show', items: list.map(({ id, anchor }) => ({ id, anchor })) });

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; command({ type: 'clear' }).catch(() => {}); };
  }, [command]);
  React.useEffect(() => api.onBrowserAnnotation((event) => {
    if (event.tabId !== tabId) return;
    if (event.type === 'picked') { setPicked(event.anchor); setBounds(event.bounds || null); setSelected(null); setBody(''); setIntent('ask'); setEditing(false); setPicking(false); setError(''); }
    if (event.type === 'marker') { setSelected(event.id); setPicked(null); setEditing(false); setPicking(false); setConfirmDelete(false); }
    if (event.type === 'status') { setStatus(event); setPicking(event.active); }
    if (event.type === 'exited') { setPicking(false); if (selecting) onClose(); }
    if (event.type === 'navigated') { setPicked(null); setPicking(false); setEditing(false); if (selecting) onClose(); }
    if (event.type === 'error') { setError(event.message); setPicking(false); }
  }), [tabId, selecting, onClose]);
  React.useEffect(() => {
    let live = true;
    setReady(false); setPicking(false); setPicked(null); setEditing(false); setSelected(null); setBody('');
    if (loading) return undefined;
    // Direct annotation does not wait for saved notes or open their browser.
    const begin = selecting
      ? command({ type: 'mode', on: true }).then(() => { if (live) { setPicking(true); setReady(true); } })
      : api.interfaceAnnotations(scope).then(async (data) => {
        if (!live) return;
        setNotes(data.notes); await marks(data.notes);
        if (live) setReady(true);
      });
    begin.catch((e) => { if (live) fail(e); });
    return () => { live = false; command({ type: 'clear' }).catch(() => {}); };
  }, [scope, loading, command, selecting]);
  React.useEffect(() => {
    if (!selecting) return undefined;
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); onClose();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [selecting, onClose]);
  React.useEffect(() => { if (picked || editing) input.current?.focus(); }, [picked, editing]);
  const start = async () => {
    if (onSelect) { onSelect(); return; }
    setError(''); setPicked(null); setSelected(null); setEditing(false); setBody('');
    try { await command({ type: 'mode', on: !picking }); setPicking(!picking); } catch (e) { fail(e); }
  };
  const cancel = () => { if (selecting) { onClose(); return; } setPicked(null); setEditing(false); setBody(''); command({ type: 'mode', on: false }).catch(fail); };
  const open = async (next) => {
    setPicked(null); setSelected(next.id); setEditing(false); setConfirmDelete(false); setError('');
    try { await command({ type: 'locate', id: next.id }); setPicking(false); } catch (e) { fail(e); }
  };
  const save = async () => {
    if (busy || !body.trim() || (!picked && !note)) return;
    setBusy(true); setError('');
    try {
      const saved = picked ? await api.createInterfaceAnnotation(scope, { body, anchor: picked }) : await api.editInterfaceAnnotation(scope, note.id, body);
      if (!alive.current) return;
      if (selecting) { onClose(); return; }
      const next = notes.some((n) => n.id === saved.id) ? notes.map((n) => n.id === saved.id ? saved : n) : [...notes, saved];
      setNotes(next); setPicked(null); setEditing(false); setSelected(saved.id); setBody('');
      await marks(next); await command({ type: 'locate', id: saved.id });
    } catch (e) { fail(e); } finally { if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.deleteInterfaceAnnotation(scope, note.id);
      if (!alive.current) return;
      const next = notes.filter((n) => n.id !== note.id);
      setNotes(next); setSelected(null); setConfirmDelete(false);
      await command({ type: 'mode', on: false }); await marks(next);
    } catch (e) { fail(e); } finally { if (alive.current) setBusy(false); }
  };
  const resolution = note && status.resolutions[note.id];
  const elsewhere = resolution?.reason === 'different-page';
  const openPage = () => { try { onNavigate(new URL(note.anchor.route, url).href); } catch (e) { fail(e); } };
  const ask = async () => { try { await onAsk(note); } catch (e) { fail(e); } };
  const asking = selecting && !!picked && !!onAsk && intent === 'ask';
  const askSelection = async () => {
    if (busy || sending.current || !onAsk || !picked || !body.trim()) return;
    sending.current = true; setBusy(true); setError('');
    try {
      // Asking is a workspace conversation, not an implicit saved annotation.
      await onAsk({ body: body.trim(), anchor: picked, url: pageAddress(url).url });
      if (alive.current) onClose();
    } catch (e) { fail(e); } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const submit = () => asking ? askSelection() : save();
  const editor = (picked || editing) && <div className="ia-editor">
    <p className="ia-target" title={label(picked || note.anchor)}>{label(picked || note.anchor)}</p>
    {selecting && onAsk && <div className="ia-intent" role="group" aria-label="Annotation action">
      <button type="button" aria-pressed={intent === 'ask'} disabled={busy} onClick={() => setIntent('ask')}>Ask Bart</button>
      <button type="button" aria-pressed={intent === 'note'} disabled={busy} onClick={() => setIntent('note')}>Add note</button>
    </div>}
    <textarea ref={input} aria-label={asking ? 'Question for Bart' : 'Annotation note'} placeholder={asking ? 'Ask Bart about this element…' : 'Add a note…'} rows={4} maxLength={4000} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
    <div className="ia-actions"><button disabled={busy} onClick={cancel}>Cancel</button><button className="ia-primary" disabled={busy || !body.trim()} onClick={submit}>{asking ? (busy ? 'Sending…' : 'Ask Bart') : (busy ? 'Saving…' : 'Save note')}</button></div>
  </div>;
  const editorKeys = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (picked || editing)) { e.preventDefault(); void submit(); }
  };
  if (selecting) return picked || error ? <Composer bounds={bounds} slotRef={slotRef} onKeyDown={editorKeys}>
    {editor}
    {error && <p role="alert" className="ia-error">{error}</p>}
    {!picked && <button onClick={onClose}>Cancel</button>}
  </Composer> : null;
  return (
    <aside className="interface-annotations" aria-label="Interface annotations" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (picked || editing) cancel(); else if (picking) void start(); else onClose(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (picked || editing)) { e.preventDefault(); void save(); }
    }}>
      <div className="ia-heading"><strong>Annotations <span>{notes.length || ''}</span></strong><button aria-label="Close annotations" onClick={onClose}>×</button></div>
      <button className={`ia-pick ${picking ? 'ia-active' : ''}`} disabled={!ready || busy} onClick={start}>{picking ? 'Cancel annotation' : '+ Select an element'}</button>
      {!ready && !error && <p className="ia-muted">{loading ? 'Waiting for the page…' : 'Loading annotations…'}</p>}
      {!!status.unavailable && <p className="ia-muted">{status.unavailable} embedded frame{status.unavailable === 1 ? '' : 's'} cannot be inspected. You can annotate the frame itself.</p>}
      {error && <p role="alert" className="ia-error">{error}</p>}
      {editor}
      {note && !editing && !picked && <div className="ia-detail">
        <p className="ia-target" title={label(note.anchor)}>{label(note.anchor)}</p>
        <p className="ia-body">{note.body}</p>
        <p className="ia-muted">{resolution?.confidence === 'resolved' ? 'Element found on this page.' : resolution?.confidence === 'approximate' ? 'Closest match — the element or its text has changed.' : elsewhere ? `Written on ${note.anchor.route}` : 'Element not found on this page.'}</p>
        {elsewhere && <button onClick={openPage}>Open page</button>}
        <div className="ia-actions"><button disabled={busy} onClick={() => { setBody(note.body); setEditing(true); }}>Edit</button><button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>{onAsk && <button onClick={ask}>Ask Bart</button>}</div>
        {confirmDelete && <div className="ia-delete"><span>Delete this note?</span><button disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button><button disabled={busy} onClick={remove}>Delete</button></div>}
      </div>}
      <div className="ia-list">
        {ready && !notes.length && !picked && <p className="ia-muted">Notes you save here stay with this site or repository in this project.</p>}
        {notes.map((n, i) => <button key={n.id} className={`ia-row ${selected === n.id ? 'ia-selected' : ''}`} onClick={() => open(n)} disabled={busy}>
          <span className="ia-number">{i + 1}</span><span><span className="ia-row-body">{n.body}</span><span className="ia-row-target">{label(n.anchor)}</span></span>
        </button>)}
      </div>
    </aside>
  );
}
