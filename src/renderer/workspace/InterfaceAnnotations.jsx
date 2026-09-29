import React from 'react';
import StagePopover from './StagePopover.jsx';
import AnnotationChat from './AnnotationChat.jsx';
import { api, errorMessage } from '../api.js';
import { useSessionState } from '../session-ui.js';
import { pageAddress, routeUrl, targetLabel } from '../../shared/interface-annotations.cjs';
import './interface-annotations.css';

const label = (anchor) => targetLabel(anchor.element);

export { annotationPosition, annotationListPosition, annotationChatPosition } from './StagePopover.jsx';

function AnnotationPopover({ kind = 'composer', name = 'Add annotation', ...props }) {
  return <StagePopover {...props} name={name} kind={kind} className={`interface-annotations ia-popover ia-${kind}`} />;
}

export default function InterfaceAnnotations({ projectId, tabId, url, loading, revision = 0, mode = 'browse', onBrowse, slotRef, surfaceRef, onClose, onLocated, onNavigate, onAsk }) {
  const selecting = mode === 'select';
  const savedKey = `annotation:${projectId}:${url || 'none'}`;
  const [notes, setNotes] = React.useState([]);
  const [currentScope, setCurrentScope] = React.useState(null);
  const [picked, setPicked] = useSessionState(`${savedKey}:picked`, null);
  const [bounds, setBounds] = React.useState(null);
  const [selected, setSelected] = useSessionState(`${savedKey}:selected`, null);
  const selectedRef = React.useRef(selected);
  const [body, setBody] = useSessionState(`${savedKey}:body`, '');
  const [editing, setEditing] = useSessionState(`${savedKey}:editing`, false);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState({ resolutions: {}, unavailable: 0 });
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const input = React.useRef(null), alive = React.useRef(true);
  const sending = React.useRef(false);
  const savedDraft = React.useRef(null);
  const scope = React.useMemo(() => ({ projectId, url }), [projectId, url]);
  const note = notes.find((n) => n.id === selected);
  const replying = note?.reply?.status === 'pending';
  const command = React.useCallback((message) => tabId && url && !loading ? api.browserAnnotate(tabId, message) : Promise.resolve(), [tabId, url, loading]);
  const fail = (e) => { if (alive.current) setError(errorMessage(e)); };
  const marks = (list, site = currentScope) => {
    const items = list.filter(n => n.scope === site).map(({ id, anchor }) => ({ id, anchor }));
    return command(items.length ? { type: 'show', items } : { type: 'clear' });
  };

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; command({ type: 'clear' }).catch(() => {}); };
  }, [command]);
  React.useEffect(() => api.onBrowserAnnotation((event) => {
    if (event.tabId !== tabId) return;
    if (event.type === 'picked') { savedDraft.current = null; selectedRef.current = null; setPicked(event.anchor); setBounds(event.bounds || null); setSelected(null); setBody(''); setEditing(false); setError(''); }
    if (event.type === 'marker') { selectedRef.current = event.id; setSelected(event.id); setBounds(event.bounds || null); setPicked(null); setEditing(false); setConfirmDelete(false); onLocated?.(); }
    if (event.type === 'located' && event.id === selectedRef.current) { setBounds(event.bounds || null); onLocated?.(); }
    if (event.type === 'status') setStatus(event);
    if (event.type === 'exited' && selecting) onClose();
    if (event.type === 'navigated') { selectedRef.current = null; setSelected(null); setBounds(null); setPicked(null); setEditing(false); if (selecting) onClose(); }
    if (event.type === 'error') setError(event.message);
  }), [tabId, selecting, onClose, onLocated]);
  React.useEffect(() => {
    let live = true;
    setReady(false);
    if (selecting) { setPicked(null); setEditing(false); setSelected(null); setBody(''); }
    if (!url) { setNotes([]); setCurrentScope(null); setReady(true); return undefined; }
    if (selecting && loading) return undefined;
    // Direct annotation does not wait for saved notes or open their browser.
    if (selecting) command({ type: 'mode', on: true }).then(() => { if (live) setReady(true); }).catch(e => { if (live) fail(e); });
    return () => { live = false; command({ type: 'clear' }).catch(() => {}); };
  }, [scope, loading, command, selecting, url]);
  React.useEffect(() => {
    if (!url || (selecting && !selected)) return undefined;
    let live = true;
    api.interfaceAnnotations(scope).then(async (data) => {
        if (!live) return;
        if (selectedRef.current && !data.notes.some(n => n.id === selectedRef.current)) {
          selectedRef.current = null; setSelected(null); setEditing(false);
        }
        setNotes(data.notes); setCurrentScope(data.scope); setError(data.warnings?.join(' ') || ''); await marks(data.notes, data.scope);
        if (live) setReady(true);
      }).catch((e) => { if (live) fail(e); });
    return () => { live = false; };
  }, [scope, loading, command, selecting, url, revision, selecting && !!selected]);
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
  const cancel = () => { setPicked(null); setEditing(false); setBody(''); if (selecting) { onClose(); return; } command({ type: 'mode', on: false }).catch(fail); };
  const open = async (next) => {
    selectedRef.current = next.id; setBounds(null); setPicked(null); setSelected(next.id); setEditing(false); setConfirmDelete(false); setError('');
    try { if (next.scope === currentScope) await command({ type: 'locate', id: next.id }); } catch (e) { fail(e); }
  };
  const back = () => {
    selectedRef.current = null; setSelected(null); setBounds(null); setPicked(null); setEditing(false); setConfirmDelete(false);
    command({ type: 'mode', on: false }).then(() => onLocated?.()).catch(fail);
  };
  const save = async () => {
    if (busy || !body.trim() || (!picked && !note)) return;
    setBusy(true); setError('');
    try {
      const saved = picked && !savedDraft.current ? await api.createInterfaceAnnotation(scope, { body, anchor: picked }) : await api.editInterfaceAnnotation(scope, savedDraft.current?.id || note.id, body);
      if (!alive.current) return;
      if (selecting) { setPicked(null); setBody(''); setSelected(saved.id); onClose(); return; }
      const next = notes.some((n) => n.id === saved.id) ? notes.map((n) => n.id === saved.id ? saved : n) : [...notes, saved];
      selectedRef.current = saved.id; setNotes(next); setPicked(null); setEditing(false); setSelected(saved.id); setBody('');
      await marks(next); await command({ type: 'locate', id: saved.id });
    } catch (e) { fail(e); } finally { if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.deleteInterfaceAnnotation(scope, note.id);
      if (!alive.current) return;
      if (selecting) { onClose(); return; }
      const next = notes.filter((n) => n.id !== note.id);
      selectedRef.current = null; setNotes(next); setSelected(null); setBounds(null); setConfirmDelete(false);
      await command({ type: 'mode', on: false }); await marks(next);
      onLocated?.();
    } catch (e) { fail(e); } finally { if (alive.current) setBusy(false); }
  };
  const resolution = note?.scope === currentScope && status.resolutions[note?.id];
  const elsewhere = note && (!url || note.scope !== currentScope || note.anchor.route !== pageAddress(url).route);
  const openPage = () => { try { onNavigate(note.scope === currentScope && url ? routeUrl(note.anchor.route, url) : note.sourceUrl); } catch (e) { fail(e); } };
  const ask = async (question) => {
    if (busy || sending.current || replying) return false;
    sending.current = true; setBusy(true); setError('');
    try {
      const updated = await onAsk(note, question, { tabId });
      if (alive.current) setNotes(current => current.map(n => n.id === updated.id ? updated : n));
      return true;
    } catch (e) { fail(e); return false; } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const asking = selecting && !!picked && !!onAsk;
  const askSelection = async () => {
    if (busy || sending.current || !onAsk || !picked || !body.trim()) return;
    sending.current = true; setBusy(true); setError('');
    try {
      // Save the selected element and question first. Bart's answer is owned by
      // this annotation, including after the composer has been dismissed.
      const saved = savedDraft.current
        ? await api.editInterfaceAnnotation(scope, savedDraft.current.id, body)
        : await api.createInterfaceAnnotation(scope, { body, anchor: picked });
      savedDraft.current = saved;
      const updated = await onAsk(saved, undefined, { tabId });
      if (alive.current) {
        selectedRef.current = updated.id;
        setNotes(current => [...current.filter(n => n.id !== updated.id), updated]); setCurrentScope(updated.scope);
        setSelected(updated.id); setPicked(null); setBody('');
      }
    } catch (e) { fail(e); } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const submit = () => asking ? askSelection() : save();
  const editor = (picked || (editing && note)) && <div className="ia-editor">
    <p className="ia-target" title={label(picked || note.anchor)}>{label(picked || note.anchor)}</p>
    <textarea ref={input} aria-label={asking ? 'Question or note' : 'Annotation note'} placeholder={asking ? 'Ask Bart or add a note…' : 'Add a note…'} rows={4} maxLength={4000} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
    {selecting ? <div className="ia-actions">
      <button type="button" disabled={busy} onClick={cancel}>Cancel</button>
      <button type="button" className={onAsk ? undefined : 'ia-primary'} disabled={busy || !body.trim()} onClick={save}>Add note</button>
      {onAsk && <button type="button" className="ia-primary" disabled={busy || !body.trim()} onClick={askSelection}>Ask Bart</button>}
    </div> : <div className="ia-actions"><button disabled={busy} onClick={cancel}>Cancel</button><button className="ia-primary" disabled={busy || !body.trim()} onClick={save}>{busy ? 'Saving…' : 'Save note'}</button></div>}
  </div>;
  const editorKeys = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (picked || editing)) { e.preventDefault(); void submit(); }
  };
  if (note?.reply) return <AnnotationPopover bounds={!loading && note.scope === currentScope ? bounds : null} slotRef={slotRef} surfaceRef={surfaceRef} onDismiss={onClose} name="Annotation conversation" kind="chat" focusKey={note.id}>
    <AnnotationChat key={note.id} projectId={projectId} note={note} busy={busy} error={error} onSend={ask} onStop={() => api.stopBart(note.reply.askId).catch(fail)} onClose={onClose} onBack={selecting ? onBrowse : back} onDelete={remove} onNavigate={onNavigate} />
  </AnnotationPopover>;
  if (selecting) return picked || error ? <AnnotationPopover bounds={bounds} slotRef={slotRef} surfaceRef={surfaceRef} onKeyDown={editorKeys} onDismiss={busy ? undefined : onClose}>
    {editor}
    {error && <p role="alert" className="ia-error">{error}</p>}
    {!picked && <button onClick={onClose}>Cancel</button>}
  </AnnotationPopover> : null;
  return (
    <AnnotationPopover bounds={note && !loading && resolution?.confidence !== 'unresolved' ? bounds : null} slotRef={slotRef} surfaceRef={surfaceRef} onKeyDown={editorKeys} onDismiss={busy ? undefined : onClose} name={note ? 'Annotation' : 'Annotations'} kind={note ? 'note' : 'browser'} focusKey={`${selected}:${editing}`}>
      <div className="ia-heading stage-popover-heading" data-popover-heading="1">
        {note ? <button type="button" className="ia-back" aria-label="All annotations" disabled={busy} onClick={back}>‹ Annotations</button> : <strong>Annotations</strong>}
        <button type="button" aria-label="Close annotations" disabled={busy} onClick={onClose}>×</button>
      </div>
      {!ready && !error && <p className="ia-muted">{loading ? 'Waiting for the page…' : 'Loading annotations…'}</p>}
      {error && <p role="alert" className="ia-error">{error}</p>}
      {editor}
      {note && !editing && !picked && <div className="ia-detail">
        <p className="ia-target" title={label(note.anchor)}>{label(note.anchor)}</p>
        <p className="ia-body">{note.body}</p>
        <p className="ia-muted">{resolution?.confidence === 'resolved' ? 'Element found on this page.' : resolution?.confidence === 'approximate' ? 'Closest match — the element or its text has changed.' : elsewhere ? `Written on ${note.anchor.route}` : 'Element not found on this page.'}</p>
        {elsewhere && (note.sourceUrl ? <button onClick={openPage}>Open page</button> : <p className="ia-muted">This repository's preview is offline. Rebuild it to locate the element; your note is saved.</p>)}
        <div className="ia-actions"><button disabled={busy} onClick={() => { setBody(note.body); setEditing(true); }}>Edit</button><button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</button>{onAsk && <button disabled={busy} onClick={() => ask()}>Ask Bart</button>}</div>
        {confirmDelete && <div className="ia-delete"><span>Delete this note?</span><button disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button><button disabled={busy} onClick={remove}>Delete</button></div>}
      </div>}
      {!note && <div className="ia-list" aria-busy={!ready}>
        {ready && !notes.length && !picked && <p className="ia-muted">{url ? 'No annotations for this website yet.' : 'Open a website to see its annotations.'}</p>}
        {notes.map(n => <button key={n.id} className="ia-row" onClick={() => open(n)} disabled={busy}>
          <span className="ia-number">{n.scope === currentScope ? notes.filter(n => n.scope === currentScope).findIndex(item => item.id === n.id) + 1 : '·'}</span><span><span className="ia-row-body">{n.body}</span><span className="ia-row-target">{n.sourceName || pageAddress(n.url).site}</span></span>
        </button>)}
      </div>}
    </AnnotationPopover>
  );
}
