import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { looksAddable, searchRows } from '../model/rail.js';
import { flatWorkspaces } from '../model/nav.js';
import { agentGroups, archivedVersions, countWorkspaces, fitChildren, fitGroups, inboxEntries, pathTo, recentWorkspaces, sinceWords, sourceGroups, sourceKind, versionsOf } from '../model/sidebar.js';
import { connectInbox, dockLine } from '../model/connect.js';
import GithubPane from './GithubPane.jsx';
import { useAddRun } from './useAddRun.js';
import { usePlaced } from '../ui/usePlaced.js';
import { useBodies } from './useBodies.js';
import { carriesDrop, readDrop } from '../model/drop.js';
import TrashPanel from '../post-its/TrashPanel.jsx';
import { openSettings } from '../ui/Settings.jsx';
import { useBuildNotifications } from '../ui/SandboxNotifications.jsx';
import * as I from '../ui/SidebarIcons.jsx';
import {
  AgentsPanel, ConnectionsPanel, ContextMenu, Floating, InboxPanel, LibraryPanel, NewWorkspaceDialog, OVERLEAF_URL, PeekCard,
  ProjectMenu, RenameField, RowAction, SearchDialog, SourcesPanel, WorkspacesPanel, panelEdge, text, usePeek,
} from './SidebarPanels.jsx';

// The workspace sidebar (2026-10-07, Hudson's "Sidebar" workspace: Sidebar requirements, the hand-drawn mockup and its
// Order, Iconography, Switch Projects, and Linear's sidebar, its "Your teams" above all). From the top:
//   the head: the project's name, cut to fit, and its chevron, which opens its menu (Switch project, Rename); then
//     Settings and Search, the two icons right of it;
//   fixed rows, always there and never folded: Inbox (the agents that finished and wait for you, and the repository builds
//     the notification bell used to hold: while the sidebar shows, the bell is in here; its tray wears a dot),
//     Agents (running, waiting on you, done), Connections (GitHub, Zotero, Overleaf), Library (search it, add from it, open
//     it whole) and Add sources (a Note, a Sticky, a link or a path, files from disk, a repository from GitHub);
//   Workspaces, a section: the three worked in last, each with its sub-workspaces and archived versions under a chevron (children only, never
//     grandchildren), the one open here marked; a + on the title makes a workspace and a + on a row a sub-workspace in it,
//     each named in a small dialog. A fixed size: what does not fit is behind "More";
//   Your sources, a section, the largest: this workspace's things under two subsections, Starred and Notes, which are always
//     open (no chevrons: the whole section folds), the first few of each indented under its name, then "More"; and below
//     them the websites, code and files mixed in one list, each with its own icon. A star on any of them keeps it under Starred;
//   the foot: the stickies shown or hidden (it never makes or deletes one), and the trash when it holds something.
// Sections have no icons and fold on their chevrons, which always show; items in them have icons unless they are indented,
// when a faint line runs beside them instead. A section never runs past its share of the sidebar: "More" opens a panel
// beside the sidebar with everything (SidebarPanels.jsx). Hovering a source peeks at it; a double-click renames; a right
// click offers the rest. The sidebar folds away from the toggle in the title bar or ⌘\ (Workspace.jsx).

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const LINE = 30; // a line of the sidebar: a fixed row, a group, a source, a workspace, "More"
const GROUP_CAP = 5; // "the first few" of a group
const ICON = 18; // the icon's box in a row
const CHILD_ROOM = 3; // the sub-workspaces the Workspaces section shows, shared by its open rows
const WORKSPACE_ROWS = 3; // Hudson: "List last three edited workspaces"
const OPEN_KEY = 'engelbart.sidebar.open';
const SIZE = { row: 14.5, indent: 13.5, head: 13 }; // the text of a row, an indented row and a section's title

/* ------------------------------------------------------------------ marks */

// A project card's Delete (Home.jsx): a small can, drawn in the minus's line.
export const TRASH_MARK = (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block' }}>
    <path d="M2.5 4h11 M6.25 4V2.75a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75V4 M3.75 4l.7 9.1a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.7-9.1 M6.75 6.75v4.5 M9.25 6.75v4.5" />
  </svg>
);

const CIRCLE_PLUS = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M9 5.5v7 M5.5 9h7" />
  </svg>
);

const rectOf = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
const glyphItem = (result) => (result.kind === 'item' ? result.row : result.found);

/* ------------------------------------------------------- adding (shared) */

