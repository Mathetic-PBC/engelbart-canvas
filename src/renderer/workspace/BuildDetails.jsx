import React from 'react';
import { api } from '../api.js';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { timeToLive } from '../model/canvas-build.js';
import { formatDuration } from '../model/run-steps.js';
import { canOpenPreview, canOpenTerminal } from '../model/sandbox-notifications.js';
import { GH } from '../ui/Icons.jsx';
import RunTimeline, { RunLogs } from './RunTimeline.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import './build-details.css';

export function repoToolbarStatus(run) {
  if (run?.status === 'starting') return { label: 'Preparing…', kind: 'starting' };
  if (run?.status === 'failed') return { label: 'Needs attention', kind: 'failed' };
  if (run?.status === 'ready') return canOpenPreview(run)
    ? { label: 'Live', kind: 'live' }
    : { label: 'Ready', kind: 'ready' };
  return { label: 'Inactive', kind: 'inactive' };
}

export function RepoIdentity({ repo, onVisit }) {
  const visit = event => {
    event.preventDefault();
    if (onVisit) onVisit();
    else window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: repo.url } }));
  };
  return <a className="repo-toolbar-identity repo-repository-link" href={repo.url} title={`Open ${repo.name} on GitHub`}
    aria-label={`Open ${repo.name} on GitHub`} onClick={visit} onAuxClick={event => { if (event.button === 1) visit(event); }}>
    <GH /><span className="repo-toolbar-name">{repo.name}</span>
  </a>;
}

export function RepoRuntimeStatus({ repo, run, working, onOpen, arrow = false }) {
  const status = repoToolbarStatus(run);
  const content = <>
    {status.kind === 'failed'
      ? <svg className="repo-toolbar-warning" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2 15 14H1Z" /><path d="M8 6v4m0 2v.01" /></svg>
      : <span className={status.kind === 'starting' ? 'repo-toolbar-spinner' : 'repo-toolbar-dot'} aria-hidden="true" />}
    {status.label}
  </>;
  return <span className="repo-runtime">
    <span className="repo-runtime-separator" aria-hidden="true">/</span>
    {status.kind === 'live'
      ? <button type="button" className="repo-toolbar-status repo-toolbar-status-live" aria-label={`Open live preview for ${repo.name}`}
        disabled={working} aria-busy={working} onClick={onOpen}>{content}
        {arrow && <span className="repo-toolbar-open" aria-hidden="true">↗</span>}</button>
      : <span className={`repo-toolbar-status repo-toolbar-status-${status.kind}`} role="status">{content}</span>}
  </span>;
}

const DETAILS_TABS = ['build', 'logs', 'environment'];
const KIND_LABELS = { interface: 'Web interface', terminal: 'Terminal', both: 'Web interface and terminal' };

// How a person uses the repository, as Claude declared it before setting it up, and why.
export function RepoKind({ run }) {
  if (!KIND_LABELS[run?.kind]) return null;
  return <p className="repo-kind" data-kind={run.kind}><span className="repo-kind-label">Used through: {KIND_LABELS[run.kind]}</span>
    {run.kind_reason && <span className="repo-kind-reason"> — {run.kind_reason}</span>}
    {run.terminal?.hint && <span className="repo-kind-hint"> Try <code>{run.terminal.hint}</code> in {run.terminal.cwd === '.' ? 'the repository' : run.terminal.cwd}.</span>}</p>;
}

