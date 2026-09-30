import React from 'react';
import { api, errorMessage } from '../api.js';
import { rowOf, installable, skipWarnings, allDone, needsAction } from '../model/tools.js';

// The setup dialog for Git, Claude Code and Codex (2026-09-23; design D15). After the launch check it
// opens with only what needs the person (`mode` "launch"); Engelbart ▸ Set Up Tools… opens it with all
// three (`mode` "all"), where a skipped tool can be asked about again and automatic updates turned off.
// Rows follow the main process's snapshot as installs, updates and sign-ins run.

const LABEL = { install: 'Install', update: 'Update', 'sign-in': 'Sign in', retry: 'Try again', cancel: 'Cancel' };
const TONE = { ok: '#171717', muted: '#8f8f8f', busy: '#8f8f8f', warn: '#a35200', error: '#e70022' };

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
    <path d="M2.5 6.2 5 8.6l4.5-5.2" fill="none" stroke="#1a7f37" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Pulse = () => <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: '#8f8f8f', flex: 'none', animation: 'github-wait 1.4s ease-in-out infinite' }} />;

function Row({ row, onAct, onAskAgain, onOpenPage, showAskAgain }) {
  return (
    <div data-tool-row={row.id} style={{ display: 'grid', gridTemplateColumns: '112px 1fr auto', alignItems: 'center', columnGap: 12, rowGap: 4, padding: '10px 0', borderTop: '1px solid #f2f2f2' }}>
      <span style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
      <span data-tool-state style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, font: '12px/1.4 var(--font-mono)', color: TONE[row.tone] }}>
        {row.tone === 'ok' && <Check />}
        {row.tone === 'busy' && <Pulse />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.state}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {row.page && <button type="button" className="hov-ink" onClick={() => onOpenPage(row.page)} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Open page</button>}
        {showAskAgain && row.skipped && <button type="button" data-tool-ask-again={row.id} className="hov-ink" onClick={() => onAskAgain(row.id)} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Ask again</button>}
        {row.action && (
          <button type="button" data-tool-action={row.action} data-tool={row.id} className="hov-wash" onClick={() => onAct(row)} style={{ minHeight: 30, padding: '6px 12px', border: '1px solid #eaeaea', borderRadius: 7, background: '#fff', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>{LABEL[row.action]}</button>
        )}
      </span>
      {row.detail && <span data-tool-detail style={{ gridColumn: '1 / -1', font: '12px/1.5 var(--font-sans)', color: TONE[row.detailTone] || TONE.error, overflowWrap: 'anywhere' }}>{row.detail}</span>}
    </div>
  );
}

export default function ToolSetup({ snapshot, ids, mode = 'launch', onClose }) {
  const [warning, setWarning] = React.useState(null); // the lines Skip warns with, while it waits to be confirmed
  const [error, setError] = React.useState('');
  const rows = ids.filter((id) => snapshot.tools[id]).map((id) => rowOf(snapshot.tools[id]));
  const pending = ids.filter((id) => needsAction(snapshot.tools[id]));
  const toInstall = installable(snapshot, ids);
  const done = allDone(snapshot, ids);
  const run = (promise) => Promise.resolve(promise).catch((candidate) => setError(errorMessage(candidate)));

  // Escape closes the dialog only: taken in the capture phase and stopped there, so the workspace's own Escape
  // (all projects) and the editor's never see it.
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const act = (row) => {
    setError('');
    if (row.action === 'install') return run(api.toolsInstall([row.id]));
    if (row.action === 'update') return run(api.toolsUpdate(row.id));
    if (row.action === 'sign-in') return run(api.toolsSignIn(row.id));
    if (row.action === 'cancel') return run(api.toolsCancelSignIn(row.id));
    if (row.action === 'retry') return run(snapshot.tools[row.id].installed ? api.toolsCheck() : api.toolsInstall([row.id]));
    return null;
  };
  const skip = () => {
    const lines = skipWarnings(snapshot, pending);
    if (lines.length) { setWarning(lines); return; }
    run(api.toolsSkip(pending)).then(onClose);
  };
  const confirmSkip = () => run(api.toolsSkip(pending)).then(onClose);

  const primary = { minHeight: 36, padding: '9px 16px', border: 0, borderRadius: 8, background: '#0070f3', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' };
  const quiet = { padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#8f8f8f' };

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Engelbart" data-tool-setup={mode} data-overlay="1" style={{ position: 'fixed', inset: 0, zIndex: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(255,255,255,.35)' }}>
      <div style={{ width: 'min(500px, 100%)', display: 'flex', flexDirection: 'column', gap: 16, padding: 28, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: 'rise 200ms cubic-bezier(.25,.1,.25,1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ margin: 0, font: '500 20px/1.3 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>{mode === 'all' ? 'Tools' : 'Set up Engelbart'}</h2>
          <button type="button" aria-label="Close" data-tool-close className="hov-ink" onClick={onClose} style={{ ...quiet, font: '18px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
        </div>
        {warning ? (
          <div data-tool-warning style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {warning.map((line) => <p key={line} style={{ margin: 0, font: '13.5px/1.6 var(--font-sans)', color: '#171717' }}>{line}</p>)}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button type="button" data-tool-skip-confirm onClick={confirmSkip} style={{ ...primary, background: '#171717' }} autoFocus>Skip anyway</button>
              <button type="button" className="hov-ink" onClick={() => setWarning(null)} style={quiet}>Back</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {rows.map((row) => <Row key={row.id} row={row} onAct={act} showAskAgain={mode === 'all'} onAskAgain={(id) => run(api.toolsAskAgain(id))} onOpenPage={(url) => run(api.openExternal(url))} />)}
            </div>
            {error && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {mode === 'all' ? (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: '13px/1 var(--font-sans)', color: '#171717', cursor: 'pointer' }}>
                    <input type="checkbox" data-tool-updates checked={snapshot.updates !== 'ask'} onChange={(event) => run(api.toolsSetUpdates(event.target.checked ? 'auto' : 'ask'))} />
                    Update automatically
                  </label>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="hov-ink" onClick={() => run(api.toolsCheck())} style={quiet}>Check again</button>
                  <button type="button" onClick={onClose} style={primary}>Done</button>
                </>
              ) : done ? (
                <button type="button" data-tool-done onClick={onClose} style={primary} autoFocus>Done</button>
              ) : (
                <>
                  {toInstall.length > 1 && <button type="button" data-tool-install-all onClick={() => { setError(''); run(api.toolsInstall(toInstall)); }} style={primary}>Install all</button>}
                  <span style={{ flex: 1 }} />
                  {pending.length > 0 && <button type="button" data-tool-skip className="hov-ink" onClick={skip} style={quiet}>Skip</button>}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
