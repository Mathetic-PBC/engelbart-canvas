// What the workspace sidebar (Rail.jsx, 2026-10-07) opens beside itself: Hudson's "(not centered) scrollable modal next to
// that (to the right) that shows all of the options". Inbox, Agents, Connections and Library from the fixed rows; every
// workspace (Workspaces' "More"); a group of Your sources whole (its "More"); the project's menu under its name; and, in
// the middle of the window, Search and a new workspace's name. One is open at a time; Escape or a press anywhere else
// closes it, and Escape never goes on to leave the workspace.

import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { GH, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { looksAddable, searchRows } from '../model/rail.js';
import { findWorkspaces } from '../model/nav.js';
import { sinceWords } from '../model/sidebar.js';
import { usePlaced } from '../ui/usePlaced.js';
import { useBodies } from './useBodies.js';
import { useGithubStatus } from './useGithubStatus.js';
import { useZoteroStatus } from './useZoteroStatus.js';
import { zoteroSyncLine } from './Connections.jsx';
import { ItemPeek } from '../screens/Home.jsx';
import { openSettings } from '../ui/Settings.jsx';
import * as I from '../ui/SidebarIcons.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
export const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const SHADOW = '0 12px 32px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04)';
const PEEK_OPEN = 350, PEEK_SWITCH = 90, PEEK_CLOSE = 180;

/* ------------------------------------------------------------------ layers */

// What floats over the workspace, in the order it opened: Escape is the newest one's, and a press inside a newer one (a
// menu or a peek opened from a panel) does not close an older one.
const layers = [];
let nextLayer = 1;
// `stack` false: a press inside it still belongs to it (a peek), but it takes no Escape.
function useLayer({ stack = true } = {}) {
  const [id] = React.useState(() => nextLayer++);
  React.useEffect(() => {
    if (!stack) return undefined;
    layers.push(id);
    return () => { const at = layers.indexOf(id); if (at >= 0) layers.splice(at, 1); };
  }, [id, stack]);
  return id;
}

/**
 * Closes with Escape (the newest layer's alone; taken in the capture phase, before an editor or the workspace sees it)
 * and with a press anywhere but inside it, inside a layer opened after it, or on `ignore` (what opened it, which toggles).
 */
export function useDismiss(ref, onClose, { ignore = null, layer }) {
  const live = React.useRef(onClose);
  live.current = onClose;
  React.useEffect(() => {
    const away = (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (ref.current && ref.current.contains(target)) return;
      if (ignore && target.closest(ignore)) return;
      const other = target.closest('[data-sb-layer]');
      if (other && Number(other.dataset.sbLayer) > layer) return;
      live.current();
    };
    const key = (event) => {
      if (event.key !== 'Escape' || layers[layers.length - 1] !== layer) return;
      event.preventDefault();
      event.stopPropagation();
      live.current();
    };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', key, true); };
  }, [ref, ignore, layer]);
}

/** A panel beside what opened it (`anchor`, a rect; `side` 'right', or 'below' for a menu), placed to stay in the window. */
export function Floating({ anchor, side = 'right', gap = 8, cap = 560, width = 340, onClose, ignore = null, label, style, children, ...rest }) {
  const layer = useLayer();
  const [ref, placed] = usePlaced(anchor, { side, gap, cap });
  useDismiss(ref, onClose, { ignore, layer });
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} data-overlay="1" data-sb-layer={layer} {...rest} style={{ ...placed, zIndex: 80, width, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, boxShadow: SHADOW, animation: `rise 140ms ${EASE}`, ...(placed.maxHeight != null ? { overflowY: 'hidden' } : {}), ...style }}>
      {children}
    </div>,
    document.body,
  );
}

/** A dialog in the middle of the window, over a faint veil (Search, a new workspace). */
function Centered({ onClose, label, width = 560, top = '14vh', children, ...rest }) {
  const layer = useLayer();
  const ref = React.useRef(null);
  useDismiss(ref, onClose, { layer });
  return createPortal(
    <div data-overlay="1" data-sb-layer={layer} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(23,23,23,.12)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: top }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} {...rest} style={{ width: `min(${width}px, calc(100vw - 32px))`, maxHeight: 'calc(100vh - 28vh)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e2e2e2', borderRadius: 12, boxShadow: '0 16px 48px rgba(0,0,0,.16)', overflow: 'hidden', animation: `rise 140ms ${EASE}` }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- the pieces */

export function PanelHead({ title, count, children }) {
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 6px' }}>
      <span style={{ ...text(13, '#171717', 600), whiteSpace: 'nowrap' }}>{title}</span>
      {count != null && count > 0 && <span style={text(12, '#8f8f8f')}>{count}</span>}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

const Group = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
    <div style={{ padding: '10px 10px 4px', ...text(12, '#8f8f8f', 500) }}>{title}</div>
    {children}
  </div>
);

export function Empty({ children }) {
  return <div data-sb-empty="1" style={{ padding: '6px 14px 14px', ...text(12.5, '#8f8f8f'), lineHeight: 1.55 }}>{children}</div>;
}

/** A row of a panel: its icon, its name over a line of what it is, and what its hover offers on the right. */
export function PanelRow({ icon, title, meta, active = false, faint = false, onClick, onContextMenu, onEnter, onLeave, actions = null, ...rest }) {
  return (
    <div
      role="button"
      tabIndex={-1}
      className={active ? 'sb-prow' : 'sb-prow hov-wash'}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      {...rest}
      style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, minHeight: meta ? 42 : 32, boxSizing: 'border-box', padding: meta ? '5px 8px 5px 10px' : '0 8px 0 10px', borderRadius: 6, cursor: 'pointer', background: active ? '#efefef' : 'transparent', transition: 'background 120ms' }}
    >
      {icon && <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#4d4d4d' }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(13.5, faint ? '#8f8f8f' : '#171717', active ? 500 : 400) }}>{title}</span>
        {meta && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12, '#8f8f8f') }}>{meta}</span>}
      </span>
      {actions && <span className="sb-prow-actions" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2 }}>{actions}</span>}
    </div>
  );
}