// The existing inspector, shared by repository controls and build notifications.
// Navigation and start/stop still come from the caller's current run and actions.
export default function BuildDetails({ repo, item, busy = {}, act, open, openTerminal, error, visible, onClose, returnFocus, id, onVisitRepository }) {
  const generatedId = React.useId();
  const detailsId = id || generatedId;
  const run = item?.run;
  const liveDuration = React.useMemo(() => timeToLive(run), [run]);
  const log = run?.build_log || [];
  const active = run && ['starting', 'ready'].includes(run.status);
  const actionTarget = run || { id: repo.id };
  const working = !!busy[actionTarget.id];
  const status = repoToolbarStatus(run);
  const [tab, setTab] = React.useState('build');
  const [environmentVisited, setEnvironmentVisited] = React.useState(false);
  const dialog = React.useRef(null), closeButton = React.useRef(null);
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    const element = dialog.current;
    if (visible) {
      setTab('build');
      if (!element.open) element.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } else {
      if (element.open) element.close();
      if (wasOpen.current) returnFocus?.current?.focus({ preventScroll: true });
    }
    wasOpen.current = visible;
  }, [visible, returnFocus]);
  const closeDetails = () => {
    // Release the native modal before the caller restores focus to its trigger.
    if (dialog.current?.open) dialog.current.close();
    onClose();
  };
  const openPreview = () => { closeDetails(); open(run); };
  const terminal = !!openTerminal && canOpenTerminal(run);
  const showTerminal = () => { closeDetails(); openTerminal(run); };
  const visitRepository = () => {
    closeDetails();
    if (onVisitRepository) onVisitRepository(repo);
    else window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: repo.url } }));
  };
  const chooseTab = value => { setTab(value); if (value === 'environment') setEnvironmentVisited(true); };
  const tabKeys = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = DETAILS_TABS.indexOf(tab);
    const next = event.key === 'Home' ? DETAILS_TABS[0] : event.key === 'End' ? DETAILS_TABS.at(-1)
      : DETAILS_TABS[(index + (event.key === 'ArrowRight' ? 1 : DETAILS_TABS.length - 1)) % DETAILS_TABS.length];
    chooseTab(next);
    event.currentTarget.querySelector(`[data-tab="${next}"]`)?.focus();
  };
  return <dialog ref={dialog} id={detailsId} role="dialog" aria-modal="true" aria-label={`Build for ${repo.name}`} data-overlay="1" className="repo-details" hidden={!visible}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); closeDetails(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails(); } }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetails();
    }}>
    <header className="repo-details-heading">
      <div className="repo-details-repository"><RepoIdentity repo={repo} onVisit={visitRepository} /><RepoRuntimeStatus repo={repo} run={run} working={working} onOpen={openPreview} /></div>
      <div className="repo-details-actions"><button ref={closeButton} type="button" className="repo-details-action repo-details-close" onClick={closeDetails} aria-label="Close build details" title="Close">×</button></div>
    </header>
    <div className="repo-details-tab-row">
      <div role="tablist" aria-label="Build details" className="repo-details-tabs" onKeyDown={tabKeys}>
        {DETAILS_TABS.map(value => <button key={value} type="button" role="tab" data-tab={value} id={`${detailsId}-${value}-tab`}
          aria-selected={tab === value} aria-controls={`${detailsId}-${value}`} tabIndex={tab === value ? 0 : -1}
          onClick={() => chooseTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      {liveDuration !== null && <span className="repo-build-duration" title="Wall-clock time from setup start (or the latest restart) to the first verified live preview.">
        Time to live <time dateTime={`PT${Math.round(liveDuration / 1000)}S`}>{formatDuration(liveDuration)}</time>
      </span>}
    </div>
    {error && <p role="alert" className="repo-error">{error}</p>}
    <div className="repo-details-scroll repo-details-build-pane" id={`${detailsId}-build`} role="tabpanel" aria-labelledby={`${detailsId}-build-tab`} hidden={tab !== 'build'}>
      <RepoKind run={run} />
      {visible && <RunTimeline key={run?.id || 'pending'} run={run} repoName={repo.name} visible={tab === 'build'} onOpenPreview={status.kind === 'live' ? openPreview : undefined} />}
      {run?.error && <p role="alert" className="repo-error">{run.error}</p>}
      {!log.length && <p className="repo-notice">{item?.message || (run ? 'Earlier build details are unavailable. New build activity will appear here.' : 'Build progress will appear here when setup starts.')}</p>}
    </div>
    <div className="repo-details-scroll repo-details-log-pane" id={`${detailsId}-logs`} role="tabpanel" aria-labelledby={`${detailsId}-logs-tab`} hidden={tab !== 'logs'}>
      {visible && <RunLogs key={run?.id || 'pending'} run={run} visible={tab === 'logs'} />}
    </div>
    <div className="repo-details-scroll" id={`${detailsId}-environment`} role="tabpanel" aria-labelledby={`${detailsId}-environment-tab`} hidden={tab !== 'environment'}>
      {environmentVisited && <EnvironmentPanel repo={repo} run={run} embedded />}
    </div>
    <footer className="repo-details-footer"><div className="repo-details-actions">
      {active && terminal && <button type="button" className={`repo-details-action${canOpenPreview(run) ? '' : ' repo-details-action-primary'}`} disabled={working} onClick={showTerminal}>Open terminal</button>}
      {active
        ? (!terminal || canOpenPreview(run)) && <button type="button" className="repo-details-action repo-details-action-primary" disabled={working || status.kind !== 'live'} onClick={openPreview}>Open preview</button>
        : <button type="button" className="repo-details-action repo-details-action-primary" disabled={working} onClick={() => act(actionTarget, () => api.startSandbox(repo.id))}>{run ? 'Retry build' : 'Run'}</button>}
      {(active || (run?.status === 'failed' && run.sandbox_id)) && <button type="button" className="repo-details-action" disabled={working} onClick={() => act(run, () => api.stopSandbox(run.id))}>Stop sandbox</button>}
    </div></footer>
  </dialog>;
}
