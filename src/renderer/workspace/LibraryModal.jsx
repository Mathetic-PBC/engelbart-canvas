import React from 'react';
import { api, errorMessage } from '../api.js';
import { KindGlyph as Glyph } from '../ui/Icons.jsx';
import { LIBRARY_CHIPS, kindLabel, libraryCounts } from '../model/kind.js';
import { addedLine, batches, libraryDate, libraryViewRows, whereLine } from '../model/library-view.js';
import { Centered, text } from './SidebarPanels.jsx';
import { useBodies } from './useBodies.js';

// The Library window (2026-10-11, the Library's Phase C, first cut; the mockups in the Library 2 workspace), opened by the
// sidebar Library's "Open full library": the popover stays the quick search. Two views: what this project holds
// (library.libraryForProject: made in it, on its own list, or in a workspace) and Everything in the library. Everything
// adds to the project (add-to-project, in batches of 200, the open workspace too); In this project removes from it
// (remove-from-project, after saying which workspaces still mention it). A row's name opens it, as the sidebar does.
// Still to come with Phase B's columns: the source's logo and "From", a chat's messages and a meeting's minutes, chips by
// source, the preview panel, and Move to trash for a note written here.

const SHOWN_AT_ONCE = 300; // rows drawn before "Show more"
const GRID = '28px minmax(0, 1fr) 150px 200px 96px 92px';

