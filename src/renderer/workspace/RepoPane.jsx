import React from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { timeToLive } from '../model/canvas-build.js';
import { formatDuration } from '../model/run-steps.js';
import { useSandboxes } from '../ui/SandboxProgress.jsx';
import { GH } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import RepoReadme from './RepoReadme.jsx';
import RunTimeline, { RunLogs } from './RunTimeline.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import './repo-pane.css';

export function repoToolbarStatus(run) {
  if (run?.status === 'starting') return { label: 'Preparing…', kind: 'starting' };
  if (run?.status === 'failed') return { label: 'Needs attention', kind: 'failed' };
  if (run?.status === 'ready') return run.preview_url
    ? { label: 'Live', kind: 'live' }
    : { label: 'Ready', kind: 'ready' };
  return { label: 'Inactive', kind: 'inactive' };
}

const DETAILS_TABS = ['build', 'logs', 'environment'];

export function RepoSwitcher({ repo, repositories, onSelect }) {
  const [anchor, setAnchor] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [highlightedId, setHighlightedId] = React.useState(repo.id);
  const trigger = React.useRef(null);
  const search = React.useRef(null);
  const id = React.useId();
  const [panel, placed] = usePlaced(anchor, { cap: 440 });
  const needle = query.trim().toLowerCase();
  const matches = repositories.filter((row) => `${row.name} ${row.url || ''}`.toLowerCase().includes(needle));
  const highlighted = Math.max(0, matches.findIndex((row) => row.id === highlightedId));
  const close = (restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  React.useEffect(() => {
    if (!anchor) return;
    const frame = requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', resize);
    };
  }, [anchor]);
  React.useEffect(() => {
    if (anchor) panel.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [anchor, highlighted, query]);
  const choose = (id) => {
    const pane = trigger.current?.closest('.repo-pane');
    close(true);
    onSelect(id);
    // Selecting a different repo remounts Repository, including the trigger.
    requestAnimationFrame(() => (pane?.querySelector('.repo-switch-trigger') || trigger.current)?.focus({ preventScroll: true }));
  };
  const navigate = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (event.target !== search.current || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) {
        const next = (highlighted + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        setHighlightedId(matches[next].id);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (matches[highlighted]) choose(matches[highlighted].id);
    }
  };
  const show = () => {
    setQuery('');
    setHighlightedId(repo.id);
    setAnchor(trigger.current.parentElement.getBoundingClientRect());
  };
  return <>
    <button ref={trigger} type="button" className="repo-switch-trigger" aria-label="Switch repository" title="Switch repository"
      aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? id : undefined}
      onClick={() => anchor ? close() : show()} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}><svg className="repo-toolbar-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 6 3-3 3 3m-6 4 3 3 3-3" /></svg></button>
    {anchor && createPortal(<div ref={panel} id={id} className="repo-switch-menu" role="dialog" aria-label="Switch repository" data-overlay="1" style={{ ...placed, overflowY: 'hidden' }} onKeyDown={navigate}>
      <div className="repo-switch-search">
        <input ref={search} type="text" role="combobox" aria-label="Find repository" placeholder="Find Repository…"
          aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
          aria-activedescendant={matches.length ? `${id}-option-${highlighted}` : undefined}
          autoComplete="off" spellCheck={false} value={query} onChange={(event) => { setQuery(event.target.value); setHighlightedId(null); }} />
        <button type="button" className="repo-switch-escape" aria-label="Close repository switcher" onClick={() => close(true)}>Esc</button>
      </div>
      <div id={`${id}-list`} className="repo-switch-list" role="listbox" aria-label="Repositories">
        {matches.map((row, index) => <button key={row.id} id={`${id}-option-${index}`} type="button" role="option" aria-selected={row.id === repo.id} tabIndex={-1}
          data-highlighted={index === highlighted} className="repo-switch-option" onPointerMove={() => setHighlightedId(row.id)}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(row.id)}>
          <span className="repo-switch-label"><GH /><span>{row.name}</span></span>
          <span className="repo-switch-check" aria-hidden="true">{row.id === repo.id && <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7" /></svg>}</span>
        </button>)}
      </div>
      {!matches.length && <p className="repo-switch-empty" role="status">No repositories found.</p>}
    </div>, document.body)}
  </>;
}

