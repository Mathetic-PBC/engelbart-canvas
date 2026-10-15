import React from 'react';

// Choose files under Obsidian (2026-10-14: "clicking choose files on obsidian should open a picker like the obsidian
// sidebar … there is no way for me to find the obsidian files easily"): the vaults Obsidian knows, drawn like its file
// explorer (folders first with a chevron, notes without .md, faint indent guides, a grey row on hover and when chosen),
// with a box on each row to choose it. A folder chosen brings in everything under it. `api.obsidianTree()` reads the vaults
// (src/main/onboarding/obsidian-tree.cjs); `chosen` the paths already chosen; `onChoose([{ path, name, file }])`.

const Svg = ({ d }) => <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />;
const CHEV = <Svg d={'<path d="m9 6 6 6-6 6"/>'} />;
const CHECK = <Svg d={'<path d="m5 12 4 4 10-10"/>'} />;
const SEARCH = <Svg d={'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'} />;

/** Every node of `tree` whose name matches `query`, with the folders above it (a flat list for the search). */
function matches(tree, query, trail = []) {
  const out = [];
  for (const node of tree) {
    if (node.name.toLowerCase().includes(query)) out.push({ node, trail });
    if (node.dir && node.children) out.push(...matches(node.children, query, [...trail, node.name]));
  }
  return out;
}

export default function ObsidianPicker({ api, chosen = [], onChoose, onCancel }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(() => new Set());
  const [picked, setPicked] = React.useState(() => new Map(chosen.map((path) => [path, { path, name: path.split('/').pop(), file: /\.[a-z0-9]+$/i.test(path) }])));
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    let live = true;
    api.obsidianTree().then((out) => {
      if (!live) return;
      setData(out);
      // The vaults open, their folders closed, as Obsidian opens.
      setOpen(new Set((out.vaults || []).map((vault) => vault.path)));
    }).catch((failure) => { if (live) setError(String((failure && failure.message) || failure).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOpen = (path) => setOpen((now) => { const next = new Set(now); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  // A path is chosen when it or a folder above it is.
  const covered = (path) => [...picked.keys()].some((one) => path === one || path.startsWith(`${one}/`));
  const togglePick = (node) => setPicked((now) => {
    const next = new Map(now);
    if (next.has(node.path)) next.delete(node.path);
    else {
      // A folder chosen holds what was chosen inside it.
      for (const one of [...next.keys()]) if (one.startsWith(`${node.path}/`)) next.delete(one);
      next.set(node.path, { path: node.path, name: node.dir ? node.name : node.path.split('/').pop(), file: !node.dir });
    }
    return next;
  });

  const row = (node, depth, trail = null) => {
    const isOpen = node.dir && open.has(node.path);
    const on = picked.has(node.path);
    const inside = !on && covered(node.path);
    return (
      <React.Fragment key={node.path}>
        <div className={`ob-row ${on || inside ? 'is-on' : ''}`} style={{ paddingLeft: 8 + depth * 17 }} data-obsidian-path={node.path}
          onClick={() => (node.dir && !trail ? toggleOpen(node.path) : togglePick(node))}>
          {depth > 0 && !trail && Array.from({ length: depth }, (_, i) => <span key={i} className="ob-guide" style={{ left: 15 + i * 17 }} />)}
          <span className={`ob-chev ${node.dir ? '' : 'none'} ${isOpen ? 'open' : ''}`}>{node.dir ? CHEV : null}</span>
          <span className={`ob-name ${node.dir ? 'dir' : ''}`}>{node.name}{trail && trail.length ? <small>{trail.join(' / ')}</small> : null}</span>
          <button type="button" className={`ob-box ${on || inside ? 'on' : ''}`} role="checkbox" aria-checked={on || inside} aria-label={`Choose ${node.name}`} disabled={inside}
            onClick={(event) => { event.stopPropagation(); togglePick(node); }}>{on || inside ? CHECK : null}</button>
        </div>
        {isOpen && !trail && node.children && node.children.map((child) => row(child, depth + 1))}
      </React.Fragment>
    );
  };

  const q = query.trim().toLowerCase();
  const vaults = (data && data.vaults) || [];
  return (
    <div className="ob" data-obsidian-picker="1">
      <div className="modal-head"><h3>Choose from Obsidian</h3><button type="button" className="close" aria-label="Close" onClick={onCancel}>×</button></div>
      <label className="ob-search">{SEARCH}<input className="field" placeholder="Search files" aria-label="Search files" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></label>
      <div className="ob-tree" role="tree">
        {!data && !error && <div className="ob-empty">Reading your vaults…</div>}
        {error && <div className="ob-empty">{error}</div>}
        {data && !vaults.length && <div className="ob-empty">Obsidian has no vaults on this Mac.</div>}
        {vaults.map((vault) => (
          <div key={vault.path} className="ob-vault">
            {vaults.length > 1 || !q ? row({ name: vault.name, path: vault.path, dir: true, children: vault.tree }, 0) : null}
            {q && (vaults.length > 1 ? open.has(vault.path) : true) && matches(vault.tree, q).slice(0, 200).map(({ node, trail }) => row(node, 1, trail))}
          </div>
        ))}
      </div>
      <div className="mf">
        <span className="muted ob-count">{picked.size ? `${picked.size} chosen` : ''}</span>
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn small" data-obsidian-add="1" disabled={!picked.size} onClick={() => onChoose([...picked.values()])}>Add</button>
      </div>
    </div>
  );
}