function Tick({ on, some = false, disabled = false, onChange, label }) {
  return (
    <button type="button" role="checkbox" aria-checked={some ? 'mixed' : on ? 'true' : 'false'} aria-label={label} disabled={disabled} onClick={onChange}
      style={{ width: 16, height: 16, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${on || some ? '#171717' : '#c9c9c9'}`, borderRadius: 4, background: disabled ? '#f2f2f2' : on || some ? '#171717' : '#fff', color: '#fff', cursor: disabled ? 'default' : 'pointer' }}>
      {(on || some) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={disabled ? '#8f8f8f' : 'currentColor'} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{some && !on ? <path d="M6 12h12" /> : <path d="M20 6 9 17l-5-5" />}</svg>}
    </button>
  );
}

function Tag({ children }) {
  return <span style={{ flex: 'none', padding: '1px 7px', borderRadius: 999, background: '#f2f2f2', whiteSpace: 'nowrap', ...text(11.5, '#4d4d4d') }}>{children}</span>;
}

export default function LibraryModal({ project, workspaceId = null, library = [], onOpenRow, onChanged = () => {}, onClose }) {
  const [scope, setScope] = React.useState('project');
  const [q, setQ] = React.useState('');
  const [picked, setPicked] = React.useState('all');
  const [held, setHeld] = React.useState(null); // libraryForProject's rows, null while they come
  const [ticks, setTicks] = React.useState(() => new Set());
  const [shown, setShown] = React.useState(SHOWN_AT_ONCE);
  const [busy, setBusy] = React.useState(false);
  const [said, setSaid] = React.useState('');
  const [problem, setProblem] = React.useState('');
  const [confirm, setConfirm] = React.useState(null); // { row, mentions }
  const inputRef = React.useRef(null);

  const loadHeld = React.useCallback(() => api.libraryForProject(project.id).then((rows) => setHeld(rows || [])).catch((error) => { setHeld([]); setProblem(errorMessage(error)); }), [project.id]);
  React.useEffect(() => { void loadHeld(); }, [loadHeld]);
  React.useEffect(() => { const timer = setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0); return () => clearTimeout(timer); }, []);
  const bodies = useBodies(project.id, true);

  const heldIds = React.useMemo(() => new Set((held || []).map((row) => row.id)), [held]);
  const everything = React.useMemo(() => library.map((row) => (heldIds.has(row.id) ? { ...row, held: true } : row)), [library, heldIds]);
  const counts = React.useMemo(() => ({ project: libraryCounts(held || []).all, all: libraryCounts(library).all }), [held, library]);
  const base = scope === 'project' ? held || [] : everything;
  const chipCounts = React.useMemo(() => libraryCounts(base), [base]);
  const chip = chipCounts[picked] > 0 ? picked : 'all';
  const rows = React.useMemo(() => libraryViewRows({ rows: base, chip, query: q, bodies }), [base, chip, q, bodies]);
  React.useEffect(() => { setShown(SHOWN_AT_ONCE); }, [scope, chip, q]);

  const tickable = scope === 'all' ? rows.filter((row) => !row.held) : [];
  const ticked = tickable.filter((row) => ticks.has(row.id));
  const allTicked = tickable.length > 0 && ticked.length === tickable.length;
  const toggle = (id) => setTicks((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const tickAll = () => setTicks((now) => { const next = new Set(now); for (const row of tickable) { if (allTicked) next.delete(row.id); else next.add(row.id); } return next; });

  const switchTo = (next) => { setScope(next); setPicked('all'); setSaid(''); setProblem(''); };

  // Add: every ticked row of the library, in batches of 200 (main refuses more at once), into the project and the open
  // workspace; one line for all of it, and which batch did not go in.
  const add = async () => {
    const ids = [...ticks].filter((id) => !heldIds.has(id));
    if (!ids.length || busy) return;
    setBusy(true); setSaid(''); setProblem('');
    const results = [];
    for (const batch of batches(ids)) {
      try { results.push(await api.addToProject(project.id, batch, workspaceId ? { workspaceId } : {})); } catch (error) { results.push({ error: errorMessage(error), ids: batch }); }
    }
    setTicks(new Set());
    await loadHeld();
    onChanged();
    setSaid(addedLine(results, project.name));
    setBusy(false);
  };

  const askRemove = async (row) => {
    setProblem('');
    let mentions = [];
    try { mentions = await api.projectItemMentions(project.id, row.id); } catch { mentions = []; }
    setConfirm({ row, mentions });
  };
  const remove = async () => {
    const { row } = confirm;
    setConfirm(null);
    setBusy(true); setSaid(''); setProblem('');
    try {
      await api.removeFromProject(project.id, [row.id]);
      await loadHeld();
      onChanged();
      setSaid(`Removed ${row.name} from ${project.name}. It is still in your library.`);
    } catch (error) { setProblem(errorMessage(error)); }
    setBusy(false);
  };
  const open = (row) => { onClose(); onOpenRow(row); };

  const segment = (id, label, count) => (
    <button type="button" data-library-scope={id} aria-pressed={scope === id} onClick={() => switchTo(id)}
      style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', border: 0, borderRadius: 7, background: scope === id ? '#fff' : 'transparent', boxShadow: scope === id ? '0 1px 2px rgba(0,0,0,.08)' : 'none', cursor: 'pointer', ...text(13, scope === id ? '#171717' : '#4d4d4d', 500) }}>
      {label}<span style={text(12, '#8f8f8f')}>{count == null ? '…' : count}</span>
    </button>
  );
  const head = (label) => <span style={{ ...text(11.5, '#8f8f8f', 500), whiteSpace: 'nowrap' }}>{label}</span>;
  const chips = LIBRARY_CHIPS.filter((one) => one.id === 'all' || chipCounts[one.id] > 0);

  return (
    <Centered onClose={onClose} label="Library" width={1080} top="5vh" maxHeight="90vh" data-library-modal={scope}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px 10px' }}>
        <span style={{ ...text(16, '#171717', 600) }}>Library</span>
        <div role="tablist" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, background: '#f2f2f2' }}>
          {segment('project', 'In this project', held ? counts.project : null)}
          {segment('all', 'Everything', counts.all)}
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="hov-wash" aria-label="Close" onClick={onClose} style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: 'none', cursor: 'pointer', ...text(18, '#8f8f8f') }}>×</button>
      </div>
      <div style={{ flex: 'none', padding: '0 16px 8px' }}>
        <input ref={inputRef} value={q} onChange={(event) => setQ(event.target.value)} placeholder={scope === 'project' ? `Search ${project.name}` : 'Search your whole library'} aria-label="Search the library" spellCheck={false} data-library-search="1"
          style={{ width: '100%', boxSizing: 'border-box', height: 36, padding: '0 12px', border: '1px solid #eaeaea', borderRadius: 8, outline: 'none', ...text(14) }} />
      </div>
      <div role="toolbar" aria-label="Show only" style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 10px' }}>
        {chips.map((one) => (
          <button key={one.id} type="button" data-library-chip={one.id} aria-pressed={one.id === chip} onClick={() => setPicked(one.id === chip ? 'all' : one.id)} className={one.id === chip ? '' : 'hov-wash'}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', border: `1px solid ${one.id === chip ? '#171717' : '#eaeaea'}`, borderRadius: 999, background: one.id === chip ? '#171717' : '#fff', cursor: 'pointer', ...text(12.5, one.id === chip ? '#fff' : '#4d4d4d', 500) }}>
            {one.label}<span style={text(12, one.id === chip ? '#c9c9c9' : '#8f8f8f')}>{chipCounts[one.id]}</span>
          </button>
        ))}
      </div>
      <div style={{ flex: 'none', display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12, padding: '6px 16px', borderTop: '1px solid #f0f0f0', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
        <span>{scope === 'all' && <Tick on={allTicked} some={!allTicked && ticked.length > 0} disabled={!tickable.length} onChange={tickAll} label="Select all shown" />}</span>
        {head(`Name · ${rows.length}`)}{head('Kind')}{head(scope === 'project' ? 'Where' : 'From')}{head('Edited')}<span />
      </div>
      <div data-library-rows="1" style={{ flex: '1 1 auto', minHeight: 120, overflowY: 'auto' }}>
        {scope === 'project' && held == null && <div style={{ padding: 20, ...text(13, '#8f8f8f') }}>Loading…</div>}
        {(scope === 'all' || held != null) && !rows.length && (
          <div style={{ padding: 20, ...text(13, '#8f8f8f') }}>{q.trim() ? `Nothing matches “${q.trim()}”.` : scope === 'project' ? 'Nothing in this project yet. Add things from Everything.' : 'Your library is empty.'}</div>
        )}
        {rows.slice(0, shown).map((row) => {
          const on = ticks.has(row.id);
          return (
            <div key={row.id} data-library-row={row.id} className="hov-wash" style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12, padding: '7px 16px', borderBottom: '1px solid #f5f5f5', background: on ? '#f5f9ff' : undefined }}>
              <span>{scope === 'all' && <Tick on={on || !!row.held} disabled={!!row.held} onChange={() => toggle(row.id)} label={row.held ? `${row.name} is in this project` : `Select ${row.name}`} />}</span>
              <button type="button" onClick={() => open(row)} title={`Open ${row.name}`} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ flex: 'none', display: 'flex' }}><Glyph item={row} box={16} color="#4d4d4d" /></span>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(13.5, '#171717', 500) }}>{row.name}</span>
                    {scope === 'all' && row.held && <Tag>In this project</Tag>}
                  </span>
                  {row.summary && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12, '#8f8f8f') }}>{row.summary}</span>}
                </span>
              </button>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12.5, '#4d4d4d') }}>{kindLabel(row)}</span>
              <span title={whereLine(row, scope)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12.5, '#4d4d4d') }}>{whereLine(row, scope)}</span>
              <span style={{ whiteSpace: 'nowrap', ...text(12.5, '#8f8f8f') }}>{libraryDate(row)}</span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {scope === 'project' && !row.origin && <button type="button" className="hov-ink" data-library-remove={row.id} disabled={busy} onClick={() => askRemove(row)} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', ...text(12.5, '#8f8f8f', 500) }}>Remove</button>}
                {scope === 'project' && row.origin && <span title="Written in this project: it goes to the trash from its workspace, not out of the project" style={text(12, '#c9c9c9')}>Made here</span>}
              </span>
            </div>
          );
        })}
        {rows.length > shown && (
          <button type="button" className="hov-wash" onClick={() => setShown((n) => n + SHOWN_AT_ONCE)} style={{ width: '100%', padding: '10px 16px', border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', ...text(13, '#4d4d4d', 500) }}>Show {Math.min(SHOWN_AT_ONCE, rows.length - shown)} more of {rows.length - shown}</button>
        )}
      </div>
      {(said || problem) && <div data-library-said="1" style={{ flex: 'none', padding: '8px 16px', borderTop: '1px solid #f0f0f0', ...text(12.5, problem ? '#e70022' : '#4d4d4d') }}>{problem || said}</div>}
      {scope === 'all' && ticked.length > 0 && (
        <div data-library-add-bar="1" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderTop: '1px solid #eaeaea', background: '#fff' }}>
          <span style={text(13, '#171717', 500)}>{ticked.length} selected</span>
          <button type="button" className="hov-ink" onClick={() => setTicks(new Set())} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', ...text(13, '#8f8f8f', 500) }}>Clear</button>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...text(12.5, '#8f8f8f') }}>Bart and every agent in this project can read them once added</span>
          <button type="button" data-library-add="1" disabled={busy} onClick={add} style={{ flex: 'none', height: 34, padding: '0 16px', border: 0, borderRadius: 8, background: '#171717', color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, ...text(13, '#fff', 500) }}>
            {busy ? 'Adding…' : `Add ${ticked.length} to ${project.name}`}
          </button>
        </div>
      )}
      {confirm && (
        <Centered onClose={() => setConfirm(null)} label={`Remove ${confirm.row.name}`} width={420} top="24vh" data-library-confirm="1">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '18px 20px 16px' }}>
            <span style={text(15, '#171717', 600)}>Remove “{confirm.row.name}” from {project.name}?</span>
            <span style={text(13, '#4d4d4d')}>It is taken out of every workspace in this project. It stays in your library, and Everything still lists it.</span>
            {confirm.mentions.length > 0 && (
              <span data-library-mentions={confirm.mentions.length} style={text(13, '#a35200')}>
                Still mentioned in {confirm.mentions.length} workspace{confirm.mentions.length === 1 ? '' : 's'}: {confirm.mentions.map((one) => one.path || one.name).join(', ')}. Those mentions stay and still open it.
              </span>
            )}
            <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, paddingTop: 6 }}>
              <button type="button" className="hov-ink" onClick={() => setConfirm(null)} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', ...text(13, '#8f8f8f', 500) }}>Cancel</button>
              <button type="button" data-library-confirm-remove="1" onClick={remove} style={{ height: 32, padding: '0 14px', border: 0, borderRadius: 8, background: '#171717', cursor: 'pointer', ...text(13, '#fff', 500) }}>Remove</button>
            </span>
          </div>
        </Centered>
      )}
    </Centered>
  );
}
