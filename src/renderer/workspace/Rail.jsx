import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, kindOf, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { linkedSidebarSection, looksAddable, searchRows, sidebarSectionOf, sidebarSections } from '../model/rail.js';
import WorkspaceTree, { Chevron } from './WorkspaceTree.jsx';
import './sidebar.css';
import { ago, findWorkspaces } from '../model/nav.js';
import GithubPane from './GithubPane.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { ItemPeek } from '../screens/Home.jsx';
import trashPng from '../../../design/assets/trash.png';
import trashFullPng from '../../../design/assets/trash-full.png';
import TrashPanel from '../post-its/TrashPanel.jsx';
import notePng from '../../../design/assets/yellow-sticky-note.png';

// The current workspace card stays above search, the workspace tree, and grouped context.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const PEEK_OPEN = 350;
const PEEK_SWITCH = 90;
const PEEK_CLOSE = 180;
const MENU_CLOSE = 220;
const PEEK_GAP = 8;
const ROW_DRAG = 'application/x-engelbart-row';
const BAR_SIZE = 'clamp(52px, 24cqw, 96px)';

function markStyle(status, interactive = true) {
  const done = status === 'done';
  const prog = status === 'progress';
  const base = done
    ? { background: '#171717', color: '#fff', font: '600 9px/13px var(--font-sans)', textAlign: 'center', border: 0 }
    : { border: `1.5px ${prog ? 'dashed' : 'solid'} #171717`, background: 'transparent' };
  return { ...base, flex: 'none', width: 13, height: 13, borderRadius: '50%', padding: 0, cursor: interactive ? 'pointer' : 'default', boxSizing: 'border-box', appearance: 'none', display: 'inline-block' };
}

function statusTitle(status) {
  if (status === 'done') return 'Done — click for todo';
  if (status === 'progress') return 'In progress — click for done';
  return 'Todo — click for in progress';
}

function blurOnEnter(event) {
  if (event.key === 'Enter' || event.key === 'Escape') event.target.blur();
}

/** The switcher's search field (Sidebar.dc.html): a grey well with the library search's magnifier, smaller. */
function SwitcherSearch({ value, onChange, onKeyDown, inputRef }) {
  return (
    <div className="rail-field" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 2px', padding: '0 10px', borderRadius: 6, background: '#f2f2f2' }}>
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
      <input
        ref={inputRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Search"
        aria-label="Search workspaces"
        data-workspace-search="1"
        spellCheck={false}
        style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: 'var(--rail-row-font)', color: '#171717' }}
      />
      {value && <button type="button" className="hov-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => onChange({ target: { value: '' } })} aria-label="Clear" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>}
    </div>
  );
}

/** The workspace mark drawn at any size (the design's 19px head, stroke 1.3); the same four boxes as the KindGlyph's. */
function WsMark({ size, stroke = 1.3 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinejoin: 'round' }}>
      <path d="M2.5 1.5h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M9 1.5h4.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z M2.5 8h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z M11 8h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-2.5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

