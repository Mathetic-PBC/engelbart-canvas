import React from 'react';
import InlineField from '../ui/InlineField.jsx';
import { api, errorMessage } from '../api.js';
import { KIND, kindOf, SEARCH } from '../ui/Icons.jsx';
import DocPreview from '../ui/DocPreview.jsx';
import { hasTag, isNote, kindKey, kindRank, KIND_ORDER } from '../model/kind.js';
import { AddToLibrary } from '../workspace/Rail.jsx';

// All projects (Claude Design "Projects.dc.html", 2026-09-21): the library as a rail on the left
// — one list sorted by kind, a search field, Add context — and the projects beside it as cards that
// size to their content: name, the kinds of library items the project holds, and its most
// recently edited workspaces as page tiles. A card opens the project; a tile opens that workspace.
// Hovering a library row or a tile for a beat opens a peek you can move onto and scroll. Add context is the workspace
// sidebar's (Rail.jsx AddToLibrary, 2026-09-28): a link or a path, files from disk, a repository from GitHub.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const MAX_ICONS = 5;
const OPEN_DELAY = 350;
const SWITCH_DELAY = 90;
const CLOSE_DELAY = 180;
const PEEK_GAP = 8;

const basename = (value) => String(value || '').split('/').pop();
const stripScheme = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

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

/** The kinds a project holds, once each, in the rail's order; then how many items they stand for. */
function HeldIcons({ rows }) {
  if (!rows.length) return null;
  const kinds = KIND_ORDER.filter((key) => rows.some((row) => kindKey(row) === key)).slice(0, MAX_ICONS);
  const rest = rows.length - kinds.length;
  return (
    <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 7, color: '#171717' }}>
      {kinds.map((type) => <span key={type} className="glyph14" title={KIND[type].label}>{KIND[type].glyph}</span>)}
      <span style={{ marginLeft: 1, font: '12px/1 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>{rest > 0 ? `+ ${rest} more` : `${rows.length} from the library`}</span>
    </span>
  );
}

