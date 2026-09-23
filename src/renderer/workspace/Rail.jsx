import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, kindOf, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { looksAddable, searchRows } from '../model/rail.js';
import { usePlaced } from '../ui/usePlaced.js';
import { ItemPeek } from '../screens/Home.jsx';
import trashPng from '../../../design/assets/trash.png';
import trashFullPng from '../../../design/assets/trash-full.png';
import notePng from '../../../design/assets/yellow-sticky-note.png';
import copyPng from '../../../design/assets/copy-papers.png';

// The sidebar (Claude Design "Canvas.dc.html" and "Add - Mention.dc.html", 2026-09-22; Hudson's tweaks in
// design/goal-canvas/SIDEBAR-TWEAKS.md). From the top: the current workspace as a header (status mark, editable name,
// "n / m"; its hover lists the sibling workspaces and "+ New"); the workspace's own document as a full-width row; then
// the workspace's library on a grey card — a search field that brings in what the library already holds (and makes a
// new note or a nested workspace), the rows themselves (hover peeks, double-click renames, drag onto the trash to take
// one out of this workspace), and a + whose menu adds something new to the library and to this workspace. At the bottom,
// three pictures that size with the sidebar: the trash (it takes post-its too, and shows paper once something is in
// it), a sticky note that makes a post-it, and Copy (the open document with every @mentioned file placed where it is
// mentioned, src/main/context/expand-mentions.cjs). Every row's name is its own; nothing here explains itself.

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
    ? { background: '#171717', color: '#fff', font: '600 9px/14px var(--font-sans)', textAlign: 'center', border: 0 }
    : { border: `1.5px ${prog ? 'dashed' : 'solid'} #171717`, background: 'transparent' };
  return { ...base, flex: 'none', width: 14, height: 14, borderRadius: '50%', padding: 0, cursor: interactive ? 'pointer' : 'default', boxSizing: 'border-box', appearance: 'none', display: 'inline-block' };
}

function statusTitle(status) {
  if (status === 'done') return 'Done — click for todo';
  if (status === 'progress') return 'In progress — click for done';
  return 'Todo — click for in progress';
}

function blurOnEnter(event) {
  if (event.key === 'Enter' || event.key === 'Escape') event.target.blur();
}

function copiedLabel(copied) {
  const parts = ['Copied'];
  if (copied.files) parts.push(`${copied.files} file${copied.files === 1 ? '' : 's'}`);
  if (copied.missing) parts.push(`${copied.missing} missing`);
  return parts.join(' · ');
}

