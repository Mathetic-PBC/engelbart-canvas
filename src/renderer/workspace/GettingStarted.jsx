import React from 'react';
import { api } from '../api.js';
import { STEPS, WAITING_LINE, allDone, headerLine, openStepOf, pickView, toggled } from '../model/getting-started.js';

// Getting started (2026-10-09): above the document of a new user's "Getting started" workspace, never written into it.
// On top, the project's description as they typed it; under it, five steps they tick by hand, the open one with its hint.
// Step 2 holds the workspaces Connect your library suggested (they show up on their own once written), each with Start,
// and "Something else…" for their own words: Start makes the workspace and goes there, one at a time. Five ticked folds
// it to its header; Hide takes it away for good. Its state is main's (store/getting-started.cjs).

const GREY = '#8f8f8f';
const LINE = '#eaeaea';
const START = { flex: 'none', padding: '5px 12px', border: '1px solid #171717', borderRadius: 7, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1.3 var(--font-sans)' };
const QUIET = { padding: '2px 4px', border: 0, background: 'none', cursor: 'pointer', font: '400 12.5px/1.4 var(--font-sans)', color: GREY };

function Circle({ done, n, onClick }) {
  return (
    <button type="button" role="checkbox" aria-checked={done} aria-label={`Step ${n} done`} data-getting-started-tick={n} onClick={onClick}
      style={{ flex: 'none', width: 18, height: 18, marginTop: 3, padding: 0, borderRadius: '50%', border: `1.5px solid ${done ? '#171717' : '#c9c9c9'}`, background: done ? '#171717' : '#fff', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 10px/1 var(--font-sans)' }}>
      {done ? '✓' : ''}
    </button>
  );
}

/** `state` main's ({ ticked, hidden }); `onState` its answer after a change; `onStarted(workspaceId)` goes there. */
export default function GettingStarted({ projectId, description = '', state, onState, onStarted, workspaceIdOf = () => null, onError = () => {} }) {
  const ticked = state.ticked || [];
  const [picked, setPicked] = React.useState(null); // the step whose title was clicked
  const [folded, setFolded] = React.useState(() => allDone(ticked));
  const [workspaces, setWorkspaces] = React.useState({ status: 'waiting', suggestions: [], picked: [] });
  const [custom, setCustom] = React.useState(null); // null until typed in: then the person's words
  const [busy, setBusy] = React.useState(false);

  // The suggestions, and again whenever Connect says this project's session changed (they are written in the background).
  React.useEffect(() => {
    let alive = true;
    const load = () => api.connectWorkspaces(projectId).then((value) => { if (alive && value) setWorkspaces(value); }).catch(() => {});
    load();
    const off = api.onConnect((snapshot) => { if (snapshot && snapshot.projectId === projectId) load(); });
    return () => { alive = false; off(); };
  }, [projectId]);

  const done = allDone(ticked);
  const wasDone = React.useRef(done);
  React.useEffect(() => { if (done && !wasDone.current) setFolded(true); wasDone.current = done; }, [done]);

  const save = (patch) => api.setGettingStarted(projectId, patch).then((next) => { if (next) onState(next); }).catch((error) => onError(error));
  const tick = (n) => {
    const next = toggled(ticked, n);
    if (picked === n && next.includes(n)) setPicked(null);
    onState({ ...state, ticked: next });
    void save({ ticked: next });
  };
  const open = openStepOf(ticked, picked);
  const view = pickView(workspaces, description);
  const customText = custom == null ? view.custom : custom;

  const start = async (choice) => {
    if (busy) return;
    setBusy(true);
    try {
      const made = await api.connectPickWorkspace(projectId, choice);
      if (made.gettingStarted) onState(made.gettingStarted);
      setWorkspaces((now) => ({ ...now, picked: [...(now.picked || []), made.name] }));
      if (choice.custom !== undefined) setCustom(null);
      setPicked(null);
      await onStarted(made.workspaceId);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const pickBody = (
    <div data-getting-started-pick={view.kind} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {view.kind === 'waiting' && <div data-getting-started-waiting="1" style={{ font: '400 14px/1.5 var(--font-sans)', color: GREY }}>{WAITING_LINE}</div>}
      {view.cards.map((card) => (
        <div key={card.index} data-getting-started-card={card.index} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px', border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: '500 14.5px/1.4 var(--font-sans)', color: '#171717' }}>{card.name}</div>
            {card.description && <div style={{ font: '400 14px/1.45 var(--font-sans)', color: '#4d4d4d', marginTop: 2 }}>{card.description}</div>}
            {card.why && <div style={{ font: '400 12.5px/1.4 var(--font-sans)', color: GREY, marginTop: 3 }}>{card.why}</div>}
          </div>
          {card.started ? (
            <span data-getting-started-started={card.index} style={{ flex: 'none', marginTop: 4, font: '400 13px/1.3 var(--font-sans)', color: GREY, whiteSpace: 'nowrap' }}>
              Started · <button type="button" className="hov-ink" disabled={!workspaceIdOf(card.name)} onClick={() => { const id = workspaceIdOf(card.name); if (id) void onStarted(id); }} style={{ ...QUIET, padding: 0, font: 'inherit', color: '#0070f3' }}>Open</button>
            </span>
          ) : (
            <button type="button" data-getting-started-start={card.index} disabled={busy} onClick={() => start({ index: card.index })} style={{ ...START, opacity: busy ? 0.5 : 1 }}>Start</button>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '8px 12px', border: `1px solid ${LINE}`, borderRadius: 8 }}>
        <textarea data-getting-started-custom="1" rows={view.kind === 'none' && customText ? 2 : 1} value={customText} onChange={(event) => setCustom(event.target.value)} placeholder="Something else…" aria-label="Something else" spellCheck={false}
          style={{ flex: 1, minWidth: 0, margin: 0, padding: '4px 0', border: 0, outline: 'none', resize: 'vertical', background: 'transparent', font: '400 14px/1.5 var(--font-sans)', color: '#171717' }} />
        <button type="button" data-getting-started-start="custom" disabled={busy || !customText.trim()} onClick={() => start({ custom: customText })} style={{ ...START, opacity: busy || !customText.trim() ? 0.4 : 1, cursor: busy || !customText.trim() ? 'default' : 'pointer' }}>Start</button>
      </div>
    </div>
  );

  return (
    <div data-getting-started="1" style={{ margin: '14px 0 6px', userSelect: 'text', cursor: 'auto' }}>
      {description && (
        <div data-getting-started-description="1" style={{ padding: '10px 14px', border: `1px solid ${LINE}`, borderRadius: 8, font: '400 15px/1.55 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{description}</div>
      )}
      <div style={{ marginTop: 14, border: `1px solid ${LINE}`, borderRadius: 10, background: '#fafafa' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 14px' }}>
          <button type="button" data-getting-started-head="1" aria-expanded={!folded} onClick={() => setFolded(!folded)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 14px/1.4 var(--font-sans)', color: '#171717', textAlign: 'left' }}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 10, color: GREY, transform: folded ? 'rotate(-90deg)' : 'none', transition: 'transform 120ms' }}>▾</span>
            <span data-getting-started-count="1">{headerLine(ticked)}</span>
          </button>
          <button type="button" className="hov-ink" data-getting-started-hide="1" onClick={() => { onState({ ...state, hidden: true }); void save({ hidden: true }); }} title="Hide Getting started for good" style={QUIET}>Hide</button>
        </div>
        {!folded && (
          <ol style={{ listStyle: 'none', margin: 0, padding: '0 14px 12px' }}>
            {STEPS.map((step) => {
              const isDone = ticked.includes(step.n), isOpen = open === step.n;
              return (
                <li key={step.n} data-getting-started-step={step.n} data-open={isOpen ? '1' : '0'} style={{ display: 'flex', gap: 10, padding: '6px 0', borderTop: step.n === 1 ? 0 : `1px solid ${LINE}` }}>
                  <Circle done={isDone} n={step.n} onClick={() => tick(step.n)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <button type="button" data-getting-started-title={step.n} onClick={() => setPicked(step.n)} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', font: `${isOpen ? 500 : 400} 14.5px/1.6 var(--font-sans)`, color: isDone && !isOpen ? GREY : '#171717', textDecoration: isDone && !isOpen ? 'line-through' : 'none' }}>
                      {step.n}. {step.title}
                    </button>
                    {isOpen && step.hint && <div data-getting-started-hint={step.n} style={{ font: '400 13.5px/1.5 var(--font-sans)', color: GREY }}>{step.hint}</div>}
                    {isOpen && step.n === 2 && pickBody}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