export function Repository({ repo, repositories = [], onSelect, item, busy, act, open, error }) {
  const run = item?.run;
  const liveDuration = React.useMemo(() => timeToLive(run), [run]);
  const log = run?.build_log || [];
  const active = run && ['starting', 'ready'].includes(run.status);
  const actionTarget = run || { id: repo.id };
  const working = !!busy[actionTarget.id];
  const status = repoToolbarStatus(run);
  const canSwitch = repositories.length > 1 && !!onSelect;
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [detailsTab, setDetailsTab] = React.useState('build');
  const [environmentVisited, setEnvironmentVisited] = React.useState(false);
  const detailsButton = React.useRef(null);
  const detailsDialog = React.useRef(null);
  const closeButton = React.useRef(null);
  const wasDetailsOpen = React.useRef(false);
  const detailsId = React.useId();
  const showDetails = () => { setDetailsTab('build'); setDetailsOpen(true); };
  const closeDetails = () => setDetailsOpen(false);
  const openPreview = () => { closeDetails(); open(run); };
  const visitRepository = (event) => {
    event.preventDefault();
    closeDetails();
    window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: repo.url } }));
  };
  const identity = <a className="repo-toolbar-identity repo-repository-link" href={repo.url} title={`Open ${repo.name} on GitHub`}
    aria-label={`Open ${repo.name} on GitHub`} onClick={visitRepository} onAuxClick={(event) => { if (event.button === 1) visitRepository(event); }}>
    <GH /><span className="repo-toolbar-name">{repo.name}</span>
  </a>;
  React.useEffect(() => {
    const dialog = detailsDialog.current;
    if (detailsOpen) {
      // The native modal sits above the whole workspace and keeps focus inside it.
      if (!dialog.open) dialog.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } else {
      if (dialog.open) dialog.close();
      // Restore focus to the toolbar after the modal closes.
      if (wasDetailsOpen.current) detailsButton.current?.focus({ preventScroll: true });
    }
    wasDetailsOpen.current = detailsOpen;
  }, [detailsOpen]);
  const chooseTab = (tab) => {
    setDetailsTab(tab);
    if (tab === 'environment') setEnvironmentVisited(true);
  };
  const tabKeys = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = DETAILS_TABS.indexOf(detailsTab);
    const next = event.key === 'Home' ? DETAILS_TABS[0] : event.key === 'End' ? DETAILS_TABS.at(-1)
      : DETAILS_TABS[(index + (event.key === 'ArrowRight' ? 1 : DETAILS_TABS.length - 1)) % DETAILS_TABS.length];
    chooseTab(next);
    event.currentTarget.querySelector(`[data-tab="${next}"]`)?.focus();
  };
  const statusIcon = status.kind === 'failed'
    ? <svg className="repo-toolbar-warning" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2 15 14H1Z" /><path d="M8 6v4m0 2v.01" /></svg>
    : <span className={status.kind === 'starting' ? 'repo-toolbar-spinner' : 'repo-toolbar-dot'} aria-hidden="true" />;
  const statusContent = <>
    {statusIcon}
    {status.label}
  </>;
  const runtimeStatus = (showArrow = false) => <span className="repo-runtime">
    <span className="repo-runtime-separator" aria-hidden="true">/</span>
    {status.kind === 'live'
      ? <button type="button" className="repo-toolbar-status repo-toolbar-status-live" aria-label={`Open live preview for ${repo.name}`}
        disabled={working} aria-busy={working} onClick={openPreview}>{statusContent}
        {showArrow && <span className="repo-toolbar-open" aria-hidden="true">↗</span>}</button>
      : <span className={`repo-toolbar-status repo-toolbar-status-${status.kind}`} role="status">{statusContent}</span>}
  </span>;
  return <div className="repo-selected" onKeyDown={(event) => {
    // Escape closes the modal without also closing the workspace.
    if (detailsOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails(); }
  }}>
    <header className="repo-toolbar" aria-label={`Controls for ${repo.name}`}>
      <div className="repo-toolbar-repository">
        {identity}
        {canSwitch && <RepoSwitcher repo={repo} repositories={repositories} onSelect={onSelect} />}
      </div>
      <div className="repo-toolbar-actions">
        <button ref={detailsButton} type="button" className="repo-toolbar-build" aria-haspopup="dialog" aria-expanded={detailsOpen} aria-controls={detailsId}
          onClick={() => detailsOpen ? closeDetails() : showDetails()}>Build</button>
        {runtimeStatus(true)}
      </div>
    </header>
    {error && !detailsOpen && <p role="alert" className="repo-error">{error}</p>}
    <div className="repo-body">
      <div className="repo-reading" inert={detailsOpen}>
        <RepoReadme repo={repo} />
      </div>
      <dialog ref={detailsDialog} id={detailsId} role="dialog" aria-modal="true" aria-label={`Build for ${repo.name}`} data-overlay="1" className="repo-details" hidden={!detailsOpen}
        onCancel={(event) => { event.preventDefault(); closeDetails(); }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetails();
        }}>
        <header className="repo-details-heading">
          <div className="repo-details-repository">{identity}{runtimeStatus()}</div>
          <div className="repo-details-actions">
            <button ref={closeButton} type="button" className="repo-details-action repo-details-close" onClick={closeDetails} aria-label="Close build details" title="Close">×</button>
          </div>
        </header>
        <div className="repo-details-tab-row">
          <div role="tablist" aria-label="Build details" className="repo-details-tabs" onKeyDown={tabKeys}>
            {DETAILS_TABS.map((tab) => <button key={tab} type="button" role="tab" data-tab={tab} id={`${detailsId}-${tab}-tab`}
              aria-selected={detailsTab === tab} aria-controls={`${detailsId}-${tab}`} tabIndex={detailsTab === tab ? 0 : -1}
              onClick={() => chooseTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
          </div>
          {liveDuration !== null && <span className="repo-build-duration" title="Wall-clock time from setup start (or the latest restart) to the first verified live preview.">
            Time to live <time dateTime={`PT${Math.round(liveDuration / 1000)}S`}>{formatDuration(liveDuration)}</time>
          </span>}
        </div>
        {error && <p role="alert" className="repo-error">{error}</p>}
        <div className="repo-details-scroll repo-details-build-pane" id={`${detailsId}-build`} role="tabpanel" aria-labelledby={`${detailsId}-build-tab`} hidden={detailsTab !== 'build'}>
          {detailsOpen && <RunTimeline key={run?.id || 'pending'} run={run} repoName={repo.name} visible={detailsTab === 'build'}
            onOpenPreview={status.kind === 'live' ? openPreview : undefined} />}
          {run?.error && <p role="alert" className="repo-error">{run.error}</p>}
          {!log.length && <p className="repo-notice">{item?.message || (run ? 'Earlier build details are unavailable. New build activity will appear here.' : 'Build progress will appear here when setup starts.')}</p>}
        </div>
        <div className="repo-details-scroll repo-details-log-pane" id={`${detailsId}-logs`} role="tabpanel" aria-labelledby={`${detailsId}-logs-tab`} hidden={detailsTab !== 'logs'}>
          {detailsOpen && <RunLogs key={run?.id || 'pending'} run={run} visible={detailsTab === 'logs'} />}
        </div>
        <div className="repo-details-scroll" id={`${detailsId}-environment`} role="tabpanel" aria-labelledby={`${detailsId}-environment-tab`} hidden={detailsTab !== 'environment'}>
          {environmentVisited && <EnvironmentPanel repo={repo} run={run} embedded />}
        </div>
        <footer className="repo-details-footer">
          <div className="repo-details-actions">
            {active
              ? <button type="button" className="repo-details-action repo-details-action-primary" disabled={working || status.kind !== 'live'} onClick={openPreview}>Open preview</button>
              : <button type="button" className="repo-details-action repo-details-action-primary" disabled={working} onClick={() => act(actionTarget, () => api.startSandbox(repo.id))}>{run ? 'Retry build' : 'Run'}</button>}
            {(active || (run?.status === 'failed' && run.sandbox_id)) && <button type="button" className="repo-details-action" disabled={working} onClick={() => act(run, () => api.stopSandbox(run.id))}>Stop sandbox</button>}
          </div>
        </footer>
      </dialog>
    </div>
  </div>;
}

export default function RepoPane({ repositories, selectedId, onSelect }) {
  const { items, error, busy, act, open } = useSandboxes();
  const repo = repositories.find((row) => row.id === selectedId) || repositories[0];
  React.useEffect(() => { if (repo && repo.id !== selectedId) onSelect(repo.id); }, [repo?.id, selectedId, onSelect]);
  return <section className="repo-pane" aria-label="Repository">
    {repo ? <Repository key={repo.id} repo={repo} repositories={repositories} onSelect={onSelect} item={items[repo.id]} busy={busy} act={act} open={open} error={error} />
      : <p className="repo-empty">Select a GitHub repository from the sidebar, or add one to the library, to read its README and see its build here.</p>}
  </section>;
}