// The sidebar's head (Sidebar.dc.html, 2026-09-23): a grey box, "Workspace" over the workspace's icon and name (no
// "n / m"). Hovering it opens the switcher under it again (2026-09-23, Hudson: "add back hover on the workspace and
// search"), and moving off closes it unless its search holds text or the keyboard; a click opens it with the caret in
// the search. The switcher: a search that finds any workspace of the project by name, the sibling workspaces (each mark
// steps it through todo · in progress · done; the current one, bold, opens its own document), and "+ New". A
// double-click on the name renames it.
function WorkspaceHeader({ topics, topic, all, onOpenDoc, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic }) {
  const [hover, setHover] = React.useState(false); // the switcher is open
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(-1);
  const timer = React.useRef(null);
  const boxRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const renameRef = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useEffect(() => { setEditing(false); }, [topic && topic.id]);
  React.useEffect(() => { if (editing && renameRef.current) { renameRef.current.focus(); renameRef.current.select(); } }, [editing]);

  const found = q.trim() ? findWorkspaces(all, q) : null;
  const items = found || topics;
  const lit = idx >= 0 && idx < items.length ? items[idx] : null;
  const shut = React.useCallback(() => { clearTimeout(timer.current); setHover(false); setQ(''); setIdx(-1); if (fieldRef.current && document.activeElement === fieldRef.current) fieldRef.current.blur(); }, []);
  // A hover opens it; a click opens it too and gives the search the keyboard.
  const open = () => { clearTimeout(timer.current); if (!editing) setHover(true); };
  const close = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!(fieldRef.current && document.activeElement === fieldRef.current) && !fieldRef.current?.value) shut(); }, MENU_CLOSE);
  };
  const focusSearch = () => {
    if (editing) return;
    open();
    setTimeout(() => { if (fieldRef.current) fieldRef.current.focus({ preventScroll: true }); }, 0);
  };
  // A press anywhere else closes it, typed or not.
  React.useEffect(() => {
    if (!hover) return undefined;
    const away = (event) => { if (boxRef.current && !boxRef.current.contains(event.target)) shut(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [hover, shut]);

  // The current workspace in the list opens its own document; any other goes there.
  const go = (candidate) => { shut(); if (topic && candidate.id === topic.id) onOpenDoc(); else onSelectTopic(candidate.id); };
  const onKey = (event) => {
    const n = items.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((idx + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx(idx <= 0 ? n - 1 : idx - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); const pick = lit || (found && found[0]); if (pick) go(pick); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) { setQ(''); setIdx(-1); } else shut(); }
  };
  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (topic && next && next !== topic.name) onRenameTopic(next);
  };
  const untitled = !topic || isUntitled(topic.name);
  const menuRow = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', transition: 'background 120ms' };
  return (
    <div ref={boxRef} data-workspace-header="1" onMouseEnter={open} onMouseLeave={close} style={{ flex: 'none', position: 'relative', zIndex: 6, marginBottom: 18 }}>
      <div style={{ padding: '8px 12px', background: '#f2f2f2', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ font: '500 12.5px/1.3 var(--font-sans)', color: '#8f8f8f' }}>Workspace</div>
        <div
          role="button"
          tabIndex={-1}
          aria-label="Switch workspace"
          aria-expanded={hover}
          data-switch-workspace="1"
          onClick={focusSearch}
          onDoubleClick={() => { if (!topic) return; shut(); setDraft(untitled ? '' : topic.name); setEditing(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', color: '#171717' }}
        >
          <WsMark size={19} />
          {editing
            ? (
              <input
                ref={renameRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value.replace(/[/\\]/g, '-'))}
                onBlur={commit}
                onKeyDown={(event) => { if (event.key === 'Enter') event.target.blur(); else if (event.key === 'Escape') { event.stopPropagation(); setDraft(topic.name); setEditing(false); } }}
                onClick={(event) => event.stopPropagation()}
                placeholder={topic && isUntitled(topic.name) ? topic.name : ''}
                aria-label="Name"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '600 15px/1.5 var(--font-sans)', color: '#171717' }}
              />
            )
            : <span data-workspace-name="1" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '600 15px/1.5 var(--font-sans)', color: untitled ? '#8f8f8f' : '#171717' }}>{topic ? topic.name : 'no workspace yet…'}</span>}
        </div>
      </div>
      {hover && !editing && (
        <div data-overlay="1" data-workspace-menu="1" style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 30, maxHeight: 'min(440px, calc(100vh - 160px))', overflowY: 'auto', boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2, animation: `rise 160ms ${EASE}` }}>
          <SwitcherSearch
            inputRef={fieldRef}
            value={q}
            onChange={(event) => { setQ(event.target.value); setIdx(event.target.value.trim() ? 0 : -1); }}
            onKeyDown={onKey}
          />
          {items.map((candidate, i) => {
            const on = topic && candidate.id === topic.id;
            const above = found ? candidate.above : [];
            return (
              <div key={candidate.id} data-workspace-item={candidate.id} className={i === idx || on ? undefined : 'hov-wash'} onClick={() => go(candidate)} style={{ ...menuRow, background: i === idx || on ? '#f2f2f2' : 'transparent' }}>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onCycleTopic(candidate); }} title={statusTitle(candidate.status)} aria-label={statusTitle(candidate.status)} style={markStyle(candidate.status)}>{candidate.status === 'done' ? '✓' : ''}</button>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: isUntitled(candidate.name) ? '#8f8f8f' : '#171717' }}>{candidate.name}</span>
                  {above.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '11.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{above.join(' / ')}</span>}
                </span>
              </div>
            );
          })}
          {!found && (
            <div className="hov-ink-wash" data-new-workspace="1" onClick={() => { shut(); onAddTopic(); }} style={{ ...menuRow, padding: '6px 10px 8px', color: '#8f8f8f', transition: 'color 120ms, background 120ms' }}>
              <span style={{ flex: 'none', width: 13, textAlign: 'center', font: '400 15px/1 var(--font-sans)' }}>+</span>
              <span style={{ font: '14px/1.5 var(--font-sans)' }}>New</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The minus on a row's right (2026-09-23, Hudson's flaticon "minus" 992683: a ring with a bar, the + row's mirror).
const CIRCLE_MINUS = (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M5.5 9h7" />
  </svg>
);

export function RailRow({ row, flash, faded, glyphKind, onClick, onRenameStart, onRename, onRenameEnd, onDragStart, onDragEnd, onEnter, onLeave, onAdd, addDisabled, addLabel = 'Add context', onRemove }) {
  const inputRef = React.useRef(null);
  const [draft, setDraft] = React.useState(row.name);
  React.useEffect(() => { setDraft(row.name); }, [row.name, row.editing]);
  React.useEffect(() => {
    if (row.editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [row.editing]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== row.name) onRename(row, next);
    onRenameEnd();
  };
  const draggable = !!onDragStart && !row.editing;
  const name = <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: 'var(--rail-row-font)', fontWeight: row.on ? 500 : 400, color: isUntitled(row.name) ? '#8f8f8f' : '#171717' }}>{row.name}</span>;
  return (
    <div
      data-rail-row={row.id}
      className={`rail-context-row hov-wash${onRemove ? ' rail-has-remove' : ''}`}
      role={row.editing || onAdd ? undefined : "button"}
      tabIndex={row.editing || onAdd ? undefined : 0}
      aria-label={row.name}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onClick(row); } }}
      draggable={draggable}
      onDragStart={draggable ? (event) => onDragStart(row, event) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={onAdd ? undefined : () => { if (!row.editing) onClick(row); }}
      onDoubleClick={(event) => { if (row.type === 'workspace' || !onRenameStart) return; event.stopPropagation(); onRenameStart(row); }}
      onMouseEnter={onEnter ? (event) => onEnter(row, event.currentTarget) : undefined}
      onMouseLeave={onLeave}
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box', borderRadius: 6, cursor: 'pointer',
        width: '100%', minHeight: 'var(--rail-row-height)', margin: '0 0 2px', padding: onAdd && !row.editing ? 0 : '8px 10px',
        background: row.on ? '#eaeaea' : 'transparent',
        opacity: faded ? 0.4 : 1, animation: flash ? 'added 1600ms ease-out' : undefined, transition: 'background 120ms',
      }}
    >
      {(!onAdd || row.editing) && <Glyph item={row} kind={glyphKind} box="var(--rail-icon-size)" size="var(--rail-icon-size)" />}
      {row.editing
        ? (
          <input
            ref={inputRef}
            data-rename={row.id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
            onClick={(event) => event.stopPropagation()}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: 'var(--rail-row-font)', fontWeight: row.on ? 500 : 400, color: '#171717' }}
          />
        )
        : onAdd ? <button type="button" className="rail-row-open" aria-label={row.name} onClick={() => onClick(row)}><Glyph item={row} kind={glyphKind} box="var(--rail-icon-size)" size="var(--rail-icon-size)" />{name}</button> : name}
      {onAdd && !row.editing && <button type="button" className="rail-icon-action rail-row-add" aria-label={addLabel} title={addLabel} disabled={addDisabled} draggable={false}
        onClick={(event) => { event.stopPropagation(); onAdd(event); }} onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}>+</button>}
      {onRemove && !row.editing && <button type="button" className="rail-icon-action rail-row-remove" data-rail-remove={row.id}
        aria-label={`Take ${row.name} out of this workspace`} title="Remove from workspace" draggable={false}
        onClick={(event) => { event.stopPropagation(); onRemove(row); }} onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}>{CIRCLE_MINUS}</button>}
    </div>
  );
}

