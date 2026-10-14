import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { looksAddable, searchRows } from '../model/rail.js';
import { flatWorkspaces } from '../model/nav.js';
import {
  LEVEL_ROWS, MAX_DEPTH, archivedVersions, folderRows, indexTree, libraryLabel, openPath, projectPlan, projectSlots, rollUp,
  shortcutOf, sourceIcon, summarize, summaryOf, toggleOpen, workspaceActivity,
} from '../model/sidebar.js';
import { libraryCounts } from '../model/kind.js';
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
  AddPicker, AgentsPanel, ContextMenu, Count, CreateProjectDialog, FolderDialog, LibraryPanel, Pill, PeekCard, ProjectFlyout,
  ProjectMenu, ProjectsPanel, RenameField, RowAction, SearchDialog, ShortcutsDialog, SiblingsPanel, SourcesPanel, Tip, panelEdge,
  text, usePeek,
} from './SidebarPanels.jsx';

// The sidebar, redone (2026-10-13) from Hudson's "Sidebar" project and the mockup built from it
// (design/sidebar-mockup/Sidebar.html: "it is exactly how I want it"). What were workspaces are projects now: the
// top-level project the switcher picks, and the projects nested in it, four levels in all. From the top:
//   the head: the top-level project's name and its chevron (which never turns), opening its menu (Switch project, Rename,
//     Project page, Keyboard shortcuts); then Settings and New note;
//   fixed rows: Agents (the Inbox folded in; a count in a rounded square, its outline breathing while one runs, filled grey
//     once all of them wait for you, 9+), Library (its size, 999+), Search;
//   Projects: at most three level-2 projects, a shortlist a click never reorders, ten rows in all counting what is open under
//     them and every More; one path open at a time; a group shows five, or four and More; a guide line only beside the
//     deepest group open; counts roll up, each agent once; the + (on hover) makes a project within that one; a level-2
//     project you are not in shows its chevron on hover; resting on a folded project shows what is in it; Ctrl+1–9 and ⌘J;
//   Sources: this project's folder (its sources, five or four and More), then the person's own folders, the same in every
//     project, and Create new; + adds to the project or, on a folder, to that folder;
//   the foot: the stickies shown or hidden, and the trash when it holds something.
// Chevrons point down while open and up while folded. The sidebar folds away from the toggle in the title bar or ⌘\.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const LINE = 30; // a line of the sidebar: a fixed row, a project, a source, a folder, "More"
const ICON = 18; // the icon's box in a row
const OPEN_KEY = 'engelbart.sidebar.open';
const SLOTS_KEY = 'engelbart.sidebar.slots'; // top-level project id → the level-2 projects its section shows
const SIZE = { row: 14.5, indent: 13.5, head: 13 }; // the text of a row, an indented row and a section's title
const HOVER_OPEN = 350, HOVER_SWITCH = 90, HOVER_CLOSE = 180; // the note previews' beat (SidebarPanels.jsx usePeek)

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

// What is folded open, kept for the next time the app opens (a convenience of this machine: storage may refuse).
// Keys: `section:<key>`, `folder:<project id>` (this project's folder of Sources), `folder:<folder id>`.
function readStored(key, fallback) {
  try { const saved = JSON.parse(window.localStorage.getItem(key) || 'null'); return saved && typeof saved === 'object' ? saved : fallback; } catch { return fallback; }
}
function useStored(key, fallback) {
  const [value, setValue] = React.useState(() => readStored(key, fallback));
  React.useEffect(() => { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ } }, [key, value]);
  return [value, setValue];
}

// A press on a row does not focus it (the keyboard's ring would show on it once Escape closed what it opened); a name
// being typed in it keeps its caret.
const keepFocus = (event) => { if (!(event.target.closest && event.target.closest('input'))) event.preventDefault(); };

const CHEV = (size = 13) => <I.ChevronDown size={size} stroke={2.4} />;

/** A chevron that folds: down while open, up while folded (styles.css .sb-chev). `onHover`: only while the row is hovered. */
function Chevron({ open, onClick, label, onHover = false, ...rest }) {
  return (
    <button type="button" className={`sb-chev${onHover ? ' sb-on-hover' : ''}`} data-open={open ? '1' : '0'} aria-label={label} aria-expanded={open} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClick(event); }} onDoubleClick={(event) => event.stopPropagation()} {...rest}>
      {CHEV()}
    </button>
  );
}

/**
 * A line of the sidebar: its icon (none when indented), its name, then what it shows on the right (`right`). `active`:
 * where you are; `holds`: you are in something folded inside it (its name in bold). A div, so the buttons it holds can be
 * buttons.
 */