function TopicHeader({ topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic }) {
  const [hover, setHover] = React.useState(false);
  const shown = (value) => (value && !isUntitled(value) ? value : '');
  const [draft, setDraft] = React.useState(topic ? shown(topic.name) : '');
  const timer = React.useRef(null);
  React.useEffect(() => { setDraft(topic ? shown(topic.name) : ''); }, [topic && topic.id, topic && topic.name]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const index = topic ? topics.findIndex((candidate) => candidate.id === topic.id) : -1;
  const open = () => { clearTimeout(timer.current); setHover(true); };
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 120); };
  const commit = () => {
    const next = draft.trim();
    if (!topic) return;
    if (!next || next === topic.name) { setDraft(shown(topic.name)); return; }
    onRenameTopic(next);
  };
  return (
    <div onMouseEnter={open} onMouseLeave={close} style={{ flex: 'none', position: 'relative', marginBottom: 23 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px' }}>
        {topic
          ? <button type="button" onClick={() => onCycleTopic(topic)} title={statusTitle(topic.status)} aria-label={statusTitle(topic.status)} style={markStyle(topic.status)}>{topic.status === 'done' ? '✓' : ''}</button>
          : <span style={markStyle('open', false)} />}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={blurOnEnter}
          placeholder={topic ? (isUntitled(topic.name) ? topic.name : '') : 'no workspace yet…'}
          disabled={!topic}
          aria-label="Name"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '600 14px/1.5 var(--font-sans)', color: '#171717' }}
        />
        <span style={{ flex: 'none', font: '11px/1 var(--font-sans)', color: '#8f8f8f' }}>{topics.length ? `${index + 1} / ${topics.length}` : '0 / 0'}</span>
      </div>
      {hover && (
        <div data-overlay="1" data-workspace-menu="1" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 30, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
          {topics.map((candidate) => {
            const on = topic && candidate.id === topic.id;
            return (
              <div key={candidate.id} className="hov-wash" onClick={() => { setHover(false); onSelectTopic(candidate.id); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: on ? '#fafafa' : 'transparent', transition: 'background 120ms' }}>
                <span style={markStyle(candidate.status, false)}>{candidate.status === 'done' ? '✓' : ''}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 13.5px/1.5 var(--font-sans)`, color: isUntitled(candidate.name) ? '#8f8f8f' : '#171717' }}>{candidate.name}</span>
              </div>
            );
          })}
          <div className="hov-ink-wash" onClick={() => { setHover(false); onAddTopic(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', color: '#8f8f8f', transition: 'color 120ms' }}>
            <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '500 13px/1 var(--font-sans)' }}>+</span>
            <span style={{ font: '13.5px/1.5 var(--font-sans)' }}>New</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RailRow({ row, wide, flash, faded, onClick, onRenameStart, onRename, onRenameEnd, onDragStart, onDragEnd, onEnter, onLeave }) {
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
      className={wide ? 'hov-wash' : 'hov-wash2'}
      draggable={draggable}
      onDragStart={draggable ? (event) => onDragStart(row, event) : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={() => { if (!row.editing) onClick(row); }}
      onDoubleClick={(event) => { if (row.type === 'workspace') return; event.stopPropagation(); onRenameStart(row); }}
      onMouseEnter={onEnter ? (event) => onEnter(row, event.currentTarget) : undefined}
      onMouseLeave={onLeave}
      style={{
        flex: 'none', display: 'flex', alignItems: 'center', gap: 10, boxSizing: 'border-box', borderRadius: 6, cursor: 'pointer',
        ...(wide ? { width: 'calc(100% + 16px)', margin: '0 -8px 5px', padding: '8px 18px' } : { width: '100%', margin: '0 0 2px', padding: '8px 10px' }),
        background: row.on ? '#fff' : 'transparent', boxShadow: row.on ? '0 1px 3px #0000000a, 0 0 0 1px #eaeaea' : 'none',
        opacity: faded ? 0.4 : 1, animation: flash ? 'added 1600ms ease-out' : undefined, transition: 'background 120ms',
      }}
    >
      <Glyph item={row} />
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
        : <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: isUntitled(row.name) ? '#8f8f8f' : '#171717' }}>{row.name}</span>}
      {row.type === 'child' && <span style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>→</span>}
    </div>
  );
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
const glyphItem = (result) => (result.kind === 'item' ? result.row : result.kind === 'fresh' ? result.found : result.kind === 'note' ? { type: 'md', tags: ['note'] } : { type: 'workspace' });
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
function LibrarySearch({ library, inRail, onPick, previews, onPreview, onOpenHeld, onOpenChange, shut }) {
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
  const rows = open ? searchRows({ query: q, library, inRail, found: answer }) : [];
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
    <div data-rail-search="1" style={{ flex: 'none', position: 'relative', margin: '0 0 6px' }}>
      <div ref={boxRef} className="rail-search rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', border: '1px solid #fff', borderRadius: 8, background: '#fff', transition: 'box-shadow 120ms' }}>
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
        <Hanging anchor={anchor} width={anchor.width} cap={Math.max(160, window.innerHeight - 220)} panelRef={listRef} data-rail-results="1" style={{ padding: 4, overflowY: 'auto' }}>
          {rows.map((result, i) => (
            <button key={result.key} type="button" data-result={result.key} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(result)} onMouseEnter={() => { if (idx !== i) setIdx(i); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: 0, borderRadius: 6, background: i === at ? '#f2f2f2' : 'transparent', textAlign: 'left', cursor: 'pointer' }}>
              <Glyph item={glyphItem(result)} box={18} color="#4d4d4d" />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{result.name}</span>
              {/^new\b/.test(result.tag)
                ? <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '15px/1 var(--font-sans)', color: '#8f8f8f' }}>+</span>
                : <span style={{ flex: 'none', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{result.tag}</span>}
            </button>
          ))}
          {problem && <div style={{ padding: '7px 10px', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{problem}</div>}
        </Hanging>
      )}
      {peekItem && createPortal(
        <div ref={peekRef} data-overlay="1" data-rail-peek="1" style={{ position: 'fixed', zIndex: 71, left: anchor.right + 24, top: anchor.bottom + 6, width: 380, maxHeight: 400, overflowY: 'auto', boxSizing: 'border-box', ...cardStyle }}>
          {peekItem.kind === 'item'
            ? <ItemPeek row={peekItem.row} more={previews[`${peekItem.row.id}:${peekItem.row.last_edited || ''}`]} onOpenWorkspace={onOpenHeld} />
            : <FreshPeek found={peekItem.found} />}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The + under the library's rows: a link, a path or files from disk become new rows, in the library and in this workspace. */
function AddToLibrary({ onAdd, onPickDisk, onOpenChange, shut }) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const rowRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const timer = React.useRef(null);
  const wantFocus = React.useRef(false);
  const settled = React.useRef(false); // just added: the rows grew under a still pointer, which is not a hover
  const live = React.useRef({ value: '', busy: false });
  live.current = { value, busy };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);
  // The field takes the keyboard as soon as the menu shows, so a link can be pasted straight away. Not in the ref: the
  // panel is invisible for the frame in which it measures itself (ui/usePlaced.js), and an invisible field takes no focus.
  React.useEffect(() => {
    if (!open || !wantFocus.current) return undefined;
    const timer = setTimeout(() => { if (fieldRef.current) { fieldRef.current.focus({ preventScroll: true }); wantFocus.current = false; } }, 0);
    return () => clearTimeout(timer);
  }, [open, anchor]);

  const hide = React.useCallback(() => { clearTimeout(timer.current); setOpen(false); setValue(''); setError(''); }, []);
  React.useEffect(() => { if (shut && open && !live.current.busy) hide(); }, [shut]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = () => {
    clearTimeout(timer.current);
    if (open) return;
    if (rowRef.current) setAnchor(rectOf(rowRef.current));
    wantFocus.current = true;
    setValue('');
    setError('');
    setOpen(true);
  };
  // Moving off closes it after a short grace, unless something has been typed or it is busy.
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (live.current.value.trim() || live.current.busy) return;
      if (fieldRef.current && document.activeElement === fieldRef.current) fieldRef.current.blur();
      hide();
    }, MENU_CLOSE);
  };
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (live.current.busy) return; if (![rowRef, menuRef].some((ref) => ref.current && ref.current.contains(event.target))) hide(); };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open, hide]);

  const run = async (work) => {
    setBusy(true);
    setError('');
    try {
      const problems = await work();
      if (problems && problems.length) setError(problems.join(' · '));
      else { settled.current = true; hide(); }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const commit = () => { const input = value.trim(); if (input && !busy) void run(async () => { await onAdd(input); return []; }); };
  const fromGithub = () => {
    setValue('https://github.com/');
    setError('');
    const field = fieldRef.current;
    if (field) setTimeout(() => { field.focus({ preventScroll: true }); const n = field.value.length; field.setSelectionRange(n, n); }, 0);
  };

  const addable = looksAddable(value);
  const border = error ? '#e70022' : value ? '#c9c9c9' : '#eaeaea';
  const menuRow = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '7px 8px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', cursor: 'pointer' };
  return (
    <div data-rail-add="1" style={{ flex: 'none', position: 'relative' }} onMouseEnter={() => { if (!settled.current) show(); }} onMouseLeave={() => { settled.current = false; leave(); }}>
      <button ref={rowRef} type="button" className="hov-ink-wash2" onClick={() => (open ? hide() : show())} aria-label="Add to library" aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: 0, borderRadius: 6, background: open ? '#eaeaea' : 'transparent', color: open ? '#171717' : '#8f8f8f', textAlign: 'left', cursor: 'pointer', transition: 'background 120ms, color 120ms' }}>
        <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '400 17px/1 var(--font-sans)' }}>+</span>
      </button>
      {open && anchor && (
        <Hanging anchor={anchor} width={anchor.width} gap={4} panelRef={menuRef} data-rail-add-menu="1" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave} style={{ padding: 10 }}>
          <div className="rail-field" style={{ display: 'flex', alignItems: 'center', height: 34, boxSizing: 'border-box', padding: '0 10px', background: '#fafafa', border: `1px solid ${border}`, borderRadius: 6, transition: 'border-color 120ms' }}>
            <input
              ref={fieldRef}
              value={value}
              readOnly={busy}
              onChange={(event) => { setValue(event.target.value); setError(''); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commit(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
              }}
              placeholder="Upload URL or path"
              aria-label="Link or path"
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '13px/1.4 var(--font-sans)', color: '#171717', opacity: busy ? 0.5 : 1 }}
            />
          </div>
          {error && <div data-add-error="1" style={{ padding: '6px 2px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</div>}
          <button type="button" className="hov-wash" disabled={busy} onClick={() => run(onPickDisk)} style={{ ...menuRow, marginTop: 6 }}>
            <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d' }}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }}><path d="M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" /></svg>
            </span>
            <span style={{ flex: 1, minWidth: 0, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Choose from disk…</span>
          </button>
          <button type="button" className="hov-wash" disabled={busy} onClick={fromGithub} style={{ ...menuRow, marginTop: 2 }}>
            <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717' }}><span style={{ display: 'flex', width: 14, height: 14 }}>{KIND.git.glyph}</span></span>
            <span style={{ flex: 1, minWidth: 0, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Add from GitHub…</span>
          </button>
          {addable && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 0 0' }}>
              <button type="button" className="hov-dim" disabled={busy} onClick={commit} style={{ padding: '7px 12px', border: 0, borderRadius: 6, background: '#171717', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#fff' }}>Add to library</button>
            </div>
          )}
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

const barButton = (enabled) => ({ flex: 'none', width: BAR_SIZE, aspectRatio: '1', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 10, background: 'transparent', cursor: enabled ? 'pointer' : 'default' });
const barPicture = { display: 'block', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' };

/** The three pictures at the bottom: they size with the sidebar (52–96px) and name themselves on hover. */
function BottomBar({ trashRef, full, dragging, over, onTrashDragOver, onTrashDragEnter, onTrashDragLeave, onTrashDrop, onPostIt, onCopy, copied, copyLabel }) {
  const [tip, setTip] = React.useState(null);
  const off = () => setTip(null);
  return (
    <div data-rail-bar="1" style={{ flex: 'none', containerType: 'inline-size', padding: '6px 16px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'clamp(4px, 4cqw, 16px)' }}>
        <div style={{ position: 'relative', display: 'flex' }}>
          <div
            ref={trashRef}
            data-trash={full ? 'full' : 'empty'}
            aria-label="Trash"
            onMouseEnter={() => setTip('trash')}
            onMouseLeave={off}
            onDragOver={onTrashDragOver}
            onDragEnter={onTrashDragEnter}
            onDragLeave={onTrashDragLeave}
            onDrop={onTrashDrop}
            style={{ ...barButton(false), transition: 'transform 120ms, opacity 120ms', transform: over ? 'scale(1.12)' : 'none', opacity: dragging || over ? 1 : 0.7 }}
          >
            <img src={full ? trashFullPng : trashPng} alt="" draggable={false} style={{ ...barPicture, width: '90%', height: '90%' }} />
          </div>
          {tip === 'trash' && !dragging && <BarTip text="Trash" align="flex-start" />}
        </div>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button type="button" className="bar-press" data-add-post-it="1" aria-label="Note" disabled={!onPostIt} onClick={onPostIt || undefined} onMouseEnter={() => setTip('note')} onMouseLeave={off} style={barButton(!!onPostIt)}>
            <img src={notePng} alt="" draggable={false} style={{ ...barPicture, width: '100%', height: '100%', transform: 'translateY(10%)' }} />
          </button>
          {tip === 'note' && <BarTip text="Note" align="center" />}
        </div>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button type="button" className="bar-press" data-copy-doc="1" aria-label="Copy" disabled={!onCopy} onClick={onCopy || undefined} onMouseEnter={() => setTip('copy')} onMouseLeave={off} style={barButton(!!onCopy)}>
            <img src={copyPng} alt="" draggable={false} style={{ ...barPicture, width: '92%', height: '92%' }} />
          </button>
          {copied ? <BarTip text={copiedLabel(copied)} align="center" color="#171717" /> : tip === 'copy' && copyLabel ? <BarTip text={copyLabel} align="center" /> : null}
        </div>
      </div>
    </div>
  );
}

export default function Rail({
  width, topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic,
  rows, flashId, onRowClick, onRowRenameStart, onRowRename, onRowRenameEnd,
  library, inRail, onSearchPick, onAddInput, onPickDisk, onOpenHeld,
  onTrashRow, trashFull, postItDrag, trashRef,
  onPostIt, onCopy, copied, copyLabel,
}) {
  const [peek, setPeek] = React.useState(null); // { row, rect }
  const [previews, setPreviews] = React.useState({}); // `${id}:${last_edited}` → previewLibraryItem's answer
  const [dragging, setDragging] = React.useState(null);
  const [overTrash, setOverTrash] = React.useState(false);
  const [menus, setMenus] = React.useState({ search: false, add: false });
  const timer = React.useRef(null);
  const wsRow = rows.find((row) => row.id === 'ws') || null;
  const itemRows = rows.filter((row) => row.id !== 'ws');

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
  return (
    <aside aria-label="Sidebar" style={{ flex: 'none', width, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 7, background: '#fafafa' }}>
      <div onScroll={() => { hold(); setPeek(null); }} style={{ flex: 1, minHeight: 0, boxSizing: 'border-box', padding: '24px 16px 8px', display: 'flex', flexDirection: 'column', overflowY: 'auto', overflowX: 'hidden' }}>
        <TopicHeader topics={topics} topic={topic} onSelectTopic={onSelectTopic} onCycleTopic={onCycleTopic} onRenameTopic={onRenameTopic} onAddTopic={onAddTopic} />
        {wsRow && <RailRow row={wsRow} wide flash={flashId === wsRow.id} onClick={onRowClick} onRenameStart={onRowRenameStart} onRename={onRowRename} onRenameEnd={onRowRenameEnd} />}
        {topic && (
          <div data-screen-label="Library" data-rail-library="1" style={{ flex: 'none', margin: '4px -8px 0', padding: 4, background: '#f2f2f2', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
            <LibrarySearch library={library} inRail={inRail} onPick={onSearchPick} previews={previews} onPreview={preview} onOpenHeld={onOpenHeld} onOpenChange={setSearchOpen} shut={menus.add} />
            {itemRows.map((row) => (
              <RailRow
                key={row.id}
                row={row}
                flash={flashId === row.id}
                faded={dragging === row.id}
                onClick={onRowClick}
                onRenameStart={onRowRenameStart}
                onRename={onRowRename}
                onRenameEnd={onRowRenameEnd}
                onDragStart={row.type === 'child' ? null : dragStart}
                onDragEnd={dragEnd}
                onEnter={openPeek}
                onLeave={closePeek}
              />
            ))}
            <AddToLibrary onAdd={onAddInput} onPickDisk={onPickDisk} onOpenChange={setAddOpen} shut={menus.search} />
          </div>
        )}
      </div>
      <BottomBar
        trashRef={trashRef}
        full={trashFull}
        dragging={!!dragging || !!(postItDrag && postItDrag.active)}
        over={overTrash || !!(postItDrag && postItDrag.over)}
        onTrashDragOver={trashDragOver}
        onTrashDragEnter={trashDragEnter}
        onTrashDragLeave={trashDragLeave}
        onTrashDrop={trashDrop}
        onPostIt={onPostIt}
        onCopy={onCopy}
        copied={copied}
        copyLabel={copyLabel}
      />
      {peek && !dragging && !busyMenus && createPortal(
        // The wrapper reaches back over the gap to the row, so crossing the gap still counts as hovering.
        <div data-overlay="1" data-rail-peek="1" onMouseEnter={hold} onMouseLeave={closePeek} style={{ position: 'fixed', zIndex: 60, left: peekLeft, top: peekTop, paddingLeft: PEEK_GAP }}>
          <div style={{ width: 380, maxHeight: Math.min(440, window.innerHeight - peekTop - 12), overflowY: 'auto', boxSizing: 'border-box', ...cardStyle }}>
            <ItemPeek row={peek.row} more={previews[`${peek.row.id}:${peek.row.last_edited || ''}`] || undefined} onOpenWorkspace={(projectId, workspaceId) => { setPeek(null); onOpenHeld(projectId, workspaceId); }} />
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