// A panel that hangs from something (the all-projects screen's "Add context"). Fixed to the window, so no scrolling cuts
// it off; under what it hangs from, or above it near the bottom (ui/usePlaced.js).
function Hanging({ anchor, width, gap = 6, cap, panelRef, zIndex = 70, style, children, ...rest }) {
  const [ref, placed] = usePlaced(anchor, { gap, cap });
  const setRef = (element) => { ref.current = element; if (panelRef) panelRef.current = element; };
  return createPortal(
    <div ref={setRef} data-overlay="1" {...rest} style={{ ...placed, width, zIndex, boxSizing: 'border-box', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}`, ...style }}>
      {children}
    </div>,
    document.body,
  );
}

function AddError({ children, style }) {
  return <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere', ...style }}>{children}</div>;
}

/** "Upload URL or path": Enter adds what is typed (`onEnter`), Escape closes (`onEscape`); red while it went wrong. */
function LinkField({ inputRef, value, busy, error, onChange, onEnter, onEscape }) {
  const border = error ? '#e70022' : value ? '#c9c9c9' : '#eaeaea';
  return (
    <div className="rail-field" style={{ display: 'flex', alignItems: 'center', boxSizing: 'border-box', padding: '0 10px', margin: '4px 0', background: '#fafafa', border: `1px solid ${border}`, borderRadius: 6, transition: 'border-color 120ms' }}>
      <input
        ref={inputRef}
        value={value}
        readOnly={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); onEnter(); }
          else if (event.key === 'Escape' && onEscape) { event.preventDefault(); event.stopPropagation(); onEscape(); }
        }}
        placeholder="Upload URL or path"
        aria-label="Link or path"
        spellCheck={false}
        style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
      />
    </div>
  );
}

/** The field's "Add to library", at the right; `disabled` (nothing typed yet) shows faint. */
function LinkAddButton({ busy, disabled = false, onClick }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 0 0' }}>
      <button type="button" className="hov-dim" disabled={busy || disabled} onClick={onClick} style={{ padding: '7px 12px', border: 0, borderRadius: 6, background: '#171717', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#fff', ...(disabled ? { opacity: 0.35, cursor: 'default' } : {}) }}>Add to library</button>
    </div>
  );
}

/**
 * What adding offers (Sidebar.dc.html's "+ Add context", 2026-09-23; the all-projects screen's library uses it too): with
 * `search`, a search over the library first, whose rows bring what they find in; a new Note, Sticky or Sub-Workspace when
 * their handlers are given; then a link or a path, files from disk, or a repository from GitHub (GithubPane), each a new
 * row of the library, and of this workspace when there is one. The sidebar's "Add sources" (2026-10-07) has a Note and a
 * Sticky, no search, no Sub-Workspace and no rule under them; its link or path comes first (2026-10-08), above the Note. `onDone` closes it once something was added; `onBusy` says
 * when it is at work (it cannot close then).
 */
function AddMenuBody({ projectId = null, search = true, onAdd, onPickDisk, onNewNote, onNewSticky, onNewChild, onPickRepo, onSearchPick, library, inRail, onDone, onBusy }) {
  const [view, setView] = React.useState('menu'); // 'menu' | 'github' (GithubPane: signing in, then the repositories)
  const [value, setValue] = React.useState('');
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null); // { query, result }: what the main process said an address or a path is
  const searchRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const { busy, error, setError, run } = useAddRun(onDone);
  React.useEffect(() => { if (onBusy) onBusy(busy); }, [busy, onBusy]);
  // The first field takes the keyboard as soon as the menu shows, so a link can be pasted straight away. Not in the ref:
  // the panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes none.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const naming = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-rename]');
      const into = search ? searchRef.current : fieldRef.current;
      if (!naming && into) into.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [search]);

  const commit = () => { const input = value.trim(); if (input && !busy) void run(async () => { await onAdd(input); return []; }); };
  const make = (work) => { if (!busy) void run(async () => { await work(); return []; }); };
  const addable = looksAddable(value);

  // The search: the rows model/rail.js searchRows gives the sidebar's search, listed in the menu itself.
  const typed = q.trim();
  const typedAddable = search && looksAddable(typed);
  React.useEffect(() => {
    if (!typedAddable) return undefined;
    let alive = true;
    const wait = setTimeout(() => {
      api.lookupLibraryItem(typed)
        .then((result) => { if (alive) setFound({ query: typed, result }); })
        .catch((failure) => { if (alive) setFound({ query: typed, result: { row: null, found: null, error: errorMessage(failure) } }); });
    }, 120);
    return () => { alive = false; clearTimeout(wait); };
  }, [typedAddable, typed]);
  const answer = typedAddable && found && found.query === typed ? found.result : undefined;
  const bodies = useBodies(projectId, search, { all: !projectId }); // what things say, matched too (MATH-29); the home page's library has no project, so it reads the whole library's
  const results = search && typed ? searchRows({ query: typed, library, inRail, found: answer, bodies }) : [];
  const at = results.length ? Math.min(idx, results.length - 1) : -1;
  const pickResult = (result) => { if (result && !busy) void run(async () => { await onSearchPick(result, typed); return []; }); };
  const onSearchKey = (event) => {
    const n = results.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pickResult(results[at]); }
    else if (event.key === 'Escape' && q) { event.preventDefault(); event.stopPropagation(); setQ(''); setIdx(0); }
  };
  const searchProblem = (answer && answer.error) || '';
  const menuRow = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' };
  const menuText = { flex: 1, minWidth: 0, font: '14px/1.5 var(--font-sans)', color: '#171717' };

  if (view === 'github') {
    return (
      <>
        <GithubPane library={library} inRail={inRail} busy={busy} onBack={() => { setView('menu'); setError(''); }} onPick={(entry) => make(() => onPickRepo(entry))} />
        {error && <AddError>{error}</AddError>}
      </>
    );
  }
  return (
    <>
      {search && (
        <div className="rail-field" data-add-search="1" style={{ display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', padding: '0 10px', marginBottom: 6, border: `1px solid ${q ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, background: '#fff', transition: 'border-color 120ms' }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
          <input
            ref={searchRef}
            value={q}
            readOnly={busy}
            onChange={(event) => { setQ(event.target.value); setIdx(0); setError(''); }}
            onKeyDown={onSearchKey}
            placeholder="Search"
            aria-label="Search the library"
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
          />
          {q && <button type="button" className="hov-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQ(''); setIdx(0); if (searchRef.current) searchRef.current.focus(); }} aria-label="Clear" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>}
        </div>
      )}
      {typed ? (
        <>
          {results.map((result, i) => (
            <button key={result.key} type="button" data-add-result={result.key} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => pickResult(result)} onMouseMove={() => { if (idx !== i) setIdx(i); }} style={{ ...menuRow, background: i === at ? '#f2f2f2' : 'transparent' }}>
              <Glyph item={glyphItem(result)} />
              <span style={{ ...menuText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.name}</span>
              {/^new\b/.test(result.tag)
                ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>
                : <span style={{ flex: 'none', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{result.tag}</span>}
            </button>
          ))}
          {(searchProblem || error) && <AddError>{searchProblem || error}</AddError>}
        </>
      ) : (
        <>
          {!search && (
            <>
              <LinkField inputRef={fieldRef} value={value} busy={busy} error={error} onChange={(next) => { setValue(next); setError(''); }} onEnter={commit} />
              {error && <AddError>{error}</AddError>}
              {addable && <LinkAddButton busy={busy} onClick={commit} />}
            </>
          )}
          {onNewNote && (
            <button type="button" className="hov-wash" data-new="note" disabled={busy} onClick={() => make(onNewNote)} style={menuRow}>
              <I.NoteIcon size={16} style={{ color: '#171717' }} />
              <span style={menuText}>Note</span>
            </button>
          )}
          {onNewSticky && (
            <button type="button" className="hov-wash" data-new="sticky" disabled={busy} onClick={() => make(onNewSticky)} style={{ ...menuRow, marginTop: 2 }}>
              <I.StickyIcon size={16} style={{ color: '#171717' }} />
              <span style={menuText}>Sticky</span>
            </button>
          )}
          {onNewChild && (
            <button type="button" className="hov-wash" data-new="workspace" disabled={busy} onClick={() => make(onNewChild)} style={{ ...menuRow, marginTop: 2 }}>
              <I.WorkspaceIcon size={16} style={{ color: '#171717' }} />
              <span style={menuText}>Sub-Workspace</span>
            </button>
          )}
          {search && (onNewNote || onNewChild) && <div style={{ height: 1, margin: '6px 0 8px', background: '#eaeaea' }} />}
          {search && (
            <>
              <LinkField inputRef={fieldRef} value={value} busy={busy} error={error} onChange={(next) => { setValue(next); setError(''); }} onEnter={commit} />
              {error && <AddError>{error}</AddError>}
            </>
          )}
          <button type="button" className="hov-wash" disabled={busy} onClick={() => run(onPickDisk)} style={menuRow}>
            <I.FolderIcon size={16} style={{ color: '#171717' }} />
            <span style={menuText}>Choose from disk…</span>
          </button>
          <button type="button" className="hov-wash" data-add-github="1" disabled={busy} onClick={() => { setError(''); setView('github'); }} style={{ ...menuRow, marginTop: 2 }}>
            <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><span style={{ display: 'flex', width: 14, height: 14 }}>{KIND.git.glyph}</span></span>
            <span style={menuText}>Add from GitHub…</span>
          </button>
          {search && addable && <LinkAddButton busy={busy} onClick={commit} />}
        </>
      )}
    </>
  );
}

/** The all-projects screen's "Add context" (Home.jsx): its row, and the menu (AddMenuBody, with its search) hanging under it. */
export function AddToLibrary({ projectId = null, onAdd, onPickDisk, onNewNote, onNewChild, onPickRepo, onSearchPick, library, inRail, onOpenChange, shut }) {
  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const rowRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const busy = React.useRef(false);
  const onBusy = React.useCallback((value) => { busy.current = value; }, []);
  React.useEffect(() => { if (onOpenChange) onOpenChange(open); }, [open, onOpenChange]);
  const hide = React.useCallback(() => setOpen(false), []);
  React.useEffect(() => { if (shut && open && !busy.current) hide(); }, [shut]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    if (open) { if (!busy.current) hide(); return; }
    if (rowRef.current) setAnchor(rectOf(rowRef.current));
    setOpen(true);
  };
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (busy.current) return; if (![rowRef, menuRef].some((ref) => ref.current && ref.current.contains(event.target))) hide(); };
    const key = (event) => { if (event.key === 'Escape' && !busy.current) { event.preventDefault(); event.stopPropagation(); hide(); } };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', key, true); };
  }, [open, hide]);
  return (
    <div data-rail-add="1" style={{ flex: 'none', position: 'relative' }}>
      <button ref={rowRef} type="button" className="hov-wash" onClick={toggle} aria-label="Add context" aria-expanded={open} style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', padding: '6px 10px 8px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', color: open ? '#171717' : '#8f8f8f', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms, color 120ms' }}>
        {CIRCLE_PLUS}
        <span style={{ marginLeft: 9, font: '14px/1.5 var(--font-sans)' }}>Add context</span>
      </button>
      {open && anchor && (
        <Hanging anchor={anchor} width={anchor.width} gap={4} panelRef={menuRef} data-rail-add-menu="1" style={{ padding: 10 }}>
          <AddMenuBody projectId={projectId} search onAdd={onAdd} onPickDisk={onPickDisk} onNewNote={onNewNote} onNewChild={onNewChild} onPickRepo={onPickRepo} onSearchPick={onSearchPick} library={library} inRail={inRail} onDone={hide} onBusy={onBusy} />
        </Hanging>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the pieces */

// Which parts are folded open, kept for the next time the app opens (a convenience of this machine: storage may refuse).
// Keys: `section:<key>`, `ws:<id>` (a workspace row). A part never touched takes its default.
function readOpen() {
  try { const saved = JSON.parse(window.localStorage.getItem(OPEN_KEY) || '{}'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
}
function useOpen() {
  const [opened, setOpened] = React.useState(readOpen);
  React.useEffect(() => { try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(opened)); } catch { /* not remembered */ } }, [opened]);
  return [opened, setOpened];
}

// A press on a row does not focus it (the keyboard's ring would show on it once Escape closed what it opened); a name
// being typed in it keeps its caret.
const keepFocus = (event) => { if (!(event.target.closest && event.target.closest('input'))) event.preventDefault(); };

/** The chevron that folds (Iconography: down while folded, turned up while open), always shown. */
function Chevron({ open, onClick, label }) {
  const mark = <I.ChevronDown size={13} stroke={2.4} style={{ color: '#9b9b9b', transform: open ? 'rotate(180deg)' : 'none', transition: `transform 160ms ${EASE}` }} />;
  if (!onClick) return <span aria-hidden="true" style={{ flex: 'none', display: 'flex', marginLeft: 5 }}>{mark}</span>;
  return (
    <button type="button" className="sb-chevron" aria-label={label} aria-expanded={open} onClick={(event) => { event.stopPropagation(); onClick(event); }} onDoubleClick={(event) => event.stopPropagation()} style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginLeft: 2, padding: 0, border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>
      {mark}
    </button>
  );
}

/**
 * A line of the sidebar: its icon (none when indented), its name, then the chevron right after it, and on the right what
 * it shows (`right`) or offers on hover (`hover`). `active`: where you are. A div, so the buttons it holds can be buttons.
 */
function Row({ icon, label, title, indent = false, active = false, faint = false, height = LINE, chevron = null, right = null, hover = null, flash = false, onClick, onDoubleClick, onContextMenu, onMouseEnter, onMouseLeave, expanded, style, ...rest }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="sb-row"
      data-active={active ? '1' : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
      onMouseDown={keepFocus}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget && onClick) { event.preventDefault(); onClick(event); } }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      {...rest}
      style={{ flex: 'none', position: 'relative', display: 'flex', alignItems: 'center', height, boxSizing: 'border-box', padding: indent ? '0 6px 0 10px' : '0 6px 0 8px', borderRadius: 6, cursor: 'pointer', outline: 'none', animation: flash ? 'added 1600ms ease-out' : undefined, ...style }}
    >
      {!indent && icon && <span style={{ flex: 'none', width: ICON, height: ICON, marginRight: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? '#171717' : '#5c5c5c' }}>{icon}</span>}
      <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(indent ? SIZE.indent : SIZE.row, faint ? '#9b9b9b' : active ? '#171717' : indent ? '#4d4d4d' : '#262626', active ? 500 : 400), lineHeight: `${height}px` }}>{label}</span>
      {chevron}
      <span style={{ flex: '1 0 6px' }} />
      {hover && <span className="sb-hover" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 1 }}>{hover}</span>}
      {right && <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>{right}</span>}
    </div>
  );
}

