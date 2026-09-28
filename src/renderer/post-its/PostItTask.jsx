// A post-it's quick task, opened from the state on its card (Claude Design "Post-it Quick Task", 2026-09-27; it replaced
// the Quick task dialog). It hangs from that state, covering the cards it reaches, as the Build popup does.
//   Building    what the agent is doing, and Stop.
//   Needs you   (too big for a quick task, or it needs a look: failed, not merged on its own) and Stopped: the task can
//               only go on in a workspace. A search over every workspace, sub-workspaces too; the model, set to what the
//               task ran on; the send, which adds it to that workspace (an archived version of it, main/store/archive.cjs
//               importTask) and goes there; and Discard.
//   Added to    once it went: keep the post-it, or delete it.
import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { findWorkspaces } from '../model/nav.js';
import { usePlaced } from '../ui/usePlaced.js';
import ModelGrid, { EASE, Caret, choiceLabel, useBeside } from './ModelGrid.jsx';
import { SEND_ARROW, sendStyle } from './PostItBuild.jsx';

const WIDTH = 420;
const WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
const TOO_BIG = 'This task was too complex to build outside of a workspace. You must add it to a workspace below to continue.';
const STOPPED = 'This task was stopped. Add it to a workspace below to continue.';

const WORKSPACE_ICON = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: '#171717', strokeWidth: 1.4, strokeLinejoin: 'round' }}><path d="M2.5 1.5h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M9 1.5h4.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M2.5 8h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z" /></svg>;
const SEARCH = <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>;
export const Dots = () => (
  <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
    {[0, 0.15, 0.3].map((delay) => <span key={delay} style={{ display: 'block', flex: 'none', width: 4, height: 4, borderRadius: 999, background: 'currentColor', animation: `pdot 1.1s ease-in-out ${delay}s infinite` }} />)}
  </span>
);
const quiet = { padding: '4px 8px', border: 0, background: 'transparent', cursor: 'pointer', font: '500 13px/1.4 var(--font-sans)', color: '#8f8f8f', transition: 'color 120ms' };

/** What the card says a task that stopped short needs. */
function messageFor(task) {
  if (['stopped', 'interrupted'].includes(task.status)) return STOPPED;
  if (task.status === 'failed') return `This task failed${task.error ? `: ${task.error.replace(/\.$/, '')}` : ''}. Add it to a workspace below to continue.`;
  if (['review', 'conflict'].includes(task.status)) return 'This task\'s changes could not be merged on their own. Add it to a workspace below to review them.';
  return TOO_BIG;
}

