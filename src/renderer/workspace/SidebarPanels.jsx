// What the sidebar (Rail.jsx; redone 2026-10-13 from design/sidebar-mockup/Sidebar.html) opens beside itself: Hudson's
// "(not centered) scrollable modal next to that (to the right) that shows all of the options". Agents (the Inbox folded in)
// and Library from the fixed rows; every project here (Projects' More) and a level's siblings (its More); a folded
// project's children while the pointer rests on it; a folder of Sources whole (its More); what + adds to a folder; the
// project's menu under its name; and, in the middle of the window, Search, Keyboard shortcuts, a new project's name and a
// new folder's. One is open at a time; Escape or a press anywhere else closes it, and Escape never goes on to leave the
// project.

import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND, KindGlyph as Glyph } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { libraryPanelRows, looksAddable, parseSources, searchRows } from '../model/rail.js';
import { LIBRARY_CHIPS, libraryCounts } from '../model/kind.js';
import { findWorkspaces } from '../model/nav.js';
import { countLabel, sinceWords, sourceIcon, shortcutProjects } from '../model/sidebar.js';
import { NotificationRows, useBuildNotifications } from '../ui/SandboxNotifications.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { useBodies } from './useBodies.js';
import { useAddRun } from './useAddRun.js';
import GithubPane from './GithubPane.jsx';
import { ItemPeek } from '../screens/Home.jsx';
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
export function Floating({ anchor, side = 'right', gap = 8, cap = 560, width = 340, onClose, ignore = null, label, style, children, panelRef = null, ...rest }) {
  const layer = useLayer();
  const [ref, placed] = usePlaced(anchor, { side, gap, cap });
  useDismiss(ref, onClose, { ignore, layer });
  const setRef = (element) => { ref.current = element; if (panelRef) panelRef.current = element; };
  return createPortal(
    <div ref={setRef} role="dialog" aria-label={label} data-overlay="1" data-sb-layer={layer} {...rest} style={{ ...placed, zIndex: 80, width, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, boxShadow: SHADOW, animation: `rise 140ms ${EASE}`, ...(placed.maxHeight != null ? { overflowY: 'hidden' } : {}), ...style }}>
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

export function PanelHead({ title, count, note = null, children }) {
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 6px' }}>
      <span style={{ ...text(13, '#171717', 600), whiteSpace: 'nowrap' }}>{title}</span>
      {count != null && count > 0 && <span style={text(12, '#8f8f8f')}>{count}</span>}
      {note && <span style={{ ...text(12, '#8f8f8f'), whiteSpace: 'nowrap' }}>{note}</span>}
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
  return <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px' }}>{children}</div>;
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

/* ----------------------------------------------------------------- counts */

/** The Agents row's count (2026-10-13): a number in a rounded square, its outline breathing while any agent runs, filled grey once all of them wait to be looked at; 9+ past nine. */
export function Pill({ summary, ...rest }) {
  if (!summary || !summary.total) return null;
  const label = `${summary.ready} to look at, ${summary.running} running`;
  return <span className={`sb-pill ${summary.running ? 'running' : 'ready'}`} title={label} aria-label={label} {...rest}>{countLabel(summary.total)}</span>;
}

/** A project's count: the bare number, grey and breathing while something under it runs, dark once all of it is ready. */
export function Count({ summary, ...rest }) {
  if (!summary || !summary.total) return null;
  const label = `${summary.ready} to look at, ${summary.running} running`;
  return <span className={`sb-count ${summary.running ? 'running' : 'done'}`} title={label} aria-label={label} {...rest}>{countLabel(summary.total)}</span>;
}

/** How long ago, short: now, 4m, 2h, 3d. */
export function since(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (Number.isNaN(at)) return '';
  const m = Math.round(Math.max(0, now - at) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/**
 * A path that does not fit loses its front, a level at a time, to "./" (Engelbart/User Interface → ./User Interface).
 * `parts`: the names, outermost first.
 */
export function FitCrumb({ parts, style, ...rest }) {
  const ref = React.useRef(null);
  const [dropped, setDropped] = React.useState(0);
  const key = parts.join('\n');
  React.useLayoutEffect(() => { setDropped(0); }, [key]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || dropped >= parts.length - 1) return;
    if (el.scrollWidth > el.clientWidth + 1) setDropped(dropped + 1);
  });
  return <span ref={ref} data-crumb={parts.join('/')} {...rest} style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'clip', ...text(12, '#8f8f8f'), ...style }}>{dropped ? `./${parts.slice(dropped).join('/')}` : parts.join('/')}</span>;
}

/* ----------------------------------------------------------------- Agents */

const AGENT_GROUPS = [['Failed', 'failed'], ['Needs you', 'needs'], ['Finished', 'unseen'], ['Running', 'running'], ['Earlier', 'done']];
const EARLIER_SHOWN = 12;
const agentIcon = (kind) => (kind === 'connect' ? <I.LibraryIcon size={15} /> : kind === 'bart' || kind === 'brainstorm' || kind === 'discover' ? <I.ChatIcon size={15} /> : <I.AgentsIcon size={15} />);

/**
 * Agents, with what was the Inbox (2026-10-13: "Combine inbox and Agents into just Agents"): what failed, what needs you,
 * what finished and was not looked at, what runs, and the last few done, newest first in each; under them the repositories'
 * builds the notification bell held (Building… → Build finished / Build failed), read once the panel opens. A row says
 * where it is and how long ago, with its own count; a press goes to it. "Next agent needing attention" is ⌘J's.
 * `entries`: model/sidebar.js agentEntries. `crumbOf(node)`: the project's path, names outermost first.
 */
export function AgentsPanel({ anchor, entries, crumbOf, onGo, onNext, onSeenAll, onClose, ignore }) {
  const { sandboxes, rows: repoBuilds } = useBuildNotifications();
  const unread = repoBuilds.filter((row) => !row.read).map((row) => row.id);
  React.useEffect(() => { if (sandboxes && unread.length) sandboxes.markNotificationsRead(unread); }, [sandboxes, unread.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = React.useState(0);
  React.useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(timer); }, []);
  const groups = AGENT_GROUPS.map(([title, state]) => [title, state, entries.filter((entry) => entry.state === state)])
    .map(([title, state, list]) => [title, state, state === 'done' ? list.slice(0, EARLIER_SHOWN) : list])
    .filter(([, , list]) => list.length);
  const toLook = entries.filter((entry) => entry.state === 'needs' || entry.state === 'unseen' || entry.state === 'failed').length;
  const unseen = entries.some((entry) => entry.state === 'unseen');
  const row = (entry) => {
    const crumb = entry.node ? crumbOf(entry.node) : entry.kind === 'quick' ? ['A post-it'] : entry.did ? [entry.did] : [];
    return (
      <div key={entry.id} role="button" tabIndex={-1} className="sb-prow" data-agent-entry={entry.id} data-agent-state={entry.state} onClick={() => onGo(entry)} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
        <span style={{ flex: 'none', width: 18, display: 'flex', justifyContent: 'center', color: '#4d4d4d' }}>{agentIcon(entry.kind)}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(14, '#171717'), lineHeight: 1.35 }}>{entry.title}</span>
          {crumb.length > 0 && <FitCrumb parts={crumb} style={{ marginTop: 1, lineHeight: 1.35 }} />}
        </span>
        <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, ...text(12, '#8f8f8f') }}>{since(entry.at)}<Pill summary={{ total: entry.state === 'done' ? 0 : 1, running: entry.state === 'running' ? 1 : 0, ready: entry.state === 'running' ? 0 : 1 }} /></span>
      </div>
    );
  };
  return (
    <Floating anchor={anchor} width={360} cap={620} label="Agents" onClose={onClose} ignore={ignore} data-sb-panel="agents">
      <PanelHead title="Agents" note={toLook > 0 ? <span data-agents-to-look="1">{toLook} to look at</span> : null}>
        {unseen && <button type="button" className="hov-bd2" data-agents-seen-all="1" onClick={onSeenAll} style={{ height: 26, padding: '0 10px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', boxShadow: '0 1px 1px #0000000a', cursor: 'pointer', ...text(12, '#171717', 500) }}>Mark all as seen</button>}
      </PanelHead>
      {!groups.length && !(repoBuilds.length || (sandboxes && sandboxes.error))
        ? <Empty>Nothing yet. When an agent finishes or asks you something, it shows here.</Empty>
        : (
          <Scroll style={{ padding: '4px 6px 8px' }}>
            {groups.map(([title, state, list]) => <Group key={state} title={title}>{list.map(row)}</Group>)}
            {sandboxes && (repoBuilds.length > 0 || sandboxes.error) && (
              <div data-agents-repositories="1">
                <div style={{ padding: '10px 10px 4px', ...text(12, '#8f8f8f', 500) }}>Repositories</div>
                <NotificationRows sandboxes={sandboxes} rows={repoBuilds} onClose={onClose} />
              </div>
            )}
          </Scroll>
        )}
      <button type="button" className="hov-wash" data-agents-next="1" onClick={() => { onClose(); onNext(); }} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 20, width: '100%', minHeight: 38, boxSizing: 'border-box', padding: '8px 14px', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13.5) }}>
        <span>Next agent needing attention</span><span className="sb-shortcut" style={{ marginLeft: 'auto' }}>⌘J</span>
      </button>
    </Floating>
  );
}