// Position popup menus within the available window.
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

const rectOf = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
const glyphItem = (result) => result.kind === 'workspace' || result.kind === 'child' ? { type: 'workspace' } : result.kind === 'note' ? { type: 'md', tags: ['note'] } : result.kind === 'item' ? result.row : result.found;
const cardStyle = { padding: '14px 16px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: `rise 160ms ${EASE}` };

// What a new address or path would be, before the library holds it: its kind, the name it would get, where it is.
function FreshPeek({ found }) {
  const kind = kindOf(found);
  const where = found.url ? found.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : (found.path || found.folder_path || '');
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>
        <Glyph item={found} box={14} color="#4d4d4d" />{kind.label}
      </div>
      <div style={{ marginTop: 9, font: '500 14.5px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{found.name}</div>
      {where && <div style={{ marginTop: 4, font: '11.5px/1.5 var(--font-mono)', color: '#8f8f8f', overflowWrap: 'anywhere' }}>{where}</div>}
    </>
  );
}

/** The search field: what the library already holds comes into this workspace from here (Canvas.dc.html `results`). */
function LibrarySearch({ library, workspaces, canAdd, searchRef, inRail, onPick, previews, onPreview, onOpenHeld, onOpenChange, shut }) {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null); // { query, result } — what the main process said an address or a path is
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const boxRef = React.useRef(null);
  const inputRef = searchRef;
  const listRef = React.useRef(null);
  const peekRef = React.useRef(null);

  const typed = q.trim();
  const addable = looksAddable(typed);
  React.useEffect(() => {
    if (!open || !addable) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api.lookupLibraryItem(typed)
        .then((result) => { if (live) setFound({ query: typed, result }); })
        .catch((error) => { if (live) setFound({ query: typed, result: { row: null, found: null, error: errorMessage(error) } }); });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [open, addable, typed]);
  const answer = addable && found && found.query === typed ? found.result : undefined;
  const rows = open ? searchRows({ query: q, library, workspaces, inRail, found: answer }).filter((row) => canAdd || row.kind === 'workspace' || row.kind === 'child') : [];
  const at = rows.length ? Math.min(idx, rows.length - 1) : -1;
  const lit = at >= 0 ? rows[at] : null;
  const problem = note || (answer && answer.error) || '';

  const close = React.useCallback(() => { setOpen(false); setQ(''); setIdx(0); setNote(''); }, []);
  React.useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);
  React.useEffect(() => { if (shut && open) { close(); if (inputRef.current) inputRef.current.blur(); } }, [shut]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    if (!open || !boxRef.current) { setAnchor(null); return undefined; }
    const measure = () => { if (boxRef.current) setAnchor(rectOf(boxRef.current)); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);
  // A press anywhere else closes it, the way the design's `_away` does.
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (![boxRef, listRef, peekRef].some((ref) => ref.current && ref.current.contains(event.target))) close(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open, close]);
  React.useEffect(() => { if (lit && lit.kind === 'item') onPreview(lit.row); }, [lit && lit.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (result) => {
    if (!result || busy) return;
    setBusy(true);
    setNote('');
    try {
      await onPick(result, typed);
      close();
      if (inputRef.current) inputRef.current.blur();
    } catch (error) {
      setNote(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (lit) void pick(lit); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); event.currentTarget.blur(); }
  };

  const showList = open && anchor && (rows.length > 0 || !!problem);
  const peekItem = showList && lit && (lit.kind === 'item' || lit.kind === 'fresh') ? lit : null;
  return (
    <div data-rail-search="1" style={{ flex: 'none', position: 'relative' }}>
      <div ref={boxRef} className="rail-search rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #e5e5e5', borderRadius: 7, background: '#fff', transition: 'box-shadow 120ms' }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none', width: 'var(--rail-icon-size)', height: 'var(--rail-icon-size)' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
        <input
          ref={inputRef}
          value={q}
          readOnly={busy}
          onChange={(event) => { setQ(event.target.value); setIdx(0); setNote(''); setOpen(true); }}
          onKeyDown={onKey}
          onFocus={() => { if (!open) { setOpen(true); setIdx(0); } }}
          placeholder="Search…"
          aria-label="Search workspaces and context"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: '8px 0', border: 0, background: 'transparent', font: 'var(--rail-row-font)', color: '#171717', opacity: busy ? 0.5 : 1 }}
        />
        {q && <button type="button" className="hov-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQ(''); setIdx(0); setNote(''); if (inputRef.current) inputRef.current.focus(); }} aria-label="Clear" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>}
      </div>
      {showList && (
        <Hanging anchor={anchor} width={anchor.width} cap={Math.max(160, window.innerHeight - 220)} panelRef={listRef} data-rail-results="1" style={{ padding: 4, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((result, i) => (
            <button key={result.key} type="button" data-result={result.key} title={result.path || result.name} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(result)} onMouseEnter={() => { if (idx !== i) setIdx(i); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: i === at ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer' }}>
              <Glyph item={glyphItem(result)} box={18} color="#4d4d4d" />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{result.name}</span>
              {/^new\b/.test(result.tag)
                ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>
                : <span style={{ flex: 'none', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{result.tag}</span>}
            </button>
          ))}
          {problem && <div style={{ padding: '7px 10px', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{problem}</div>}
        </Hanging>
      )}
      {peekItem && createPortal(
        <div ref={peekRef} data-overlay="1" data-hover="1" data-rail-peek="1" style={{ position: 'fixed', zIndex: 71, left: anchor.right + 24, top: anchor.bottom + 6, width: 380, maxHeight: 400, overflowY: 'auto', boxSizing: 'border-box', ...cardStyle }}>
          {peekItem.kind === 'item'
            ? <ItemPeek row={peekItem.row} more={previews[`${peekItem.row.id}:${peekItem.row.last_edited || ''}`]} onOpenWorkspace={onOpenHeld} />
            : <FreshPeek found={peekItem.found} />}
        </div>,
        document.body,
      )}
    </div>
  );
}

// "+ Add context" under the sections opens on click: a search over the library first
// (the sidebar's search again, closer to hand: typing lists what it finds
// in place of the rest), then a new Note or Sub-Workspace made here, then a link, a path or files from disk, or a
// repository from GitHub, that become new rows, in the library and in this workspace.
const CIRCLE_PLUS = (
  <svg aria-hidden="true" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block', width: 'var(--rail-icon-size)', height: 'var(--rail-icon-size)' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M9 5.5v7 M5.5 9h7" />
  </svg>
);

function AddToLibrary({ onAdd, onPickDisk, onNewNote, onNewChild, onNewConversation, onPickRepo, onSearchPick, library, workspaces, inRail, onOpenChange, shut, request, disabled }) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState('context');
  const linkSection = kind === 'overleaf';
  const triggerRef = React.useRef(null);
  const [q, setQ] = React.useState(''); // the search at the top of the menu
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null); // { query, result }: what the main process said an address or a path is
  const searchRef = React.useRef(null);
  const [view, setView] = React.useState('menu'); // 'menu' | 'github' (GithubPane: signing in, then the repositories)
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const rowRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const timer = React.useRef(null);
  const wantFocus = React.useRef(false);
  const live = React.useRef({ value: '', busy: false, view: 'menu' });
  live.current = { value: value || q, busy, view };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);
  // The field takes the keyboard as soon as the menu shows, so a link can be pasted straight away. Not in the ref: the
  // panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes no focus.
  React.useEffect(() => {
    if (!open || !wantFocus.current) return undefined;
    const timer = setTimeout(() => {
      const naming = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-rename]'); // a name being typed on the rail keeps the keyboard
      if (naming) { wantFocus.current = false; return; }
      const field = kind === 'conversations' ? menuRef.current?.querySelector('[data-conversation-provider]') : linkSection ? fieldRef.current : searchRef.current;
      if (field) { field.focus({ preventScroll: true }); wantFocus.current = false; }
    }, 0);
    return () => clearTimeout(timer);
  }, [open, anchor]);

  const hide = React.useCallback(() => { clearTimeout(timer.current); setOpen(false); setValue(''); setError(''); setView('menu'); setQ(''); setIdx(0); }, []);
  React.useEffect(() => { if ((shut || disabled) && open && !live.current.busy) hide(); }, [shut, disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (nextKind = 'context', trigger = rowRef.current) => {
    clearTimeout(timer.current);
    if (disabled || busy || (open && triggerRef.current === trigger && kind === nextKind)) return;
    triggerRef.current = trigger;
    if (trigger) setAnchor(rectOf(trigger));
    setKind(nextKind);
    setView('menu');
    setQ('');
    setIdx(0);
    wantFocus.current = true;
    setValue('');
    setError('');
    setOpen(true);
  };
  React.useEffect(() => { if (request) show(request.kind, request.trigger); }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  // Moving off closes it after a short grace, unless something has been typed, it is busy, or GitHub is open in it (its
  // repository picker should stay open while reading it).
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (live.current.value.trim() || live.current.busy || live.current.view !== 'menu') return;
      for (const ref of [fieldRef, searchRef]) if (ref.current && document.activeElement === ref.current) ref.current.blur();
      hide();
    }, MENU_CLOSE);
  };
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (live.current.busy) return; if (![rowRef, menuRef, triggerRef].some((ref) => ref.current && ref.current.contains(event.target))) hide(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open, hide]);

  const run = async (work) => {
    setBusy(true);
    setError('');
    try {
      const problems = await work();
      if (problems && problems.length) setError(problems.join(' · '));
      else hide();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const commit = () => {
    const input = value.trim();
    if (input && !busy) void run(async () => {
      if (linkSection && linkedSidebarSection(input) !== kind) throw new Error('Enter an Overleaf project URL.');
      if (linkSection) {
        const result = await api.lookupLibraryItem(input);
        if (result.error) throw new Error(result.error);
        if (result.row) { await onSearchPick({ kind: 'item', row: result.row }, input); return []; }
      }
      await onAdd(input);
      return [];
    });
  };
  const make = (work) => { if (!busy) void run(async () => { await work(); return []; }); };
  const fromGithub = () => { setError(''); setView('github'); };

  const addable = looksAddable(value);

  // The search: the same rows as the sidebar's (model/rail.js searchRows), listed in the menu itself.
  const typed = q.trim();
  const typedAddable = looksAddable(typed);
  React.useEffect(() => {
    if (!open || !typedAddable) return undefined;
    let alive = true;
    const wait = setTimeout(() => {
      api.lookupLibraryItem(typed)
        .then((result) => { if (alive) setFound({ query: typed, result }); })
        .catch((failure) => { if (alive) setFound({ query: typed, result: { row: null, found: null, error: errorMessage(failure) } }); });
    }, 120);
    return () => { alive = false; clearTimeout(wait); };
  }, [open, typedAddable, typed]);
  const answer = typedAddable && found && found.query === typed ? found.result : undefined;
  const results = typed ? searchRows({ query: typed, library, workspaces, inRail, found: answer })
    .filter((result) => !linkSection || (result.row || result.found) && sidebarSectionOf(result.row || result.found) === kind) : [];
  const at = results.length ? Math.min(idx, results.length - 1) : -1;
  const pickResult = (result) => { if (result && !busy) void run(async () => { await onSearchPick(result, typed); return []; }); };
  const onSearchKey = (event) => {
    const n = results.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pickResult(results[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) { setQ(''); setIdx(0); } else hide(); }
  };
  const actionLabel = SECTION_ADD_LABEL[kind] || 'Add context';
  const placeholder = SECTION_PLACEHOLDER[kind] || 'Upload URL or path';
  const searchProblem = (answer && answer.error) || '';
  const border = error ? '#e70022' : value ? '#c9c9c9' : '#eaeaea';
  const menuRow = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' };
  const menuText = { flex: 1, minWidth: 0, font: '14px/1.5 var(--font-sans)', color: '#171717' };
  return (
    <div data-rail-add="1" style={{ flex: 'none', position: 'relative' }} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
      <button ref={rowRef} type="button" className="hov-wash" disabled={disabled} onClick={() => (open && triggerRef.current === rowRef.current ? hide() : show())} aria-label="Add context" aria-expanded={open && triggerRef.current === rowRef.current} style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: 'var(--rail-row-height)', boxSizing: 'border-box', padding: '8px 10px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', color: open ? '#171717' : '#8f8f8f', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms, color 120ms' }}>
        {CIRCLE_PLUS}
        <span style={{ marginLeft: 9, font: 'var(--rail-row-font)' }}>Add context</span>
      </button>
      {open && anchor && (
        <Hanging anchor={anchor} width={Math.max(285, anchor.width)} gap={4} panelRef={menuRef} data-rail-add-menu="1" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave} style={{ padding: 10 }}>
          {kind === 'conversations' ? (
            <>
              <div style={{ padding: '2px 10px 8px', font: '500 12px/1.4 var(--font-sans)', color: '#737373' }}>New conversation</div>
              {[['claude', 'Claude Code'], ['codex', 'Codex']].map(([provider, label]) => (
                <button key={provider} type="button" className="hov-wash" data-conversation-provider={provider} disabled={busy}
                  onClick={() => make(() => onNewConversation(provider))} style={menuRow}>
                  <Glyph item={{ type: 'chat' }} /><span style={menuText}>{label}</span>
                </button>
              ))}
              {error && <div data-add-error="1" style={{ padding: '6px 10px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
            </>
          ) : view === 'github' ? (
            <>
              <GithubPane library={library} inRail={inRail} busy={busy} onBack={() => { setView('menu'); setError(''); }} onPick={(entry) => make(() => onPickRepo(entry))} />
              {error && <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</div>}
            </>
          ) : (<>
          {kind !== 'context' && <div style={{ padding: '2px 2px 9px', font: '500 12px/1.4 var(--font-sans)', color: '#525252' }}>{actionLabel}</div>}
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
          {typed ? (<>
            {results.map((result, i) => (
              <button key={result.key} type="button" data-add-result={result.key} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => pickResult(result)} onMouseMove={() => { if (idx !== i) setIdx(i); }} style={{ ...menuRow, background: i === at ? '#f2f2f2' : 'transparent' }}>
                <Glyph item={glyphItem(result)} />
                <span style={{ ...menuText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.name}</span>
                {/^new\b/.test(result.tag)
                  ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>
                  : <span style={{ flex: 'none', font: '500 10px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{result.tag}</span>}
              </button>
            ))}
            {(searchProblem || error) && <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{searchProblem || error}</div>}
          </>) : (<>
          {kind === 'context' && <>
          <button type="button" className="hov-wash" data-new="note" disabled={busy} onClick={() => make(onNewNote)} style={menuRow}>
            <Glyph item={{ type: 'md', tags: ['note'] }} />
            <span style={menuText}>Document</span>
          </button>
          <button type="button" className="hov-wash" data-new="workspace" disabled={busy} onClick={() => make(onNewChild)} style={{ ...menuRow, marginTop: 2 }}>
            <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#171717' }}><WsMark size={12} stroke={1.6} /></span>
            <span style={menuText}>Sub-Workspace</span>
          </button>
          <div style={{ height: 1, margin: '6px 0 8px', background: '#eaeaea' }} />
          </>}
          <div className="rail-field" style={{ display: 'flex', alignItems: 'center', boxSizing: 'border-box', padding: '0 10px', marginBottom: 4, background: '#fafafa', border: `1px solid ${border}`, borderRadius: 6, transition: 'border-color 120ms' }}>
            <input
              ref={fieldRef}
              value={value}
              readOnly={busy}
              onChange={(event) => { setValue(event.target.value); setError(''); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
              }}
              placeholder={placeholder}
              aria-label="Link or path"
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
            />
          </div>
          {error && <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</div>}
          {!linkSection && <button type="button" className="hov-wash" disabled={busy} onClick={() => run(onPickDisk)} style={menuRow}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', display: 'block', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round' }}><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
            <span style={menuText}>Choose from disk…</span>
          </button>}
          {!linkSection && <button type="button" className="hov-wash" data-add-github="1" disabled={busy} onClick={fromGithub} style={{ ...menuRow, marginTop: 2 }}>
            <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><span style={{ display: 'flex', width: 13, height: 13 }}>{KIND.git.glyph}</span></span>
            <span style={menuText}>Add from GitHub…</span>
          </button>}
          {addable && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 0 0' }}>
              <button type="button" className="hov-dim" disabled={busy} onClick={commit} style={{ padding: '7px 12px', border: 0, borderRadius: 6, background: '#171717', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#fff' }}>{actionLabel}</button>
            </div>
          )}
          </>)}
          </>)}
        </Hanging>
      )}
    </div>
  );
}

function BarTip({ text, align, color = '#4d4d4d' }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 4px)', zIndex: 50, display: 'flex', justifyContent: align, pointerEvents: 'none' }}>
      <div role="tooltip" style={{ padding: '6px 9px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', color, font: '400 11.5px/1.3 var(--font-sans)', whiteSpace: 'nowrap', animation: `rise 120ms ${EASE}` }}>{text}</div>
    </div>
  );
}

// Above the bottom pictures (2026-09-22): the workspace to go to next — the one where an agent has finished and waits
// for you (the icon wears a blue dot), else the one written in before (model/nav.js). A click on it, or ⌘J, goes there
// with its tabs; its time and the key show on hover.
function NextRow({ next, projectId, onGo }) {
  const [tip, setTip] = React.useState(false);
  if (!next) return null;
  const when = ago(next.at);
  const words = [next.why === 'agent' ? `Bart answered ${when === 'now' ? 'just now' : `${when} ago`}` : `Edited ${when === 'now' ? 'just now' : `${when} ago`}`];
  if (next.waiting > 1) words.push(`${next.waiting} waiting`);
  words.push('⌘J');
  const elsewhere = next.projectId !== projectId;
  return (
    <div style={{ flex: 'none', position: 'relative', padding: '0 8px' }}>
      <button
        type="button"
        className="hov-wash2"
        data-next-workspace={next.workspaceId}
        data-next-why={next.why}
        onClick={() => { setTip(false); onGo(next); }}
        onMouseEnter={() => setTip(true)}
        onMouseLeave={() => setTip(false)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 'var(--rail-row-height)', boxSizing: 'border-box', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' }}
      >
        <span style={{ position: 'relative', flex: 'none', display: 'flex' }}>
          <Glyph item={{ type: 'workspace' }} box="var(--rail-icon-size)" size="var(--rail-icon-size)" />
          {next.why === 'agent' && <span data-needs-you="1" style={{ position: 'absolute', top: -2, right: -3, width: 7, height: 7, borderRadius: '50%', background: '#0070f3', boxShadow: '0 0 0 1.5px #fafafa' }} />}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: 'var(--rail-row-font)', color: isUntitled(next.name) ? '#8f8f8f' : '#171717' }}>
          {elsewhere && <span style={{ color: '#8f8f8f' }}>{next.projectName} / </span>}{next.name}
        </span>
        <span aria-hidden="true" style={{ flex: 'none', font: '14px/1 var(--font-sans)', color: '#4d4d4d' }}>→</span>
      </button>
      {tip && <BarTip text={words.join(' · ')} align="center" />}
    </div>
  );
}

const barButton = (enabled) => ({ flex: 'none', width: BAR_SIZE, aspectRatio: '1', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 10, background: 'transparent', cursor: enabled ? 'pointer' : 'default' });
const barPicture = { display: 'block', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' };

/** The trash and sticky note sit together at the bottom left: they size
 *  with the sidebar (52–96px) and name themselves on hover. */
function BottomBar({ trashRef, full, dragging, over, onTrashDragOver, onTrashDragEnter, onTrashDragLeave, onTrashDrop, postItTrash, onPostIt }) {
  const [tip, setTip] = React.useState(null);
  const [opened, setOpened] = React.useState(null); // the trash panel's anchor (the can's rect) while it is open
  const off = () => setTip(null);
  const closeTrash = React.useCallback(() => setOpened(null), []);
  const toggleTrash = (event) => {
    if (!postItTrash) return;
    const r = event.currentTarget.getBoundingClientRect();
    setTip(null);
    setOpened((now) => (now ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }));
  };
  return (
    <div data-rail-bar="1" style={{ flex: 'none', containerType: 'inline-size', padding: '6px 16px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8 }}>
        <div style={{ position: 'relative', display: 'flex' }}>
          <div
            ref={trashRef}
            data-trash={full ? 'full' : 'empty'}
            data-trash-over={over ? '1' : '0'}
            aria-label="Trash"
            role="button"
            tabIndex={postItTrash ? 0 : -1}
            aria-expanded={!!opened}
            onClick={toggleTrash}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleTrash(event); } }}
            onMouseEnter={() => setTip('trash')}
            onMouseLeave={off}
            onDragOver={onTrashDragOver}
            onDragEnter={onTrashDragEnter}
            onDragLeave={onTrashDragLeave}
            onDrop={onTrashDrop}
            // Something held over it (a row, or a post-it crumpling into it): the can grows, darkens its ground and shows
            // itself full, so letting go visibly lands (2026-09-22).
            style={{ ...barButton(!!postItTrash), transition: 'transform 120ms, opacity 120ms, background 120ms, box-shadow 120ms', transform: over ? 'scale(1.22)' : 'none', opacity: dragging || over || opened ? 1 : 0.7, background: over ? '#e8e8e8' : opened ? '#f2f2f2' : 'transparent', boxShadow: over ? 'inset 0 0 0 2px #171717' : 'none' }}
          >
            <img src={full || over ? trashFullPng : trashPng} alt="" draggable={false} style={{ ...barPicture, width: '90%', height: '90%' }} />
          </div>
          {tip === 'trash' && !dragging && !opened && <BarTip text="Trash" align="flex-start" />}
          {opened && postItTrash && <TrashPanel anchor={opened} trash={postItTrash} onClose={closeTrash} />}
        </div>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button type="button" className="bar-press" data-add-post-it="1" aria-label="Note" disabled={!onPostIt} onClick={onPostIt || undefined} onMouseEnter={() => setTip('note')} onMouseLeave={off} style={barButton(!!onPostIt)}>
            <img src={notePng} alt="" draggable={false} style={{ ...barPicture, width: '100%', height: '100%', transform: 'translateY(10%)' }} />
          </button>
          {tip === 'note' && <BarTip text="Note" align="center" />}
        </div>
      </div>
    </div>
  );
}

const SECTION_KIND = { workspaces: 'workspace', notes: 'note', github: 'git', papers: 'pdf', overleaf: 'overleaf', conversations: 'chat', other: 'folder' };
const SECTION_ADD_LABEL = { workspaces: 'Add workspace', notes: 'Add document', github: 'Add repository', papers: 'Add paper', overleaf: 'Add Overleaf project', conversations: 'Add conversation', other: 'Add context' };
const SECTION_EMPTY = { notes: 'No documents yet', github: 'No repositories yet', papers: 'No papers yet', overleaf: 'No Overleaf projects yet', conversations: 'No conversations yet' };
const SECTION_PLACEHOLDER = { github: 'GitHub repository URL', papers: 'Paper URL, DOI, or file path', overleaf: 'Overleaf project URL' };

export function RailSection({ id, label, children, onAdd, addDisabled, revealId }) {
  const [open, setOpen] = React.useState(!!revealId);
  React.useEffect(() => { if (revealId) setOpen(true); }, [revealId]);
  return <section className="rail-section" data-rail-section={id} aria-label={label}>
    <div className="rail-section-head">
      <button type="button" className="rail-section-heading" aria-label={label} title={label} aria-expanded={open} aria-controls={`rail-section-${id}`} onClick={() => setOpen(!open)}>
        <Chevron open={open} /><span className="rail-section-icon glyph-fit" aria-hidden="true">{KIND[SECTION_KIND[id]].glyph}</span>
        <span className="rail-section-label">{label}</span>
      </button>
      {onAdd && <button type="button" className="rail-icon-action rail-section-add" aria-label={SECTION_ADD_LABEL[id]} title={SECTION_ADD_LABEL[id]} disabled={addDisabled} onClick={onAdd}>+</button>}
    </div>
    <div id={`rail-section-${id}`} hidden={!open}>{children}</div>
  </section>;
}

function RailSubsection({ category, renderRow, onAdd, addDisabled, revealId }) {
  const [open, setOpen] = React.useState(!!revealId);
  React.useEffect(() => { if (revealId) setOpen(true); }, [revealId]);
  const contentId = `rail-subsection-${category.id}`;
  const toggle = () => setOpen((value) => !value);
  return <li data-rail-subsection={category.id}>
    <div className="workspace-tree-row rail-section-head">
      <button type="button" className="workspace-toggle rail-icon-action" aria-label={`${open ? 'Collapse' : 'Expand'} ${category.label}`} aria-expanded={open} aria-controls={contentId} onClick={toggle}><Chevron open={open} /></button>
      <Glyph kind={category.kind} box="var(--rail-icon-size)" size="var(--rail-icon-size)" color="#737373" />
      <button type="button" className="workspace-tree-name" aria-expanded={open} aria-controls={contentId} onClick={toggle}>{category.label}</button>
      {onAdd && <button type="button" className="rail-icon-action rail-section-add" aria-label={SECTION_ADD_LABEL[category.id]} title={SECTION_ADD_LABEL[category.id]} disabled={addDisabled} onClick={onAdd}>+</button>}
    </div>
    <div className="workspace-children" id={contentId} hidden={!open}>
      {category.rows.length === 0 && <p className="rail-empty">{category.empty}</p>}
      {category.rows.map(renderRow)}
    </div>
  </li>;
}

export default function Rail({
  width, topics = [], topic, allWorkspaces = [], onOpenDoc, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic,
  workspaces, onSelectWorkspace, onCreateWorkspace, onRenameWorkspace, onDeleteWorkspace,
  conversations = [], onNewConversation, onOpenConversation,
  rows, flashId, onRowClick, onRowRenameStart, onRowRename, onRowRenameEnd,
  library, inRail, onSearchPick, onAddInput, onPickDisk, onNewNote, onNewChild, onPickRepo, onOpenHeld,
  onTrashRow, trashFull, postItTrash, postItDrag, trashRef,
  next, projectId, onGoNext,
  onPostIt,
}) {
  const [peek, setPeek] = React.useState(null); // { row, rect }
  const [previews, setPreviews] = React.useState({}); // `${id}:${last_edited}` → previewLibraryItem's answer
  const [dragging, setDragging] = React.useState(null);
  const [overTrash, setOverTrash] = React.useState(false);
  const [menus, setMenus] = React.useState({ search: false, add: false });
  const [addRequest, setAddRequest] = React.useState(null);
  const searchRef = React.useRef(null);
  const timer = React.useRef(null);
  const itemRows = rows.filter((row) => row.type !== 'workspace' && row.type !== 'child');
  const sections = sidebarSections([...itemRows, ...conversations]);

  /* ------------------------------------------------------------------ peek */
  // After a beat on a row, what it is: the same card as the all-projects screen's library.
  const hold = () => { clearTimeout(timer.current); timer.current = null; };
  React.useEffect(() => hold, []);
  const openPeek = (row, element) => {
    hold();
    if (row.type === 'child' || dragging) return;
    if (peek && peek.row.id === row.id) return;
    timer.current = setTimeout(() => {
      if (!element.isConnected) return;
      const aside = element.closest('aside');
      // beside the sidebar, never over it (the design's max(300, …)), at the row's height
      setPeek({ row, rect: element.getBoundingClientRect(), edge: aside ? aside.getBoundingClientRect().right : 0 });
    }, peek ? PEEK_SWITCH : PEEK_OPEN);
  };
  const closePeek = () => { hold(); timer.current = setTimeout(() => setPeek(null), PEEK_CLOSE); };
  const dismissPeek = () => { hold(); setPeek(null); };
  const requestAdd = (section, event) => {
    dismissPeek();
    if (section === 'notes') onNewNote();
    else setAddRequest({ kind: section === 'other' ? 'context' : section, trigger: event.currentTarget });
  };
  const asked = React.useRef(new Set());
  const preview = React.useCallback((row) => {
    const key = `${row.id}:${row.last_edited || ''}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    api.previewLibraryItem(row.id).then((more) => setPreviews((now) => ({ ...now, [key]: more }))).catch(() => setPreviews((now) => ({ ...now, [key]: {} })));
  }, []);
  React.useEffect(() => { if (peek && peek.row.type !== 'image') preview(peek.row); }, [peek, preview]);
  const busyMenus = menus.search || menus.add;
  const setSearchOpen = React.useCallback((value) => setMenus((current) => (current.search === value ? current : { ...current, search: value })), []);
  const setAddOpen = React.useCallback((value) => setMenus((current) => (current.add === value ? current : { ...current, add: value })), []);

  /* ----------------------------------------------------------------- trash */
  const dragStart = (row, event) => {
    try { event.dataTransfer.setData(ROW_DRAG, row.id); event.dataTransfer.effectAllowed = 'move'; } catch { /* the drag still carries its row in state */ }
    hold();
    setPeek(null);
    setDragging(row.id);
  };
  const dragEnd = () => { setDragging(null); setOverTrash(false); };
  const trashDragOver = (event) => { if (!dragging) return; event.preventDefault(); try { event.dataTransfer.dropEffect = 'move'; } catch { /* fine */ } };
  const trashDragEnter = () => { if (dragging) setOverTrash(true); };
  const trashDragLeave = (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOverTrash(false); };
  const trashDrop = (event) => {
    event.preventDefault();
    const row = itemRows.find((candidate) => candidate.id === dragging);
    setDragging(null);
    setOverTrash(false);
    if (row) onTrashRow(row);
  };

  const peekLeft = peek ? Math.max(peek.rect.right, peek.edge) : 0;
  const peekTop = peek ? Math.max(54, Math.min(peek.rect.top - 12, window.innerHeight - 380)) : 0;
  const revealIdFor = (section) => section.rows.find((row) => row.id === flashId && row.tags?.includes('sticky'))?.id
    || section.children?.map(revealIdFor).find(Boolean);
  const renderRow = (row, section) => (
    <RailRow
      key={row.id}
      row={row}
      glyphKind={section.id === 'overleaf' || section.id === 'conversations' ? SECTION_KIND[section.id] : null}
      flash={flashId === row.id}
      faded={dragging === row.id}
      onClick={section.id === 'conversations' ? (row) => onOpenConversation(row.id) : onRowClick}
      onRenameStart={section.id === 'conversations' ? undefined : onRowRenameStart}
      onRename={onRowRename}
      onRenameEnd={onRowRenameEnd}
      onDragStart={section.id === 'conversations' ? undefined : dragStart}
      onDragEnd={dragEnd}
      onEnter={section.id === 'github' || section.id === 'conversations' ? dismissPeek : openPeek}
      onLeave={closePeek}
      onAdd={(event) => requestAdd(section.id, event)}
      addDisabled={!topic}
      addLabel={SECTION_ADD_LABEL[section.id]}
      onRemove={section.id === 'conversations' ? undefined : (removed) => { dismissPeek(); onTrashRow(removed); }}
    />
  );
  return (
    <aside className="workspace-sidebar" aria-label="Sidebar" style={{ flex: 'none', width, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 7, background: '#fafafa' }}>
      <div className="rail-workspace-wrap">
        <WorkspaceHeader topics={topics} topic={topic} all={allWorkspaces} onOpenDoc={onOpenDoc} onSelectTopic={onSelectTopic} onCycleTopic={onCycleTopic} onRenameTopic={onRenameTopic} onAddTopic={onAddTopic} />
      </div>
      <div className="rail-search-wrap">
        <LibrarySearch library={library} workspaces={workspaces} canAdd={!!topic} searchRef={searchRef} inRail={inRail} onPick={onSearchPick} previews={previews} onPreview={preview} onOpenHeld={onOpenHeld} onOpenChange={setSearchOpen} shut={menus.add} />
      </div>
      <div className="rail-sections" onScroll={() => { hold(); setPeek(null); }}>
        <RailSection id="workspaces" label="Sub-workspaces" onAdd={() => { dismissPeek(); onCreateWorkspace(null); }}>
          <WorkspaceTree workspaces={workspaces} currentId={topic?.id} onSelect={onSelectWorkspace} onCreate={onCreateWorkspace} onDelete={onDeleteWorkspace} onRename={onRenameWorkspace} flashId={flashId} />
        </RailSection>
        <div data-screen-label="Library" data-rail-library="1">
          {sections.map((section) => <RailSection key={section.id} id={section.id} label={section.label}
            revealId={revealIdFor(section)}
            onAdd={(event) => requestAdd(section.id, event)} addDisabled={!topic}>
            {section.children && <ul className="workspace-tree workspace-children">
              {section.children.map((category) => <RailSubsection key={category.id} category={category}
                revealId={revealIdFor(category)}
                onAdd={SECTION_ADD_LABEL[category.id] ? (event) => requestAdd(category.id, event) : undefined} addDisabled={!topic}
                renderRow={(row) => renderRow(row, SECTION_ADD_LABEL[category.id] ? category : section)} />)}
            </ul>}
            {section.rows.length === 0 && SECTION_EMPTY[section.id] && <p className="rail-empty">{SECTION_EMPTY[section.id]}</p>}
            {section.rows.map((row) => renderRow(row, section))}
          </RailSection>)}
        </div>
        <div className="rail-add-context">
          <AddToLibrary onAdd={onAddInput} onPickDisk={onPickDisk} onNewNote={onNewNote} onNewChild={onNewChild} onNewConversation={onNewConversation} onPickRepo={onPickRepo} onSearchPick={onSearchPick} library={library} workspaces={workspaces} inRail={inRail} onOpenChange={setAddOpen} shut={menus.search} request={addRequest} disabled={!topic} />
        </div>
      </div>
      <NextRow next={next} projectId={projectId} onGo={onGoNext} />
      <BottomBar
        trashRef={trashRef}
        full={trashFull}
        dragging={!!dragging || !!(postItDrag && postItDrag.active)}
        over={overTrash || !!(postItDrag && postItDrag.over)}
        onTrashDragOver={trashDragOver}
        onTrashDragEnter={trashDragEnter}
        onTrashDragLeave={trashDragLeave}
        onTrashDrop={trashDrop}
        postItTrash={postItTrash}
        onPostIt={onPostIt}
      />
      {peek && !dragging && !busyMenus && createPortal(
        // The wrapper reaches back over the gap to the row, so crossing the gap still counts as hovering.
        <div data-overlay="1" data-hover="1" data-rail-peek="1" onMouseEnter={hold} onMouseLeave={closePeek} style={{ position: 'fixed', zIndex: 60, left: peekLeft, top: peekTop, paddingLeft: PEEK_GAP }}>
          <div style={{ width: 380, maxHeight: Math.min(440, window.innerHeight - peekTop - 12), overflowY: 'auto', boxSizing: 'border-box', ...cardStyle }}>
            <ItemPeek row={peek.row} more={previews[`${peek.row.id}:${peek.row.last_edited || ''}`] || undefined} onOpenWorkspace={(projectId, workspaceId) => { setPeek(null); onOpenHeld(projectId, workspaceId); }} />
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