/** The workspace field and its search (every workspace, nested ones under their parent; typed, "in <parent>"). */
function WorkspacePick({ workspaces, value, onPick }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const fieldRef = React.useRef(null);
  React.useEffect(() => { if (open && fieldRef.current) fieldRef.current.focus({ preventScroll: true }); }, [open]);
  const typed = q.trim();
  const rows = typed ? findWorkspaces(workspaces, typed) : workspaces;
  const current = workspaces.find((held) => held.id === value);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" data-post-it-ws={value || ''} onClick={() => { setOpen((now) => !now); setQ(''); }} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: `1px solid ${open ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 8, background: '#fafafa', cursor: 'pointer', textAlign: 'left', transition: 'border-color 120ms' }}>
        {WORKSPACE_ICON}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 13px/1.4 var(--font-sans)', color: '#171717' }}>{current ? current.name : 'Choose a workspace'}</span>
        <Caret up={open} />
      </button>
      {open && (
        <div data-overlay="1" data-cover="1" style={{ position: 'absolute', zIndex: 6, top: 'calc(100% + 4px)', left: 0, right: 0, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2, animation: `rise 120ms ${EASE}` }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, padding: '0 10px', borderRadius: 6, background: '#f2f2f2', cursor: 'text' }}>
            {SEARCH}
            <input ref={fieldRef} data-post-it-ws-search="1" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && rows.length) { event.preventDefault(); onPick(rows[0].id); setOpen(false); }
              else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) setQ(''); else setOpen(false); }
            }} placeholder="Search" aria-label="Search workspaces" spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, outline: 'none', background: 'transparent', font: '13px/1.5 var(--font-sans)', color: '#171717' }} />
          </label>
          <div style={{ maxHeight: 200, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows.map((held) => {
              const on = held.id === value;
              const parent = held.above && held.above.length ? held.above[held.above.length - 1] : '';
              return (
                <button key={held.id} type="button" className="hov-wash" data-post-it-ws-row={held.id} onMouseDown={(event) => event.preventDefault()} onClick={() => { onPick(held.id); setOpen(false); setQ(''); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, paddingLeft: typed ? 0 : 16 * (held.above ? held.above.length : 0), overflow: 'hidden' }}>
                    <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 500 : 400} 13px/1.5 var(--font-sans)`, color: '#171717' }}>{held.name}</span>
                    {typed && parent && <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>in {parent}</span>}
                  </span>
                  <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '500 12px/1 var(--font-sans)', color: '#171717' }}>{on ? '✓' : ''}</span>
                </button>
              );
            })}
            {!rows.length && <div style={{ padding: '8px 10px', font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>No workspace matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * `task` the quick task's public record; `progress` its turn's; `anchor` the state's rect on the card (window px).
 * `workspaces` flatWorkspaces of the project, `hereId` the workspace open now (the picker starts on it).
 * `onAction(action)` stop | discard; `onPromote(workspaceId, choice)` → the moved task; `onGo(task)` opens where it went;
 * `onDelete()` throws the post-it out.
 */
export default function PostItTask({ task, progress, anchor, workspaces, hereId, onAction, onPromote, onGo, onDelete, onClose }) {
  const [models, setModels] = React.useState(null);
  const [choice, setChoice] = React.useState(() => ({ provider: task.provider, model: task.model, effort: task.effort }));
  const [workspaceId, setWorkspaceId] = React.useState(() => (workspaces.some((held) => held.id === hereId) ? hereId : workspaces[0] ? workspaces[0].id : null));
  const [modelOpen, setModelOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [asked, setAsked] = React.useState(null); // the workspace's name, once the task went there: keep or delete
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [ref, placed] = usePlaced(anchor, { gap: 8, align: 'end' });
  const modelStyle = useBeside(ref, WIDTH, modelOpen);
  React.useEffect(() => { let live = true; api.buildModels().then((value) => { if (live) setModels(value); }).catch(() => {}); return () => { live = false; }; }, []);
  React.useEffect(() => { if (!confirm) return undefined; const timer = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(timer); }, [confirm]);
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (modelOpen) setModelOpen(false); else onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modelOpen, onClose]);
  React.useEffect(() => {
    const away = (event) => { if (!busy && !(event.target && event.target.closest && event.target.closest('[data-post-it-task], [data-ny-model]'))) onClose(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [busy, onClose]);

  const working = !asked && WORKING.has(task.status);
  const done = !asked && !working;
  const word = asked ? `Added to ${asked}` : working ? 'Building' : ['stopped', 'interrupted'].includes(task.status) ? 'Stopped' : 'Needs you';
  const activity = (progress && progress.activity) || (task.status === 'setting-up' ? 'Setting up its copy of the code' : task.status === 'queued' ? 'Waiting for a slot' : 'Working');
  const target = workspaces.find((held) => held.id === workspaceId);
  const ready = !!(target && choice && !busy);
  const promote = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const moved = await onPromote(workspaceId, choice);
      setAsked(target.name);
      setModelOpen(false);
      onGo(moved);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  return createPortal(
    <>
      <div ref={ref} data-overlay="1" data-cover="1" data-post-it-task={task.id} role="dialog" aria-label="Quick task" style={{ ...placed, zIndex: 55, width: WIDTH, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 10, animation: `rise 160ms ${EASE}` }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 10px 12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span data-post-it-task-word="1" style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 13px/1.4 var(--font-sans)', color: '#171717' }}><span>{word}</span>{working && <Dots />}</span>
            <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ flex: 'none', padding: '0 4px', border: 0, background: 'transparent', cursor: 'pointer', font: '16px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
          </div>
          {working && <div data-post-it-activity="1" style={{ font: '13px/1.5 var(--font-sans)', color: '#4d4d4d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activity}</div>}
          {done && <div style={{ font: '13.5px/1.6 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{messageFor(task)}</div>}
          {asked && <div style={{ font: '13.5px/1.6 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>The task now lives in {asked}. Keep this task, or delete it?</div>}
          {error && <div style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
        </div>
        {asked && (<>
          <div style={{ height: 1, background: '#eaeaea' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, padding: 8 }}>
            <button type="button" className="hov-ink" data-post-it-keep="1" onClick={onClose} style={{ ...quiet, padding: '7px 10px', lineHeight: 1 }}>Keep task</button>
            <button type="button" className="hov-dim" data-post-it-delete="1" onClick={() => { onDelete(); onClose(); }} style={{ padding: '8px 14px', border: 0, borderRadius: 8, background: '#171717', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#fff' }}>Delete task</button>
          </div>
        </>)}
        {working && (<>
          <div style={{ height: 1, background: '#eaeaea' }} />
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px' }}>
            {task.status !== 'accepting' && <button type="button" className="hov-ink" data-quick-act="stop" onClick={() => onAction('stop')} style={quiet}>Stop</button>}
          </div>
        </>)}
        {done && (<>
          <div style={{ height: 1, background: '#eaeaea' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 8px 0' }}>
            <span style={{ padding: '0 8px', font: '500 12.5px/1.3 var(--font-sans)', color: '#4d4d4d' }}>Continue building this task in a workspace.</span>
            <WorkspacePick workspaces={workspaces} value={workspaceId} onPick={setWorkspaceId} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 8px 8px' }}>
            <button type="button" className="hov-ink" data-quick-act="discard" onClick={() => { if (confirm) { setConfirm(false); onAction('discard'); onClose(); } else setConfirm(true); }} style={{ ...quiet, color: confirm ? '#e70022' : '#8f8f8f' }}>{confirm ? 'Discard for good?' : 'Discard'}</button>
            <span style={{ flex: 1 }} />
            <button type="button" data-post-it-model="1" onClick={() => setModelOpen((open) => !open)} aria-haspopup="dialog" aria-expanded={modelOpen} disabled={!models}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', border: `1px solid ${modelOpen ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 999, background: '#fff', cursor: 'pointer', font: '12px/1 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'nowrap', transition: 'border-color 120ms' }}>
              <span>{choiceLabel(models, choice) || task.modelName}</span><Caret up={modelOpen} />
            </button>
            <button type="button" data-quick-act="promote" onClick={promote} disabled={!ready} aria-label={target ? `Continue in ${target.name}` : 'Continue in a workspace'} title={target ? `Continue in ${target.name}` : undefined} className={ready ? 'hov-dim' : undefined} style={sendStyle(ready)}>{SEND_ARROW}</button>
          </div>
        </>)}
      </div>
      {modelOpen && models && (
        <div data-overlay="1" data-cover="1" data-ny-model="1" style={{ ...modelStyle, zIndex: 60, boxSizing: 'border-box', background: '#fff', border: '1px solid #eaeaea', borderRadius: 10, overflow: 'hidden', animation: `rise 140ms ${EASE}` }}>
          <ModelGrid models={models} choice={choice} onChoose={(next) => setChoice(next)} />
        </div>
      )}
    </>,
    document.body,
  );
}