/**
 * The children of a row, indented, a faint line running beside them under the row's icon (Linear's sub-teams); their
 * names line up with the row's, and their wash starts after the line.
 */
function Indented({ children, ...rest }) {
  return (
    <div {...rest} style={{ position: 'relative', display: 'flex', flexDirection: 'column', paddingLeft: 24 }}>
      <span aria-hidden="true" style={{ position: 'absolute', left: 15.5, top: 2, bottom: 2, width: 1, background: '#e3e3e3' }} />
      {children}
    </div>
  );
}

/** "··· More" (Linear's): what a section or a group had no room for, in a panel beside the sidebar. */
function MoreRow({ indent = false, onClick, open = false, ...rest }) {
  return (
    <div role="button" tabIndex={0} className="sb-row sb-more" data-active={open ? '1' : undefined} onClick={onClick} onMouseDown={keepFocus} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(event); } }} {...rest} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: indent ? 6 : 10, height: LINE, boxSizing: 'border-box', padding: indent ? '0 6px 0 10px' : '0 6px 0 8px', borderRadius: 6, cursor: 'pointer', outline: 'none', color: '#8f8f8f' }}>
      <I.DotsIcon size={ICON} />
      <span style={text(indent ? SIZE.indent : SIZE.row, '#8f8f8f')}>More</span>
    </div>
  );
}

