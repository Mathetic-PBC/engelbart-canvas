import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KindGlyph } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { useWorkspaceRepository } from './useWorkspaceRepository.js';

const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 32, boxSizing: 'border-box', padding: '6px 8px', border: 0, borderRadius: 6, background: 'transparent', color: '#3d3d3d', cursor: 'pointer', textAlign: 'left', font: '400 14px/20px var(--font-sans)' };
const ellipsis = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rule = { height: 1, margin: '5px 8px', background: '#eaeaea' };

const repositoryDetails = repo => [repo.name, repo.directory].filter(Boolean).join('\n');

export function RepositoryMenu({ anchor, triggerRef, selection, onChanged, onOpenLink, onClose, defaultScope = false }) {
  const { value, busy, error, setError, projectId, workspaceId } = selection;
  const [projectDefault, setProjectDefault] = React.useState(defaultScope);
  const onConnect = async input => { if (await selection.connect(input, projectDefault)) { onClose(true); await onChanged?.(); } };
  const selectedId = projectDefault ? value?.defaultRepoId : value?.connected?.repoId || value?.repoId;
  const [ref, placed] = usePlaced(anchor, { gap: 4, cap: 360 });
  React.useEffect(() => {
    const away = event => { if (!ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(); };
    const key = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); onClose(true);
    };
    // A scrolling/resizing document should never leave its menu behind.
    const moved = event => { if (!ref.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [onClose, ref, triggerRef]);
  React.useEffect(() => {
    if (placed.visibility !== 'hidden') (ref.current?.querySelector('[aria-checked="true"]:not(:disabled)') || ref.current?.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
  }, [placed.visibility, ref, projectDefault]);
  const onKeyDown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const at = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  return createPortal(
    <div ref={ref} data-overlay="1" data-cover="1" data-repository-chooser="1" role="menu" aria-label={projectDefault ? 'Project default repository' : 'Workspace repository'} onKeyDown={onKeyDown}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !triggerRef.current?.contains(event.relatedTarget)) onClose(); }}
      style={{ ...placed, zIndex: 70, width: 320, maxWidth: 'calc(100vw - 24px)', padding: 6, boxSizing: 'border-box', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.08)' }}>
      <div style={{ padding: '6px 8px', font: '12px/1.5 var(--font-sans)', color: '#777' }}>Repository</div>
      {projectDefault && <div style={{ padding: '0 8px 6px', font: '12px/1.5 var(--font-sans)', color: '#777' }}>Project default — applies to inheriting workspaces</div>}
      {(value?.repositories || []).map(repo => <button key={repo.id} type="button" role="menuitemradio" aria-checked={selectedId === repo.id} data-repository-option={repo.id} className="hov-wash" disabled={busy} aria-description={repositoryDetails(repo)} onClick={() => onConnect({ repoId: repo.id })} style={rowStyle}>
        <KindGlyph kind="git" size={15} box={16} color="#737373" />
        <span style={{ flex: 1, ...ellipsis }}>{repo.name}</span>
        {selectedId === repo.id && <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flex: 'none', color: '#737373' }}><path d="m2 6 2.5 2.5L10 3" /></svg>}
      </button>)}
      {!!value?.repositories?.length && <div role="separator" style={rule} />}
      {!projectDefault && value?.connected && <button type="button" role="menuitem" className="hov-wash" onClick={() => { onClose(true); api.openWorkspaceRepository(projectId, workspaceId).catch(e => setError(errorMessage(e))); }} style={rowStyle}><KindGlyph kind="folder" size={15} box={16} color="#737373" />Open folder</button>}
      {!projectDefault && value?.connected?.githubUrl && onOpenLink && <button type="button" role="menuitem" className="hov-wash" onClick={() => { onClose(true); onOpenLink(value.connected.githubUrl); }} style={rowStyle}><KindGlyph kind="git" size={15} box={16} color="#737373" />Open on GitHub</button>}
      {projectDefault && <button type="button" role="menuitem" className="hov-wash" disabled={busy} onClick={() => onConnect({ createDefault: true })} style={rowStyle}>Create project code/</button>}
      <div role="separator" style={rule} />
      <button type="button" role="menuitem" data-project-default-action="1" disabled={busy} className="hov-wash" onClick={() => setProjectDefault(!projectDefault)} style={rowStyle}>{projectDefault ? 'Back to workspace connection' : 'Change project default…'}</button>
      {(error || value?.defaultIssue) && <div role="status" style={{ padding: '6px 8px', font: '12px/1.5 var(--font-sans)', color: '#8a4525' }}>{error || value.defaultIssue.message}</div>}
    </div>, document.body,
  );
}

export default function RepositoryRow({ projectId, workspaceId, revision, onChanged, onOpenLink, label = '', disabled = false }) {
  const selection = useWorkspaceRepository(projectId, workspaceId, revision);
  const { value, error, busy } = selection;
  const [anchor, setAnchor] = React.useState(null);
  const [defaultScope, setDefaultScope] = React.useState(false);
  const triggerRef = React.useRef(null);
  React.useEffect(() => setAnchor(null), [projectId, workspaceId]);
  const close = React.useCallback((focus = false) => { setAnchor(null); if (focus) triggerRef.current?.focus({ preventScroll: true }); }, []);
  const repo = value?.connected;
  return <div data-workspace-repository={workspaceId} style={{ marginTop: 8 }}>
    <button ref={triggerRef} type="button" data-repository-toggle="1" className="hov-wash" aria-label={repo ? `${label || 'Change repository'}: ${repo.name}` : 'Choose a repository'} aria-haspopup="menu" aria-expanded={!!anchor} disabled={busy || disabled}
      title={repo ? `${repo.directory}\nChange workspace repository` : 'Choose a workspace repository'}
      onClick={event => { setDefaultScope(false); setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect()); }}
      style={{ ...rowStyle, width: 'auto', maxWidth: 'calc(100% + 8px)', marginLeft: -8, background: anchor ? '#f5f5f5' : 'transparent' }}>
      <KindGlyph kind="git" size={15} box={16} color="#737373" />
      <span style={ellipsis}>{label ? `${label}: ` : ''}{repo?.name || (value ? 'Choose a repository' : 'Repository…')}</span>
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', color: '#8f8f8f' }}><path d="m2.5 4 2.5 2.5L7.5 4" /></svg>
    </button>
    {repo && <div data-repository-path="1" title={repo.directory} style={{ ...ellipsis, marginLeft: 18, font: '11.5px/16px var(--font-sans)', color: '#8f8f8f' }}>{repo.displayPath}</div>}
    {(error || value?.error) && <div role="status" style={{ marginTop: 4, font: '12px/1.5 var(--font-sans)', color: '#8a4525', overflowWrap: 'anywhere' }}>{error || value.error}</div>}
    {!anchor && value?.defaultIssue && <button type="button" onClick={event => { setDefaultScope(true); setAnchor(event.currentTarget.getBoundingClientRect()); }} style={{ ...rowStyle, fontSize: 12 }}>Choose a project default…</button>}
    {anchor && <RepositoryMenu anchor={anchor} triggerRef={triggerRef} selection={selection} onChanged={onChanged} onOpenLink={onOpenLink} onClose={close} defaultScope={defaultScope} />}
  </div>;
}
