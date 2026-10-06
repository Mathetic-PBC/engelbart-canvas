import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, kindOf, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { ADD_PANELS, looksAddable, railSections, RAIL_SECTIONS, searchRows } from '../model/rail.js';
import { ago, findWorkspaces } from '../model/nav.js';
import GithubPane from './GithubPane.jsx';
import { useAddRun } from './useAddRun.js';
import { usePlaced } from '../ui/usePlaced.js';
import { useBodies } from './useBodies.js';
import { carriesDrop, readDrop } from '../model/drop.js';
import { ItemPeek } from '../screens/Home.jsx';
import trashPng from '../../../design/assets/trash.png';
import trashFullPng from '../../../design/assets/trash-full.png';
import TrashPanel from '../post-its/TrashPanel.jsx';
import notePng from '../../../design/assets/yellow-sticky-note.png';

// The sidebar (Claude Design "Sidebar.dc.html", 2026-09-23, over "Canvas.dc.html" and "Add - Mention.dc.html" of
// 2026-09-22; Hudson's tweaks in design/goal-canvas/SIDEBAR-TWEAKS.md). From the top: the current workspace in a grey box,
// "Workspace" over its icon and name (a click opens the switcher: a search over every workspace of the project, the
// siblings, "+ New"; a double-click renames); the library search, which finds anything the library
// holds and brings it in; this workspace's rows under quiet section labels — Notes, Websites, GitHub, Files,
// Sub-Workspaces, Archived (model/rail.js railSections; always shown, closed until opened, the first carries Expand
// all; each but Archived has a + that adds its own kind, MATH-44) — where a hover peeks, a
// double-click renames and a drag onto the trash takes one out of this workspace; and "+ Add context", whose menu makes a
// Note or a Sub-Workspace here or adds something new to the library and to this workspace; files, a picture or a link
// dropped on these rows (MATH-19, 2026-10-05) are added and linked the same way. At the bottom, the workspace
// to go to next (an agent waiting there, else the one written in before; ⌘J), then two pictures that size with the
// sidebar: the trash (it takes post-its too and keeps them a week; a click lists them to restore; it shows paper once
// something is in it) and a sticky note that makes a post-it. Copy left for the document's lower left (2026-09-23).
// Every row's name is its own; nothing here explains itself.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const PEEK_OPEN = 350;
const PEEK_SWITCH = 90;
const PEEK_CLOSE = 180;
const MENU_CLOSE = 220;
const PEEK_GAP = 8;
const ROW_DRAG = 'application/x-engelbart-row';
const BAR_SIZE = 'clamp(52px, 24cqw, 96px)';

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
        style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '13px/1.5 var(--font-sans)', color: '#171717' }}
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
// the search. The switcher: a search that finds any workspace of the project by name, the sibling workspaces (the current
// one, bold, opens its own document), and "+ New". A
// double-click on the name renames it. A row's can, on hover (2026-09-30), deletes that workspace: into the trash, with
// what is nested in it.
function WorkspaceHeader({ topics, topic, all, onOpenDoc, onSelectTopic, onRenameTopic, onAddTopic, onDeleteTopic }) {
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
  // A hover opens it. A click on the name does not (2026-09-23): it closes the menu and opens this workspace's document.
  const open = () => { clearTimeout(timer.current); if (!editing) setHover(true); };
  const close = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!(fieldRef.current && document.activeElement === fieldRef.current) && !fieldRef.current?.value) shut(); }, MENU_CLOSE);
  };
  const openOwn = () => { if (editing || !topic) return; shut(); onOpenDoc(); };
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
    <div ref={boxRef} data-workspace-header="1" onMouseEnter={open} onMouseLeave={close} style={{ flex: 'none', position: 'relative', zIndex: 6, marginBottom: 16 }}>
      <div style={{ padding: '12px 12px 10px', background: '#f2f2f2', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ font: '500 12.5px/1.3 var(--font-sans)', color: '#8f8f8f' }}>Workspace</div>
        <div
          role="button"
          tabIndex={-1}
          aria-label="Open workspace"
          aria-expanded={hover}
          data-switch-workspace="1"
          onClick={openOwn}
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
                style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '600 14px/1.5 var(--font-sans)', color: '#171717' }}
              />
            )
            : <span data-workspace-name="1" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '600 14px/1.5 var(--font-sans)', color: untitled ? '#8f8f8f' : '#171717' }}>{topic ? topic.name : 'no workspace yet…'}</span>}
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
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: isUntitled(candidate.name) ? '#8f8f8f' : '#171717' }}>{candidate.name}</span>
                  {above.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '11.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{above.join(' / ')}</span>}
                </span>
                {onDeleteTopic && (
                  <button
                    type="button"
                    className="rail-minus"
                    data-delete-workspace={candidate.id}
                    aria-label={`Delete ${candidate.name}`}
                    title="Move to the trash"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => { event.stopPropagation(); onDeleteTopic(candidate.id); }}
                    style={{ flex: 'none', display: 'flex', margin: '-2px -2px -2px 0', padding: 2, border: 0, background: 'transparent', cursor: 'pointer', color: '#8f8f8f' }}
                  >
                    {TRASH_MARK}
                  </button>
                )}
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

// A switcher row's Delete (2026-09-30): a small can, drawn in the minus's line. A project card's Delete too (Home.jsx).
export const TRASH_MARK = (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block' }}>
    <path d="M2.5 4h11 M6.25 4V2.75a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75V4 M3.75 4l.7 9.1a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.7-9.1 M6.75 6.75v4.5 M9.25 6.75v4.5" />
  </svg>
);

