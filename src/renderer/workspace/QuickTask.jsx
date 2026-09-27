// A post-it's quick task, opened from the card's state (2026-09-25; design B23). A quick task has no workspace document to
// hold its card, so it is shown here: where it stands, what it said, and what can be done with it — Review, Accept,
// Discard, Resume, and Run as big task, which moves it into the workspace in front as a Build and continues its session.
// Bare, like the Build card: Hudson redraws both in Claude Design.
import React from 'react';
import { createPortal } from 'react-dom';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const STATUS = { 'setting-up': 'Setting up', queued: 'Waiting for a slot', running: 'Working', 'needs-you': 'Needs you', review: 'Ready to review', stopped: 'Stopped', failed: 'Failed', escalated: 'Too big for a quick task', interrupted: 'Interrupted', accepting: 'Accepting', conflict: 'Conflict', accepted: 'Merged', discarded: 'Discarded' };
const WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
const text = (color = '#8f8f8f') => ({ padding: '4px 6px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', font: '500 13px/1.4 var(--font-sans)', color });

export default function QuickTask({ task, progress, workspaceName, onAction, onPromote, onClose }) {
  const [confirm, setConfirm] = React.useState(false);
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  React.useEffect(() => { if (!confirm) return undefined; const timer = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(timer); }, [confirm]);
  if (!task) return null;
  const working = WORKING.has(task.status);
  const final = !!task.final;
  return createPortal(
    <div data-overlay="1" data-quick-task={task.id} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 55, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 24px 24px', background: 'rgba(255,255,255,.35)' }}>
      <div role="dialog" aria-modal="true" aria-label="Quick task" style={{ width: 'min(560px, 100%)', maxHeight: '76vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 160ms ${EASE}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ font: '600 15px/1.4 var(--font-sans)', color: '#171717' }}>Quick task</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '15px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{task.title}</span>
          <span data-quick-status={task.status} style={{ flex: 'none', font: '500 12.5px/1.4 var(--font-sans)', color: task.status === 'failed' || task.status === 'conflict' ? '#e70022' : task.status === 'review' ? '#0070f3' : '#8f8f8f' }}>{STATUS[task.status] || task.status}</span>
          <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(task.messages || []).map((m, n) => (
            <div key={n} style={m.role === 'engelbart' ? { font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' } : { font: '14px/1.6 var(--font-sans)', color: m.role === 'you' ? '#171717' : '#4d4d4d', whiteSpace: 'pre-wrap', paddingLeft: m.role === 'you' ? 10 : 0, borderLeft: m.role === 'you' ? '2px solid #c9c9c9' : 'none' }}>{m.text}</div>
          ))}
          {task.escalation && <div style={{ font: '14px/1.6 var(--font-sans)', color: '#171717' }}>{task.escalation}</div>}
          {working && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{(progress && progress.activity) || STATUS[task.status]}</div>}
          {task.error && !final && <div style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{task.error}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {working && task.status !== 'accepting' && <button type="button" className="hov-ink" data-quick-act="stop" onClick={() => onAction('stop')} style={text()}>Stop</button>}
          {!working && (!final || task.status === 'accepted') && <button type="button" className="hov-ink" data-quick-act="review" onClick={() => onAction('review')} style={text()}>Review</button>}
          {!working && ['interrupted', 'stopped', 'failed'].includes(task.status) && <button type="button" className="hov-ink" data-quick-act="resume" onClick={() => onAction('resume')} style={text()}>Resume</button>}
          {!working && !final && <button type="button" className="hov-ink" data-quick-act="accept" onClick={() => onAction('accept')} style={text('#0070f3')}>Accept</button>}
          {!working && !final && workspaceName && <button type="button" className="hov-ink" data-quick-act="promote" onClick={onPromote} title={`Continue it as a Build of "${workspaceName}"`} style={text('#171717')}>Run as big task</button>}
          {!working && !final && <button type="button" className="hov-ink" data-quick-act="discard" onClick={() => { if (confirm) { setConfirm(false); onAction('discard'); } else setConfirm(true); }} style={text(confirm ? '#e70022' : '#8f8f8f')}>{confirm ? 'Discard for good?' : 'Discard'}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