function Row({ icon, label, title, indent = false, active = false, holds = false, faint = false, right = null, flash = false, onClick, onDoubleClick, onContextMenu, onMouseEnter, onMouseLeave, onMouseOver, expanded, className = '', style, ...rest }) {
  const strong = active || holds;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sb-row ${className}`}
      data-active={active ? '1' : undefined}
      data-holds={holds ? '1' : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
      onMouseDown={keepFocus}
      onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget && onClick) { event.preventDefault(); onClick(event); } }}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseOver={onMouseOver}
      {...rest}
      style={{ flex: 'none', position: 'relative', display: 'flex', alignItems: 'center', height: LINE, boxSizing: 'border-box', padding: indent ? '0 6px 0 10px' : '0 6px 0 8px', borderRadius: 6, cursor: 'pointer', outline: 'none', userSelect: 'none', animation: flash ? 'added 1600ms ease-out' : undefined, ...style }}
    >
      {!indent && icon && <span style={{ flex: 'none', width: ICON, height: ICON, marginRight: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? '#171717' : '#5c5c5c' }}>{icon}</span>}
      <span style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(indent ? SIZE.indent : SIZE.row, faint ? '#9b9b9b' : strong ? '#171717' : indent ? '#4d4d4d' : '#262626', strong ? 500 : 400), lineHeight: `${LINE}px` }}>{label}</span>
      <span style={{ flex: '1 0 6px' }} />
      {right}
    </div>
  );
}

/** "... More" (the mockup's): what a level or a folder had no room for, in a panel beside the sidebar. `count`: what waits behind it. */
function MoreRow({ indent = false, open = false, onClick, count = null, ...rest }) {
  return (
    <div role="button" tabIndex={0} className="sb-row sb-more" data-active={open ? '1' : undefined} onClick={onClick} onMouseDown={keepFocus} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(event); } }} {...rest} style={{ flex: 'none', display: 'flex', alignItems: 'center', height: LINE, boxSizing: 'border-box', padding: indent ? '0 6px 0 10px' : '0 6px 0 8px', borderRadius: 6, cursor: 'pointer', outline: 'none', userSelect: 'none', color: '#8f8f8f' }}>
      <span aria-hidden="true" style={{ marginRight: 4, ...text(indent ? SIZE.indent : SIZE.row, '#8f8f8f'), lineHeight: `${LINE}px` }}>...</span>
      <span style={{ ...text(indent ? SIZE.indent : SIZE.row, '#8f8f8f'), lineHeight: `${LINE}px` }}>More</span>
      <span style={{ flex: '1 0 6px' }} />
      {count && <span className="sb-tools"><span className="sb-slot-add" /><span className="sb-slot-count"><Count summary={count} /></span><span className="sb-slot-chev" /></span>}
    </div>
  );
}

/** A section's title (Linear's "Your teams"): no icon, quiet, its chevron after it; what it offers at its right. */
function SectionHead({ label, open, onToggle, children, ...rest }) {
  return (
    <div className="sb-section-head" {...rest} style={{ flex: 'none', display: 'flex', alignItems: 'center', height: LINE, padding: '0 6px 0 8px', marginTop: 12 }}>
      <button type="button" className="sb-section-toggle" aria-expanded={open} onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, padding: '2px 0', border: 0, background: 'transparent', cursor: 'pointer' }}>
        <span style={{ ...text(SIZE.head, '#8f8f8f', 500), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span className="sb-chev-mark" data-open={open ? '1' : '0'}>{CHEV()}</span>
      </button>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** A + on a row or a section, with the sidebar's own tooltip. */
function AddButton({ label, onClick, onTip, className = 'sb-add', ...rest }) {
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (onTip) onTip(null); onClick(event); }}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseEnter={onTip ? (event) => onTip(event.currentTarget, label) : undefined}
      onMouseLeave={onTip ? () => onTip(null) : undefined}
      {...rest}
    >
      <I.PlusIcon size={15} />
    </button>
  );
}

const rectOfEl = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };

/* ------------------------------------------------------------ the sidebar */

export default function Rail({
  width, hidden = false, // the sidebar folded away, or the document's full screen (MATH-23): out of sight, kept as it is
  project, onOpenProject, onNewProject, onAllProjects, onRenameProject, onOpenProjectPage = () => {}, projectCounts = new Map(),
  roots = [], hereId = null, recent = [], visits = [], entries = [],
  onSelectWorkspace, onCreateWorkspace, onRenameWorkspace, onDeleteWorkspace, onOpenVersion,
  onGoAgent = () => {}, onNextAgent = () => {}, onSeenAll = () => {}, onToggleRail = () => {}, railHidden = false,
  rows = [], activeRowId = null, flashId = null,
  library = [], inRail = () => false, onOpenRow, onRenameRow, onRemoveRow, onLinkRow, onOpenHeld, onDropItems,
  onAddInput, onPickDisk, onNewNote, onPickRepo,
  folders = [], onCreateFolder = async () => {}, onRenameFolder = () => {}, onDeleteFolder = () => {}, onAddToFolder = async () => {}, onRemoveFromFolder = () => {},
  postItsHidden = false, onTogglePostIts, postItTrash = null, workspaceTrash = null, trashFull = false, postItDrag = null, trashRef,
  libraryRequest = null, onPanel = () => {}, // the Welcome walkthrough (2026-10-09): a new { n, chip } opens Library on that tab; onPanel(kind) when one opens
}) {
  const [opened, setOpened] = useStored(OPEN_KEY, {});
  const [panel, setPanel] = React.useState(null); // { kind, anchor, key?, ... }: one beside the sidebar at a time
  const [searching, setSearching] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [creating, setCreating] = React.useState(null); // { parent: { id|null, name } } while a new project is being named
  const [makingFolder, setMakingFolder] = React.useState(false);
  const [menu, setMenu] = React.useState(null); // { at, items }: a right click's
  const [renaming, setRenaming] = React.useState(null); // 'project', or the id of a project, a source or a folder being renamed
  const [dropping, setDropping] = React.useState(false);
  const asideRef = React.useRef(null);
  const peek = usePeek();

  const isOpen = (key, fallback) => (key in opened ? !!opened[key] : fallback);
  const toggleStored = (key, fallback) => setOpened((now) => ({ ...now, [key]: !(key in now ? now[key] : fallback) }));

  // Panels hang beside the sidebar at the height of the row that opened them; a second press on it closes it.
  const anchorOf = (element) => {
    const row = (element.closest && (element.closest('.sb-row, .sb-section-head') || element)).getBoundingClientRect();
    const side = asideRef.current ? asideRef.current.getBoundingClientRect() : row;
    return { left: row.left, right: side.right, top: row.top, bottom: row.bottom, width: row.width };
  };
  const toggle = (kind, element, extra = {}) => {
    peek.drop();
    setFlyout(null);
    setPanel((now) => (now && now.kind === kind && (now.key || null) === (extra.key || null) ? null : { kind, anchor: kind === 'project' ? rectOfEl(element) : anchorOf(element), ...extra }));
  };
  const close = React.useCallback(() => setPanel(null), []);
  const panelKind = panel ? panel.kind : null;
  React.useEffect(() => { if (panelKind) onPanel(panelKind); }, [panelKind]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!libraryRequest || hidden) return;
    const row = asideRef.current && asideRef.current.querySelector('[data-sb-trigger="library"]');
    if (row) { peek.drop(); setPanel({ kind: 'library', anchor: anchorOf(row), chip: libraryRequest.chip || 'all' }); }
  }, [libraryRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const ignore = (kind, key) => `[data-sb-trigger="${key ? `${kind}:${key}` : kind}"]`;

  /* ------------------------------------------------------------ projects */
  const tree = React.useMemo(() => indexTree(roots), [roots]);
  const nameOf = (id) => (tree.get(id) ? tree.get(id).node.name : '');
  const counts = React.useMemo(() => rollUp(tree, entries), [tree, entries]);
  const crumbOf = React.useCallback((id) => (tree.get(id) ? tree.get(id).path.map((step) => tree.get(step).node.name) : []), [tree]);
  // What is open follows where you are: the way down to it, and it when it holds projects. A chevron changes it until you go elsewhere.
  const [expanded, setExpanded] = React.useState(() => openPath(tree, hereId));
  const shownFor = React.useRef(hereId);
  if (shownFor.current !== hereId) { shownFor.current = hereId; setExpanded(openPath(tree, hereId)); }
  // When each level-2 project was last worked in, with everything in it: written in (the tree's `edited`, state.json
  // `recent`), or gone to (the clock's visits).
  const recency = React.useMemo(() => {
    const { within } = workspaceActivity(roots, recent);
    const out = new Map();
    for (const node of roots) out.set(node.id, within.get(node.id) || 0);
    for (const visit of visits) {
      if (visit.kind !== 'project' || !tree.has(visit.id)) continue;
      const top = tree.get(visit.id).path[0], at = Date.parse(visit.at || '') || 0;
      if (at > (out.get(top) || 0)) out.set(top, at);
    }
    return out;
  }, [roots, recent, visits, tree]);
  const [slotsAll, setSlotsAll] = useStored(SLOTS_KEY, {});
  const held = Array.isArray(slotsAll[project.id]) ? slotsAll[project.id] : null;
  const order = React.useMemo(() => projectSlots({ roots, index: tree, focusId: hereId, held, recency }), [roots, tree, hereId, held, recency]);
  React.useEffect(() => {
    if (held && held.length === order.length && held.every((id, i) => id === order[i])) return;
    setSlotsAll((now) => ({ ...now, [project.id]: order }));
  }, [order.join(','), project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = React.useMemo(() => projectPlan({ index: tree, order, expanded }), [tree, order, expanded]);
  const projectsOpen = isOpen('section:projects', true);
  const versions = React.useMemo(() => archivedVersions(roots), [roots]);

  // Resting on a folded project shows what is in it (2026-10-13), after the sidebar's beat; it goes a beat after the pointer
  // leaves the row and the card ("the hover stays unless I click somewhere else (this is a bug)").
  const [flyout, setFlyout] = React.useState(null); // { id, anchor }
  const flyTimer = React.useRef(null);
  const flyoutRef = React.useRef(null);
  flyoutRef.current = flyout;
  React.useEffect(() => () => clearTimeout(flyTimer.current), []);
  const holdFly = () => { clearTimeout(flyTimer.current); flyTimer.current = null; };
  const leaveFly = () => { holdFly(); if (flyoutRef.current) flyTimer.current = setTimeout(() => setFlyout(null), HOVER_CLOSE); };
  const wantFly = (id, element) => {
    if (flyoutRef.current && flyoutRef.current.id === id) { holdFly(); return; }
    holdFly();
    flyTimer.current = setTimeout(() => { if (element.isConnected) setFlyout({ id, anchor: anchorOf(element) }); }, flyoutRef.current ? HOVER_SWITCH : HOVER_OPEN);
  };
  // The sidebar's tooltips: a level-2 project's Ctrl+number, and what a + makes. After the same beat; gone at once.
  const [tip, setTip] = React.useState(null); // { at, kind: 'shortcut'|'label', n?, label? }
  const tipTimer = React.useRef(null);
  const tipFor = React.useRef(null);
  React.useEffect(() => () => clearTimeout(tipTimer.current), []);
  const showTip = (element, want) => {
    if (!element) { clearTimeout(tipTimer.current); tipFor.current = null; setTip(null); return; }
    if (tipFor.current === element) return;
    clearTimeout(tipTimer.current);
    tipFor.current = element;
    setTip(null);
    tipTimer.current = setTimeout(() => { if (element.isConnected && tipFor.current === element) setTip({ at: rectOfEl(element), ...want }); }, HOVER_OPEN);
  };
  const labelTip = (element, label) => showTip(element, { kind: 'label', label });
  const quiet = () => { holdFly(); setFlyout(null); showTip(null); };

  const go = (id) => { quiet(); onSelectWorkspace(id); };
  const chevronPress = (id, element) => {
    quiet();
    if (expanded.has(id) && !plan.opened.has(id)) { toggle('siblings', element, { key: id, parentId: id }); return; } // open, with no room for what is in it
    setExpanded((now) => toggleOpen(tree, now, id));
  };
  const create = (parentId) => { quiet(); close(); setCreating({ parent: parentId ? { id: parentId, name: nameOf(parentId) } : { id: null, name: project.name } }); };
  const projectMenu = (event, id) => {
    event.preventDefault();
    quiet();
    const at = tree.get(id);
    setMenu({ at: { x: event.clientX, y: event.clientY }, items: [
      { label: 'Open', icon: <I.WorkspaceIcon size={14} />, onClick: () => go(id) },
      { label: `Create project within ${at.node.name}`, icon: <I.PlusIcon size={14} />, disabled: at.level >= MAX_DEPTH, title: at.level >= MAX_DEPTH ? 'Projects go four levels deep' : undefined, onClick: () => create(id) },
      { label: 'Rename', icon: <I.PencilIcon size={14} />, onClick: () => setRenaming(id) },
      { separator: true },
      { label: 'Delete', icon: <I.TrashIcon size={14} />, danger: true, onClick: () => onDeleteWorkspace(id) },
    ] });
  };

  const projectRow = (id) => {
    const at = tree.get(id), node = at.node;
    const kids = (node.children || []).map((child) => child.id);
    const open = plan.opened.has(id); // open, and showing some of what is in it
    const here = id === hereId;
    const holds = !here && !!hereId && tree.has(hereId) && tree.get(hereId).path.includes(id) && (!open);
    const n = at.level === 2 ? shortcutOf(roots, id) : 0;
    const canAdd = at.level < MAX_DEPTH;
    const inBranch = !!hereId && tree.has(hereId) && tree.get(hereId).path.includes(id);
    const over = (event) => {
      const element = event.currentTarget;
      if (event.target.closest && event.target.closest('.sb-chev, .sb-add, input')) { if (flyoutRef.current) leaveFly(); else holdFly(); if (n) showTip(null); return; }
      if (kids.length && !open && (!panel || panel.kind === 'project') && renaming !== id) wantFly(id, element); else if (flyoutRef.current && flyoutRef.current.id !== id) leaveFly();
      if (n && !panel) showTip(element, { kind: 'shortcut', n });
    };
    const row = (
      <Row
        key={id}
        data-sb-project-row={id}
        data-level={at.level}
        indent={at.level > 2}
        icon={<I.WorkspaceIcon />}
        label={renaming === id ? <RenameField initial={node.name} onDone={(name) => { setRenaming(null); if (name) onRenameWorkspace(id, name); }} /> : node.name}
        title={n ? undefined : node.name}
        aria-label={n ? `${node.name}, Ctrl+${n}` : undefined}
        faint={isUntitled(node.name)}
        active={here}
        holds={holds}
        flash={flashId === id}
        expanded={kids.length ? open : undefined}
        onClick={() => { if (renaming !== id) go(id); }}
        onDoubleClick={() => { quiet(); setRenaming(id); }}
        onContextMenu={(event) => projectMenu(event, id)}
        onMouseOver={over}
        onMouseLeave={() => { leaveFly(); showTip(null); }}
        right={(
          <span className="sb-tools">
            <span className="sb-slot-add">{canAdd && renaming !== id && <AddButton label={`Create project within ${node.name}`} data-sb-new-child={id} onClick={() => create(id)} onTip={labelTip} />}</span>
            <span className="sb-slot-count"><Count summary={counts.get(id)} data-sb-count={id} /></span>
            <span className="sb-slot-chev">{kids.length > 0 && <Chevron open={open} onHover={at.level === 2 && !inBranch} label={open ? `Fold ${node.name}` : `Open ${node.name}`} data-sb-chevron={id} data-sb-trigger={`siblings:${id}`} onClick={(event) => chevronPress(id, event.currentTarget)} />}</span>
          </span>
        )}
      />
    );
    if (!open) return row;
    const shownKids = kids.filter((kid) => plan.shown.has(kid));
    const hiddenKids = kids.filter((kid) => !plan.shown.has(kid));
    return (
      <React.Fragment key={id}>
        {row}
        <div className={`sb-kids l${at.level + 1}`} data-sb-children={id} data-guide={plan.guide === id ? '1' : '0'}>
          {shownKids.map(projectRow)}
          {hiddenKids.length > 0 && <MoreRow indent data-sb-trigger={`siblings:${id}`} data-sb-more={id} open={!!(panel && panel.kind === 'siblings' && panel.key === id)} count={summaryOf(tree, entries, hiddenKids)} onClick={(event) => toggle('siblings', event.currentTarget, { key: id, parentId: id })} />}
        </div>
      </React.Fragment>
    );
  };

  /* --------------------------------------------------------------- sources */
  const projectFolderKey = `folder:${hereId || project.id}`;
  const sourcesOpen = isOpen('section:sources', true);
  const libraryById = React.useMemo(() => new Map(library.map((row) => [row.id, row])), [library]);
  const folderRowsOf = (folder) => folder.items.map((id) => libraryById.get(id)).filter(Boolean);
  const sourceMenu = (event, row, folder) => {
    event.preventDefault();
    peek.drop();
    const into = folders.filter((one) => !folder || one.id !== folder.id).filter((one) => !one.items.includes(row.id)).slice(0, 6);
    setMenu({ at: { x: event.clientX, y: event.clientY }, items: [
      { label: 'Open', icon: <I.ExternalIcon size={14} />, onClick: () => onOpenRow(row) },
      { label: 'Rename', icon: <I.PencilIcon size={14} />, onClick: () => setRenaming(row.id) },
      ...into.map((one) => ({ label: `Add to ${one.name}`, icon: <I.FolderIcon size={14} />, onClick: () => { void onAddToFolder(one.id, [row.id]); } })),
      ...(folder ? [{ separator: true }, { label: `Remove from ${folder.name}`, icon: <I.MinusCircleIcon size={14} />, onClick: () => onRemoveFromFolder(folder.id, row.id) }]
        : inRail(row.id) ? [{ separator: true }, { label: 'Remove from this project', icon: <I.MinusCircleIcon size={14} />, onClick: () => onRemoveRow(row) }] : []),
    ] });
  };
  const sourceRow = (row, folder = null) => (
    <Row
      key={row.id}
      data-sb-source={row.id}
      icon={<I.SourceIcon kind={sourceIcon(row)} />}
      label={renaming === row.id ? <RenameField initial={row.name} onDone={(name) => { setRenaming(null); if (name) onRenameRow(row, name); }} style={text(SIZE.row)} /> : row.name}
      title={row.name}
      faint={isUntitled(row.name)}
      active={row.id === activeRowId}
      flash={flashId === row.id}
      onClick={(event) => { if (renaming === row.id) return; peek.drop(); onOpenRow(row, event); }}
      onDoubleClick={() => { peek.drop(); setRenaming(row.id); }}
      onContextMenu={(event) => sourceMenu(event, row, folder)}
      onMouseEnter={(event) => { if (renaming !== row.id && !panel) peek.open(row, event.currentTarget, panelEdge(event.currentTarget)); }}
      onMouseLeave={peek.close}
      right={renaming === row.id ? null : (
        folder
          ? <RowAction label={`Remove from ${folder.name}`} onClick={() => { peek.drop(); onRemoveFromFolder(folder.id, row.id); }} data-sb-remove={row.id}><I.MinusCircleIcon size={15} /></RowAction>
          : inRail(row.id) ? <RowAction label="Remove from this project" onClick={() => { peek.drop(); onRemoveRow(row); }} data-sb-remove={row.id}><I.MinusCircleIcon size={15} /></RowAction> : null
      )}
    />
  );
  const addTo = (element, folder) => {
    const plus = rectOfEl(element);
    const row = anchorOf(element);
    peek.drop();
    setPanel((now) => (now && now.kind === 'add' && now.key === (folder ? folder.id : 'project') ? null : { kind: 'add', key: folder ? folder.id : 'project', folderId: folder ? folder.id : null, anchor: row, from: plus }));
  };
  const folderRow = ({ key, name, rows: list, folder = null, defaultOpen }) => {
    const storeKey = folder ? `folder:${folder.id}` : key;
    const expandedHere = isOpen(storeKey, defaultOpen);
    const { shown, more } = folderRows(list, LEVEL_ROWS);
    const morePanel = panel && panel.kind === 'sources' && panel.key === (folder ? folder.id : 'project');
    return (
      <div key={storeKey} data-sb-folder-group={folder ? folder.id : 'project'}>
        <Row
          className="sb-folder"
          data-sb-folder={folder ? folder.id : 'project'}
          icon={<I.FolderIcon />}
          label={folder && renaming === folder.id ? <RenameField initial={folder.name} onDone={(value) => { setRenaming(null); if (value) onRenameFolder(folder.id, value); }} style={text(SIZE.row)} /> : name}
          title={name}
          expanded={expandedHere}
          onClick={() => { if (!(folder && renaming === folder.id)) toggleStored(storeKey, defaultOpen); }}
          onDoubleClick={folder ? () => setRenaming(folder.id) : undefined}
          onContextMenu={folder ? (event) => { event.preventDefault(); setMenu({ at: { x: event.clientX, y: event.clientY }, items: [
            { label: 'Rename', icon: <I.PencilIcon size={14} />, onClick: () => setRenaming(folder.id) },
            { separator: true },
            { label: 'Delete folder', icon: <I.TrashIcon size={14} />, danger: true, onClick: () => onDeleteFolder(folder.id) },
          ] }); } : undefined}
          right={(
            <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2 }}>
              {expandedHere && <AddButton className="sb-add sb-folder-add" label={`Add sources to ${name}`} data-sb-trigger={`add:${folder ? folder.id : 'project'}`} data-sb-folder-add={folder ? folder.id : 'project'} onClick={(event) => addTo(event.currentTarget, folder)} onTip={labelTip} />}
              <Chevron open={expandedHere} label={`${expandedHere ? 'Collapse' : 'Expand'} ${name}`} data-sb-folder-chevron={folder ? folder.id : 'project'} onClick={() => toggleStored(storeKey, defaultOpen)} />
            </span>
          )}
        />
        {expandedHere && (
          <div data-sb-folder-rows={folder ? folder.id : 'project'} style={{ display: 'flex', flexDirection: 'column', paddingLeft: 24 }}>
            {shown.map((row) => sourceRow(row, folder))}
            {more && <MoreRow data-sb-trigger={`sources:${folder ? folder.id : 'project'}`} data-sb-more={folder ? folder.id : 'project'} open={!!morePanel} onClick={(event) => toggle('sources', event.currentTarget, { key: folder ? folder.id : 'project', folderId: folder ? folder.id : null })} />}
            {!folder && !list.length && onNewNote && (
              <button type="button" className="sb-row" data-sb-plus-note="1" onClick={() => onNewNote(null)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: LINE, padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', ...text(SIZE.indent, '#8f8f8f') }}>+ Note</button>
            )}
          </div>
        )}
      </div>
    );
  };

  // Files from Finder, a picture or a link from a browser, dropped on Sources (MATH-19): each a row of the library, in
  // this project.
  const dragOver = (event) => { if (!onDropItems || !carriesDrop(event)) return; event.preventDefault(); setDropping(true); };
  const dragLeave = (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false); };
  const drop = (event) => {
    if (!onDropItems || !carriesDrop(event)) return;
    event.preventDefault();
    setDropping(false);
    const items = readDrop(event.dataTransfer, api.pathForFile); // now: the drop's data is gone once the event is over
    if (items.length) void onDropItems(items);
  };

  /* ---------------------------------------------------------------- agents */
  const { rows: repoBuilds } = useBuildNotifications(); // the bell's, now in Agents
  const agentsSummary = React.useMemo(() => {
    const own = summarize(entries);
    const unread = repoBuilds.filter((row) => !row.read).length;
    return { total: own.total + unread, running: own.running, ready: own.ready + unread };
  }, [entries, repoBuilds]);
  const libraryTotal = React.useMemo(() => libraryCounts(library).all, [library]);

  const stickiesDrag = !!(postItDrag && postItDrag.active);
  const addPanel = panel && panel.kind === 'add' ? panel : null;
  const addFolder = addPanel && addPanel.folderId ? folders.find((one) => one.id === addPanel.folderId) || null : null;
  const addHas = React.useCallback((id) => (addFolder ? addFolder.items.includes(id) : inRail(id)), [addFolder, inRail]);

  return (
    <aside ref={asideRef} aria-label="Sidebar" data-sidebar="1" style={{ flex: 'none', width, minHeight: 0, display: hidden ? 'none' : 'flex', flexDirection: 'column', position: 'relative', zIndex: 7, boxSizing: 'border-box', padding: '0 8px', background: '#fafafa' }}>
      {/* The head: the top-level project, then Settings and New note. */}
      <div data-sb-head="project" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, height: 36 }}>
        {renaming === 'project'
          ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', height: 30, padding: '0 8px', border: '1px solid #c9c9c9', borderRadius: 6, background: '#fff' }}>
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
              style={{ flex: '0 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 8px', border: 0, borderRadius: 6, background: panel && panel.kind === 'project' ? '#ececec' : 'transparent', cursor: 'pointer' }}
            >
              <span data-sb-project-name="1" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(15, '#171717', 600), lineHeight: 1 }}>{project.name}</span>
              <span className="sb-chev-mark" style={{ color: '#9b9b9b' }}><I.ChevronDown size={14} stroke={2.4} /></span>
            </button>
          )}
        <span style={{ flex: '1 0 4px' }} />
        <button type="button" className="sb-icon" title="Settings" aria-label="Settings" data-sb-settings="1" onClick={() => { close(); openSettings(); }}><I.GearIcon /></button>
        <button type="button" className="sb-icon" title="New note" aria-label="New note" data-sb-new-note="1" disabled={!onNewNote} onClick={() => { close(); if (onNewNote) onNewNote(null); }}><I.ComposeIcon /></button>
      </div>

      <div data-sb-scroll="1" onScroll={() => { peek.drop(); quiet(); }} style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', scrollbarWidth: 'none', paddingBottom: 4 }}>
        {/* Fixed in place: Agents, Library, Search. */}
        <nav aria-label="Places" data-sb-fixed="1" style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 4 }}>
          <Row data-sb-trigger="agents" data-sb-fixed-row="agents" icon={<I.AgentsIcon />} label="Agents" active={!!(panel && panel.kind === 'agents')} right={<span style={{ flex: 'none', display: 'flex', alignItems: 'center', marginLeft: 4 }}><Pill summary={agentsSummary} data-sb-count="agents" /></span>} onClick={(event) => toggle('agents', event.currentTarget)} />
          <Row data-sb-trigger="library" data-sb-fixed-row="library" icon={<I.LibraryIcon />} label="Library" active={!!(panel && panel.kind === 'library')} right={<span data-sb-count="library" style={{ flex: 'none', marginLeft: 6, ...text(12, '#8f8f8f'), fontVariantNumeric: 'tabular-nums' }}>{libraryLabel(libraryTotal)}</span>} onClick={(event) => toggle('library', event.currentTarget)} />
          <Row data-sb-fixed-row="search" icon={<I.SearchIcon />} label="Search" active={searching} onClick={() => { close(); setSearching(true); }} />
        </nav>

        {/* Projects: the shortlist, what is open under it, More. */}
        <section data-sb-section="projects" style={{ flex: 'none', display: 'flex', flexDirection: 'column' }}>
          <SectionHead label="Projects" open={projectsOpen} onToggle={() => toggleStored('section:projects', true)} data-sb-head="projects">
            <button type="button" className="sb-shortcut hov-wash" data-sb-next-agent="1" aria-label="Next agent needing attention (⌘J)" onMouseEnter={(event) => labelTip(event.currentTarget, 'Next agent needing attention')} onMouseLeave={() => showTip(null)} onClick={() => { showTip(null); onNextAgent(); }} style={{ marginRight: 8, padding: '2px 3px', border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>⌘J</button>
            <AddButton label={`Create project within ${project.name}`} data-sb-new-workspace="1" onClick={() => create(null)} onTip={labelTip} />
          </SectionHead>
          {projectsOpen && (
            <div data-sb-projects="1" style={{ display: 'flex', flexDirection: 'column' }}>
              {!roots.length && <div style={{ height: LINE, display: 'flex', alignItems: 'center', paddingLeft: 10, ...text(13, '#a3a3a3') }}>No projects yet</div>}
              {plan.order.map(projectRow)}
              {plan.hidden.length > 0 && <MoreRow data-sb-trigger="projects" data-sb-more="projects" open={!!(panel && panel.kind === 'projects')} count={summaryOf(tree, entries, plan.hidden)} onClick={(event) => toggle('projects', event.currentTarget)} />}
            </div>
          )}
        </section>

        {/* Sources: this project's folder, the person's own folders, Create new. */}
        <section
          data-sb-section="sources"
          data-dropping={dropping ? '1' : undefined}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={drop}
          style={{ flex: '1 0 auto', display: 'flex', flexDirection: 'column', borderRadius: 8, boxShadow: dropping ? 'inset 0 0 0 2px #c9c9c9' : 'none', transition: 'box-shadow 120ms' }}
        >
          <SectionHead label="Sources" open={sourcesOpen} onToggle={() => toggleStored('section:sources', true)} data-sb-head="sources">
            {hereId && <AddButton className="sb-add" label="Add sources to this project and library" data-sb-trigger="add:project" data-sb-add-sources="1" onClick={(event) => addTo(event.currentTarget, null)} onTip={labelTip} style={{ color: '#8f8f8f' }} />}
          </SectionHead>
          {sourcesOpen && (
            <div data-sb-sources-body="1" style={{ display: 'flex', flexDirection: 'column' }}>
              {hereId && folderRow({ key: projectFolderKey, name: nameOf(hereId) || 'This project', rows, defaultOpen: true })}
              {folders.map((folder) => folderRow({ key: `folder:${folder.id}`, name: folder.name, rows: folderRowsOf(folder), folder, defaultOpen: false }))}
              <Row data-sb-create-folder="1" icon={<I.FolderPlusIcon />} label="Create new" onClick={() => { close(); setMakingFolder(true); }} />
            </div>
          )}
        </section>
      </div>

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
      {flyout && tree.has(flyout.id) && <ProjectFlyout flyout={flyout} tree={tree} counts={counts} hereId={hereId} onGo={go} onHold={holdFly} onLeave={leaveFly} />}
      {tip && (tip.kind === 'shortcut'
        ? <Tip at={tip.at} data-sb-tip="shortcut"><span className="sb-tip-key">⌃{tip.n}</span><span>Toggle project with <kbd>Ctrl + {tip.n}</kbd></span></Tip>
        : <Tip at={tip.at} data-sb-tip="label">{tip.label}</Tip>)}

      {panel && panel.kind === 'project' && <ProjectMenu anchor={panel.anchor} project={project} counts={projectCounts} onSwitch={onOpenProject} onNewProject={onNewProject} onAllProjects={onAllProjects} onRename={() => setRenaming('project')} onProjectPage={onOpenProjectPage} onShortcuts={() => setShortcuts(true)} onClose={close} ignore={ignore('project')} />}
      {panel && panel.kind === 'agents' && <AgentsPanel anchor={panel.anchor} entries={entries} crumbOf={crumbOf} onGo={(entry) => { close(); onGoAgent(entry); }} onNext={onNextAgent} onSeenAll={onSeenAll} onClose={close} ignore={ignore('agents')} />}
      {panel && panel.kind === 'library' && <LibraryPanel key={panel.chip || 'all'} anchor={panel.anchor} chip={panel.chip} projectId={project.id} library={library} inRail={inRail} onOpen={(row) => onOpenRow(row)} onLink={onLinkRow} onAddInput={(input) => onAddInput(input, null)} onOpenFull={onAllProjects} onOpenWorkspace={onOpenHeld} onClose={close} ignore={ignore('library')} />}
      {addPanel && (
        <AddPicker
          key={addPanel.key}
          anchor={addPanel.anchor}
          from={addPanel.from}
          into={{ name: addFolder ? addFolder.name : nameOf(hereId) || project.name }}
          projectId={project.id}
          library={library}
          inRail={inRail}
          has={addHas}
          onPick={(row) => (addFolder ? onAddToFolder(addFolder.id, [row.id]) : onLinkRow(row))}
          onAddInput={(input) => onAddInput(input, addFolder ? addFolder.id : null)}
          onPickDisk={() => onPickDisk(addFolder ? addFolder.id : null)}
          onPickRepo={(entry) => onPickRepo(entry, addFolder ? addFolder.id : null)}
          onNewNote={() => onNewNote(addFolder ? addFolder.id : null)}
          onClose={close}
          ignore={ignore('add', addPanel.key)}
        />
      )}
      {panel && panel.kind === 'projects' && <ProjectsPanel anchor={panel.anchor} roots={roots} tree={tree} counts={counts} hereId={hereId} versions={versions} onGo={go} onNew={() => create(null)} onMenu={projectMenu} onOpenVersion={onOpenVersion} onClose={close} ignore={ignore('projects')} />}
      {panel && panel.kind === 'siblings' && tree.has(panel.parentId) && <SiblingsPanel anchor={panel.anchor} parentId={panel.parentId} roots={roots} tree={tree} counts={counts} hereId={hereId} onGo={go} onMenu={projectMenu} onClose={close} ignore={ignore('siblings', panel.key)} />}
      {panel && panel.kind === 'sources' && (() => {
        const folder = panel.folderId ? folders.find((one) => one.id === panel.folderId) : null;
        const list = folder ? folderRowsOf(folder) : rows;
        const title = folder ? folder.name : nameOf(hereId) || project.name;
        return <SourcesPanel anchor={panel.anchor} title={title} rows={list} activeId={activeRowId} removeLabel={() => (folder ? `Remove from ${folder.name}` : 'Remove from this project')} onOpen={onOpenRow} onRemove={folder ? (row) => onRemoveFromFolder(folder.id, row.id) : (row) => { if (inRail(row.id)) onRemoveRow(row); }} onOpenWorkspace={onOpenHeld} onClose={close} ignore={ignore('sources', panel.key)} />;
      })()}
      {panel && panel.kind === 'trash' && (postItTrash || workspaceTrash) && <TrashPanel anchor={panel.anchor} trash={postItTrash} workspaces={workspaceTrash} onClose={close} />}

      {searching && <SearchDialog projectId={project.id} workspaces={flatWorkspaces(roots)} rows={rows} library={library} inRail={inRail} onGoWorkspace={go} onOpen={(row) => onOpenRow(row)} onLink={onLinkRow} onAddInput={(input) => onAddInput(input, null)} onClose={() => setSearching(false)} />}
      {shortcuts && <ShortcutsDialog roots={roots} railHidden={railHidden} onNext={onNextAgent} onGo={go} onToggleRail={onToggleRail} onClose={() => setShortcuts(false)} />}
      {creating && <CreateProjectDialog parent={creating.parent} onCreate={(name) => onCreateWorkspace({ name, parentId: creating.parent.id })} onClose={() => setCreating(null)} />}
      {makingFolder && <FolderDialog onCreate={(name) => onCreateFolder(name)} onClose={() => setMakingFolder(false)} />}
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