/** What hovering a library row adds to the row: by kind, then the projects and workspaces that hold it. The workspace sidebar shows the same card. */
export function ItemPeek({ row, more, onOpenWorkspace }) {
  const kind = kindOf(row);
  const source = row.url ? stripScheme(row.url) : row.path ? basename(row.path) : '';
  // Where it is on disk: a repository's clone (whether or not it also has an address), any other folder.
  const local = more && more.folder ? more.folder : (!row.url && !row.path ? row.folder_path : null);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>
        <span className="glyph14" style={{ color: '#4d4d4d' }}>{kind.glyph}</span>{kind.label}
      </div>
      <div style={{ marginTop: 9, font: '500 14.5px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{row.name}</div>
      {!isNote(row) && source && <div style={{ marginTop: 4, font: '11.5px/1.5 var(--font-mono)', color: '#8f8f8f', overflowWrap: 'anywhere' }}>{more && more.owner && hasTag(row, 'git') ? `${more.owner} · ${source}` : source}</div>}
      {local && !(more && more.folderMissing) && <div data-peek-local="1" style={{ marginTop: source ? 1 : 4, font: '11.5px/1.5 var(--font-mono)', color: '#8f8f8f', overflowWrap: 'anywhere' }}>{local}</div>}
      {more && more.folderMissing && <div data-peek-missing="1" style={{ marginTop: source ? 1 : 4, font: '11.5px/1.5 var(--font-mono)', color: '#c9c9c9', textDecoration: 'line-through', overflowWrap: 'anywhere' }}>{more.folderMissing}</div>}
      {!isNote(row) && row.summary && <div style={{ marginTop: 8, font: '12.5px/1.7 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{row.summary}</div>}
      {row.type === 'md' && more && more.text != null && <div style={{ marginTop: 10 }}><DocPreview text={more.text} size={12.5} /></div>}
      {more && more.files && more.files.length > 0 && (
        <div style={{ marginTop: 10, font: '12px/1.75 var(--font-mono)', color: '#4d4d4d' }}>{more.files.map((name) => <div key={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>)}</div>
      )}
      {more && more.lines && more.lines.length > 0 && (
        <pre style={{ margin: '10px 0 0', padding: '8px 10px', overflowX: 'auto', background: '#fafafa', border: '1px solid #eaeaea', borderRadius: 6, font: '11.5px/1.6 var(--font-mono)', color: '#4d4d4d' }}>{more.lines.join('\n')}</pre>
      )}
      {more && more.heldBy && more.heldBy.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 12, paddingTop: 10, borderTop: '1px solid #eaeaea', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>
          {more.heldBy.map((project) => (
            <div key={project.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8 }}>
              <span className="hov-ink" onClick={() => onOpenWorkspace(project.id, null)} style={{ fontWeight: 500, color: '#4d4d4d', cursor: 'pointer' }}>{project.name}</span>
              {project.workspaces.map((workspace) => <span key={workspace.id} className="hov-ink" onClick={() => onOpenWorkspace(project.id, workspace.id)} style={{ cursor: 'pointer' }}>{workspace.path}</span>)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Home({ projects, library, onCreateScreen, onOpenWorkspace, onOpenNote, onOpenOnStage, onRename, onLibraryChanged, error }) {
  const [renaming, setRenaming] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [addError, setAddError] = React.useState(''); // what a drop could not add
  const [addBusy, setAddBusy] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  const [justAdded, setJustAdded] = React.useState(null);
  const [peek, setPeek] = React.useState(null); // { key, kind: 'item' | 'workspace', rect, row | workspace + project }
  const [previews, setPreviews] = React.useState({}); // `${id}:${last_edited}` → what previewLibraryItem returned
  const [tiles, setTiles] = React.useState(2);
  const timer = React.useRef(null);
  const column = React.useRef(null);
  const list = React.useRef(null);

  const rows = React.useMemo(() => {
    return library.filter((row) => row.type !== 'image').sort((a, b) => kindRank(a) - kindRank(b) || String(b.last_edited || '').localeCompare(String(a.last_edited || '')));
  }, [library]);
  const shown = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => `${row.name} ${row.url || ''} ${kindOf(row).label}`.toLowerCase().includes(needle)) : rows;
  }, [rows, query]);
  const byId = React.useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  // Two workspace tiles a card, three and four as the projects column gets room for them.
  React.useEffect(() => {
    if (!column.current) return undefined;
    const observer = new ResizeObserver(([entry]) => { const width = entry.contentRect.width; setTiles(width >= 1500 ? 4 : width >= 1000 ? 3 : 2); });
    observer.observe(column.current);
    return () => observer.disconnect();
  }, []);

  /* ------------------------------------------------------------------ peek */
  // Opens after a beat, stays while the pointer is on the row, the gap or the peek, and closes a
  // moment after it has left all three.
  const hold = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const openPeek = (next, element) => {
    hold();
    if (peek && peek.key === next.key) return;
    timer.current = setTimeout(() => { if (element.isConnected) setPeek({ ...next, rect: element.getBoundingClientRect() }); }, peek ? SWITCH_DELAY : OPEN_DELAY);
  };
  const closePeek = () => { hold(); timer.current = setTimeout(() => setPeek(null), CLOSE_DELAY); };
  React.useEffect(() => hold, []);

  const previewKey = (row) => `${row.id}:${row.last_edited || ''}`;
  React.useEffect(() => {
    if (!peek || peek.kind !== 'item' || previews[previewKey(peek.row)]) return;
    const key = previewKey(peek.row);
    api.previewLibraryItem(peek.row.id).then((more) => setPreviews((current) => ({ ...current, [key]: more }))).catch(() => setPreviews((current) => ({ ...current, [key]: {} })));
  }, [peek, previews]);

  /* ---------------------------------------------------------------- adding */
  // Each input its own row; the last one added flashes. What could not be added is returned, said by whoever asked.
  async function addEach(inputs) {
    let last = null;
    const problems = [];
    for (const input of inputs) {
      try { last = await api.addLibraryItem(input); } catch (candidate) { problems.push(errorMessage(candidate)); }
    }
    if (last) {
      setQuery('');
      setJustAdded(last.id);
      await onLibraryChanged();
    }
    return problems;
  }

  // Add context's menu: a link or a path (thrown back when refused), files from disk, a repository or a search result —
  // what the library holds already opens, anything else is added.
  const addOne = async (input) => { const problems = await addEach([input]); if (problems.length) throw new Error(problems.join(' · ')); };
  const pickFromDisk = async () => addEach((await api.pickLibraryPaths()) || []);
  const pickRepo = async ({ repo, row }) => { if (row) await openRow(row); else await addOne(repo.url); };
  const searchPick = async (result, typed) => {
    if (result.kind === 'item') await openRow(result.row);
    else if (result.kind === 'fresh') await addOne(typed);
  };
  const inLibraryOnly = React.useCallback(() => false, []);

  async function dropAll(paths) {
    if (addBusy) return;
    setAddBusy(true);
    setAddError('');
    const problems = await addEach(paths);
    setAddBusy(false);
    setAddError(problems.join(' · '));
  }

  React.useEffect(() => {
    if (!justAdded || !list.current) return undefined;
    const element = list.current.querySelector(`[data-library-row="${justAdded}"]`);
    if (element) element.scrollIntoView({ block: 'nearest' });
    const done = setTimeout(() => setJustAdded(null), 1600);
    return () => clearTimeout(done);
  }, [justAdded, rows]);

  const carriesFiles = (event) => [...(event.dataTransfer ? event.dataTransfer.types : [])].includes('Files');
  const onDrop = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
    if (paths.length) void dropAll(paths);
  };

  async function openRow(row) {
    setPeek(null);
    if (isNote(row) && row.project_id) { onOpenNote(row); return; }
    // Anything else opens on a workspace's Stage (2026-09-23), never in the default browser: a workspace that holds it,
    // else the project it is in, else the one last open.
    try {
      const held = await api.projectsForLibraryItem(row.id);
      const project = held.find((candidate) => candidate.workspaces.length) || held[0];
      if (project) onOpenWorkspace(project.id, project.workspaces[0] ? project.workspaces[0].id : null, row);
      else onOpenOnStage(row);
    } catch { onOpenOnStage(row); }
  }

  /* ---------------------------------------------------------------- render */
  const peekWidth = peek && peek.kind === 'workspace' ? 420 : 380;
  const peekLeft = peek && (peek.rect.right + PEEK_GAP + peekWidth <= window.innerWidth - 8 ? peek.rect.right : Math.max(8, peek.rect.left - peekWidth - PEEK_GAP));
  const peekOnRight = peek && peekLeft === peek.rect.right;
  const peekTop = peek && Math.max(54, Math.min(peek.rect.top - 12, window.innerHeight - 380));

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="title-bar title-lead" style={{ flex: 'none', display: 'flex', alignItems: 'center', height: 54, padding: '0 18px', borderBottom: '1px solid #eaeaea' }}>
        <span style={{ font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          data-library-rail="1"
          onDragOver={(event) => { if (carriesFiles(event)) { event.preventDefault(); setDropping(true); } }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropping(false); }}
          onDrop={onDrop}
          style={{ flex: 'none', width: 340, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#fafafa', borderRight: '1px solid #eaeaea', boxShadow: dropping ? 'inset 0 0 0 2px #c9c9c9' : 'none', transition: 'box-shadow 120ms' }}
        >
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '19px 19px 0 18px' }}>
            <span style={{ font: '500 14px/1.3 var(--font-sans)', color: '#171717' }}>Library</span>
          </div>
          <div data-library-add="1" style={{ flex: 'none', padding: '10px 8px 0' }}>
            <AddToLibrary onAdd={addOne} onPickDisk={pickFromDisk} onPickRepo={pickRepo} onSearchPick={searchPick} library={library} inRail={inLibraryOnly} />
            {addError && <div style={{ padding: '4px 10px 0', font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{addError}</div>}
          </div>
          <div style={{ flex: 'none', padding: '12px 12px 0' }}>
            <label className="ring home-search" style={{ display: 'flex', alignItems: 'center', gap: 9, height: 36, padding: '0 12px', background: '#fff', borderRadius: 8, color: '#171717', cursor: 'text' }}>
              <SEARCH />
              <input value={query} spellCheck={false} placeholder="Search" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', font: '14px/1.4 var(--font-sans)', color: '#171717' }} />
            </label>
          </div>
          <div ref={list} onScroll={() => { hold(); setPeek(null); }} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '15px 0 18px' }}>
            {shown.map((row) => (
              <div
                key={row.id}
                data-library-row={row.id}
                className="hov-wash"
                onClick={() => openRow(row)}
                onMouseEnter={(event) => openPeek({ key: row.id, kind: 'item', row }, event.currentTarget)}
                onMouseLeave={closePeek}
                style={{ display: 'flex', alignItems: 'center', gap: 10, height: 31.5, padding: '0 18px 0 20px', cursor: 'pointer', background: peek && peek.key === row.id ? '#f2f2f2' : 'transparent', animation: justAdded === row.id ? 'added 1600ms ease-out' : undefined, transition: 'background 120ms' }}
              >
                <span className="glyph16" style={{ color: '#171717' }}>{kindOf(row).glyph}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '14px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div ref={column} style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '19px 20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ font: '500 14px/1.3 var(--font-sans)', color: '#171717' }}>Projects</span>
            {projects.length > 0 && <span style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{projects.length}</span>}
          </div>
          {error && <div style={{ marginTop: 8, font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 14, marginTop: 14 }}>
            {projects.map((project) => {
              const held = (project.libraryIds || []).map((id) => byId.get(id)).filter(Boolean);
              const recent = (project.recent || []).slice(0, tiles);
              const rest = project.workspaceCount - recent.length;
              return (
                <div key={project.id} data-project-card={project.id} className="ring" onClick={() => onOpenWorkspace(project.id, null)} style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 18, minWidth: 336, maxWidth: '100%', padding: 18, border: '1px solid #eaeaea', borderRadius: 10, background: '#fff', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {renaming === project.id
                        ? <InlineField initial={project.name} width={220} placeholder="project name…" onCommit={(name) => { setRenaming(null); if (name !== project.name) onRename(project.id, name); }} onCancel={() => setRenaming(null)} style={{ padding: '4px 8px' }} />
                        : <span title="Click to rename" onClick={(event) => { event.stopPropagation(); setRenaming(project.id); }} style={{ alignSelf: 'flex-start', maxWidth: '100%', font: '500 16px/1.4 var(--font-sans)', letterSpacing: '-0.1px', color: '#171717', cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>}
                      <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>
                        {project.workspaceCount} workspace{project.workspaceCount === 1 ? '' : 's'}{project.lastEdited ? ` · edited ${relative(project.lastEdited)}` : ''}
                      </span>
                    </div>
                    <HeldIcons rows={held} />
                  </div>
                  {recent.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
                      {recent.map((workspace) => (
                        <div
                          key={workspace.id}
                          data-workspace-tile={workspace.id}
                          className="hov-bd2"
                          onClick={(event) => { event.stopPropagation(); setPeek(null); onOpenWorkspace(project.id, workspace.id); }}
                          onMouseEnter={(event) => openPeek({ key: workspace.id, kind: 'workspace', workspace, project }, event.currentTarget)}
                          onMouseLeave={closePeek}
                          style={{ position: 'relative', flex: 'none', width: 168, height: 200, padding: '14px 14px 0', overflow: 'hidden', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', transition: 'border-color 120ms' }}
                        >
                          <div style={{ marginBottom: 5, font: '600 12.5px/1.3 var(--font-sans)', color: '#171717', overflowWrap: 'anywhere' }}>{workspace.name}</div>
                          <DocPreview text={workspace.text} maxLines={24} />
                          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44, background: 'linear-gradient(to bottom, rgba(255,255,255,0), #fff 85%)', pointerEvents: 'none' }} />
                        </div>
                      ))}
                      {rest > 0 && <span style={{ flex: 'none', paddingBottom: 12, marginLeft: 'auto', font: '12px/1 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>+ {rest} more</span>}
                    </div>
                  )}
                </div>
              );
            })}
            <div
              role="button"
              tabIndex={0}
              className="ring hov-ink"
              onClick={onCreateScreen}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCreateScreen(); } }}
              data-new-project="1"
              style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 320, minHeight: 96, border: '1px dashed #c9c9c9', borderRadius: 10, background: 'transparent', cursor: 'pointer', font: '500 14px/1.5 var(--font-sans)', color: '#8f8f8f' }}
            >
              + Project
            </div>
          </div>
        </div>
      </div>

      {peek && (
        // The wrapper reaches back over the gap to the row, so crossing the gap still counts as hovering.
        <div
          data-peek={peek.kind}
          data-overlay="1"
          data-hover="1"
          onMouseEnter={hold}
          onMouseLeave={closePeek}
          style={{ position: 'fixed', zIndex: 60, left: peekLeft, top: peekTop, [peekOnRight ? 'paddingLeft' : 'paddingRight']: PEEK_GAP }}
        >
          <div style={{ width: peekWidth, maxHeight: Math.min(peek.kind === 'workspace' ? 520 : 440, window.innerHeight - peekTop - 12), overflowY: 'auto', padding: '14px 16px 16px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: `rise 160ms ${EASE}` }}>
            {peek.kind === 'item'
              ? <ItemPeek row={peek.row} more={previews[previewKey(peek.row)]} onOpenWorkspace={(projectId, workspaceId) => { setPeek(null); onOpenWorkspace(projectId, workspaceId); }} />
              : (
                <>
                  <div style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{peek.project.name}{peek.workspace.path !== peek.workspace.name ? ` / ${peek.workspace.path.split('/').slice(0, -1).join(' / ')}` : ''}</div>
                  <div style={{ margin: '4px 0 8px', font: '600 15px/1.35 var(--font-sans)', color: '#171717' }}>{peek.workspace.name}</div>
                  <DocPreview text={peek.workspace.text} size={13} />
                </>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
