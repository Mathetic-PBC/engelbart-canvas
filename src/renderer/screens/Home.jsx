import React from 'react';
import InlineField from '../ui/InlineField.jsx';

function relative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** All projects: a grid of cards, closed by a dashed "+ Project" card (2026-09-17). */
export default function Home({ projects, onCreateScreen, onOpen, onRename, error }) {
  const [renaming, setRenaming] = React.useState(null);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'auto', background: '#fff' }}>
      <div style={{ position: 'absolute', left: 24, top: 18, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</span>
        {projects.length > 0 && <span style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{projects.length} project{projects.length === 1 ? '' : 's'}</span>}
      </div>
      {error && <div style={{ position: 'absolute', left: 24, top: 52, font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
      <div style={{ position: 'absolute', inset: '64px 24px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, alignContent: 'start', overflow: 'auto' }}>
        {projects.map((project) => (
          <div key={project.id} className="hov-bd2" onClick={() => onOpen(project.id)} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px 16px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', transition: 'border-color 120ms', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              {renaming === project.id
                ? <InlineField initial={project.name} width="100%" placeholder="project name…" onCommit={(name) => { setRenaming(null); if (name !== project.name) onRename(project.id, name); }} onCancel={() => setRenaming(null)} style={{ padding: '4px 8px' }} />
                : (
                  <span
                    title="Click to rename"
                    onClick={(event) => { event.stopPropagation(); setRenaming(project.id); }}
                    style={{ font: '500 14.5px/1.5 var(--font-sans)', color: '#171717', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {project.name}
                  </span>
                )}
            </div>
            <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>
              {project.workspaceCount} workspace{project.workspaceCount === 1 ? '' : 's'}{project.lastEdited ? ` · edited ${relative(project.lastEdited)}` : ''}
            </span>
          </div>
        ))}
        <div
          role="button"
          tabIndex={0}
          className="hov-ink"
          onClick={onCreateScreen}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCreateScreen(); } }}
          data-new-project="1"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 79, padding: '14px 16px 16px', border: '1px dashed #c9c9c9', borderRadius: 8, background: 'transparent', cursor: 'pointer', font: '500 14.5px/1.5 var(--font-sans)', color: '#8f8f8f', transition: 'color 120ms, border-color 120ms', minWidth: 0 }}
        >
          + Project
        </div>
      </div>
    </div>
  );
}
