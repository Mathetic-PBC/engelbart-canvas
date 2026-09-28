import React from 'react';
import { createPortal } from 'react-dom';
import { useSandboxes } from '../ui/SandboxProgress.jsx';
import { GH } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import RepoReadme from './RepoReadme.jsx';
import BuildDetails, { RepoIdentity, RepoRuntimeStatus } from './BuildDetails.jsx';
import './repo-pane.css';

export { repoToolbarStatus } from './BuildDetails.jsx';

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
  const working = !!busy[run?.id || repo.id];
  const canSwitch = repositories.length > 1 && !!onSelect;
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsButton = React.useRef(null);
  const detailsId = React.useId();
  const closeDetails = () => setDetailsOpen(false);
  return <div className="repo-selected">
    <header className="repo-toolbar" aria-label={`Controls for ${repo.name}`}>
      <div className="repo-toolbar-repository">
        <RepoIdentity repo={repo} />
        {canSwitch && <RepoSwitcher repo={repo} repositories={repositories} onSelect={onSelect} />}
      </div>
      <div className="repo-toolbar-actions">
        <button ref={detailsButton} type="button" className="repo-toolbar-build" aria-haspopup="dialog" aria-expanded={detailsOpen} aria-controls={detailsId}
          onClick={() => setDetailsOpen(value => !value)}>Build</button>
        <RepoRuntimeStatus repo={repo} run={run} working={working} onOpen={() => open(run)} arrow />
      </div>
    </header>
    {error && !detailsOpen && <p role="alert" className="repo-error">{error}</p>}
    <div className="repo-body">
      <div className="repo-reading" inert={detailsOpen}><RepoReadme repo={repo} /></div>
      <BuildDetails id={detailsId} repo={repo} item={item} busy={busy} act={act} open={open} error={error}
        visible={detailsOpen} onClose={closeDetails} returnFocus={detailsButton} />
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
