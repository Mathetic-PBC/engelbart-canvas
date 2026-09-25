import React from 'react';
import { KindGlyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';

export function Chevron({ open }) {
  return <svg className="rail-chevron" data-open={open ? '1' : '0'} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>;
}

function DeleteWorkspace({ workspace, onDelete }) {
  return <button type="button" className="workspace-delete rail-icon-action hov-del" data-delete-workspace={workspace.id} aria-label={`Delete workspace ${workspace.name}`} title={`Delete ${workspace.name}${workspace.children?.length ? ' and its nested workspaces' : ''}`} onClick={() => onDelete(workspace.id)}>×</button>;
}

function WorkspaceNode({ workspace, currentId, expanded, toggle, onSelect, onCreate, onDelete, onRename, flashId }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(workspace.name);
  const input = React.useRef(null);
  const cancelled = React.useRef(false);
  const children = workspace.children || [];
  const open = expanded.has(workspace.id);
  const selected = currentId === workspace.id;
  React.useEffect(() => { if (!editing) setDraft(workspace.name); }, [workspace.name, editing]);
  React.useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const commit = () => {
    if (!cancelled.current && draft.trim() && draft.trim() !== workspace.name) onRename(workspace, draft.trim());
    setEditing(false);
  };
  return (
    <li data-workspace-node={workspace.id}>
      <div className="workspace-row workspace-tree-row" data-workspace-row={workspace.id} data-active={selected ? '1' : '0'} style={flashId === workspace.id ? { animation: 'added 1600ms ease-out' } : undefined}>
        {children.length > 0
          ? <button type="button" className="workspace-toggle rail-icon-action" aria-label={`${open ? 'Collapse' : 'Expand'} ${workspace.name}`} aria-expanded={open} aria-controls={`workspace-children-${workspace.id}`} onClick={() => toggle(workspace.id)}><Chevron open={open} /></button>
          : <span className="workspace-toggle-space" />}
        <KindGlyph item={{ type: 'workspace' }} box="var(--rail-icon-size)" size="var(--rail-icon-size)" color={selected ? '#171717' : '#737373'} />
        {editing
          ? <input ref={input} className="workspace-tree-name workspace-tree-input" aria-label="Rename workspace" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setEditing(false); }
          }} />
          : <button type="button" className="workspace-tree-name" aria-current={selected ? 'page' : undefined} title={workspace.name} data-workspace-select={workspace.id} data-untitled={isUntitled(workspace.name) ? '1' : '0'} onClick={() => onSelect(workspace.id)} onDoubleClick={() => { cancelled.current = false; setEditing(true); }}>{workspace.name}</button>}
        {!editing && <span className="workspace-tree-actions">
          <button type="button" className="rail-icon-action" aria-label={`Add sub-workspace to ${workspace.name}`} title="Add sub-workspace" onClick={() => { toggle(workspace.id, true); onCreate(workspace.id); }}>+</button>
          <DeleteWorkspace workspace={workspace} onDelete={onDelete} />
        </span>}
      </div>
      {children.length > 0 && open && <ul className="workspace-children" id={`workspace-children-${workspace.id}`}>
        {children.map((child) => <WorkspaceNode key={child.id} workspace={child} {...{ currentId, expanded, toggle, onSelect, onCreate, onDelete, onRename, flashId }} />)}
      </ul>}
    </li>
  );
}

export default function WorkspaceTree({ workspaces, currentId, onSelect, onCreate, onDelete, onRename, flashId }) {
  const [expanded, setExpanded] = React.useState(() => new Set());
  const toggle = (id, show) => setExpanded((held) => {
    const next = new Set(held);
    if (show === true || !next.has(id)) next.add(id); else next.delete(id);
    return next;
  });
  return <nav aria-label="Sub-workspaces">
    <ul className="workspace-tree">
      {workspaces.map((workspace) => <WorkspaceNode key={workspace.id} workspace={workspace} {...{ currentId, expanded, toggle, onSelect, onCreate, onDelete, onRename, flashId }} />)}
    </ul>
    {workspaces.length === 0 && <p className="rail-empty">No sub-workspaces yet</p>}
  </nav>;
}
