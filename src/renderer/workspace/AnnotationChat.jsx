import React from 'react';
import { useSessionState } from '../session-ui.js';
import ReactMarkdown from 'react-markdown';
import { targetLabel } from '../../shared/interface-annotations.cjs';
import { api } from '../api.js';

export default function AnnotationChat({ projectId, note, busy, error, onSend, onStop, onClose, onBack, onDelete, onNavigate }) {
  const [draft, setDraft] = useSessionState(`annotation-chat:${note.id}`, '');
  const [deleting, setDeleting] = React.useState(false);
  const messages = React.useRef(null), input = React.useRef(null), follow = React.useRef(true);
  const replies = [...(note.replyHistory || []), ...(note.reply ? [note.reply] : [])];
  const pending = note.reply?.status === 'pending';
  const [stream, setStream] = React.useState(null);
  const askId = note.reply?.askId;
  React.useEffect(() => {
    setStream(null);
    if (!pending) return undefined;
    let live = true;
    const update = event => {
      if (!live || event?.askId !== askId || event.projectId !== projectId || event.annotationId !== note.id) return;
      setStream(current => current?.askId === askId && current.sequence >= event.sequence ? current : event);
    };
    // Subscribe first, then recover any text emitted before the popup opened.
    const unsubscribe = api.onBartProgress(update);
    api.annotationReplyProgress(projectId, note.id, askId).then(update).catch(() => {});
    return () => { live = false; unsubscribe(); };
  }, [projectId, note.id, askId, pending]);
  const progress = pending && stream?.askId === askId ? stream : null;
  const liveText = progress?.lines?.join('\n') || '';
  React.useLayoutEffect(() => {
    if (follow.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [note.reply, note.replyHistory, error, progress]);
  React.useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(96, input.current.scrollHeight)}px`;
  }, [draft]);
  const send = async () => {
    if (!draft.trim() || busy || pending) return;
    const question = draft;
    follow.current = true;
    if (await onSend(question)) setDraft(current => current === question ? '' : current);
    input.current?.focus({ preventScroll: true });
  };
  return <>
    <div className="ia-chat-heading" data-popover-heading="1">
      <button type="button" className="ia-chat-icon" aria-label="All annotations" title="All annotations" onClick={onBack}>‹</button>
      <div className="ia-chat-title"><strong>Bart</strong><span title={targetLabel(note.anchor.element)}>{targetLabel(note.anchor.element)}</span></div>
      <button type="button" className="ia-chat-icon" aria-label="Delete conversation" title="Delete conversation" disabled={busy || pending} onClick={() => setDeleting(value => !value)}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6" /></svg></button>
      <button type="button" className="ia-chat-icon" aria-label="Close annotations" title="Close conversation" onClick={onClose}>×</button>
    </div>
    {deleting && <div className="ia-chat-delete"><span>Delete this conversation?</span><button type="button" onClick={() => setDeleting(false)}>Keep</button><button type="button" disabled={busy} onClick={onDelete}>Delete</button></div>}
    <div ref={messages} className="ia-chat-messages" role="log" aria-label="Annotation conversation" aria-relevant="additions text" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {replies.map(reply => <React.Fragment key={reply.askId}>
        <div className="ia-chat-message ia-chat-user" aria-label="You"><p className="ia-body">{reply.question}</p></div>
        <div className="ia-chat-message ia-chat-assistant" aria-label="Bart" data-annotation-reply={note.id} aria-busy={reply.status === 'pending'}>
          <strong>Bart</strong>
          {reply.status === 'pending' && <p className="ia-chat-thinking" role="status"><span aria-hidden="true">•••</span> {progress?.activity || 'Thinking…'}</p>}
          {(reply.text || (reply.status === 'pending' && liveText)) && <ReactMarkdown skipHtml components={{
            a: ({ href, children }) => /^https?:\/\//i.test(href || '') ? <a href={href} onClick={event => { event.preventDefault(); onNavigate(href); }}>{children}</a> : <span>{children}</span>,
            img: ({ alt }) => <span>{alt}</span>,
          }}>{reply.status === 'pending' ? liveText : reply.text}</ReactMarkdown>}
          {reply.status === 'stopped' && <p className="ia-muted">Response stopped.</p>}
          {reply.status === 'interrupted' && <p className="ia-muted">The app closed before this reply finished.</p>}
          {['error', 'stopped', 'interrupted'].includes(reply.status) && reply.askId === note.reply.askId && <button type="button" disabled={busy || pending} onClick={() => onSend(reply.question)}>Try again</button>}
        </div>
      </React.Fragment>)}
      {error && <p role="alert" className="ia-error">{error}</p>}
    </div>
    <form className="ia-chat-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea ref={input} aria-label="Message Bart" placeholder="Message Bart…" rows={2} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void send(); }
      }} />
      {pending ? <button type="button" className="ia-chat-send" aria-label="Stop response" title="Stop response" onClick={onStop}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><rect x="4" y="4" width="12" height="12" rx="2" /></svg></button>
        : <button type="submit" className="ia-chat-send" aria-label="Send message" title="Send message" disabled={busy || !draft.trim()}><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></button>}
    </form>
  </>;
}
