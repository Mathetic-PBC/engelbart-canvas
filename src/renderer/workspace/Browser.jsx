import React from 'react';
import { api, errorMessage } from '../api.js';
import { KIND } from '../ui/Icons.jsx';

// The Browser pane (design 2026-09-17): tabs, ← → ↻, an address that takes a url, a file
// path, a sandbox, or a local port, a device-preset menu, expand. Web and local addresses
// render in an iframe; files are read through the main process; sandboxes are not connected.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const EASE = 'cubic-bezier(.25,.1,.25,1)';
const DEVICES = [
  { id: 'fit', name: 'Fit panel', w: 0, h: 0 },
  { id: 'se', name: 'iPhone SE', w: 375, h: 667 },
  { id: '12', name: 'iPhone 12 Pro', w: 390, h: 844 },
  { id: '15', name: 'iPhone 15 Pro Max', w: 430, h: 932 },
  { id: 'px8', name: 'Pixel 8', w: 412, h: 915 },
  { id: 'ipad', name: 'iPad mini', w: 768, h: 1024 },
];
const KIND_LABEL = { blank: 'new', web: 'web', file: 'file', sandbox: 'sandbox', local: 'local' };
const newId = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now() + Math.random()));

export function kindOf(u) {
  if (!u || u === 'about:blank') return { kind: 'blank' };
  if (/^sandbox:/i.test(u)) return { kind: 'sandbox', name: u.replace(/^sandbox:\/*/i, '') || 'sandbox' };
  if (/^(\.{0,2}\/|~\/|\/)/.test(u) || /^[\w.-]+\.(md|txt|py|js|ts|json|csv|html|css|pdf)$/i.test(u)) return { kind: 'file', path: u };
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(u)) return { kind: 'local', url: /^https?:/.test(u) ? u : `http://${u}` };
  return { kind: 'web', url: /^https?:/.test(u) ? u : `https://${u}` };
}

const stripScheme = (u) => (u === 'about:blank' ? '' : u.replace(/^https?:\/\//, ''));
const glyphFor = (k) => (k.kind === 'file' ? KIND.note.glyph : k.kind === 'sandbox' ? '▲' : '◎');

const ICON_BUTTON = { width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '14px/1 var(--font-sans)' };

export default function Browser({ projectId, visible, onExpand }) {
  const [tabs, setTabs] = React.useState(() => [{ id: newId(), url: 'about:blank', hist: ['about:blank'], hi: 0 }]);
  const [activeId, setActiveId] = React.useState(() => null);
  const [draft, setDraft] = React.useState('');
  const [menu, setMenu] = React.useState(null); // { x, y }
  const [device, setDevice] = React.useState('fit');
  const [customW, setCustomW] = React.useState('390');
  const [reloadKey, setReloadKey] = React.useState(0);
  const [file, setFile] = React.useState(null); // { path, text } | { error }
  const addressRef = React.useRef(null);
  const menuRef = React.useRef(null);

  const tab = tabs.find((t) => t.id === activeId) || tabs[0];
  const k = kindOf(tab.url);

  React.useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setMenu(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  React.useEffect(() => {
    if (k.kind !== 'file') { setFile(null); return undefined; }
    let cancelled = false;
    setFile({ path: k.path, text: 'loading…' });
    api.readTextFile(projectId, k.path).then((result) => {
      if (!cancelled) setFile({ path: result.path, text: result.text + (result.truncated ? '\n\n… (truncated at 20 000 characters)' : '') });
    }).catch((error) => {
      if (!cancelled) setFile({ path: k.path, text: `Could not open ${k.path} — ${errorMessage(error)}` });
    });
    return () => { cancelled = true; };
  }, [k.kind, k.path, projectId, reloadKey]);

  const update = (id, fn) => setTabs((current) => current.map((t) => (t.id === id ? fn(t) : t)));

  const navigate = (url) => {
    update(tab.id, (t) => { const hist = [...t.hist.slice(0, t.hi + 1), url]; return { ...t, url, hist, hi: hist.length - 1 }; });
    setDraft(stripScheme(url));
    setMenu(null);
  };
  const step = (d) => {
    update(tab.id, (t) => { const hi = clamp(t.hi + d, 0, t.hist.length - 1); return { ...t, hi, url: t.hist[hi] }; });
    const next = tab.hist[clamp(tab.hi + d, 0, tab.hist.length - 1)];
    setDraft(stripScheme(next));
  };
  const newTab = () => {
    const id = newId();
    setTabs((current) => [...current, { id, url: 'about:blank', hist: ['about:blank'], hi: 0 }]);
    setActiveId(id);
    setDraft('');
    requestAnimationFrame(() => { if (addressRef.current) addressRef.current.focus(); });
  };
  const closeTab = (id) => {
    setTabs((current) => {
      const rest = current.filter((t) => t.id !== id);
      if (!rest.length) {
        const fresh = { id: newId(), url: 'about:blank', hist: ['about:blank'], hi: 0 };
        setActiveId(fresh.id); setDraft('');
        return [fresh];
      }
      if (id === (activeId || current[0].id)) { const next = rest[rest.length - 1]; setActiveId(next.id); setDraft(stripScheme(next.url)); }
      return rest;
    });
  };
  const select = (t) => { setActiveId(t.id); setDraft(stripScheme(t.url)); setMenu(null); };
  const go = (event) => { event.preventDefault(); const v = draft.trim(); if (v) navigate(v); };

  const dev = DEVICES.find((d) => d.id === device);
  const width = device === 'custom' ? (Number(customW) || 390) : (dev ? dev.w : 0);
  const frameStyle = width ? { flex: 'none', width, height: '100%', border: 0, background: '#fff', margin: '0 auto' } : { flex: 1, width: '100%', border: 0, background: '#fff' };
  const src = k.url ? `${k.url}${reloadKey ? `${k.url.includes('?') ? '&' : '?'}r=${reloadKey}` : ''}` : '';
  const menuW = Math.min(240, (window.innerWidth || 1200) - 16);

  return (
    <div style={{ flex: 1, minHeight: 0, display: visible ? 'flex' : 'none', flexDirection: 'column', background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '6px 8px 0', background: '#fafafa', borderBottom: '1px solid #eaeaea', flex: 'none', overflow: 'hidden' }}>
        {tabs.map((t) => {
          const on = t.id === tab.id;
          const kk = kindOf(t.url);
          return (
            <div key={t.id} onClick={() => select(t)} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto', maxWidth: 200, padding: '7px 10px 8px', border: `1px solid ${on ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', marginBottom: -1, background: on ? '#fff' : 'transparent', cursor: 'pointer', font: `${on ? 500 : 400} 12px/1.3 var(--font-sans)`, color: '#171717', whiteSpace: 'nowrap' }}>
              <span style={{ flex: 'none', display: 'flex', color: '#8f8f8f', fontSize: 12, lineHeight: 1 }}>{glyphFor(kk)}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.url === 'about:blank' ? 'New tab' : stripScheme(t.url)}</span>
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); closeTab(t.id); }} aria-label="Close tab" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '12px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            </div>
          );
        })}
        <button type="button" className="hov-ink-wash" onClick={newTab} aria-label="New tab" style={{ flex: 'none', alignSelf: 'center', width: 26, height: 26, marginLeft: 4, padding: 0, border: 0, borderRadius: 6, background: 'transparent', font: '16px/1 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer' }}>+</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #eaeaea', flex: 'none' }}>
        <button type="button" className="hov-wash" onClick={() => step(-1)} aria-label="Back" style={{ ...ICON_BUTTON, color: tab.hi > 0 ? '#171717' : '#c9c9c9' }}>←</button>
        <button type="button" className="hov-wash" onClick={() => step(1)} aria-label="Forward" style={{ ...ICON_BUTTON, color: tab.hi < tab.hist.length - 1 ? '#171717' : '#c9c9c9' }}>→</button>
        <button type="button" className="hov-wash" onClick={() => setReloadKey((v) => v + 1)} aria-label="Reload" style={{ ...ICON_BUTTON, color: '#4d4d4d' }}>↻</button>
        <form onSubmit={go} className="focus-bd2" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px', borderRadius: 8, background: '#fafafa', border: '1px solid transparent', transition: 'border-color 120ms' }}>
          <span style={{ flex: 'none', padding: '2px 6px', borderRadius: 4, background: '#f2f2f2', font: '500 9px/1.4 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{KIND_LABEL[k.kind]}</span>
          <input ref={addressRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') event.target.blur(); }} placeholder="url · file path · sandbox · localhost:port" spellCheck={false} aria-label="Address" style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '12.5px/1.4 var(--font-mono)', color: '#171717', textAlign: 'center' }} />
        </form>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button type="button" className="hov-wash" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right, y: r.bottom }); }} aria-label="More" style={{ ...ICON_BUTTON, background: menu ? '#f2f2f2' : 'transparent', font: '600 16px/1 var(--font-sans)', color: '#4d4d4d' }}>⋮</button>
          {menu && (
            <div style={{ position: 'fixed', left: clamp(menu.x - menuW, 8, (window.innerWidth || 1200) - menuW - 8), top: menu.y + 6, zIndex: 60, width: menuW, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
              <div style={{ padding: '6px 10px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>Device preset</div>
              {DEVICES.map((d) => (
                <div key={d.id} className="hov-wash" onClick={() => { setDevice(d.id); setMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: 'pointer' }}>
                  <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '12px/1 var(--font-sans)', color: '#171717' }}>{device === d.id ? '✓' : ''}</span>
                  <span style={{ flex: 1, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{d.name}</span>
                  <span style={{ font: '11px/1 var(--font-mono)', color: '#8f8f8f' }}>{d.w ? `${d.w}×${d.h}` : ''}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderTop: '1px solid #eaeaea', marginTop: 4 }}>
                <span style={{ flex: 1, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Custom width</span>
                <input value={customW} onChange={(event) => { setCustomW(event.target.value.replace(/\D/g, '')); setDevice('custom'); }} inputMode="numeric" aria-label="Custom width" style={{ width: 64, padding: '4px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fafafa', font: '12px/1.4 var(--font-mono)', color: '#171717', textAlign: 'right' }} />
              </div>
            </div>
          )}
        </div>
        <button type="button" className="hov-wash" onClick={onExpand} aria-label="Expand" title="Expand" style={{ ...ICON_BUTTON, font: '13px/1 var(--font-sans)', color: '#4d4d4d' }}>⤢</button>
      </div>

      {k.kind === 'blank' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'radial-gradient(ellipse at 50% 30%, #f2f2f2, #fafafa 70%)', font: '12.5px/1.6 var(--font-mono)', color: '#4d4d4d', textAlign: 'center' }}>Enter a URL, a file path, a sandbox, or a local port.</div>
      )}
      {(k.kind === 'web' || k.kind === 'local') && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: '#f2f2f2', overflow: 'auto' }}>
          <iframe key={`${tab.id}:${reloadKey}`} title="Page" src={src} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" style={frameStyle} />
        </div>
      )}
      {k.kind === 'file' && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', font: '12.5px/1.7 var(--font-mono)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file ? file.text : ''}</div>
      )}
      {k.kind === 'sandbox' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, background: '#fafafa', textAlign: 'center' }}>
          <span style={{ font: '500 14px/1.4 var(--font-sans)', color: '#171717' }}>{k.name}</span>
          <span style={{ font: '12.5px/1.6 var(--font-sans)', color: '#8f8f8f', maxWidth: 360, textWrap: 'pretty' }}>Cloud sandbox · not connected in this prototype. The running container's forwarded port would render here.</span>
        </div>
      )}
    </div>
  );
}