/* ---------------------------------------------------------------- Library */

/**
 * The Library panel's chips (All · Notes · Papers · Repos · Web · Files): one on at a time, a press on the one that is on
 * goes back to All, a chip with nothing under it is left out. Each shows its count only when every count fits the row.
 * The keyboard: Tab from the search lands on the chip that is on, Left and Right move along, Space or Enter picks one;
 * a pick hands the keyboard back to the search (`onPicked`).
 */
function LibraryChips({ chip, counts, onPick, chipsRef }) {
  const shown = LIBRARY_CHIPS.filter((one) => one.id === 'all' || counts[one.id] > 0);
  const rowRef = React.useRef(null);
  const measureRef = React.useRef(null);
  const [fits, setFits] = React.useState(true);
  const sign = shown.map((one) => `${one.id}:${counts[one.id]}`).join(',');
  React.useLayoutEffect(() => {
    if (rowRef.current && measureRef.current) setFits(measureRef.current.scrollWidth <= rowRef.current.clientWidth);
  }, [sign]);
  const move = (event, from) => {
    const buttons = [...(chipsRef.current ? chipsRef.current.querySelectorAll('[data-library-chip]') : [])];
    const at = buttons.indexOf(event.currentTarget);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      if (next) next.focus();
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onPick(from);
    }
  };
  const chipStyle = (on) => ({ flex: 'none', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', border: `1px solid ${on ? '#efefef' : '#eaeaea'}`, borderRadius: 6, background: on ? '#efefef' : 'transparent', cursor: 'pointer', whiteSpace: 'nowrap', ...text(12, on ? '#171717' : '#4d4d4d', on ? 500 : 400) });
  const label = (one, withCount) => <>{one.label}{withCount && <span style={text(12, '#8f8f8f')}>{counts[one.id]}</span>}</>;
  return (
    <div ref={(el) => { rowRef.current = el; chipsRef.current = el; }} role="toolbar" aria-label="Show only" data-library-chips="1" style={{ flex: 'none', position: 'relative', display: 'flex', alignItems: 'center', gap: 4, margin: '0 10px 6px', overflow: 'hidden' }}>
      {shown.map((one) => (
        <button
          key={one.id}
          type="button"
          className={one.id === chip ? '' : 'hov-wash'}
          data-library-chip={one.id}
          aria-pressed={one.id === chip}
          tabIndex={one.id === chip ? 0 : -1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(one.id)}
          onKeyDown={(event) => move(event, one.id)}
          style={chipStyle(one.id === chip)}
        >
          {label(one, fits)}
        </button>
      ))}
      {/* the same row with every count, out of sight, to know whether the counts fit */}
      <div ref={measureRef} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 'max-content', visibility: 'hidden', pointerEvents: 'none', display: 'flex', gap: 4, whiteSpace: 'nowrap' }}>
        {shown.map((one) => <span key={one.id} style={chipStyle(one.id === chip)}>{label(one, true)}</span>)}
      </div>
    </div>
  );
}

/**
 * Library (Sidebar brainstorming: "a modal … search, recent and current-context items, Open full Library"): the search has
 * the keyboard; before anything is typed, what was worked on last. A press opens a row; its + brings it into this
 * workspace; an address or a path typed is added. Hovering one peeks at it. "Open full library" goes to the projects screen.
 */