/** A section's title (Linear's "Your teams"): no icon, quiet, its chevron after it; `plus` puts a + at its right. */
function SectionHead({ label, open, onToggle, plus = null, ...rest }) {
  return (
    <div className="sb-section-head" {...rest} style={{ flex: 'none', display: 'flex', alignItems: 'center', height: LINE, padding: '0 6px 0 8px', marginTop: 12 }}>
      <button type="button" className="sb-section-toggle" aria-expanded={open} onClick={onToggle} style={{ display: 'flex', alignItems: 'center', minWidth: 0, padding: '2px 0', border: 0, background: 'transparent', cursor: 'pointer' }}>
        <span style={{ ...text(SIZE.head, '#8f8f8f', 500), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <Chevron open={open} />
      </button>
      <span style={{ flex: 1 }} />
      {plus}
    </div>
  );
}

const GROUP_ICON = { starred: <I.StarIcon />, notes: <I.NoteIcon /> };
const GROUP_EMPTY = { starred: 'Star a source to keep it here', notes: 'No notes yet' };
// A mixed source's own icon: a link for a website, code for a repository, a folder for files; a note or a star keeps its own.
const SOURCE_ICON = { notes: <I.NoteIcon />, websites: <I.LinkIcon />, code: <I.CodeIcon />, files: <I.FolderIcon /> };

/** The rows to show of a group: its first `n`, with the one open in front among them when it would be cut. */
function visibleRows(rows, n, activeId) {
  const shown = rows.slice(0, n);
  if (!activeId || !n || shown.some((row) => row.id === activeId)) return shown;
  const active = rows.find((row) => row.id === activeId);
  return active ? [...shown.slice(0, n - 1), active] : shown;
}

/** How many lines fit in an element's height. */
function useLines(ref, line) {
  const [lines, setLines] = React.useState(40);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setLines(Math.max(0, Math.floor(el.clientHeight / line)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [ref, line]);
  return lines;
}

/* ------------------------------------------------------------ the sidebar */

export default function Rail({
  width, hidden = false, // the sidebar folded away, or the document's full screen (MATH-23): out of sight, kept as it is
  project, onOpenProject, onNewProject, onAllProjects, onRenameProject,
  roots = [], hereId = null, recent = [], agents = [], builds = [],
  onSelectWorkspace, onCreateWorkspace, onRenameWorkspace, onDeleteWorkspace, onOpenVersion, onSeenAll,
  connectSessions = [], onOpenConnect = () => {},
  rows = [], activeRowId = null, flashId = null, starred = [], onStar,
  library = [], inRail = () => false, onOpenRow, onRenameRow, onRemoveRow, onLinkRow, onOpenHeld, onDropItems,
  onAddInput, onPickDisk, onNewNote, onNewSticky, onPickRepo, onOpenLink,
  postItsHidden = false, onTogglePostIts, postItTrash = null, workspaceTrash = null, trashFull = false, postItDrag = null, trashRef,
}) {
  const [opened, setOpened] = useOpen();
  const [panel, setPanel] = React.useState(null); // { kind, anchor, key? }: one beside the sidebar at a time
  const [searching, setSearching] = React.useState(false);
  const [creating, setCreating] = React.useState(null); // { parent } while a new workspace is being named
  const [menu, setMenu] = React.useState(null); // { at, items }: a right click's
  const [renaming, setRenaming] = React.useState(null); // 'project', or the id of a workspace or a source being renamed
  const [dropping, setDropping] = React.useState(false);
  const asideRef = React.useRef(null);
  const sourcesRef = React.useRef(null);
  const addBusy = React.useRef(false);
  const peek = usePeek();

  const starredSet = React.useMemo(() => new Set(starred), [starred]);
  const isOpen = (key, fallback) => (key in opened ? !!opened[key] : fallback);
  const toggleOpen = (key, fallback) => setOpened((now) => ({ ...now, [key]: !(key in now ? now[key] : fallback) }));

  // Panels hang beside the sidebar at the height of the row that opened them; a second press on it closes it.
  const anchorOf = (element) => {
    const row = element.getBoundingClientRect();
    const side = asideRef.current ? asideRef.current.getBoundingClientRect() : row;
    return { left: row.left, right: side.right, top: row.top, bottom: row.bottom, width: row.width };
  };
  const toggle = (kind, element, key = null) => {
    peek.drop();
    setPanel((now) => (now && now.kind === kind && now.key === key ? null : { kind, key, anchor: kind === 'project' ? rectOf(element) : anchorOf(element) }));
  };
  const close = React.useCallback(() => setPanel(null), []);
  const closeAdd = React.useCallback(() => { if (!addBusy.current) setPanel(null); }, []);
  const onAddBusy = React.useCallback((value) => { addBusy.current = value; }, []);
  const ignore = (kind, key) => `[data-sb-trigger="${key ? `${kind}:${key}` : kind}"]`;

  /* ---------------------------------------------------------- workspaces */
  const nameOf = React.useMemo(() => {
    const names = new Map(flatWorkspaces(roots).map((workspace) => [workspace.id, workspace.name]));
    return (id) => names.get(id) || '';
  }, [roots]);
  const herePath = React.useMemo(() => pathTo(roots, hereId), [roots, hereId]);
  const ranked = React.useMemo(() => recentWorkspaces({ roots, recent, hereId, count: WORKSPACE_ROWS }), [roots, recent, hereId]);
  // A row starts open when it holds the workspace open here (itself or one nested in it), so its sub-workspaces show.
  // A workspace's archived versions sit under it after its sub-workspaces, as indented rows of their own.
  const nestedCount = (entry) => entry.children.length + versionsOf(entry.node).length;
  const wsOpenByDefault = (entry) => entry.holdsHere && nestedCount(entry) > 0;
  const wsOpen = (entry) => isOpen(`ws:${entry.node.id}`, wsOpenByDefault(entry));
  const childLines = fitChildren(ranked.map((entry) => ({ id: entry.node.id, open: wsOpen(entry), count: nestedCount(entry) })), CHILD_ROOM);
  const childrenOf = (entry) => {
    const n = childLines[entry.node.id] || 0;
    const onWay = entry.holdsHere ? herePath[1] : null; // the child on the way to the workspace open here, shown first
    const list = onWay ? [entry.children.find((child) => child.node.id === onWay.id), ...entry.children.filter((child) => child.node.id !== onWay.id)].filter(Boolean) : entry.children;
    const nested = [...list.map((child) => ({ type: 'workspace', child })), ...versionsOf(entry.node).map((version) => ({ type: 'version', version }))];
    return nested.slice(0, n);
  };
  const shownCount = ranked.reduce((n, entry) => n + 1 + (wsOpen(entry) ? childrenOf(entry).length : 0), 0);
  const versions = React.useMemo(() => archivedVersions(roots), [roots]);
  const wsMore = countWorkspaces(roots) + versions.length > shownCount;
  const wsSection = isOpen('section:workspaces', true);

  const workspaceMenu = (event, node) => {
    event.preventDefault();
    setMenu({ at: { x: event.clientX, y: event.clientY }, items: [
      { label: 'Open', icon: <I.WorkspaceIcon size={14} />, onClick: () => onSelectWorkspace(node.id) },
      { label: 'Add sub-workspace', icon: <I.PlusIcon size={14} />, onClick: () => setCreating({ parent: node }) },
      { label: 'Rename', icon: <I.PencilIcon size={14} />, onClick: () => setRenaming(node.id) },
      { separator: true },
      { label: 'Delete', icon: <I.TrashIcon size={14} />, danger: true, onClick: () => onDeleteWorkspace(node.id) },
    ] });
  };

  /* --------------------------------------------------------- your sources */
  const groups = React.useMemo(() => sourceGroups(rows, starred, library), [rows, starred, library]);
  const srcSection = isOpen('section:sources', true);
  const lines = useLines(sourcesRef, LINE);
  const fit = fitGroups(groups.map((group) => ({ key: group.key, header: group.header, count: group.rows.length })), lines, { cap: GROUP_CAP });
  // A row that just arrived opens the section, once, so it is seen arriving.
  const shownFlash = React.useRef(null);
  React.useEffect(() => {
    if (!flashId || shownFlash.current === flashId) return;
    const home = groups.find((group) => group.key !== 'starred' && group.rows.some((row) => row.id === flashId));
    if (!home) return;
    shownFlash.current = flashId;
    setOpened((now) => ({ ...now, 'section:sources': true }));
  }, [flashId, groups, setOpened]);

  const sourceMenu = (event, row) => {
    event.preventDefault();
    peek.drop();
    const on = starredSet.has(row.id);
    setMenu({ at: { x: event.clientX, y: event.clientY }, items: [
      { label: 'Open', icon: <I.ExternalIcon size={14} />, onClick: () => onOpenRow(row) },
      { label: on ? 'Unstar' : 'Star', icon: <I.StarIcon size={14} filled={on} />, onClick: () => onStar(row, !on) },
      { label: 'Rename', icon: <I.PencilIcon size={14} />, onClick: () => setRenaming(row.id) },
      ...(inRail(row.id) ? [{ separator: true }, { label: 'Remove from workspace', icon: <I.MinusCircleIcon size={14} />, onClick: () => onRemoveRow(row) }] : []),
    ] });
  };

  // Files from Finder, a picture or a link from a browser, dropped on Your sources (MATH-19): each a row of the library,
  // linked here.
  const dragOver = (event) => { if (!onDropItems || !carriesDrop(event)) return; event.preventDefault(); setDropping(true); };
  const dragLeave = (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false); };
  const drop = (event) => {
    if (!onDropItems || !carriesDrop(event)) return;
    event.preventDefault();
    setDropping(false);
    const items = readDrop(event.dataTransfer, api.pathForFile); // now: the drop's data is gone once the event is over
    if (items.length) void onDropItems(items);
  };

  /* --------------------------------------------------------------- agents */
  const inbox = React.useMemo(() => inboxEntries(agents, project.id), [agents, project.id]);
  // Connect your library's notes (2026-10-08): it needs you, or it is done. They lead the Inbox; a press opens its popup.
  const connectNotes = React.useMemo(() => connectInbox(connectSessions, project.id), [connectSessions, project.id]);
  const inboxAll = React.useMemo(() => [...connectNotes, ...inbox], [connectNotes, inbox]);
  const { unread: unreadBuilds } = useBuildNotifications(); // the bell's, now in the Inbox
  const inboxCount = inboxAll.length + unreadBuilds;
  // A workspace where an agent finished and waits for you, or one nested in it, wears a blue dot (the Inbox says what).
  const waitsIn = React.useMemo(() => new Set(inbox.map((entry) => entry.workspaceId).filter(Boolean)), [inbox]);
  const waits = (node) => waitsIn.has(node.id) || (node.children || []).some(waits);
  const waitDot = (node) => (waitsIn.size && waits(node) ? <span className="sb-dot" data-sb-waiting={node.id} title="An agent is waiting for you here" /> : null);
  const agentList = React.useMemo(() => agentGroups({ agents, builds, projectId: project.id }), [agents, builds, project.id]);
  const goAgent = (entry) => {
    close();
    if (entry.task && entry.task.version && entry.task.workspaceId) onOpenVersion({ workspaceId: entry.task.workspaceId, file: entry.task.version.file, title: entry.task.version.title });
    else if (entry.workspaceId) onSelectWorkspace(entry.workspaceId);
  };

  const stickiesDrag = !!(postItDrag && postItDrag.active);
  const sources = (
    <section
      data-sb-section="sources"
      data-dropping={dropping ? '1' : undefined}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      style={{ flex: '1 1 0', minHeight: LINE * 3, display: 'flex', flexDirection: 'column', borderRadius: 8, boxShadow: dropping ? 'inset 0 0 0 2px #c9c9c9' : 'none', transition: 'box-shadow 120ms' }}
    >
      <SectionHead label="Your sources" open={srcSection} onToggle={() => toggleOpen('section:sources', true)} data-sb-head="sources" />
      <div ref={sourcesRef} data-sb-sources-body="1" onScroll={peek.drop} style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: srcSection && !fit.fits ? 'auto' : 'hidden' }}>
        {srcSection && groups.map((group) => {
          const headed = group.header !== false; // Starred and Notes: a name, always open; the rest are one list, no name
          const shown = visibleRows(group.rows, fit.shown[group.key], activeRowId);
          const panelOpen = panel && panel.kind === 'sources' && panel.key === group.key;
          const rowsOf = (indent) => (
            <>
              {shown.map((row) => {
                const on = starredSet.has(row.id);
                return (
                  <Row
                    key={row.id}
                    data-sb-source={row.id}
                    indent={indent}
                    icon={row.type === 'md' && sourceKind(row) === 'files' ? <I.FileIcon /> : SOURCE_ICON[sourceKind(row)]}
                    label={renaming === row.id ? <RenameField initial={row.name} onDone={(name) => { setRenaming(null); if (name) onRenameRow(row, name); }} style={text(indent ? SIZE.indent : SIZE.row)} /> : row.name}
                    title={row.name}
                    faint={isUntitled(row.name)}
                    active={row.id === activeRowId}
                    flash={flashId === row.id}
                    onClick={(event) => { if (renaming === row.id) return; peek.drop(); onOpenRow(row, event); }}
                    onDoubleClick={() => { peek.drop(); setRenaming(row.id); }}
                    onContextMenu={(event) => sourceMenu(event, row)}
                    onMouseEnter={(event) => { if (renaming !== row.id) peek.open(row, event.currentTarget, panelEdge(event.currentTarget)); }}
                    onMouseLeave={peek.close}
                    hover={renaming === row.id ? null : (
                      <>
                        <RowAction label={on ? 'Unstar' : 'Star'} shown={on && group.key !== 'starred'} onClick={() => onStar(row, !on)} data-sb-star={row.id}><I.StarIcon size={15} filled={on} /></RowAction>
                        {inRail(row.id) && <RowAction label={`Take ${row.name} out of this workspace`} onClick={() => { peek.drop(); onRemoveRow(row); }} data-sb-remove={row.id}><I.MinusCircleIcon size={15} /></RowAction>}
                      </>
                    )}
                  />
                );
              })}
              {fit.more[group.key] && <MoreRow indent={indent} open={panelOpen} data-sb-trigger={`sources:${group.key}`} data-sb-more={group.key} onClick={(event) => toggle('sources', event.currentTarget, group.key)} />}
            </>
          );
          if (!headed) return group.rows.length > 0 ? <React.Fragment key={group.key}><div data-sb-group-rows={group.key} style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>{rowsOf(false)}</div></React.Fragment> : null;
          return (
            <React.Fragment key={group.key}>
              <div data-sb-group={group.key} style={{ flex: 'none', display: 'flex', alignItems: 'center', height: LINE, boxSizing: 'border-box', padding: '0 6px 0 8px' }}>
                <span style={{ flex: 'none', width: ICON, height: ICON, marginRight: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5c5c5c' }}>{GROUP_ICON[group.key]}</span>
                <span style={{ ...text(SIZE.row, '#262626', 500), lineHeight: `${LINE}px` }}>{group.label}</span>
              </div>
              {group.rows.length === 0
                ? <Indented><div data-sb-empty={group.key} style={{ height: LINE, display: 'flex', alignItems: 'center', paddingLeft: 10, ...text(SIZE.indent - 0.5, '#a3a3a3') }}>{GROUP_EMPTY[group.key]}</div></Indented>
                : (shown.length > 0 || fit.more[group.key]) && <Indented data-sb-group-rows={group.key}>{rowsOf(true)}</Indented>}
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );

  return (
    <aside ref={asideRef} aria-label="Sidebar" data-sidebar="1" style={{ flex: 'none', width, minHeight: 0, display: hidden ? 'none' : 'flex', flexDirection: 'column', position: 'relative', zIndex: 7, boxSizing: 'border-box', padding: '0 8px', background: '#fafafa' }}>
      {/* The head: the project, then Settings and Search. */}
      <div data-sb-head="project" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, height: 44, padding: '4px 0 2px' }}>
        {renaming === 'project'
          ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', height: 32, padding: '0 8px', border: '1px solid #c9c9c9', borderRadius: 6, background: '#fff' }}>
              <RenameField initial={project.name} onDone={(name) => { setRenaming(null); if (name) onRenameProject(name); }} style={text(15, '#171717', 600)} />
            </div>
          )
          : (
            <button
              type="button"
              className="sb-project"
              data-sb-trigger="project"
              aria-haspopup="menu"
              aria-expanded={!!(panel && panel.kind === 'project')}
              title={project.name}
              onClick={(event) => toggle('project', event.currentTarget)}
              style={{ flex: '0 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 8px', border: 0, borderRadius: 6, background: panel && panel.kind === 'project' ? '#ececec' : 'transparent', cursor: 'pointer' }}
            >
              <span data-sb-project-name="1" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(15, '#171717', 600) }}>{project.name}</span>
              <I.ChevronDown size={14} stroke={2.4} style={{ color: '#8f8f8f' }} />
            </button>
          )}
        <span style={{ flex: '1 0 4px' }} />
        <button type="button" className="sb-icon" title="Settings" aria-label="Settings" data-sb-settings="1" onClick={() => openSettings()}><I.GearIcon /></button>
        <button type="button" className="sb-icon" title="Search" aria-label="Search" data-sb-search="1" aria-expanded={searching} onClick={() => { close(); setSearching(true); }}><I.SearchIcon /></button>
      </div>

      {/* Fixed in place: buttons, never folded. */}
      <nav aria-label="Places" data-sb-fixed="1" style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 4 }}>
        <Row height={LINE} data-sb-trigger="inbox" data-sb-fixed-row="inbox" icon={<I.InboxIcon dot={inboxCount > 0} />} label="Inbox" active={panel && panel.kind === 'inbox'} right={inboxCount ? <span data-sb-count="inbox" style={text(13, '#8f8f8f')}>{inboxCount}</span> : null} onClick={(event) => toggle('inbox', event.currentTarget)} />
        <Row height={LINE} data-sb-trigger="agents" data-sb-fixed-row="agents" icon={<I.AgentsIcon />} label="Agents" active={panel && panel.kind === 'agents'} right={agentList.running.length ? <span data-sb-count="agents" style={{ display: 'flex', alignItems: 'center', gap: 6, ...text(13, '#8f8f8f') }}><span className="sb-pulse" aria-hidden="true" />{agentList.running.length}</span> : null} onClick={(event) => toggle('agents', event.currentTarget)} />
        <Row height={LINE} data-sb-trigger="connections" data-sb-fixed-row="connections" icon={<I.ConnectionsIcon />} label="Connections" active={panel && panel.kind === 'connections'} onClick={(event) => toggle('connections', event.currentTarget)} />
        <Row height={LINE} data-sb-trigger="library" data-sb-fixed-row="library" icon={<I.LibraryIcon />} label="Library" active={panel && panel.kind === 'library'} onClick={(event) => toggle('library', event.currentTarget)} />
        <Row height={LINE} data-sb-trigger="add" data-sb-fixed-row="add" icon={<I.AddIcon />} label="Add sources" active={panel && panel.kind === 'add'} onClick={(event) => toggle('add', event.currentTarget)} />
      </nav>

      {/* Workspaces: the three worked in last, each with its sub-workspaces. */}
      <section data-sb-section="workspaces" style={{ flex: 'none', display: 'flex', flexDirection: 'column' }}>
        <SectionHead
          label="Workspaces"
          open={wsSection}
          onToggle={() => toggleOpen('section:workspaces', true)}
          data-sb-head="workspaces"
          plus={<RowAction label="Add workspace" shown onClick={() => setCreating({ parent: null })} data-sb-new-workspace="1"><I.PlusIcon size={15} /></RowAction>}
        />
        {wsSection && ranked.map((entry) => {
          const { node } = entry;
          const open = wsOpen(entry);
          const children = open ? childrenOf(entry) : [];
          const markChild = herePath.length > 1 && herePath[0].id === node.id ? herePath[1].id : null; // a grandchild marks its parent
          return (
            <React.Fragment key={node.id}>
              <Row
                data-sb-workspace={node.id}
                icon={<I.WorkspaceIcon />}
                label={renaming === node.id ? <RenameField initial={node.name} onDone={(name) => { setRenaming(null); if (name) onRenameWorkspace(node.id, name); }} /> : node.name}
                title={node.name}
                faint={isUntitled(node.name)}
                active={node.id === hereId}
                expanded={nestedCount(entry) ? open : undefined}
                chevron={nestedCount(entry) ? <Chevron open={open} label={open ? `Fold ${node.name}` : `Show what is in ${node.name}`} onClick={() => toggleOpen(`ws:${node.id}`, wsOpenByDefault(entry))} /> : null}
                hover={renaming === node.id ? null : <RowAction label="Add sub-workspace" onClick={() => setCreating({ parent: node })} data-sb-new-child={node.id}><I.PlusIcon size={15} /></RowAction>}
                right={waitDot(node)}
                onClick={() => { if (renaming !== node.id) onSelectWorkspace(node.id); }}
                onDoubleClick={() => setRenaming(node.id)}
                onContextMenu={(event) => workspaceMenu(event, node)}
              />
              {children.length > 0 && (
                <Indented data-sb-children={node.id}>
                  {children.map((item) => (item.type === 'version' ? (
                    <Row
                      key={`${item.version.workspaceId}/${item.version.file}`}
                      data-sb-version={item.version.file}
                      indent
                      label={item.version.title}
                      title={`Archived${item.version.clearedAt ? `, cleared ${sinceWords(item.version.clearedAt)}` : ''}: ${item.version.title}`}
                      faint
                      right={<I.ArchiveIcon size={13} style={{ color: '#b0b0b0' }} />}
                      onClick={() => onOpenVersion(item.version)}
                    />
                  ) : (
                    <Row
                      key={item.child.node.id}
                      data-sb-workspace={item.child.node.id}
                      indent
                      label={renaming === item.child.node.id ? <RenameField initial={item.child.node.name} onDone={(name) => { setRenaming(null); if (name) onRenameWorkspace(item.child.node.id, name); }} /> : item.child.node.name}
                      title={item.child.node.name}
                      faint={isUntitled(item.child.node.name)}
                      active={item.child.node.id === markChild}
                      right={waitDot(item.child.node)}
                      onClick={() => { if (renaming !== item.child.node.id) onSelectWorkspace(item.child.node.id); }}
                      onDoubleClick={() => setRenaming(item.child.node.id)}
                      onContextMenu={(event) => workspaceMenu(event, item.child.node)}
                    />
                  )))}
                </Indented>
              )}
            </React.Fragment>
          );
        })}
        {wsSection && !ranked.length && <div style={{ height: LINE, display: 'flex', alignItems: 'center', padding: '0 8px', ...text(13.5, '#a3a3a3') }}>No workspaces yet</div>}
        {wsSection && wsMore && <MoreRow data-sb-trigger="workspaces" data-sb-more="workspaces" open={!!(panel && panel.kind === 'workspaces')} onClick={(event) => toggle('workspaces', event.currentTarget)} />}
      </section>

      {sources}

      {/* The foot: the stickies shown or hidden. A post-it held over it goes to the trash, which opens from here too. */}
      <div
        ref={trashRef}
        data-sb-foot="1"
        data-trash={trashFull ? 'full' : 'empty'}
        data-trash-over={postItDrag && postItDrag.over ? '1' : '0'}
        style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, margin: '6px 0 10px', borderRadius: 7, background: stickiesDrag ? (postItDrag.over ? '#e6e6e6' : '#f0f0f0') : 'transparent', boxShadow: stickiesDrag ? 'inset 0 0 0 1px #dedede' : 'none', transition: 'background 120ms' }}
      >
        {stickiesDrag
          ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, height: LINE, padding: '0 8px', ...text(14.5, '#4d4d4d') }}><I.TrashIcon style={{ color: '#4d4d4d' }} />Drop here to throw it away</div>
          : (
            <Row
              height={LINE}
              style={{ flex: 1 }}
              role="switch"
              aria-checked={!postItsHidden}
              data-toggle-post-its={postItsHidden ? 'hidden' : 'shown'}
              icon={<I.StickyIcon hidden={postItsHidden} />}
              label={postItsHidden ? 'Show stickies' : 'Hide stickies'}
              title={postItsHidden ? 'Bring every sticky back into sight' : 'Put every sticky out of sight'}
              onClick={onTogglePostIts || undefined}
            />
          )}
        {!stickiesDrag && trashFull && (
          <RowAction label="Trash" shown data-sb-trigger="trash" data-sb-trash="1" onClick={(event) => toggle('trash', event.currentTarget)}><I.TrashIcon size={16} /></RowAction>
        )}
      </div>

      {peek.peek && !panel && !menu && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={(pid, wid) => { peek.drop(); onOpenHeld(pid, wid); }} />}

      {panel && panel.kind === 'project' && <ProjectMenu anchor={panel.anchor} project={project} onSwitch={onOpenProject} onNewProject={onNewProject} onAllProjects={onAllProjects} onRename={() => setRenaming('project')} onClose={close} ignore={ignore('project')} />}
      {panel && panel.kind === 'inbox' && <InboxPanel anchor={panel.anchor} entries={inboxAll} nameOf={nameOf} onGo={(entry) => { if (entry.kind === 'connect') { close(); onOpenConnect(entry.sessionId); } else goAgent(entry); }} onClear={() => {
        onSeenAll([...new Set(inbox.map((entry) => entry.workspaceId).filter(Boolean))]);
        // a finished Connect is seen once it is cleared; one that needs you stays until it is answered
        for (const entry of connectNotes) { const session = connectSessions.find((each) => each.id === entry.sessionId); if (session && dockLine(session).tone === 'done') api.connectDismiss(entry.sessionId).catch(() => {}); }
      }} onClose={close} ignore={ignore('inbox')} />}
      {panel && panel.kind === 'agents' && <AgentsPanel anchor={panel.anchor} groups={agentList} nameOf={nameOf} onGo={goAgent} onClose={close} ignore={ignore('agents')} />}
      {panel && panel.kind === 'connections' && <ConnectionsPanel anchor={panel.anchor} onOverleaf={() => onOpenLink(OVERLEAF_URL)} onClose={close} ignore={ignore('connections')} />}
      {panel && panel.kind === 'library' && <LibraryPanel anchor={panel.anchor} projectId={project.id} library={library} inRail={inRail} onOpen={(row) => onOpenRow(row)} onLink={onLinkRow} onAddInput={onAddInput} onOpenFull={onAllProjects} onOpenWorkspace={onOpenHeld} onClose={close} ignore={ignore('library')} />}
      {panel && panel.kind === 'add' && (
        <Floating anchor={panel.anchor} width={300} cap={620} label="Add sources" onClose={closeAdd} ignore={ignore('add')} data-sb-panel="add" data-rail-add-menu="1" style={{ padding: 8, overflowY: 'auto' }}>
          <AddMenuBody projectId={project.id} search={false} onAdd={onAddInput} onPickDisk={onPickDisk} onNewNote={onNewNote} onNewSticky={onNewSticky} onPickRepo={onPickRepo} library={library} inRail={inRail} onDone={() => setPanel(null)} onBusy={onAddBusy} />
        </Floating>
      )}
      {panel && panel.kind === 'workspaces' && <WorkspacesPanel anchor={panel.anchor} roots={roots} hereId={hereId} versions={versions} onGo={onSelectWorkspace} onNew={(parentId) => setCreating({ parent: parentId ? { id: parentId, name: nameOf(parentId) } : null })} onRename={onRenameWorkspace} onDelete={onDeleteWorkspace} onOpenVersion={onOpenVersion} onClose={close} ignore={ignore('workspaces')} />}
      {panel && panel.kind === 'sources' && (() => {
        const group = groups.find((candidate) => candidate.key === panel.key);
        return group ? <SourcesPanel anchor={panel.anchor} group={group} activeId={activeRowId} starred={starredSet} inRail={inRail} onOpen={onOpenRow} onStar={onStar} onRemove={onRemoveRow} onOpenWorkspace={onOpenHeld} onClose={close} ignore={ignore('sources', group.key)} /> : null;
      })()}
      {panel && panel.kind === 'trash' && (postItTrash || workspaceTrash) && <TrashPanel anchor={panel.anchor} trash={postItTrash} workspaces={workspaceTrash} onClose={close} />}

      {searching && <SearchDialog projectId={project.id} workspaces={flatWorkspaces(roots)} rows={rows} library={library} inRail={inRail} onGoWorkspace={onSelectWorkspace} onOpen={(row) => onOpenRow(row)} onLink={onLinkRow} onAddInput={onAddInput} onClose={() => setSearching(false)} />}
      {creating && <NewWorkspaceDialog parent={creating.parent} onCreate={(name) => onCreateWorkspace({ name, parentId: creating.parent ? creating.parent.id : null })} onClose={() => setCreating(null)} />}
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