// The minus on a row's right (2026-09-23, Hudson's flaticon "minus" 992683: a ring with a bar, the + row's mirror).
const CIRCLE_MINUS = (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M5.5 9h7" />
  </svg>
);

// An archived version of the workspace (2026-09-25): a sheet in a box, the Archived section's rows.
const ARCHIVE_MARK = (
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <rect x="1.75" y="2.5" width="12.5" height="3.25" rx="0.8" />
    <path d="M2.75 5.75v6.75a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V5.75" />
    <path d="M6.5 8.5h3" />
  </svg>
);

/** When a version was cleared, the short way: "Sep 25, 14:03". */
const clearedLabel = (iso) => { const at = new Date(iso || ''); return Number.isNaN(at.getTime()) ? '' : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`; };

function RailRow({ row, flash, faded, onClick, onRenameStart, onRename, onRenameEnd, onDragStart, onDragEnd, onEnter, onLeave, onRemove, onRestore }) {
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
  return (
    <div
      data-rail-row={row.id}
      className="hov-wash"
      draggable={draggable}
      onDragStart={draggable ? (event) => onDragStart(row, event) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={(event) => { if (!row.editing) onClick(row, event); }}
      onDoubleClick={(event) => { if (row.type === 'workspace' || row.type === 'archive') return; event.stopPropagation(); onRenameStart(row); }}
      onMouseEnter={onEnter ? (event) => onEnter(row, event.currentTarget) : undefined}
      onMouseLeave={onLeave}
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box', borderRadius: 6, cursor: 'pointer',
        width: '100%', margin: 0, padding: '8px 10px',
        background: row.on ? '#fff' : 'transparent', boxShadow: row.on ? '0 1px 3px #0000000a, 0 0 0 1px #eaeaea' : 'none',
        opacity: faded ? 0.4 : 1, animation: flash ? 'added 1600ms ease-out' : undefined, transition: 'background 120ms',
      }}
    >
      {row.type === 'child'
        ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><WsMark size={15} stroke={1.5} /></span>
        : row.type === 'archive'
          ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d' }}>{ARCHIVE_MARK}</span>
          : <Glyph item={row} />}
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
            style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: '#171717' }}
          />
        )
        : row.type === 'archive'
          ? (
            <span data-archive={row.file} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '400 14px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{row.name}</span>
              <span style={{ font: '11.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{clearedLabel(row.clearedAt)}</span>
            </span>
          )
          : <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: isUntitled(row.name) ? '#8f8f8f' : '#171717' }}>{row.name}</span>}
      {onRestore && (
        <button
          type="button"
          className="rail-minus"
          data-rail-restore={row.file}
          aria-label={`Make ${row.name} the current document again`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onRestore(row); }}
          onDoubleClick={(event) => event.stopPropagation()}
          style={{ flex: 'none', margin: '-2px 0', padding: '2px 4px', border: 0, background: 'transparent', cursor: 'pointer', font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}
        >
          Restore
        </button>
      )}
      {onRemove && !row.editing && (
        <button
          type="button"
          className="rail-minus"
          data-rail-remove={row.id}
          aria-label={`Take ${row.name} out of this workspace`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onRemove(row); }}
          onDoubleClick={(event) => event.stopPropagation()}
          style={{ flex: 'none', display: 'flex', margin: '-2px -2px -2px 0', padding: 2, border: 0, background: 'transparent', cursor: 'pointer', color: '#8f8f8f' }}
        >
          {CIRCLE_MINUS}
        </button>
      )}
    </div>
  );
}

// A section header's + (MATH-44): a plain cross, in the minus's line weight.
const SECTION_PLUS = (
  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <path d="M6 1.5v9 M1.5 6h9" />
  </svg>
);

// One of the sidebar's sections (Sidebar.dc.html): a quiet grey label led by a › that darkens while the pointer is on it
// and turns down while the section is open; a click folds it. The first section carries "Collapse all" / "Expand all".
// A section with `onAdd` has a + at the header's right (MATH-44, 2026-10-06), before "Expand all": grey, dark under the
// pointer or while its panel is open (`panelOpen`); a click adds that kind of thing (Rail's addTo), given the header's rect
// to hang a panel from, and never folds the section.
function RailSection({ section, open, onToggle, all, onAdd, panelOpen = false, children }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div data-rail-section={section.key} style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <button
          type="button"
          className="hov-ink"
          onClick={onToggle}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-expanded={open}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box', padding: '10px 10px 4px', border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', color: '#8f8f8f', transition: 'color 120ms' }}
        >
          <span aria-hidden="true" style={{ flex: 'none', width: 10, display: 'inline-flex', justifyContent: 'center', font: '400 12px/1 var(--font-sans)', opacity: hover ? 1 : 0.7, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms, opacity 120ms' }}>›</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 12.5px/1.3 var(--font-sans)' }}>{section.label}</span>
        </button>
        {onAdd && (
          <button
            type="button"
            className="hov-ink"
            data-rail-section-add={section.key}
            aria-label={`Add to ${section.label}`}
            aria-expanded={panelOpen || undefined}
            onClick={(event) => { event.stopPropagation(); onAdd(rectOf(event.currentTarget.parentElement)); }}
            style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, margin: all ? '10px 8px 4px 0' : '10px 10px 4px 0', padding: 0, border: 0, borderRadius: 4, background: 'transparent', cursor: 'pointer', color: panelOpen ? '#171717' : '#8f8f8f', transition: 'color 120ms' }}
          >
            {SECTION_PLUS}
          </button>
        )}
        {all && <button type="button" data-rail-fold-all="1" onClick={all.onClick} style={{ flex: 'none', margin: '10px 10px 4px 0', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '400 11.5px/1.4 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}>{all.label}</button>}
      </div>
      {open && (section.rows.length
        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
        : <div data-rail-empty="1" style={{ padding: '4px 10px 6px', font: '400 12.5px/1.4 var(--font-sans)', color: '#c9c9c9' }}>None yet</div>)}
    </div>
  );
}

// Which sections are open, kept for the next time the app opens (a convenience of this machine: storage may refuse).
// Every section starts closed (2026-09-29); the old key remembered the folded ones, so it is left behind.
const OPEN_KEY = 'engelbart.rail.open';
function readOpen() {
  try { const saved = JSON.parse(window.localStorage.getItem(OPEN_KEY) || '{}'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
}
function useOpen() {
  const [opened, setOpened] = React.useState(readOpen);
  React.useEffect(() => { try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(opened)); } catch { /* not remembered */ } }, [opened]);
  return [opened, setOpened];
}

// A panel that hangs from something in the sidebar (the search field, the + row). Fixed to the window, so the sidebar's
// scrolling never cuts it off; under what it hangs from, or above it near the bottom (ui/usePlaced.js).
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
const glyphItem = (result) => (result.kind === 'item' ? result.row : result.found);
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
function LibrarySearch({ projectId, library, inRail, onPick, previews, onPreview, onOpenHeld, onOpenChange, shut }) {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null); // { query, result } — what the main process said an address or a path is
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const boxRef = React.useRef(null);
  const inputRef = React.useRef(null);
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
  const bodies = useBodies(projectId, open); // what things say, matched too (MATH-29)
  const rows = open ? searchRows({ query: q, library, inRail, found: answer, bodies }) : [];
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
    <div data-rail-search="1" style={{ flex: 'none', position: 'relative', margin: '0 0 2px' }}>
      <div ref={boxRef} className="rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box', padding: '0 10px', border: `1px solid ${open ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 8, background: '#fff', transition: 'border-color 120ms' }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2.6" strokeLinecap="round" style={{ flex: 'none' }}><circle cx="10" cy="10" r="6.5" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
        <input
          ref={inputRef}
          value={q}
          readOnly={busy}
          onChange={(event) => { setQ(event.target.value); setIdx(0); setNote(''); setOpen(true); }}
          onKeyDown={onKey}
          onFocus={() => { if (!open) { setOpen(true); setIdx(0); } }}
          placeholder="Search"
          aria-label="Search the library"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, background: 'transparent', font: '14px/1.5 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
        />
        {q && <button type="button" className="hov-ink" onMouseDown={(event) => event.preventDefault()} onClick={() => { setQ(''); setIdx(0); setNote(''); if (inputRef.current) inputRef.current.focus(); }} aria-label="Clear" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>}
      </div>
      {showList && (
        <Hanging anchor={anchor} width={anchor.width} cap={Math.max(160, window.innerHeight - 220)} panelRef={listRef} data-rail-results="1" style={{ padding: 4, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((result, i) => (
            <button key={result.key} type="button" data-result={result.key} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(result)} onMouseEnter={() => { if (idx !== i) setIdx(i); }} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: i === at ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer' }}>
              <Glyph item={glyphItem(result)} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '14px/1.5 var(--font-sans)', color: '#171717' }}>{result.name}</span>
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

// "+ Add context" under the sections (Sidebar.dc.html, 2026-09-23; a click opens its menu and a second click or a click
// elsewhere closes it, 2026-09-29, where hovering used to open it): a search over the library first (the sidebar's search again, closer to hand: typing lists what it finds
// in place of the rest), then a new Note or Sub-Workspace made here, then a link, a path or files from disk, or a
// repository from GitHub, that become new rows, in the library and in this workspace. The home page's library uses the
// same menu (2026-09-28), without Note and Sub-Workspace: there is no workspace there to make them in.
const CIRCLE_PLUS = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flex: 'none', display: 'block' }}>
    <circle cx="9" cy="9" r="7.5" />
    <path d="M9 5.5v7 M5.5 9h7" />
  </svg>
);

// The pieces "+ Add context" shares with the Websites and GitHub +'s (MATH-44): what went wrong, the field for a link or
// a path, its "Add to library", and the GitHub view.

function AddError({ children, style }) {
  return <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere', ...style }}>{children}</div>;
}

/** "Upload URL or path": Enter adds what is typed (`onEnter`), Escape closes (`onEscape`); red while it went wrong. */
function LinkField({ inputRef, value, busy, error, onChange, onEnter, onEscape }) {
  const border = error ? '#e70022' : value ? '#c9c9c9' : '#eaeaea';
  return (
    <div className="rail-field" style={{ display: 'flex', alignItems: 'center', boxSizing: 'border-box', padding: '0 10px', marginBottom: 4, background: '#fafafa', border: `1px solid ${border}`, borderRadius: 6, transition: 'border-color 120ms' }}>
      <input
        ref={inputRef}
        value={value}
        readOnly={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); onEnter(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape(); }
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

/** Signing in to GitHub, then its repositories (GithubPane), with what went wrong adding the one picked. */
function GithubView({ library, inRail, busy, error, onBack, onPick }) {
  return (
    <>
      <GithubPane library={library} inRail={inRail} busy={busy} onBack={onBack} onPick={onPick} />
      {error && <AddError>{error}</AddError>}
    </>
  );
}

export function AddToLibrary({ projectId = null, onAdd, onPickDisk, onNewNote, onNewChild, onPickRepo, onSearchPick, library, inRail, onOpenChange, shut }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState(''); // the search at the top of the menu
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null); // { query, result }: what the main process said an address or a path is
  const searchRef = React.useRef(null);
  const [view, setView] = React.useState('menu'); // 'menu' | 'github' (GithubPane: signing in, then the repositories)
  const [value, setValue] = React.useState('');
  const { busy, error, setError, run } = useAddRun(() => hide()); // done: the menu closes
  const [anchor, setAnchor] = React.useState(null);
  const rowRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const wantFocus = React.useRef(false);
  const live = React.useRef({ busy: false });
  live.current = { busy };
  React.useEffect(() => { if (onOpenChange) onOpenChange(open); }, [open, onOpenChange]);
  // The field takes the keyboard as soon as the menu shows, so a link can be pasted straight away. Not in the ref: the
  // panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes no focus.
  React.useEffect(() => {
    if (!open || !wantFocus.current) return undefined;
    const timer = setTimeout(() => {
      const naming = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-rename]'); // a name being typed on the rail keeps the keyboard
      if (naming) { wantFocus.current = false; return; }
      if (searchRef.current) { searchRef.current.focus({ preventScroll: true }); wantFocus.current = false; }
    }, 0);
    return () => clearTimeout(timer);
  }, [open, anchor]);

  const hide = React.useCallback(() => { setOpen(false); setValue(''); setError(''); setView('menu'); setQ(''); setIdx(0); }, [setError]);
  React.useEffect(() => { if (shut && open && !live.current.busy) hide(); }, [shut]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = () => {
    if (open) return;
    if (rowRef.current) setAnchor(rectOf(rowRef.current));
    wantFocus.current = true;
    setValue('');
    setError('');
    setOpen(true);
  };
  const toggle = () => { if (!open) show(); else if (!busy) hide(); };
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (live.current.busy) return; if (![rowRef, menuRef].some((ref) => ref.current && ref.current.contains(event.target))) hide(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open, hide]);

  const commit = () => { const input = value.trim(); if (input && !busy) void run(async () => { await onAdd(input); return []; }); };
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
  const bodies = useBodies(projectId, open); // what things say, matched too (MATH-29); the home page's library has no project
  const results = typed ? searchRows({ query: typed, library, inRail, found: answer, bodies }) : [];
  const at = results.length ? Math.min(idx, results.length - 1) : -1;
  const pickResult = (result) => { if (result && !busy) void run(async () => { await onSearchPick(result, typed); return []; }); };
  const onSearchKey = (event) => {
    const n = results.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pickResult(results[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (q) { setQ(''); setIdx(0); } else hide(); }
  };
  const searchProblem = (answer && answer.error) || '';
  const menuRow = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' };
  const menuText = { flex: 1, minWidth: 0, font: '14px/1.5 var(--font-sans)', color: '#171717' };
  return (
    <div data-rail-add="1" style={{ flex: 'none', position: 'relative' }}>
      <button ref={rowRef} type="button" className="hov-wash" onClick={toggle} aria-label="Add context" aria-expanded={open} style={{ display: 'flex', alignItems: 'center', width: '100%', boxSizing: 'border-box', padding: '6px 10px 8px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', color: open ? '#171717' : '#8f8f8f', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms, color 120ms' }}>
        {CIRCLE_PLUS}
        <span style={{ marginLeft: 9, font: '14px/1.5 var(--font-sans)' }}>Add context</span>
      </button>
      {open && anchor && (
        <Hanging anchor={anchor} width={anchor.width} gap={4} panelRef={menuRef} data-rail-add-menu="1" style={{ padding: 10 }}>
          {view === 'github' ? (
            <GithubView library={library} inRail={inRail} busy={busy} error={error} onBack={() => { setView('menu'); setError(''); }} onPick={(entry) => make(() => onPickRepo(entry))} />
          ) : (<>
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
            {(searchProblem || error) && <AddError>{searchProblem || error}</AddError>}
          </>) : (<>
          {onNewNote && (
            <button type="button" className="hov-wash" data-new="note" disabled={busy} onClick={() => make(onNewNote)} style={menuRow}>
              <Glyph item={{ type: 'md', tags: ['note'] }} />
              <span style={menuText}>Note</span>
            </button>
          )}
          {onNewChild && (
            <button type="button" className="hov-wash" data-new="workspace" disabled={busy} onClick={() => make(onNewChild)} style={{ ...menuRow, marginTop: 2 }}>
              <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#171717' }}><WsMark size={12} stroke={1.6} /></span>
              <span style={menuText}>Sub-Workspace</span>
            </button>
          )}
          {(onNewNote || onNewChild) && <div style={{ height: 1, margin: '6px 0 8px', background: '#eaeaea' }} />}
          <LinkField inputRef={fieldRef} value={value} busy={busy} error={error} onChange={(next) => { setValue(next); setError(''); }} onEnter={commit} onEscape={hide} />
          {error && <AddError>{error}</AddError>}
          <button type="button" className="hov-wash" disabled={busy} onClick={() => run(onPickDisk)} style={menuRow}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', display: 'block', fill: 'none', stroke: '#171717', strokeWidth: 1.3, strokeLinejoin: 'round' }}><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
            <span style={menuText}>Choose from disk…</span>
          </button>
          <button type="button" className="hov-wash" data-add-github="1" disabled={busy} onClick={fromGithub} style={{ ...menuRow, marginTop: 2 }}>
            <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><span style={{ display: 'flex', width: 13, height: 13 }}>{KIND.git.glyph}</span></span>
            <span style={menuText}>Add from GitHub…</span>
          </button>
          {addable && <LinkAddButton busy={busy} onClick={commit} />}
          </>)}
          </>)}
        </Hanging>
      )}
    </div>
  );
}

// What a section's + hangs under its header (MATH-44, 2026-10-06): for Websites the field for a link or a path and
// "Add to library", for GitHub the repository picker, for the others (which add at once) only what went wrong. `at`
// { key, kind, anchor }; `adding` is the Rail's useAddRun, which closes it once something is added. Escape, a press
// elsewhere or the search or "+ Add context" opening (`shut`) close it, never while it is adding. The + it hangs from
// toggles it.
function SectionPanel({ at, adding, library, inRail, onAddInput, onPickRepo, onClose, shut }) {
  const { key, kind, anchor } = at;
  const { busy, error, setError, run } = adding;
  const [value, setValue] = React.useState('');
  const panelRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const live = React.useRef(busy);
  live.current = busy;
  const close = React.useCallback(() => { if (!live.current) onClose(); }, [onClose]);
  const was = React.useRef(shut);
  React.useEffect(() => { if (shut && !was.current) close(); was.current = shut; }, [shut, close]);
  React.useEffect(() => {
    const away = (event) => {
      if (panelRef.current && panelRef.current.contains(event.target)) return;
      if (event.target.closest && event.target.closest(`[data-rail-section-add="${key}"]`)) return; // its + toggles it
      close();
    };
    // The panel is on top, so Escape is its first, wherever the keyboard is; taken here, so neither an editor nor the
    // workspace's own Escape (which leaves the workspace) sees it. While it is adding it cannot close, so the key goes on
    // to whatever has the keyboard (a terminal, an editor); only on the panel itself or the page is it still taken.
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      const own = (panelRef.current && panelRef.current.contains(event.target)) || event.target === document.body || event.target === document.documentElement;
      if (live.current && !own) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', escape, true); };
  }, [key, close]);
  // Placed again when what it holds changes its size (GitHub's sign-in state and repositories arrive after it opens),
  // so near the bottom of the window it moves above the header rather than running off.
  const [, replace] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => replace());
    watch.observe(panel);
    return () => watch.disconnect();
  }, []);
  // The field takes the keyboard once the panel shows (it is invisible for the frame it measures itself in).
  React.useEffect(() => {
    if (kind !== 'link') return undefined;
    const timer = setTimeout(() => { if (fieldRef.current) fieldRef.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [kind]);

  const commit = () => { const input = value.trim(); if (input && !busy) void run(async () => { await onAddInput(input); return []; }); };
  const pick = (entry) => { if (!busy) void run(async () => { await onPickRepo(entry); return []; }); };
  return (
    <Hanging anchor={anchor} width={anchor.width} gap={4} panelRef={panelRef} data-rail-section-panel={key} style={{ padding: 10 }}>
      {kind === 'github' && <GithubView library={library} inRail={inRail} busy={busy} error={error} onBack={close} onPick={pick} />}
      {kind === 'link' && (
        <>
          <LinkField inputRef={fieldRef} value={value} busy={busy} error={error} onChange={(next) => { setValue(next); setError(''); }} onEnter={commit} onEscape={close} />
          {error && <AddError>{error}</AddError>}
          <LinkAddButton busy={busy} disabled={!value.trim()} onClick={commit} />
        </>
      )}
      {!ADD_PANELS.has(kind) && <AddError style={{ padding: '0 2px' }}>{error}</AddError>}
    </Hanging>
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
// with its tabs. Hovering it (2026-09-23) lists every workspace kept for going back to (model/nav.js placesToGo), each
// with its time, ⌘J's one marked; a click on one opens it in place of this one.
function NextRow({ next, places = [], projectId, onGo }) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  if (!next) return null;
  const enter = () => { clearTimeout(timer.current); setOpen(true); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), MENU_CLOSE); };
  const go = (place) => { clearTimeout(timer.current); setOpen(false); onGo(place); };
  const when = (at) => { const since = ago(at); return since === 'now' ? 'just now' : since ? `${since} ago` : ''; };
  const list = places.length ? places : [{ ...next, next: true }];
  return (
    <div data-next-row="1" onMouseEnter={enter} onMouseLeave={leave} style={{ flex: 'none', position: 'relative', padding: '0 8px' }}>
      <button
        type="button"
        className="hov-wash2"
        data-next-workspace={next.workspaceId}
        data-next-why={next.why}
        onClick={() => go(next)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: 0, borderRadius: 6, background: open ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' }}
      >
        <PlaceMark why={next.why} ground="#fafafa" />
        <PlaceName place={next} projectId={projectId} size={13.5} />
        <span aria-hidden="true" style={{ flex: 'none', font: '14px/1 var(--font-sans)', color: '#4d4d4d' }}>→</span>
      </button>
      {open && (
        // The wrapper reaches down over the gap to the row, so crossing it still counts as hovering.
        <div style={{ position: 'absolute', left: 8, right: 8, bottom: '100%', zIndex: 50, paddingBottom: 4 }}>
          <div role="menu" data-overlay="1" data-next-list="1" style={{ maxHeight: 'min(360px, calc(100vh - 200px))', overflowY: 'auto', boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 2, animation: `rise 120ms ${EASE}` }}>
            {list.map((place) => (
              <button
                key={`${place.projectId}/${place.workspaceId}`}
                type="button"
                role="menuitem"
                className="hov-wash"
                data-next-place={place.workspaceId}
                onClick={() => go(place)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '7px 8px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms' }}
              >
                <PlaceMark why={place.why} ground="#fff" />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <PlaceName place={place} projectId={projectId} size={13.5} />
                  <span style={{ font: '11.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{place.why === 'agent' ? `${place.kind === 'build' ? 'Build finished a turn' : place.kind === 'brainstorm' ? 'Brainstorm asked' : place.kind === 'discover' ? 'Discover found reading' : 'Bart answered'} ${when(place.at)}` : `Edited ${when(place.at)}`}</span>
                </span>
                {place.next && <span style={{ flex: 'none', font: '11.5px/1 var(--font-sans)', color: '#8f8f8f' }}>⌘J</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlaceMark({ why, ground }) {
  return (
    <span style={{ position: 'relative', flex: 'none', display: 'flex' }}>
      <Glyph item={{ type: 'workspace' }} />
      {why === 'agent' && <span data-needs-you="1" style={{ position: 'absolute', top: -2, right: -3, width: 7, height: 7, borderRadius: '50%', background: '#0070f3', boxShadow: `0 0 0 1.5px ${ground}` }} />}
    </span>
  );
}

function PlaceName({ place, projectId, size }) {
  return (
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${size}px/1.5 var(--font-sans)`, color: isUntitled(place.name) ? '#8f8f8f' : '#171717' }}>
      {place.projectId !== projectId && <span style={{ color: '#8f8f8f' }}>{place.projectName} / </span>}{place.name}
    </span>
  );
}

const barButton = (enabled) => ({ flex: 'none', width: BAR_SIZE, aspectRatio: '1', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 10, background: 'transparent', cursor: enabled ? 'pointer' : 'default' });
const barPicture = { display: 'block', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' };

/** Beside the sticky (2026-09-29): a "Show stickies" switch on a grey pill (2026-10-02: the words stay put and the
 *  switch alone says on or off). It takes every sticky out of sight or brings them back; it never makes or deletes one. */
function StickiesToggle({ hidden, onToggle }) {
  const on = !hidden;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="stickies-toggle"
      data-toggle-post-its={hidden ? 'hidden' : 'shown'}
      onClick={onToggle}
      title={on ? 'Hide the stickies' : 'Show the stickies'}
      style={{ flex: '0 1 auto', minWidth: 0, marginLeft: 2, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 4px', border: 0, borderRadius: 999, background: '#f2f2f2', cursor: 'pointer', font: '400 12px/1.3 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}
    >
      <span className="stickies-track" style={{ flex: 'none', position: 'relative', width: 24, height: 14, borderRadius: 999, background: on ? '#171717' : '#c9c9c9' }}>
        <span data-knob="1" style={{ position: 'absolute', top: 2, left: 2, width: 10, height: 10, borderRadius: '50%', background: '#fff', transform: on ? 'translateX(10px)' : 'none' }} />
      </span>
      <span className="stickies-word" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>Show stickies</span>
    </button>
  );
}

/** The two pictures at the bottom left, the trash and the sticky beside it (2026-09-23): they size with the sidebar
 *  (52–96px) and name themselves on hover; the stickies' show/hide switch follows them. */
function BottomBar({ trashRef, full, dragging, over, onTrashDragOver, onTrashDragEnter, onTrashDragLeave, onTrashDrop, postItTrash, workspaceTrash, onPostIt, postItsHidden, onTogglePostIts }) {
  const [tip, setTip] = React.useState(null);
  const [opened, setOpened] = React.useState(null); // the trash panel's anchor (the can's rect) while it is open
  const off = () => setTip(null);
  const closeTrash = React.useCallback(() => setOpened(null), []);
  const openable = !!postItTrash || !!(workspaceTrash && workspaceTrash.rows.length);
  React.useEffect(() => { if (!openable) setOpened(null); }, [openable]);
  const toggleTrash = (event) => {
    if (!openable) return;
    const r = event.currentTarget.getBoundingClientRect();
    setTip(null);
    setOpened((now) => (now ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }));
  };
  return (
    <div data-rail-bar="1" style={{ flex: 'none', containerType: 'inline-size', padding: '6px 16px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6 }}>
        <div style={{ position: 'relative', display: 'flex' }}>
          <div
            ref={trashRef}
            data-trash={full ? 'full' : 'empty'}
            data-trash-over={over ? '1' : '0'}
            aria-label="Trash"
            role="button"
            tabIndex={openable ? 0 : -1}
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
            // itself full, so letting go visibly lands (2026-09-22). No ring around it, drawn or focus (2026-09-23).
            style={{ ...barButton(openable), outline: 'none', transition: 'transform 120ms, opacity 120ms, background 120ms', transform: over ? 'scale(1.22)' : 'none', opacity: dragging || over || opened ? 1 : 0.7, background: over ? '#e8e8e8' : opened ? '#f2f2f2' : 'transparent' }}
          >
            <img src={full || over ? trashFullPng : trashPng} alt="" draggable={false} style={{ ...barPicture, width: '90%', height: '90%' }} />
          </div>
          {tip === 'trash' && !dragging && !opened && <BarTip text="Trash" align="flex-start" />}
          {opened && openable && <TrashPanel anchor={opened} trash={postItTrash} workspaces={workspaceTrash} onClose={closeTrash} />}
        </div>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button type="button" className="bar-press" data-add-post-it="1" aria-label="New sticky" disabled={!onPostIt} onClick={onPostIt || undefined} onMouseEnter={() => setTip('note')} onMouseLeave={off} style={barButton(!!onPostIt)}>
            <img src={notePng} alt="" draggable={false} style={{ ...barPicture, width: '100%', height: '100%', transform: 'translateY(10%)' }} />
          </button>
          {tip === 'note' && <BarTip text="Sticky" align="flex-start" />}
        </div>
        {onTogglePostIts && <StickiesToggle hidden={!!postItsHidden} onToggle={onTogglePostIts} />}
      </div>
    </div>
  );
}

export default function Rail({
  width, topics, topic, allWorkspaces, onOpenDoc, onSelectTopic, onRenameTopic, onAddTopic, onDeleteTopic,
  rows, flashId, onRowClick, onRowRenameStart, onRowRename, onRowRenameEnd,
  library, inRail, onSearchPick, onAddInput, onPickDisk, onNewNote, onNewChild, onPickRepo, onOpenHeld, onDropItems,
  onTrashRow, onRestoreArchive, trashFull, postItTrash, workspaceTrash, postItDrag, trashRef,
  next, places, projectId, onGoNext,
  onPostIt, postItsHidden, onTogglePostIts,
  hidden = false, // the document's full screen (MATH-23): out of sight, kept as it is
}) {
  const [peek, setPeek] = React.useState(null); // { row, rect }
  const [previews, setPreviews] = React.useState({}); // `${id}:${last_edited}` → previewLibraryItem's answer
  const [dragging, setDragging] = React.useState(null);
  const [overTrash, setOverTrash] = React.useState(false);
  const [dropping, setDropping] = React.useState(false); // files or a link held over the library rows
  // What is open over the sidebar, one at a time: the search's list, the "+ Add context" menu, and a section +'s panel
  // (`section` { key, kind, anchor }, MATH-44; set too while a + that adds at once is at work).
  const [menus, setMenus] = React.useState({ search: false, add: false, section: null });
  const [opened, setOpened] = useOpen(); // section key → unfolded
  const timer = React.useRef(null);
  const itemRows = rows;
  const sections = railSections(rows);
  const anyShut = sections.some((section) => !opened[section.key]);
  const foldAll = { label: anyShut ? 'Expand all' : 'Collapse all', onClick: () => setOpened(anyShut ? Object.fromEntries(RAIL_SECTIONS.map((section) => [section.key, true])) : {}) };
  // A row that just arrived (added from the search or Add context) opens its section, once, so it is seen arriving.
  const shown = React.useRef(null);
  React.useEffect(() => {
    if (!flashId || shown.current === flashId) return;
    const home = sections.find((section) => section.rows.some((row) => row.id === flashId));
    if (!home) return;
    shown.current = flashId;
    setOpened((now) => (now[home.key] ? now : { ...now, [home.key]: true }));
  }, [flashId, sections, setOpened]);

  /* ------------------------------------------------------------------ peek */
  // After a beat on a row, what it is: the same card as the all-projects screen's library.
  const hold = () => { clearTimeout(timer.current); timer.current = null; };
  React.useEffect(() => hold, []);
  const openPeek = (row, element) => {
    hold();
    if (row.type === 'child' || row.type === 'archive' || dragging) return;
    if (peek && peek.row.id === row.id) return;
    timer.current = setTimeout(() => {
      if (!element.isConnected) return;
      const aside = element.closest('aside');
      // beside the sidebar, never over it (the design's max(300, …)), at the row's height
      setPeek({ row, rect: element.getBoundingClientRect(), edge: aside ? aside.getBoundingClientRect().right : 0 });
    }, peek ? PEEK_SWITCH : PEEK_OPEN);
  };
  const closePeek = () => { hold(); timer.current = setTimeout(() => setPeek(null), PEEK_CLOSE); };
  const asked = React.useRef(new Set());
  const preview = React.useCallback((row) => {
    const key = `${row.id}:${row.last_edited || ''}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    api.previewLibraryItem(row.id).then((more) => setPreviews((now) => ({ ...now, [key]: more }))).catch(() => setPreviews((now) => ({ ...now, [key]: {} })));
  }, []);
  React.useEffect(() => { if (peek && peek.row.type !== 'image') preview(peek.row); }, [peek, preview]);
  const busyMenus = menus.search || menus.add || !!menus.section;
  const setSearchOpen = React.useCallback((value) => setMenus((current) => (current.search === value ? current : { ...current, search: value })), []);
  const setAddOpen = React.useCallback((value) => setMenus((current) => (current.add === value ? current : { ...current, add: value })), []);

  /* ------------------------------------------------------- a section's + */
  // (MATH-44, 2026-10-06) Notes and Sub-Workspaces make one at once, Files opens the system picker; Websites and GitHub
  // open a panel under the header (SectionPanel). The section opens on the click, so what arrives is seen (the flash
  // effect above would open it too). One + at work at a time; what went wrong hangs under the header.
  const closeSection = React.useCallback(() => setMenus((current) => (current.section ? { ...current, section: null } : current)), []);
  const adding = useAddRun(closeSection);
  const addWork = { note: onNewNote, workspace: onNewChild, disk: onPickDisk, link: onAddInput, github: onPickRepo };
  const addTo = (section, anchor) => {
    if (adding.busy) return;
    const { key, add: kind } = section;
    setOpened((now) => (now[key] ? now : { ...now, [key]: true }));
    adding.setError('');
    if (ADD_PANELS.has(kind)) {
      setMenus((current) => (current.section && current.section.key === key ? { ...current, section: null } : { ...current, section: { key, kind, anchor } }));
      return;
    }
    setMenus((current) => ({ ...current, section: { key, kind, anchor } }));
    const work = addWork[kind];
    void adding.run(kind === 'disk' ? work : async () => { await work(); return []; }); // the picker returns what it could not add
  };
  const sectionPanel = menus.section && (ADD_PANELS.has(menus.section.kind) || adding.error) ? menus.section : null;

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

  /* ------------------------------------------------------------------ drop */
  // Files from Finder, a picture or a link from a browser, dropped on the library rows (MATH-19): each a row of the
  // library, linked here (Workspace.jsx addDroppedHere). A row's own drag to the trash is not one of these.
  const libraryDragOver = (event) => { if (!onDropItems || !carriesDrop(event)) return; event.preventDefault(); setDropping(true); };
  const libraryDragLeave = (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false); };
  const libraryDrop = (event) => {
    if (!onDropItems || !carriesDrop(event)) return;
    event.preventDefault();
    setDropping(false);
    const items = readDrop(event.dataTransfer, api.pathForFile); // now: the drop's data is gone once the event is over
    if (items.length) void onDropItems(items);
  };

  const peekLeft = peek ? Math.max(peek.rect.right, peek.edge) : 0;
  const peekTop = peek ? Math.max(54, Math.min(peek.rect.top - 12, window.innerHeight - 380)) : 0;
  return (
    <aside aria-label="Sidebar" style={{ flex: 'none', width, minHeight: 0, display: hidden ? 'none' : 'flex', flexDirection: 'column', position: 'relative', zIndex: 7, background: '#fafafa' }}>
      <div onScroll={() => { hold(); setPeek(null); }} style={{ flex: 1, minHeight: 0, boxSizing: 'border-box', padding: '16px 8px 8px', display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden' }}>
        <WorkspaceHeader topics={topics} topic={topic} all={allWorkspaces} onOpenDoc={onOpenDoc} onSelectTopic={onSelectTopic} onRenameTopic={onRenameTopic} onAddTopic={onAddTopic} onDeleteTopic={onDeleteTopic} />
        {topic && (
          <div data-screen-label="Library" data-rail-library="1" data-dropping={dropping ? '1' : undefined} onDragOver={libraryDragOver} onDragLeave={libraryDragLeave} onDrop={libraryDrop} style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 8, boxShadow: dropping ? 'inset 0 0 0 2px #c9c9c9' : 'none', transition: 'box-shadow 120ms' }}>
            <LibrarySearch projectId={projectId} library={library} inRail={inRail} onPick={onSearchPick} previews={previews} onPreview={preview} onOpenHeld={onOpenHeld} onOpenChange={setSearchOpen} shut={menus.add || !!menus.section} />
            {sections.map((section, i) => (
              <RailSection
                key={section.key}
                section={section}
                open={!!opened[section.key]}
                onToggle={() => setOpened((now) => ({ ...now, [section.key]: !now[section.key] }))}
                all={i === 0 ? foldAll : null}
                onAdd={section.add && addWork[section.add] ? (anchor) => addTo(section, anchor) : null}
                panelOpen={!!sectionPanel && sectionPanel.key === section.key && ADD_PANELS.has(sectionPanel.kind)}
              >
                {section.rows.map((row) => (
                  <RailRow
                    key={row.id}
                    row={row}
                    flash={flashId === row.id}
                    faded={dragging === row.id}
                    onClick={onRowClick}
                    onRenameStart={onRowRenameStart}
                    onRename={onRowRename}
                    onRenameEnd={onRowRenameEnd}
                    onDragStart={row.type === 'child' || row.type === 'archive' ? null : dragStart}
                    onDragEnd={dragEnd}
                    onEnter={openPeek}
                    onLeave={closePeek}
                    onRemove={row.type === 'child' || row.type === 'archive' ? null : (removed) => { hold(); setPeek(null); onTrashRow(removed); }}
                    onRestore={row.type === 'archive' && onRestoreArchive ? onRestoreArchive : null}
                  />
                ))}
              </RailSection>
            ))}
            <AddToLibrary projectId={projectId} onAdd={onAddInput} onPickDisk={onPickDisk} onNewNote={onNewNote} onNewChild={onNewChild} onPickRepo={onPickRepo} onSearchPick={onSearchPick} library={library} inRail={inRail} onOpenChange={setAddOpen} shut={menus.search || !!menus.section} />
          </div>
        )}
        {topic && sectionPanel && (
          <SectionPanel key={`${sectionPanel.key}:${sectionPanel.kind}`} at={sectionPanel} adding={adding} library={library} inRail={inRail} onAddInput={onAddInput} onPickRepo={onPickRepo} onClose={closeSection} shut={menus.search || menus.add} />
        )}
      </div>
      <NextRow next={next} places={places} projectId={projectId} onGo={onGoNext} />
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
        workspaceTrash={workspaceTrash}
        onPostIt={onPostIt}
        postItsHidden={postItsHidden}
        onTogglePostIts={onTogglePostIts}
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