export function LibraryPanel({ anchor, chip: openOn = 'all', projectId, library, inRail, onOpen, onLink, onAddInput, onOpenFull, onOpenWorkspace, onClose, ignore, picking = null, panelRef = null }) {
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
  const counts = React.useMemo(() => libraryCounts(library), [library]); // a pasted picture is its document's: under no chip
  // Which kind is shown: kept while the panel is open, All again each time it opens (or the tab the Welcome walkthrough's
  // step 1 opened it on, `chip`); a chip emptied meanwhile is All.
  const [picked, setPicked] = React.useState(openOn || 'all');
  const chip = counts[picked] > 0 ? picked : 'all';
  const chipNoun = (LIBRARY_CHIPS.find((one) => one.id === chip) || {}).noun || '';
  const inputRef = React.useRef(null);
  const chipsRef = React.useRef(null);
  const pickChip = (id) => {
    setPicked(id === chip ? 'all' : id);
    setIdx(0);
    if (inputRef.current) inputRef.current.focus({ preventScroll: true });
  };
  // Picking (2026-10-13, + on Sources: its More opens the whole library beside it): a press adds the row to where + was
  // pressed (`picking.onPick`), and what is there already is left out.
  const listed = React.useMemo(() => (picking ? library.filter((row) => !picking.has(row.id)) : library), [library, picking]);
  const rows = React.useMemo(
    () => libraryPanelRows({ query: typed, library: listed, chip, inRail, found: answer, bodies }),
    [typed, listed, chip, inRail, answer, bodies],
  );
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
    else if (picking) void run(async () => { await picking.onPick(result.row); });
    else { onClose(); onOpen(result.row); }
  };
  const onKey = (event) => {
    const n = rows.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pick(rows[at]); }
    else if (event.key === 'Tab' && !event.shiftKey && chipsRef.current) {
      const on = chipsRef.current.querySelector('[data-library-chip][tabindex="0"]') || chipsRef.current.querySelector('[data-library-chip]');
      if (on) { event.preventDefault(); on.focus(); }
    }
  };
  return (
    <Floating anchor={anchor} width={360} cap={600} label="Library" onClose={onClose} ignore={ignore} panelRef={panelRef} data-sb-panel="library" data-picking={picking ? '1' : undefined}>
      <PanelHead title="Library" count={counts.all}>
        {picking && <RowAction label="Close library" shown onClick={onClose} data-close-picker-library="1"><I.CloseIcon size={14} /></RowAction>}
      </PanelHead>
      <SearchField value={q} onChange={(value) => { setQ(value); setIdx(0); setProblem(''); }} onKeyDown={onKey} inputRef={inputRef} placeholder="Search the library, or paste a link" />
      {counts.all > 0 && <LibraryChips chip={chip} counts={counts} onPick={pickChip} chipsRef={chipsRef} />}
      {!typed && <div data-library-heading="1" style={{ padding: '2px 14px 2px', ...text(12, '#8f8f8f', 500) }}>{chipNoun ? `Recent ${chipNoun}` : 'Recent'}</div>}
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
                : picking ? null
                  : here ? <span style={{ ...text(11.5, '#8f8f8f'), padding: '0 4px' }}>In this project</span>
                    : <RowAction label="Add to this project" onClick={() => void run(async () => { await onLink(row); })}><I.PlusIcon size={14} /></RowAction>}
            />
          );
        })}
        {!rows.length && <Empty>{chipNoun
          ? (typed ? `No ${chipNoun} match` : `No ${chipNoun} in the library`)
          : (typed ? 'Nothing in the library by that name.' : 'The library is empty. Add a source to start it.')}</Empty>}
        {(problem || (answer && answer.error)) && <div style={{ padding: '4px 10px', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{problem || answer.error}</div>}
      </Scroll>
      {!picking && <PanelFoot><FootButton onClick={() => { onClose(); onOpenFull(); }} data-sb-open-library="1"><I.LibraryIcon size={14} />Open full library</FootButton></PanelFoot>}
      {peek.peek && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={(pid, wid) => { peek.drop(); onClose(); onOpenWorkspace(pid, wid); }} />}
    </Floating>
  );
}

/* --------------------------------------------------------------- projects */

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

const CHEVRON = (size = 13) => <I.ChevronDown size={size} stroke={2.4} />;

/**
 * Projects as a tree in a panel (the mockup's treeRows): the section's More, a level's More and the card a folded project
 * shows on hover. A level-2 project has its icon; each row has its count and, unless `expandAll`, a chevron that folds it
 * (`folded`, a Set; `onFold(id)`). `guideLevel`: the level whose children get the guide line; `contextRoot`: the project the
 * card is about, in bold. `q`: what the panel's search holds; a row shows when it or something in it matches.
 */
export function ProjectTree({ ids, depth = 0, tree, counts, hereId, folded = null, onFold = null, expandAll = false, guideLevel = null, contextRoot = null, q = '', onGo, onMenu = null }) {
  const matches = (id) => { const n = tree.get(id).node; return !q || n.name.toLowerCase().includes(q) || (n.children || []).some((child) => matches(child.id)); };
  return ids.filter((id) => tree.has(id) && matches(id)).map((id) => {
    const at = tree.get(id), n = at.node;
    const kids = (n.children || []).map((child) => child.id);
    const isFolded = !expandAll && !q && !!folded && folded.has(id);
    const here = id === hereId;
    const inHere = hereId && tree.has(hereId) && tree.get(hereId).path.includes(id);
    return (
      <React.Fragment key={id}>
        <div
          role="button"
          tabIndex={-1}
          className={`sb-prow${id === contextRoot ? ' sb-fly-context' : ''}`}
          data-tree-project={id}
          data-active={here ? '1' : undefined}
          onClick={() => onGo(id)}
          onContextMenu={onMenu ? (event) => onMenu(event, id) : undefined}
          style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, boxSizing: 'border-box', padding: '0 8px', borderRadius: 6, cursor: 'pointer', background: here ? '#ececec' : undefined }}
        >
          {at.level === 2 ? <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5c5c5c' }}><I.WorkspaceIcon size={18} /></span>
            : depth === 0 ? <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#4d4d4d' }}><I.WorkspaceIcon size={15} /></span> : null}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(depth ? 13.5 : 14, depth ? '#4d4d4d' : '#171717', id === contextRoot || here ? 500 : 400), ...(isUntitled(n.name) ? { color: '#8f8f8f' } : {}) }}>{n.name}</span>
          <span className="sb-tools" style={{ marginLeft: 0 }}>
            <span className="sb-slot-count"><Count summary={counts.get(id)} /></span>
            {!expandAll && <span className="sb-slot-chev">{kids.length > 0 && <button type="button" className={`sb-chev${at.level > 1 && !inHere ? ' sb-on-hover' : ''}`} data-tree-fold={id} data-open={isFolded ? '0' : '1'} aria-label={`${isFolded ? 'Open' : 'Fold'} ${n.name}`} onClick={(event) => { event.stopPropagation(); if (onFold) onFold(id); }}>{CHEVRON()}</button>}</span>}
          </span>
        </div>
        {kids.length > 0 && !isFolded && (
          <div className="sb-fly-kids" data-parent={id} data-guide={at.level === guideLevel ? '1' : '0'} style={{ paddingLeft: depth ? 18 : 22 }}>
            <ProjectTree ids={kids} depth={depth + 1} tree={tree} counts={counts} hereId={hereId} folded={folded} onFold={onFold} expandAll={expandAll} guideLevel={guideLevel} contextRoot={contextRoot} q={q} onGo={onGo} onMenu={onMenu} />
          </div>
        )}
      </React.Fragment>
    );
  });
}

