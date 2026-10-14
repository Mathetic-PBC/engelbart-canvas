import React from 'react';
import * as I from '../ui/SidebarIcons.jsx';
import { Count, FitCrumb, Floating, text } from './SidebarPanels.jsx';
import { recentPages } from '../model/sidebar.js';

// The clock right of the sidebar's toggle (2026-10-13, the "Sidebar" project: "a small clock that shows the last ten (or
// less) opened notes or projects and clicking on one should essentially just open it in a new tab or go to that tab if it
// is already open"). Its list (model/sidebar.js recentPages): the top-level project's page first, then the projects, at any
// level, and the notes opened last, the only two things the middle shows. A project row carries its path under its name,
// cut from the front to "./" when it does not fit, and its count; a note has no path.

/**
 * `visits` [{ kind, id, at }]; `tree` model/sidebar.js indexTree's; `notes` Map of note id → row; `counts` id → summary;
 * `project` the top-level project; `onOpen({ kind, id })`.
 */
export default function RecentPages({ visits, tree, notes, counts, project, onOpen }) {
  const [anchor, setAnchor] = React.useState(null);
  const buttonRef = React.useRef(null);
  const close = React.useCallback(() => setAnchor(null), []);
  const pages = anchor ? recentPages({ visits, index: tree, notes }) : [];
  const toggle = () => {
    if (anchor) { setAnchor(null); return; }
    const r = buttonRef.current.getBoundingClientRect();
    setAnchor({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width });
  };
  const row = (page) => {
    const top = page.kind === 'top';
    const note = page.kind === 'note' ? notes.get(page.id) : null;
    const at = page.kind === 'project' ? tree.get(page.id) : null;
    const name = top ? project.name : note ? note.name : at ? at.node.name : '';
    const crumb = at ? [project.name, ...at.path.slice(0, -1).map((id) => tree.get(id).node.name)] : [];
    const icon = top ? <I.ProjectIcon size={17} /> : note ? <I.SourceIcon kind="note" size={17} /> : <I.WorkspaceIcon size={17} />;
    return (
      <div key={`${page.kind}:${page.id}`} role="button" tabIndex={-1} className="sb-prow" data-recent-page={`${page.kind}:${page.id}`} onClick={() => { close(); onOpen(page); }} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
        <span style={{ flex: 'none', width: 18, display: 'flex', justifyContent: 'center', color: '#4d4d4d' }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(14, '#171717'), lineHeight: 1.35 }}>{name}</span>
          {crumb.length > 0 && <FitCrumb parts={crumb} style={{ marginTop: 1, lineHeight: 1.35 }} />}
        </span>
        {at && <span style={{ flex: 'none', display: 'flex', alignItems: 'center' }}><Count summary={counts.get(page.id)} /></span>}
      </div>
    );
  };
  return (
    <>
      <button ref={buttonRef} type="button" className="sb-icon" data-recent-pages="1" data-no-drag="1" aria-label="Recent pages" title="Recent pages" aria-expanded={!!anchor} onClick={toggle}>
        <I.ClockIcon />
      </button>
      {anchor && (
        <Floating anchor={anchor} side="below" gap={4} width={330} cap={520} label="Recent pages" onClose={close} ignore="[data-recent-pages]" data-sb-panel="recent">
          <div style={{ flex: 'none', padding: '12px 14px 6px', ...text(13.5, '#171717', 500) }}>Recent pages</div>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: '0 6px 8px' }}>
            {pages.map(row)}
          </div>
        </Floating>
      )}
    </>
  );
}