/** A small icon button on a row's right (shown on the row's hover unless `shown`). */
export function RowAction({ label, onClick, shown = false, children, ...rest }) {
  return (
    <button
      type="button"
      className={shown ? 'sb-act sb-act-on' : 'sb-act'}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onClick(event); }}
      onDoubleClick={(event) => event.stopPropagation()}
      {...rest}
      style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', color: '#8f8f8f' }}
    >
      {children}
    </button>
  );
}

/** A panel's search field, which has the keyboard as soon as the panel shows. */
export function SearchField({ value, onChange, onKeyDown, placeholder = 'Search', inputRef, autoFocus = true }) {
  const own = React.useRef(null);
  const ref = inputRef || own;
  React.useEffect(() => {
    if (!autoFocus) return undefined;
    const timer = setTimeout(() => { if (ref.current) ref.current.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [autoFocus, ref]);
  return (
    <div className="rail-field" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, margin: '4px 10px 6px', padding: '0 10px', border: `1px solid ${value ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 7, background: '#fff', transition: 'border-color 120ms' }}>
      <I.SearchIcon size={14} style={{ color: '#8f8f8f' }} />
      <input ref={ref} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} aria-label={placeholder} spellCheck={false} style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', ...text(13.5) }} />
      {value && <button type="button" className="hov-ink" aria-label="Clear" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); if (ref.current) ref.current.focus(); }} style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', ...text(13, '#c9c9c9') }}>×</button>}
    </div>
  );
}

const Scroll = ({ children, style }) => <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '2px 4px 6px', display: 'flex', flexDirection: 'column', gap: 1, ...style }}>{children}</div>;

export function PanelFoot({ children }) {
  return <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderTop: '1px solid #f0f0f0' }}>{children}</div>;
}

export function FootButton({ onClick, children, ...rest }) {
  return <button type="button" className="hov-ink-wash" onClick={onClick} {...rest} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', ...text(12.5, '#4d4d4d') }}>{children}</button>;
}

/* ----------------------------------------------------------- hover peeks */

/**
 * What hovering a library row shows after a beat (the all-projects screen's card, Home.jsx ItemPeek), beside the panel or
 * the sidebar it is in, at the row's height. `edge`: the x it starts at. → { peek, open(row, element, edge), close, hold }
 */
export function usePeek() {
  const [peek, setPeek] = React.useState(null); // { row, rect, edge }
  const [previews, setPreviews] = React.useState({});
  const timer = React.useRef(null);
  const asked = React.useRef(new Set());
  const hold = React.useCallback(() => { clearTimeout(timer.current); timer.current = null; }, []);
  React.useEffect(() => hold, [hold]);
  const open = React.useCallback((row, element, edge) => {
    hold();
    timer.current = setTimeout(() => {
      if (!element.isConnected) return;
      setPeek((now) => (now && now.row.id === row.id ? now : { row, rect: element.getBoundingClientRect(), edge }));
    }, peek ? PEEK_SWITCH : PEEK_OPEN);
  }, [hold, peek]);
  const close = React.useCallback(() => { hold(); timer.current = setTimeout(() => setPeek(null), PEEK_CLOSE); }, [hold]);
  const drop = React.useCallback(() => { hold(); setPeek(null); }, [hold]);
  React.useEffect(() => {
    if (!peek || peek.row.type === 'image') return;
    const key = `${peek.row.id}:${peek.row.last_edited || ''}`;
    if (asked.current.has(key)) return;
    asked.current.add(key);
    api.previewLibraryItem(peek.row.id).then((more) => setPreviews((now) => ({ ...now, [key]: more }))).catch(() => setPreviews((now) => ({ ...now, [key]: {} })));
  }, [peek]);
  const more = peek ? previews[`${peek.row.id}:${peek.row.last_edited || ''}`] : undefined;
  return { peek, more, open, close, hold, drop };
}

/** The right edge of the panel (or the sidebar) a row is in: where its peek starts. */
export const panelEdge = (element) => (element.closest('[data-sb-panel], aside') || element).getBoundingClientRect().right;

/** The peek card, beside `peek.edge` at the row's height; the pointer may cross the gap onto it and scroll it. */
export function PeekCard({ peek, more, onHold, onClose, onOpenWorkspace }) {
  const layer = useLayer({ stack: false });
  if (!peek) return null;
  const top = Math.max(12, Math.min(peek.rect.top - 12, window.innerHeight - 380));
  const width = 360;
  const roomRight = peek.edge + 8 + width <= window.innerWidth - 8;
  const left = roomRight ? peek.edge : Math.max(8, peek.rect.left - width - 16);
  return createPortal(
    <div data-overlay="1" data-hover="1" data-sb-peek="1" data-sb-layer={layer} onMouseEnter={onHold} onMouseLeave={onClose} style={{ position: 'fixed', zIndex: 95, left, top, paddingLeft: roomRight ? 8 : 0, paddingRight: roomRight ? 0 : 8 }}>
      <div style={{ width, maxHeight: Math.min(440, window.innerHeight - top - 12), overflowY: 'auto', boxSizing: 'border-box', padding: '14px 16px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: `rise 160ms ${EASE}` }}>
        <ItemPeek row={peek.row} more={more} onOpenWorkspace={onOpenWorkspace} />
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ Inbox */

const agentIcon = (kind) => (kind === 'build' || kind === 'quick' ? <I.AgentsIcon size={15} /> : <I.ChatIcon size={15} />);

/** The agents that finished and wait for you to look, newest first; a press goes to their workspace, which clears them. */
export function InboxPanel({ anchor, entries, nameOf, onGo, onClear, onClose, ignore }) {
  return (
    <Floating anchor={anchor} width={340} label="Inbox" onClose={onClose} ignore={ignore} data-sb-panel="inbox">
      <PanelHead title="Inbox" count={entries.length}>
        {entries.length > 0 && <FootButton onClick={onClear} data-inbox-clear="1">Mark all as seen</FootButton>}
      </PanelHead>
      {entries.length === 0
        ? <Empty>Nothing new. When an agent finishes or asks you something, it lands here.</Empty>
        : (
          <Scroll>
            {entries.map((entry) => (
              <PanelRow
                key={entry.id}
                data-inbox-entry={entry.id}
                icon={agentIcon(entry.kind)}
                title={nameOf(entry.workspaceId) || entry.name || 'A workspace'}
                meta={`${entry.did}${entry.at ? ` · ${sinceWords(entry.at)}` : ''}`}
                onClick={() => onGo(entry)}
              />
            ))}
          </Scroll>
        )}
    </Floating>
  );
}

/* ----------------------------------------------------------------- Agents */

/** The project's agents by where they stand: running, waiting on you, done. A press goes to where each was asked. */
export function AgentsPanel({ anchor, groups, nameOf, onGo, onClose, ignore }) {
  const total = groups.running.length + groups.waiting.length + groups.done.length;
  const where = (entry) => (entry.workspaceId ? nameOf(entry.workspaceId) || 'A workspace' : entry.kind === 'quick' ? 'A post-it' : '');
  const row = (entry) => (
    <PanelRow
      key={entry.id}
      data-agent-entry={entry.id}
      icon={agentIcon(entry.kind)}
      title={entry.title}
      meta={[where(entry), entry.state, sinceWords(entry.at)].filter(Boolean).join(' · ')}
      onClick={() => onGo(entry)}
    />
  );
  return (
    <Floating anchor={anchor} width={360} label="Agents" onClose={onClose} ignore={ignore} data-sb-panel="agents">
      <PanelHead title="Agents" count={groups.running.length}>{groups.running.length > 0 && <span style={text(12, '#8f8f8f')}>running</span>}</PanelHead>
      {total === 0
        ? <Empty>No agents yet. Ask @bart in a document, or press Build under it to hand the workspace to a coding agent.</Empty>
        : (
          <Scroll>
            {groups.running.length > 0 && <Group title="Running">{groups.running.map(row)}</Group>}
            {groups.waiting.length > 0 && <Group title="Waiting on you">{groups.waiting.map(row)}</Group>}
            {groups.done.length > 0 && <Group title="Done">{groups.done.map(row)}</Group>}
          </Scroll>
        )}
    </Floating>
  );
}

/* ------------------------------------------------------------ Connections */

const ZoteroGlyph = () => <svg aria-hidden="true" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 3h9l-9 10h9" /></svg>;
// Overleaf's leaf, plainly drawn.
const OverleafGlyph = () => <svg aria-hidden="true" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10z" /><path d="M3 13 9 7" /></svg>;
export const OVERLEAF_URL = 'https://www.overleaf.com/project';

/**
 * Connections (requirement 5: Zotero, Overleaf, GitHub): where each stands. GitHub and Zotero are signed in to in
 * Settings' Connections page, which a press opens; their libraries are reached from the + and the @ menu. Overleaf is
 * read from the Stage, where a press opens its projects.
 */
export function ConnectionsPanel({ anchor, onOverleaf, onClose, ignore }) {
  const [github] = useGithubStatus();
  const [zotero] = useZoteroStatus();
  const manage = () => { onClose(); openSettings('connections'); };
  const gh = !github ? 'Checking…' : github.connected ? `Connected${github.login ? ` · @${github.login}` : ''}` : github.pending ? 'Waiting for sign-in…' : 'Not connected';
  const sync = zotero && zotero.connected ? zoteroSyncLine(zotero.sync) : null;
  const zt = !zotero ? 'Checking…' : zotero.connected ? [`Connected${zotero.username ? ` · ${zotero.username}` : ''}`, sync && !sync.error ? sync.text.replace(/^Synced · /, '') : ''].filter(Boolean).join(' · ') : zotero.pending ? 'Finish signing in in your browser' : 'Not connected';
  const dot = (on) => <span aria-hidden="true" title={on ? 'Connected' : 'Not connected'} style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: on ? '#0070f3' : '#d4d4d4' }} />; // the one accent
  return (
    <Floating anchor={anchor} width={330} label="Connections" onClose={onClose} ignore={ignore} data-sb-panel="connections">
      <PanelHead title="Connections" />
      <Scroll>
        <PanelRow data-sb-connection="github" icon={<span className="glyph-fit" style={{ display: 'flex', width: 14, height: 14 }}><GH /></span>} title="GitHub" meta={gh} onClick={manage} actions={dot(!!(github && github.connected))} />
        <PanelRow data-sb-connection="zotero" icon={<ZoteroGlyph />} title="Zotero" meta={zt} onClick={manage} actions={dot(!!(zotero && zotero.connected))} />
        <PanelRow data-sb-connection="overleaf" icon={<OverleafGlyph />} title="Overleaf" meta="Open your projects on the Stage" onClick={() => { onClose(); onOverleaf(); }} actions={<I.ExternalIcon size={13} style={{ color: '#8f8f8f' }} />} />
      </Scroll>
      <PanelFoot><FootButton onClick={manage} data-sb-manage-connections="1"><I.GearIcon size={14} />Manage connections</FootButton></PanelFoot>
    </Floating>
  );
}

/* ---------------------------------------------------------------- Library */

const LIBRARY_RECENT = 40;
const edited = (row) => Date.parse(row.last_edited || row.created || '') || 0;

/**
 * Library (Sidebar brainstorming: "a modal … search, recent and current-context items, Open full Library"): the search has
 * the keyboard; before anything is typed, what was worked on last. A press opens a row; its + brings it into this
 * workspace; an address or a path typed is added. Hovering one peeks at it. "Open full library" goes to the projects screen.
 */
export function LibraryPanel({ anchor, projectId, library, inRail, onOpen, onLink, onAddInput, onOpenFull, onOpenWorkspace, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const typed = q.trim();
  const addable = looksAddable(typed);
  React.useEffect(() => {
    if (!addable) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api.lookupLibraryItem(typed)
        .then((result) => { if (live) setFound({ query: typed, result }); })
        .catch((error) => { if (live) setFound({ query: typed, result: { row: null, found: null, error: errorMessage(error) } }); });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [addable, typed]);
  const answer = addable && found && found.query === typed ? found.result : undefined;
  const bodies = useBodies(projectId, true);
  const things = React.useMemo(() => library.filter((row) => row.type !== 'image'), [library]); // a pasted picture is its document's
  const rows = React.useMemo(() => {
    if (!typed) return [...things].sort((a, b) => edited(b) - edited(a)).slice(0, LIBRARY_RECENT).map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : '' }));
    return searchRows({ query: typed, library: things, inRail, found: answer, bodies });
  }, [typed, things, inRail, answer, bodies]);
  const at = rows.length ? Math.min(idx, rows.length - 1) : -1;
  const peek = usePeek();
  const run = async (work) => {
    if (busy) return;
    setBusy(true); setProblem('');
    try { await work(); } catch (error) { setProblem(errorMessage(error)); } finally { setBusy(false); }
  };
  const pick = (result) => {
    if (!result) return;
    if (result.kind === 'fresh') void run(async () => { await onAddInput(typed); setQ(''); });
    else { onClose(); onOpen(result.row); }
  };
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pick(rows[at]); }
  };
  return (
    <Floating anchor={anchor} width={360} cap={600} label="Library" onClose={onClose} ignore={ignore} data-sb-panel="library">
      <PanelHead title="Library" count={things.length} />
      <SearchField value={q} onChange={(value) => { setQ(value); setIdx(0); setProblem(''); }} onKeyDown={onKey} placeholder="Search the library, or paste a link" />
      {!typed && <div style={{ padding: '2px 14px 2px', ...text(12, '#8f8f8f', 500) }}>Recent</div>}
      <Scroll>
        {rows.map((result, i) => {
          const row = result.kind === 'item' ? result.row : null;
          const here = row && inRail(row.id);
          return (
            <PanelRow
              key={result.key}
              data-library-result={result.key}
              icon={<Glyph item={row || result.found} box={16} color="#4d4d4d" />}
              title={result.name}
              active={i === at && !!typed}
              onClick={() => pick(result)}
              onEnter={(event) => { if (idx !== i) setIdx(i); if (row) peek.open(row, event.currentTarget, panelEdge(event.currentTarget)); }}
              onLeave={peek.close}
              actions={result.kind === 'fresh'
                ? <span style={text(12, '#8f8f8f')}>Add</span>
                : here ? <span style={{ ...text(11.5, '#8f8f8f'), padding: '0 4px' }}>here</span>
                  : <RowAction label="Add to this workspace" onClick={() => void run(async () => { await onLink(row); })}><I.PlusIcon size={14} /></RowAction>}
            />
          );
        })}
        {!rows.length && <Empty>{typed ? 'Nothing in the library by that name.' : 'The library is empty. Add a source to start it.'}</Empty>}
        {(problem || (answer && answer.error)) && <div style={{ padding: '4px 10px', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{problem || answer.error}</div>}
      </Scroll>
      <PanelFoot><FootButton onClick={() => { onClose(); onOpenFull(); }} data-sb-open-library="1"><I.LibraryIcon size={14} />Open full library</FootButton></PanelFoot>
      {peek.peek && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={(pid, wid) => { peek.drop(); onClose(); onOpenWorkspace(pid, wid); }} />}
    </Floating>
  );
}

/* ------------------------------------------------------------- Workspaces */

function flatten(roots) {
  const out = [];
  const walk = (list, depth, above) => { for (const node of list || []) { out.push({ node, depth, above }); walk(node.children, depth + 1, [...above, node.name]); } };
  walk(roots, 0, []);
  return out;
}

/** A name typed in place: Enter or leaving it keeps it, Escape keeps the old one. */
export function RenameField({ initial, onDone, style }) {
  const [draft, setDraft] = React.useState(initial);
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) { ref.current.focus(); ref.current.select(); } }, []);
  const done = React.useRef(false);
  const finish = (keep) => { if (done.current) return; done.current = true; const next = draft.trim(); onDone(keep && next && next !== initial ? next : null); };
  return (
    <input
      ref={ref}
      data-rename="1"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/[/\\]/g, '-'))}
      onBlur={() => finish(true)}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); finish(false); } }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      spellCheck={false}
      style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', ...text(13.5), ...style }}
    />
  );
}

/**
 * Every workspace of the project (Workspaces' "More"), as the tree has them, the one open here marked: a press goes there,
 * a double-click renames it, its + makes a sub-workspace in it and its can puts it in the trash (with what is nested in
 * it; the sidebar's trash brings it back for a week). Under them, every archived version (one per Clear), newest first.
 */
export function WorkspacesPanel({ anchor, roots, hereId, versions, onGo, onNew, onRename, onDelete, onOpenVersion, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const [renaming, setRenaming] = React.useState(null);
  const all = React.useMemo(() => flatten(roots), [roots]);
  const found = q.trim() ? findWorkspaces(all.map(({ node, above }) => ({ id: node.id, name: node.name, above })), q) : null;
  const list = found ? found.map((hit) => ({ node: all.find((entry) => entry.node.id === hit.id).node, depth: 0, above: hit.above })) : all;
  const go = (id) => { onClose(); onGo(id); };
  // The workspace open here in sight when the list opens.
  React.useEffect(() => {
    const here = hereId && document.querySelector(`[data-sb-all-workspace="${hereId}"]`);
    if (here && here.scrollIntoView) here.scrollIntoView({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Floating anchor={anchor} width={340} cap={620} label="All workspaces" onClose={onClose} ignore={ignore} data-sb-panel="workspaces">
      <PanelHead title="Workspaces" count={all.length}>
        <RowAction label="New workspace" shown onClick={() => { onClose(); onNew(null); }} data-sb-panel-new="1"><I.PlusIcon size={14} /></RowAction>
      </PanelHead>
      {all.length > 8 && <SearchField value={q} onChange={setQ} placeholder="Find a workspace" />}
      <Scroll>
        {list.map(({ node, depth, above }) => (
          <div key={node.id} style={{ display: 'flex', alignItems: 'stretch' }}>
            {/* a level in: a faint line under the icon above, and the name in line with that one's */}
            {Array.from({ length: depth }, (_, i) => <span key={i} aria-hidden="true" style={{ flex: 'none', position: 'relative', width: 26 }}><span style={{ position: 'absolute', left: 17.5, top: 0, bottom: 0, width: 1, background: '#e6e6e6' }} /></span>)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <PanelRow
                data-sb-all-workspace={node.id}
                icon={depth === 0 ? <I.WorkspaceIcon size={15} /> : null}
                title={renaming === node.id ? <RenameField initial={node.name} onDone={(name) => { setRenaming(null); if (name) onRename(node.id, name); }} /> : node.name}
                meta={found && above.length ? above.join(' / ') : null}
                faint={isUntitled(node.name)}
                active={node.id === hereId}
                onClick={() => { if (renaming !== node.id) go(node.id); }}
                onDoubleClick={() => setRenaming(node.id)}
                actions={renaming === node.id ? null : (
                  <>
                    <RowAction label={`New sub-workspace in ${node.name}`} onClick={() => { onClose(); onNew(node.id); }}><I.PlusIcon size={14} /></RowAction>
                    <RowAction label={`Delete ${node.name}`} onClick={() => onDelete(node.id)} data-sb-delete-workspace={node.id}><I.TrashIcon size={14} /></RowAction>
                  </>
                )}
              />
            </div>
          </div>
        ))}
        {found && !found.length && <Empty>No workspace by that name.</Empty>}
        {!found && versions.length > 0 && (
          <Group title="Archived">
            {versions.map((version) => (
              <PanelRow
                key={`${version.workspaceId}/${version.file}`}
                data-sb-version={version.file}
                icon={<I.ArchiveIcon size={15} />}
                title={version.title}
                meta={`${version.name}${version.clearedAt ? ` · cleared ${sinceWords(version.clearedAt)}` : ''}`}
                onClick={() => { onClose(); onOpenVersion(version); }}
              />
            ))}
          </Group>
        )}
      </Scroll>
    </Floating>
  );
}

/* ---------------------------------------------------------- a source group */

/**
 * One group of Your sources whole (its "More"): every row with its kind, the one open marked; a press opens it, its star
 * stars it, its minus takes it out of this workspace (the library keeps it). Long groups get a search.
 */
export function SourcesPanel({ anchor, group, activeId, starred, inRail, onOpen, onStar, onRemove, onOpenWorkspace, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const needle = q.trim().toLowerCase();
  const rows = needle ? group.rows.filter((row) => `${row.name} ${row.url || ''}`.toLowerCase().includes(needle)) : group.rows;
  const peek = usePeek();
  return (
    <Floating anchor={anchor} width={340} cap={620} label={group.label} onClose={onClose} ignore={ignore} data-sb-panel={`sources-${group.key}`}>
      <PanelHead title={group.label} count={group.rows.length} />
      {group.rows.length > 8 && <SearchField value={q} onChange={setQ} placeholder={`Find in ${group.label}`} />}
      <Scroll>
        {rows.map((row) => {
          const on = starred.has(row.id);
          return (
            <PanelRow
              key={row.id}
              data-sb-source-all={row.id}
              icon={<Glyph item={row} box={16} color="#4d4d4d" />}
              title={row.name}
              faint={isUntitled(row.name)}
              active={row.id === activeId}
              onClick={(event) => { peek.drop(); onClose(); onOpen(row, event); }}
              onEnter={(event) => peek.open(row, event.currentTarget, panelEdge(event.currentTarget))}
              onLeave={peek.close}
              actions={(
                <>
                  <RowAction label={on ? 'Unstar' : 'Star'} shown={on} onClick={() => onStar(row, !on)}><I.StarIcon size={14} filled={on} /></RowAction>
                  {inRail(row.id) && <RowAction label={`Take ${row.name} out of this workspace`} onClick={() => onRemove(row)}><I.MinusCircleIcon size={14} /></RowAction>}
                </>
              )}
            />
          );
        })}
        {!rows.length && <Empty>{needle ? 'Nothing by that name.' : 'Nothing here yet.'}</Empty>}
      </Scroll>
      {peek.peek && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={(pid, wid) => { peek.drop(); onClose(); onOpenWorkspace(pid, wid); }} />}
    </Floating>
  );
}

/* -------------------------------------------------------------- the project */

/**
 * The project's menu, under its name (Switch Projects: Linear's workspace menu with only "Switch workspace", and Rename):
 * Switch project opens the list beside it, every project with this one ticked, then New project and All projects.
 */
export function ProjectMenu({ anchor, project, onSwitch, onNewProject, onAllProjects, onRename, onClose, ignore }) {
  const [list, setList] = React.useState(null);
  const [sub, setSub] = React.useState(null); // the Switch row's rect while its list is open
  const switchRef = React.useRef(null);
  React.useEffect(() => {
    let live = true;
    api.listProjects().then((projects) => { if (live) setList(projects); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  const openSub = () => { if (switchRef.current) { const r = switchRef.current.getBoundingClientRect(); setSub({ left: r.left, right: r.right, top: r.top - 5, bottom: r.bottom }); } };
  const item = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 32, boxSizing: 'border-box', padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13.5) };
  return (
    <>
      <Floating anchor={anchor} side="below" gap={4} width={230} label="Project" onClose={onClose} ignore={ignore} data-sb-panel="project" style={{ padding: 5, gap: 1 }}>
        <button ref={switchRef} type="button" className="hov-wash" data-sb-switch-project="1" aria-expanded={!!sub} onMouseEnter={openSub} onClick={openSub} style={{ ...item, background: sub ? '#f2f2f2' : 'transparent' }}>
          <span style={{ flex: 1 }}>Switch project</span>
          <I.ChevronRight size={13} style={{ color: '#8f8f8f' }} />
        </button>
        <button type="button" className="hov-wash" data-sb-rename-project="1" onMouseEnter={() => setSub(null)} onClick={() => { onClose(); onRename(); }} style={item}>
          <span style={{ flex: 1 }}>Rename</span>
        </button>
      </Floating>
      {sub && (
        <Floating anchor={sub} side="right" gap={6} width={250} cap={460} label="Switch project" onClose={() => setSub(null)} ignore="[data-sb-switch-project]" data-sb-panel="projects" style={{ padding: 5, gap: 1 }}>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {list === null && <div style={{ padding: '7px 10px', ...text(13, '#8f8f8f') }}>Loading…</div>}
            {(list || []).map((candidate) => (
              <button key={candidate.id} type="button" className="hov-wash" data-sb-project={candidate.id} onClick={() => { onClose(); if (candidate.id !== project.id) onSwitch(candidate.id); }} style={item}>
                <I.ProjectIcon size={15} style={{ color: '#4d4d4d' }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: candidate.id === project.id ? 500 : 400 }}>{candidate.name}</span>
                {candidate.id === project.id && <I.CheckIcon size={14} style={{ color: '#171717' }} />}
              </button>
            ))}
          </div>
          <div style={{ height: 1, margin: '4px 6px', background: '#efefef' }} />
          <button type="button" className="hov-wash" data-sb-new-project="1" onClick={() => { onClose(); onNewProject(); }} style={item}><I.PlusIcon size={15} style={{ color: '#4d4d4d' }} /><span>New project</span></button>
          <button type="button" className="hov-wash" data-sb-all-projects="1" onClick={() => { onClose(); onAllProjects(); }} style={item}><I.LibraryIcon size={15} style={{ color: '#4d4d4d' }} /><span>All projects and library</span></button>
        </Floating>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- Search */

const MAX_EACH = 6;

/**
 * Search (the head's magnifier): the project's workspaces, this workspace's sources, and the library, as words are typed;
 * an address or a path can be added. ↑↓ and Enter, or a press: a workspace goes there, a source opens; a library row's +
 * brings it into this workspace.
 */
export function SearchDialog({ projectId, workspaces, rows, library, inRail, onGoWorkspace, onOpen, onLink, onAddInput, onClose }) {
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const [found, setFound] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const typed = q.trim();
  const addable = looksAddable(typed);
  React.useEffect(() => {
    if (!addable) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api.lookupLibraryItem(typed)
        .then((result) => { if (live) setFound({ query: typed, result }); })
        .catch((error) => { if (live) setFound({ query: typed, result: { row: null, found: null, error: errorMessage(error) } }); });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [addable, typed]);
  const answer = addable && found && found.query === typed ? found.result : undefined;
  const bodies = useBodies(projectId, true);
  const sections = React.useMemo(() => {
    if (!typed) return [];
    const out = [];
    const spaces = findWorkspaces(workspaces, typed).slice(0, MAX_EACH).map((workspace) => ({ kind: 'workspace', key: `ws:${workspace.id}`, workspace }));
    if (spaces.length) out.push({ title: 'Workspaces', items: spaces });
    const here = searchRows({ query: typed, library: rows, inRail: () => true, bodies }).slice(0, MAX_EACH).map((result) => ({ kind: 'source', key: `here:${result.key}`, result }));
    if (here.length) out.push({ title: 'In this workspace', items: here });
    const held = new Set(rows.map((row) => row.id));
    const lib = searchRows({ query: typed, library: library.filter((row) => !held.has(row.id)), inRail, found: answer, bodies }).slice(0, MAX_EACH).map((result) => ({ kind: result.kind === 'fresh' ? 'fresh' : 'library', key: `lib:${result.key}`, result }));
    if (lib.length) out.push({ title: 'Library', items: lib });
    return out;
  }, [typed, workspaces, rows, library, inRail, answer, bodies]);
  const flat = sections.flatMap((section) => section.items);
  const at = flat.length ? Math.min(idx, flat.length - 1) : -1;
  const activate = async (item) => {
    if (!item) return;
    try {
      if (item.kind === 'workspace') { onClose(); onGoWorkspace(item.workspace.id); }
      else if (item.kind === 'fresh') { await onAddInput(typed); onClose(); }
      else { onClose(); onOpen(item.result.row); }
    } catch (error) { setProblem(errorMessage(error)); }
  };
  const onKey = (event) => {
    const n = flat.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); void activate(flat[at]); }
  };
  let n = -1;
  return (
    <Centered onClose={onClose} label="Search" data-sb-search-dialog="1">
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid #f0f0f0' }}>
        <I.SearchIcon size={16} style={{ color: '#8f8f8f' }} />
        <SearchInput value={q} onChange={(value) => { setQ(value); setIdx(0); setProblem(''); }} onKeyDown={onKey} />
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: typed ? '4px 6px 8px' : 0 }}>
        {sections.map((section) => (
          <Group key={section.title} title={section.title}>
            {section.items.map((item) => {
              n += 1;
              const i = n;
              if (item.kind === 'workspace') {
                return <PanelRow key={item.key} data-search-result={item.key} icon={<I.WorkspaceIcon size={15} />} title={item.workspace.name} meta={item.workspace.above.length ? item.workspace.above.join(' / ') : null} active={i === at} onEnter={() => setIdx(i)} onClick={() => activate(item)} />;
              }
              const result = item.result;
              const row = result.kind === 'item' ? result.row : null;
              return (
                <PanelRow
                  key={item.key}
                  data-search-result={item.key}
                  icon={<Glyph item={row || result.found} box={16} color="#4d4d4d" />}
                  title={item.kind === 'fresh' ? `Add ${result.name}` : result.name}
                  active={i === at}
                  onEnter={() => setIdx(i)}
                  onClick={() => activate(item)}
                  actions={item.kind === 'library' && row && !inRail(row.id) ? <RowAction label="Add to this workspace" shown={i === at} onClick={() => { onClose(); void onLink(row); }}><I.PlusIcon size={14} /></RowAction> : null}
                />
              );
            })}
          </Group>
        ))}
        {typed && !flat.length && <Empty>Nothing matches “{typed}”.</Empty>}
        {(problem || (answer && answer.error)) && <div style={{ padding: '4px 14px 8px', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{problem || answer.error}</div>}
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 14, padding: '8px 16px', borderTop: '1px solid #f0f0f0', ...text(11.5, '#8f8f8f') }}>
        <span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span>
      </div>
    </Centered>
  );
}

function SearchInput({ value, onChange, onKeyDown }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const timer = setTimeout(() => { if (ref.current) ref.current.focus(); }, 0); return () => clearTimeout(timer); }, []);
  return <input ref={ref} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Search workspaces, sources and the library" aria-label="Search" spellCheck={false} data-sb-search-input="1" style={{ flex: 1, minWidth: 0, height: 52, padding: 0, border: 0, background: 'transparent', ...text(15) }} />;
}

/* ------------------------------------------------------- a new workspace */

/** Its name (Workspaces' +, a workspace's +): Enter or Create makes it, in `parent` when there is one; left empty it is untitled. */
export function NewWorkspaceDialog({ parent = null, onCreate, onClose }) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const ref = React.useRef(null);
  React.useEffect(() => { const timer = setTimeout(() => { if (ref.current) ref.current.focus(); }, 0); return () => clearTimeout(timer); }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true); setProblem('');
    try { await onCreate(name.trim()); onClose(); } catch (error) { setProblem(errorMessage(error)); setBusy(false); }
  };
  const button = { minHeight: 32, padding: '0 14px', borderRadius: 7, cursor: 'pointer', ...text(13, '#171717', 500) };
  return (
    <Centered onClose={() => { if (!busy) onClose(); }} label={parent ? 'New sub-workspace' : 'New workspace'} width={420} top="18vh" data-sb-new-workspace-dialog="1">
      <div style={{ padding: '18px 20px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={text(15, '#171717', 600)}>{parent ? 'New sub-workspace' : 'New workspace'}</div>
        <div style={text(12.5, '#8f8f8f')}>{parent ? <>Inside <span style={{ color: '#4d4d4d' }}>{parent.name}</span>. A workspace holds a research question or goal: its document, notes and sources.</> : 'A workspace holds a research question or goal: its document, notes and sources.'}</div>
      </div>
      <div style={{ padding: '10px 20px 4px' }}>
        <input ref={ref} value={name} onChange={(event) => setName(event.target.value.replace(/[/\\]/g, '-'))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} placeholder={parent ? 'Sub-workspace name' : 'Workspace name'} aria-label="Name" spellCheck={false} data-sb-new-workspace-name="1" style={{ width: '100%', boxSizing: 'border-box', height: 36, padding: '0 11px', border: '1px solid #e2e2e2', borderRadius: 8, background: '#fff', ...text(14) }} />
        {problem && <div style={{ marginTop: 6, ...text(12, '#e70022') }}>{problem}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px 18px' }}>
        <button type="button" className="hov-bd2" onClick={onClose} disabled={busy} style={{ ...button, border: '1px solid #e5e5e5', background: '#fff', color: '#4d4d4d', fontWeight: 400 }}>Cancel</button>
        <button type="button" className="hov-dim" onClick={create} disabled={busy} data-sb-create-workspace="1" style={{ ...button, border: 0, background: '#171717', color: '#fff', opacity: busy ? 0.6 : 1 }}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </Centered>
  );
}

/* ----------------------------------------------------------- right-click */

/** A menu at the pointer (`at` { x, y }): `items` [{ label, onClick, danger, separator }]. */
export function ContextMenu({ at, items, onClose }) {
  const layer = useLayer();
  const ref = React.useRef(null);
  useDismiss(ref, onClose, { layer });
  const [spot, setSpot] = React.useState({ left: at.x, top: at.y, visibility: 'hidden' });
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setSpot({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y]);
  return createPortal(
    <div ref={ref} role="menu" data-overlay="1" data-sb-layer={layer} data-sb-context-menu="1" style={{ position: 'fixed', zIndex: 120, ...spot, minWidth: 190, boxSizing: 'border-box', padding: 5, display: 'flex', flexDirection: 'column', gap: 1, background: '#fff', border: '1px solid #e6e6e6', borderRadius: 9, boxShadow: SHADOW, animation: `rise 120ms ${EASE}` }}>
      {items.map((item, i) => (item.separator
        ? <div key={`s${i}`} style={{ height: 1, margin: '4px 6px', background: '#efefef' }} />
        : (
          <button key={item.label} type="button" role="menuitem" className="hov-wash" onClick={() => { onClose(); item.onClick(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13, item.danger ? '#e70022' : '#171717') }}>
            {item.icon && <span style={{ width: 15, display: 'flex', justifyContent: 'center', color: item.danger ? '#e70022' : '#4d4d4d' }}>{item.icon}</span>}
            {item.label}
          </button>
        )))}
    </div>,
    document.body,
  );
}