const useFolded = (initial) => {
  const [folded, setFolded] = React.useState(() => new Set(initial));
  const flip = React.useCallback((id) => setFolded((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  return [folded, flip];
};

/**
 * Every project here (Projects' More): a search, the tree with every level-2 project folded but the one you are in, each
 * row's count, a + that makes one at the top; under it every archived version (one per Clear), newest first.
 */
export function ProjectsPanel({ anchor, roots, tree, counts, hereId, versions = [], onGo, onNew, onMenu, onOpenVersion, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const branch = hereId && tree.has(hereId) ? tree.get(hereId).path[0] : null;
  const [folded, flip] = useFolded(roots.filter((node) => node.id !== branch && (node.children || []).length).map((node) => node.id));
  const go = (id) => { onClose(); onGo(id); };
  const needle = q.trim().toLowerCase();
  return (
    <Floating anchor={anchor} width={340} cap={620} label="Projects" onClose={onClose} ignore={ignore} data-sb-panel="projects">
      <PanelHead title="Projects" count={tree.size}>
        <RowAction label="Create project" shown onClick={() => { onClose(); onNew(null); }} data-sb-panel-new="1"><I.PlusIcon size={15} /></RowAction>
      </PanelHead>
      <SearchField value={q} onChange={setQ} placeholder="Find a project" />
      <Scroll style={{ padding: '4px 6px 8px' }}>
        <ProjectTree ids={roots.map((node) => node.id)} tree={tree} counts={counts} hereId={hereId} folded={folded} onFold={flip} q={needle} onGo={go} onMenu={onMenu} />
        {needle && ![...tree.values()].some((entry) => entry.node.name.toLowerCase().includes(needle)) && <Empty>No project by that name.</Empty>}
        {!needle && versions.length > 0 && (
          <Group title="Archived">
            {versions.map((version) => (
              <PanelRow key={`${version.workspaceId}/${version.file}`} data-sb-version={version.file} icon={<I.ArchiveIcon size={15} />} title={version.title} meta={`${version.name}${version.clearedAt ? ` · cleared ${sinceWords(version.clearedAt)}` : ''}`} onClick={() => { onClose(); onOpenVersion(version); }} />
            ))}
          </Group>
        )}
      </Scroll>
    </Floating>
  );
}

/** A level's More: every sibling there and what is in each, open, each foldable; nothing above them. */
export function SiblingsPanel({ anchor, parentId, roots, tree, counts, hereId, onGo, onMenu, onClose, ignore }) {
  const [folded, flip] = useFolded([]);
  const ids = parentId ? (tree.get(parentId).node.children || []).map((child) => child.id) : roots.map((node) => node.id);
  return (
    <Floating anchor={anchor} width={320} cap={560} label="More projects" onClose={onClose} ignore={ignore} data-sb-panel="siblings">
      <Scroll style={{ padding: '6px 6px 8px' }}>
        <ProjectTree ids={ids} depth={1} tree={tree} counts={counts} hereId={hereId} folded={folded} onFold={flip} onGo={(id) => { onClose(); onGo(id); }} onMenu={onMenu} />
      </Scroll>
    </Floating>
  );
}

/**
 * What a folded project holds, beside the sidebar while the pointer rests on its row (2026-10-13: "when I hover over a
 * project that has children I can see its children"): the project, then everything in it, open, with no chevrons; a
 * guide line only beside the deepest group, and none when there are only children.
 */
export function ProjectFlyout({ flyout, tree, counts, hereId, onGo, onHold, onLeave }) {
  const layer = useLayer({ stack: false });
  const [ref, placed] = usePlaced(flyout.anchor, { side: 'right', gap: 6, cap: 440 });
  const at = tree.get(flyout.id);
  if (!at) return null;
  let deepest = null;
  const walk = (node, level) => { for (const child of node.children || []) { if ((child.children || []).length) deepest = Math.max(deepest || 0, level + 1); walk(child, level + 1); } };
  walk(at.node, at.level);
  return createPortal(
    <div ref={ref} data-overlay="1" data-hover="1" data-sb-flyout={flyout.id} data-sb-layer={layer} onMouseEnter={onHold} onMouseLeave={onLeave} style={{ ...placed, zIndex: 82, width: 270, boxSizing: 'border-box', padding: 5, display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e6e6e6', borderRadius: 10, boxShadow: SHADOW, animation: `rise 140ms ${EASE}`, overflowY: 'auto' }}>
      <ProjectTree ids={[flyout.id]} tree={tree} counts={counts} hereId={hereId} expandAll guideLevel={deepest} contextRoot={flyout.id} onGo={onGo} />
    </div>,
    document.body,
  );
}

/** A tooltip in the app's own look, under what it is about (`at`, a rect), after the sidebar's beat. */
export function Tip({ at, children, ...rest }) {
  const width = 240;
  const left = Math.max(8, Math.min(at.left + 28, (window.innerWidth || 1200) - width - 8));
  const top = at.bottom + 48 <= (window.innerHeight || 800) ? at.bottom + 5 : Math.max(8, at.top - 45);
  return createPortal(<div role="tooltip" data-overlay="1" className="sb-tip" {...rest} style={{ left, top }}>{children}</div>, document.body);
}

/* ------------------------------------------------------------ the sources */

/**
 * A folder of Sources whole (its More): every source in it, the one open marked; a press opens it, its minus takes it out
 * of the folder (the library keeps it). Long folders get a search.
 */
export function SourcesPanel({ anchor, title, rows, activeId, removeLabel, onOpen, onRemove, onOpenWorkspace, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const needle = q.trim().toLowerCase();
  const listed = needle ? rows.filter((row) => `${row.name} ${row.url || ''}`.toLowerCase().includes(needle)) : rows;
  const peek = usePeek();
  return (
    <Floating anchor={anchor} width={330} cap={620} label={title} onClose={onClose} ignore={ignore} data-sb-panel="sources">
      <PanelHead title={title} count={rows.length} />
      {rows.length > 8 && <SearchField value={q} onChange={setQ} placeholder={`Find in ${title}`} />}
      <Scroll>
        {listed.map((row) => (
          <PanelRow
            key={row.id}
            data-sb-source-all={row.id}
            icon={<I.SourceIcon kind={sourceIcon(row)} size={16} />}
            title={row.name}
            faint={isUntitled(row.name)}
            active={row.id === activeId}
            onClick={(event) => { peek.drop(); onClose(); onOpen(row, event); }}
            onEnter={(event) => peek.open(row, event.currentTarget, panelEdge(event.currentTarget))}
            onLeave={peek.close}
            actions={onRemove ? <RowAction label={removeLabel(row)} onClick={() => onRemove(row)}><I.MinusCircleIcon size={14} /></RowAction> : null}
          />
        ))}
        {!listed.length && <Empty>{needle ? 'Nothing by that name.' : 'Nothing here yet.'}</Empty>}
      </Scroll>
      {peek.peek && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={(pid, wid) => { peek.drop(); onClose(); onOpenWorkspace(pid, wid); }} />}
    </Floating>
  );
}

const PICKER_SHOWN = 5;
const PICKER_LEAVE = 180; // ms after the pointer leaves the picker (and the library beside it) before it hides
const PICKER_MARGIN = 12;

/**
 * What + on Sources adds (2026-10-13, the mockup's add picker; its latest, Hudson 2026-10-15, desktop
 * engelbart-sidebar-mockup.html): a search over the library, its first five that are not there yet, More (the whole
 * library beside it, with its chips), then "Upload URL or path" always open (several pasted at once: model/rail.js
 * parseSources), what was added so far listed under it, Add from GitHub and "Upload or add files" (the file picker). It
 * stays open while things are added, each one listed; it hides by itself a beat after the pointer leaves it, the library
 * beside it and the + it came from (2026-10-13: "if I move my cursor outside the obvious area … it should auto hide").
 * `into`: what the + belongs to ({ name } of the project or of a folder); `has(id)`: whether it holds that row already.
 * `onPick(row)`, `onAddInput(input)` (→ the row), `onPickRepo(entry)` add to it.
 */
export function AddPicker({ anchor, from, into, projectId, library, inRail, has, onPick, onAddInput, onPickRepo, onLibraryChange, onClose, ignore }) {
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  const [value, setValue] = React.useState('');
  const [added, setAdded] = React.useState([]); // [{ key, name, row }] added while it was open
  const [view, setView] = React.useState('menu');
  const [side, setSide] = React.useState(null); // the library beside it: { anchor } while open
  const ref = React.useRef(null);
  const sideRef = React.useRef(null);
  const fieldRef = React.useRef(null);
  const searchRef = React.useRef(null);
  const { busy, error, setError, run } = useAddRun(null);
  // Nothing closes it while it is adding. It does not hide by itself while GitHub's sign-in or list is in it, or while a
  // link or a path is typed in it; Escape and a press elsewhere still close it then.
  const busyRef = React.useRef(false);
  busyRef.current = busy;
  const stayRef = React.useRef(false);
  stayRef.current = busy || view === 'github' || !!value.trim();
  React.useEffect(() => { const timer = setTimeout(() => { if (searchRef.current) searchRef.current.focus({ preventScroll: true }); }, 0); return () => clearTimeout(timer); }, []);
  React.useEffect(() => { if (onLibraryChange) onLibraryChange(!!side); }, [side, onLibraryChange]);
  // Hiding by itself: the pointer more than a little outside the picker, the library beside it, a peek and the + itself.
  React.useEffect(() => {
    let timer = null;
    const inside = (event) => {
      const boxes = [ref.current, sideRef.current, ...document.querySelectorAll('[data-sb-peek]')].filter(Boolean).map((el) => el.getBoundingClientRect());
      if (from) boxes.push(from);
      return boxes.some((r) => event.clientX >= r.left - PICKER_MARGIN && event.clientX <= r.right + PICKER_MARGIN && event.clientY >= r.top - PICKER_MARGIN && event.clientY <= r.bottom + PICKER_MARGIN);
    };
    const move = (event) => {
      if (inside(event) || stayRef.current) { clearTimeout(timer); timer = null; return; }
      if (!timer) timer = setTimeout(() => { timer = null; if (!stayRef.current) onClose(); }, PICKER_LEAVE);
    };
    const leave = () => { if (!timer && !stayRef.current) timer = setTimeout(() => { timer = null; if (!stayRef.current) onClose(); }, PICKER_LEAVE); };
    document.addEventListener('mousemove', move, true);
    document.documentElement.addEventListener('mouseleave', leave);
    return () => { clearTimeout(timer); document.removeEventListener('mousemove', move, true); document.documentElement.removeEventListener('mouseleave', leave); };
  }, [from, onClose]);
  const typed = q.trim();
  const candidates = React.useMemo(() => library.filter((row) => !has(row.id) && row.type !== 'image'), [library, has]);
  const results = React.useMemo(() => {
    if (!typed) return [...candidates].sort((a, b) => (Date.parse(b.last_edited || b.created || '') || 0) - (Date.parse(a.last_edited || a.created || '') || 0)).map((row) => ({ kind: 'item', key: row.id, row, name: row.name }));
    return searchRows({ query: typed, library: candidates, inRail: () => false, found: undefined }).filter((result) => result.kind === 'item');
  }, [typed, candidates]);
  const shown = results.slice(0, PICKER_SHOWN);
  const at = shown.length ? Math.min(idx, shown.length - 1) : -1;
  const peek = usePeek();
  const remember = (row, text = '') => setAdded((now) => { const key = (row && row.id) || text; return !key || now.some((one) => one.key === key) ? now : [...now, { key, name: (row && row.name) || text, row: row || null }]; });
  const pick = (row) => { if (row && !busy) void run(async () => { peek.drop(); await onPick(row); remember(row); return []; }); };
  // Each link or path typed or pasted is added in turn; what could not be stays in the field, saying why.
  const parsed = parseSources(value);
  const good = parsed.filter((one) => one.ok);
  const commit = () => {
    if (!good.length || busy) return;
    void run(async () => {
      const left = [], problems = [];
      const add = async (one) => {
        if (!one.ok) { left.push(one.text); problems.push(one.why); return; }
        try { remember(await onAddInput(one.text), one.text); } catch (failure) {
          // A path with spaces that is not one: its words, one by one.
          if (one.split) { for (const piece of one.split) await add(piece); return; }
          left.push(one.text); problems.push(errorMessage(failure));
        }
      };
      for (const one of parsed) await add(one);
      setValue(left.join(' '));
      setTimeout(() => { if (fieldRef.current) fieldRef.current.focus(); }, 0);
      return problems;
    });
  };
  // Upload or add files: the file picker, every file and folder chosen added as a typed path is.
  const chooseFiles = () => {
    if (busy) return;
    void run(async () => {
      const problems = [];
      for (const file of (await api.pickLibraryPaths()) || []) {
        try { remember(await onAddInput(file), file); } catch (failure) { problems.push(errorMessage(failure)); }
      }
      return problems;
    });
  };
  const openSide = () => {
    if (side) { setSide(null); return; }
    const r = ref.current ? ref.current.getBoundingClientRect() : null;
    if (r) setSide({ anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } });
  };
  const onSearchKey = (event) => {
    const n = shown.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (n) setIdx((at + 1) % n); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (n) setIdx((at - 1 + n) % n); }
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pick(shown[at].row); else if (looksAddable(typed)) { setValue(typed); setTimeout(() => { if (fieldRef.current) fieldRef.current.focus(); }, 0); } }
  };
  const mi = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 32, boxSizing: 'border-box', padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13.5) };
  return (
    <>
      <Floating anchor={anchor} width={320} cap={620} label={`Add sources to ${into.name}`} onClose={() => { if (!busyRef.current) onClose(); }} ignore={ignore} panelRef={ref} data-sb-panel="add" data-add-picker="1" style={{ padding: 8 }}>
        {view === 'github' ? (
          <>
            <GithubPane library={library} inRail={inRail} busy={busy} onBack={() => { setView('menu'); setError(''); }} onPick={(entry) => { if (!busy) void run(async () => { await onPickRepo(entry); return []; }); }} />
            {error && <div style={{ padding: '6px 2px 0', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{error}</div>}
          </>
        ) : (
          <>
            <div className="rail-field" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, height: 32, boxSizing: 'border-box', padding: '0 10px', marginBottom: 6, border: `1px solid ${q ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, background: '#fff' }}>
              <I.SearchIcon size={14} stroke={2.4} style={{ color: '#171717' }} />
              <input ref={searchRef} value={q} onChange={(event) => { setQ(event.target.value); setIdx(0); }} onKeyDown={onSearchKey} placeholder="Search library" aria-label="Search library" spellCheck={false} data-add-search="1" style={{ flex: 1, minWidth: 0, padding: 0, border: 0, outline: 'none', background: 'transparent', ...text(14) }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {shown.map((result, i) => (
                <button key={result.key} type="button" data-add-result={result.key} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(result.row)} onMouseEnter={(event) => { if (idx !== i) setIdx(i); peek.open(result.row, event.currentTarget, panelEdge(event.currentTarget)); }} onMouseLeave={peek.close} style={{ ...mi, background: i === at && typed ? '#f2f2f2' : 'transparent' }} className="hov-wash">
                  <span style={{ flex: 'none', display: 'flex', color: '#4d4d4d' }}><I.SourceIcon kind={sourceIcon(result.row)} size={16} /></span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.name}</span>
                </button>
              ))}
              {!shown.length && <div style={{ height: 30, display: 'flex', alignItems: 'center', paddingLeft: 10, ...text(13, '#a3a3a3') }}>Nothing matches</div>}
              {results.length > PICKER_SHOWN && (
                <button type="button" className="sb-row sb-more" data-add-more="1" onClick={openSide} style={{ display: 'flex', alignItems: 'center', height: 30, boxSizing: 'border-box', padding: '0 6px 0 8px', border: 0, borderRadius: 6, background: side ? '#e6e6e6' : 'transparent', cursor: 'pointer', ...text(14, '#8f8f8f'), lineHeight: '30px' }}>
                  <span aria-hidden="true" style={{ marginRight: 4 }}>...</span><span>More</span>
                </button>
              )}
            </div>
            {/* No line between the library and the rest (2026-10-14: "I never want horizontal dividing lines"): a gap. */}
            <div style={{ padding: '10px 0 4px' }}>
              <div className="rail-field" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, boxSizing: 'border-box', padding: '0 10px', border: `1px solid ${error && value ? '#e70022' : value ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, background: '#fff' }}>
                <I.PlusIcon size={14} stroke={2.4} style={{ flex: 'none', color: '#171717' }} />
                <input ref={fieldRef} value={value} readOnly={busy} onChange={(event) => { setValue(event.target.value); setError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} placeholder="Upload URL or path" aria-label="Upload URL or path" spellCheck={false} data-add-value="1" style={{ flex: 1, minWidth: 0, padding: 0, border: 0, outline: 'none', background: 'transparent', ...text(14) }} />
              </div>
              {error && <div data-add-error="1" style={{ padding: '6px 2px 2px', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{error}</div>}
              {good.length > 0 && <button type="button" className="hov-ink" data-add-link="1" disabled={busy} onClick={commit} style={{ display: 'block', height: 30, marginTop: 6, padding: '0 12px', border: '1px solid #e4e4e4', borderRadius: 7, background: '#fff', boxShadow: '0 1px 1px #0000000a', cursor: 'pointer', ...text(13, '#171717', 500) }}>{good.length > 1 ? 'Add sources' : 'Add source'}</button>}
            </div>
            {added.length > 0 && (
              <div data-add-added="1" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>
                {added.map((one) => (
                  <div key={one.key} data-add-added-row={one.key} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, padding: '0 10px', ...text(13.5) }}>
                    <span style={{ flex: 'none', display: 'flex', color: '#8f8f8f' }}><I.SourceIcon kind={one.row ? sourceIcon(one.row) : 'website'} size={16} /></span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{one.name}</span>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="hov-wash" data-add-github="1" disabled={busy} onClick={() => { setError(''); setView('github'); setSide(null); }} style={mi}>
              <span className="glyph-fit" style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d' }}><span style={{ display: 'flex', width: 14, height: 14 }}>{KIND.git.glyph}</span></span><span>Add from GitHub</span>
            </button>
            <button type="button" className="hov-wash" data-add-files="1" disabled={busy} onClick={chooseFiles} style={mi}>
              <span style={{ flex: 'none', display: 'flex', color: '#4d4d4d' }}><I.PaperclipIcon size={16} /></span><span>Upload or add files</span>
            </button>
          </>
        )}
      </Floating>
      {side && (
        <LibraryPanel
          anchor={side.anchor}
          projectId={projectId}
          library={library}
          inRail={inRail}
          panelRef={sideRef}
          picking={{ has: (id) => has(id), onPick: async (row) => { await onPick(row); remember(row); } }}
          onOpen={() => {}}
          onLink={() => {}}
          onAddInput={async (input) => { remember(await onAddInput(input), input); }}
          onOpenFull={() => {}}
          onOpenWorkspace={() => {}}
          onClose={() => setSide(null)}
          ignore="[data-add-more]"
        />
      )}
      {peek.peek && <PeekCard peek={peek.peek} more={peek.more} onHold={peek.hold} onClose={peek.close} onOpenWorkspace={() => {}} />}
    </>
  );
}

/* -------------------------------------------------------------- the project */

/**
 * The top-level project's menu, under its name (Switch Projects: Linear's workspace menu): Switch project opens the list
 * beside it, every top-level project with its count and this one ticked, then New project and All projects; Rename;
 * Project page, the project's own page, which opens in the middle; and Keyboard shortcuts.
 * `counts`: project id → summary (model/sidebar.js summarize) for the switcher's list.
 */
export function ProjectMenu({ anchor, project, counts = new Map(), onSwitch, onNewProject, onAllProjects, onRename, onProjectPage, onShortcuts, onClose, ignore }) {
  const [list, setList] = React.useState(null);
  const [sub, setSub] = React.useState(null); // the Switch row's rect while its list is open
  const switchRef = React.useRef(null);
  React.useEffect(() => {
    let live = true;
    api.listProjects().then((projects) => { if (live) setList(projects); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  // The list beside closes a moment after the pointer moves onto another row, and not at all when it reaches the list:
  // the way there crosses Rename on a slant (2026-10-13, found driving it: the list was gone before the pointer got there).
  const shutTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(shutTimer.current), []);
  const keepSub = () => { clearTimeout(shutTimer.current); shutTimer.current = null; };
  const shutSub = () => { keepSub(); shutTimer.current = setTimeout(() => setSub(null), 300); };
  const openSub = () => { keepSub(); if (switchRef.current) { const r = switchRef.current.getBoundingClientRect(); setSub({ left: r.left, right: r.right, top: r.top - 5, bottom: r.bottom }); } };
  const item = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 32, boxSizing: 'border-box', padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13.5) };
  return (
    <>
      <Floating anchor={anchor} side="below" gap={4} width={230} label="Project" onClose={onClose} ignore={ignore} data-sb-panel="project" style={{ padding: 5, gap: 1 }}>
        <button ref={switchRef} type="button" className="hov-wash" data-sb-switch-project="1" aria-expanded={!!sub} onMouseEnter={openSub} onClick={openSub} style={{ ...item, background: sub ? '#f2f2f2' : 'transparent' }}>
          <span style={{ flex: 1 }}>Switch project</span>
          <I.ChevronRight size={13} style={{ color: '#8f8f8f' }} />
        </button>
        <button type="button" className="hov-wash" data-sb-rename-project="1" onMouseEnter={shutSub} onClick={() => { onClose(); onRename(); }} style={item}>
          <span style={{ flex: 1 }}>Rename</span>
        </button>
        <button type="button" className="hov-wash" data-sb-project-page="1" onMouseEnter={shutSub} onClick={() => { onClose(); onProjectPage(); }} style={item}>
          <span style={{ flex: 1 }}>Project page</span>
          <I.ArrowOutIcon size={14} style={{ color: '#8f8f8f' }} />
        </button>
        <div style={{ height: 1, margin: '4px 6px', background: '#efefef' }} />
        <button type="button" className="hov-wash" data-sb-shortcuts="1" onMouseEnter={shutSub} onClick={() => { onClose(); onShortcuts(); }} style={item}>
          <span style={{ flex: 1 }}>Keyboard shortcuts</span>
          <span className="sb-shortcut">⌃1–9 · ⌘J</span>
        </button>
      </Floating>
      {sub && (
        <Floating anchor={sub} side="right" gap={6} width={250} cap={460} label="Switch project" onClose={() => setSub(null)} ignore="[data-sb-switch-project]" data-sb-panel="switch" onMouseEnter={keepSub} style={{ padding: 5, gap: 1 }}>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {list === null && <div style={{ padding: '7px 10px', ...text(13, '#8f8f8f') }}>Loading…</div>}
            {(list || []).map((candidate) => (
              <button key={candidate.id} type="button" className="hov-wash" data-sb-project={candidate.id} onClick={() => { onClose(); if (candidate.id !== project.id) onSwitch(candidate.id); }} style={item}>
                <I.ProjectIcon size={15} style={{ color: '#4d4d4d' }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: candidate.id === project.id ? 500 : 400 }}>{candidate.name}</span>
                <Count summary={counts.get(candidate.id)} />
                <span className="sb-slot-chev">{candidate.id === project.id && <I.CheckIcon size={14} style={{ color: '#171717' }} />}</span>
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

/** Keyboard shortcuts (the project menu's last row): ⌘J, Ctrl+1–9 for this top-level project's level-2 projects, ⌘\. */
export function ShortcutsDialog({ roots, railHidden = false, onNext, onGo, onToggleRail, onClose }) {
  const ids = shortcutProjects(roots);
  const row = { display: 'flex', alignItems: 'center', gap: 20, width: '100%', minHeight: 38, boxSizing: 'border-box', padding: '8px 14px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', ...text(13.5) };
  return (
    <Centered onClose={onClose} label="Keyboard shortcuts" width={480} data-sb-shortcuts-dialog="1">
      <div style={{ padding: '14px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 6px 14px' }}>
          <span style={text(13, '#171717', 600)}>Keyboard shortcuts</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="sb-icon" aria-label="Close" onClick={onClose}><I.CloseIcon size={14} /></button>
        </div>
        {/* 2026-10-14, Hudson: no subtext and no horizontal dividing lines here ("they are useless"); the groups are set
            apart by space alone. */}
        <button type="button" className="hov-wash" onClick={() => { onClose(); onNext(); }} style={row}><span>Next agent needing attention</span><span className="sb-shortcut" style={{ marginLeft: 'auto' }}>⌘J</span></button>
        {ids.length > 0 && (
          <>
            <div style={{ padding: '14px 14px 4px', ...text(12, '#8f8f8f', 500) }}>Projects</div>
            {ids.map((id, i) => {
              const node = roots.find((candidate) => candidate.id === id);
              return <button key={id} type="button" className="hov-wash" data-shortcut-project={id} onClick={() => { onClose(); onGo(id); }} style={row}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node ? node.name : ''}</span><span className="sb-shortcut" style={{ marginLeft: 'auto' }}>Ctrl+{i + 1}</span></button>;
            })}
          </>
        )}
        <div style={{ height: 10 }} />
        <button type="button" className="hov-wash" onClick={() => { onClose(); onToggleRail(); }} style={row}><span>{railHidden ? 'Show' : 'Hide'} sidebar</span><span className="sb-shortcut" style={{ marginLeft: 'auto' }}>⌘\</span></button>
      </div>
    </Centered>
  );
}

/* ----------------------------------------------------------------- Search */

const MAX_EACH = 6;

/**
 * Search (the fixed row under Library): the projects here, this project's sources, and the library, as words are typed;
 * an address or a path can be added. ↑↓ and Enter, or a press: a project goes there, a source opens; a library row's +
 * brings it into this project.
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
    if (spaces.length) out.push({ title: 'Projects', items: spaces });
    const here = searchRows({ query: typed, library: rows, inRail: () => true, bodies }).slice(0, MAX_EACH).map((result) => ({ kind: 'source', key: `here:${result.key}`, result }));
    if (here.length) out.push({ title: 'In this project', items: here });
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
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
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
                  actions={item.kind === 'library' && row && !inRail(row.id) ? <RowAction label="Add to this project" shown={i === at} onClick={() => { onClose(); void onLink(row); }}><I.PlusIcon size={14} /></RowAction> : null}
                />
              );
            })}
          </Group>
        ))}
        {typed && !flat.length && <Empty>Nothing matches “{typed}”.</Empty>}
        {(problem || (answer && answer.error)) && <div style={{ padding: '4px 14px 8px', ...text(12, '#e70022'), overflowWrap: 'anywhere' }}>{problem || answer.error}</div>}
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 14, padding: '8px 16px', ...text(11.5, '#8f8f8f') }}>
        <span>↑↓ to move</span><span>↵ to open</span><span>esc to close</span>
      </div>
    </Centered>
  );
}

function SearchInput({ value, onChange, onKeyDown }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const timer = setTimeout(() => { if (ref.current) ref.current.focus(); }, 0); return () => clearTimeout(timer); }, []);
  return <input ref={ref} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Search projects, sources and the library" aria-label="Search" spellCheck={false} data-sb-search-input="1" style={{ flex: 1, minWidth: 0, height: 52, padding: 0, border: 0, background: 'transparent', ...text(15) }} />;
}

/* ----------------------------------------------------- naming a new thing */

/**
 * A name for something new, in the middle of the window (2026-10-13: "when creating it should always be Create project
 * within {PARENT NAME}"): `title` over a field, Cancel and `action`; Create waits for a name. Enter makes it.
 */
function NameDialog({ title, placeholder, action, onCreate, onClose, ...rest }) {
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const ref = React.useRef(null);
  React.useEffect(() => { const timer = setTimeout(() => { if (ref.current) ref.current.focus(); }, 0); return () => clearTimeout(timer); }, []);
  const given = name.trim();
  const create = async () => {
    if (busy || !given) return;
    setBusy(true); setProblem('');
    try { await onCreate(given); onClose(); } catch (error) { setProblem(errorMessage(error)); setBusy(false); }
  };
  const button = { height: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer', ...text(13, '#171717', 500) };
  return (
    <Centered onClose={() => { if (!busy) onClose(); }} label={title} width={440} top="14vh" {...rest}>
      <div style={{ padding: '18px 18px 16px' }}>
        <div style={text(15, '#171717', 500)}>{title}</div>
        <input ref={ref} value={name} onChange={(event) => { setName(event.target.value.replace(/[/\\]/g, '-')); setProblem(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} placeholder={placeholder} aria-label={placeholder} spellCheck={false} data-name-field="1" style={{ display: 'block', width: '100%', boxSizing: 'border-box', height: 36, marginTop: 14, padding: '0 10px', border: `1px solid ${given ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 6, background: '#fff', outline: 'none', ...text(14) }} />
        {problem && <div style={{ marginTop: 6, ...text(12, '#e70022') }}>{problem}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="hov-bd2" onClick={onClose} disabled={busy} style={{ ...button, border: '1px solid #e4e4e4', background: '#fff', boxShadow: '0 1px 1px #0000000a' }}>Cancel</button>
          <button type="button" className="hov-dim" onClick={create} disabled={busy || !given} data-name-create="1" style={{ ...button, border: '1px solid #171717', background: '#171717', color: '#fff', opacity: busy || !given ? 0.35 : 1, cursor: busy || !given ? 'default' : 'pointer' }}>{busy ? 'Creating…' : action}</button>
        </div>
      </div>
    </Centered>
  );
}

/** A project's name, made inside `parent` (the top-level project, or one in it). */
export function CreateProjectDialog({ parent, onCreate, onClose }) {
  return <NameDialog title={`Create project within ${parent.name}`} placeholder="Name" action="Create" onCreate={onCreate} onClose={onClose} data-sb-create-project-dialog="1" />;
}

/** A new folder of Sources: the person's, in every project. */
export function FolderDialog({ onCreate, onClose }) {
  return <NameDialog title="Create folder" placeholder="Folder name" action="Create folder" onCreate={onCreate} onClose={onClose} data-sb-folder-dialog="1" />;
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
          <button key={item.label} type="button" role="menuitem" className={item.disabled ? undefined : 'hov-wash'} disabled={!!item.disabled} title={item.title} onClick={() => { if (item.disabled) return; onClose(); item.onClick(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: item.disabled ? 'default' : 'pointer', opacity: item.disabled ? 0.4 : 1, textAlign: 'left', ...text(13, item.danger ? '#e70022' : '#171717') }}>
            {item.icon && <span style={{ width: 15, display: 'flex', justifyContent: 'center', color: item.danger ? '#e70022' : '#4d4d4d' }}>{item.icon}</span>}
            {item.label}
          </button>
        )))}
    </div>,
    document.body,
  );
}
