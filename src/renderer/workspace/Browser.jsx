import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { KIND } from '../ui/Icons.jsx';
import { kindOf, stripScheme, OPEN_IN_BROWSER } from '../model/address.js';

// The Browser pane (design 2026-09-17; native pages 2026-09-20): tabs, ← → ↻, an address that
// takes a url, a file path, a sandbox, or a local port, a device-preset menu, expand. A web or
// local page is a WebContentsView in the main process (src/main/browser/views.cjs), laid over
// the placeholder below, so no site can refuse it as a frame; history, title and address are the
// page's own. A native view covers everything in this document, so while a menu or a modal
// overlaps the placeholder the view is hidden behind a picture of itself. An html file, by its
// full path or a path inside the engelbart folder, is a page too (the main process says whether
// the path names one); other files are read through the main process as text; sandboxes are not
// connected.

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
const ERR_CONNECTION_REFUSED = -102;
const RETRY_MS = 2000;
const newId = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now() + Math.random()));
const blankTab = () => ({ id: newId(), url: 'about:blank', web: null });
const isPage = (k) => k.kind === 'web' || k.kind === 'local' || k.kind === 'disk';
const hasScheme = (input) => /^https?:\/\//i.test(input);
const quiet = (promise) => promise.catch(() => {});

const glyphFor = (k) => (k.kind === 'file' || k.kind === 'disk' ? KIND.note.glyph : k.kind === 'sandbox' ? '▲' : '◎');

const ICON_BUTTON = { width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '14px/1 var(--font-sans)' };

// HTTP authentication (a staging site, a proxy). In the document, not in the pane: a popup can ask too.
function LoginPrompt({ request, onAnswer }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const field = { padding: '8px 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', font: '13px/1.4 var(--font-sans)', color: '#171717' };
  return (
    <div data-overlay="1" role="dialog" aria-modal="true" aria-label={`Sign in to ${request.host}`} onKeyDown={(event) => { if (event.key === 'Escape') onAnswer(null); }} style={{ position: 'fixed', inset: 0, zIndex: 130, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh', background: 'rgba(255,255,255,.35)' }}>
      <form onSubmit={(event) => { event.preventDefault(); onAnswer({ username, password }); }} style={{ width: 'min(360px, calc(100vw - 32px))', display: 'flex', flexDirection: 'column', gap: 10, padding: 18, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}` }}>
        <span style={{ font: '500 14px/1.4 var(--font-sans)', color: '#171717', overflowWrap: 'anywhere' }}>{request.host}</span>
        {request.realm && <span style={{ marginTop: -6, font: '12px/1.5 var(--font-mono)', color: '#8f8f8f', overflowWrap: 'anywhere' }}>{request.realm}</span>}
        <input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} aria-label="Username" autoComplete="off" spellCheck={false} style={field} />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} aria-label="Password" autoComplete="off" style={field} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 14, marginTop: 4 }}>
          <button type="button" className="hov-ink" onClick={() => onAnswer(null)} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#8f8f8f' }}>Cancel</button>
          <button type="submit" style={{ padding: '9px 14px', border: 0, borderRadius: 8, background: '#0070f3', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' }}>Sign in</button>
        </div>
      </form>
    </div>
  );
}

export default function Browser({ projectId, visible, onExpand, initialUrl }) {
  const [tabs, setTabs] = React.useState(() => [blankTab()]); // { id, url, web: the page's state from main | null }
  const [activeId, setActiveId] = React.useState(() => null);
  const [draft, setDraft] = React.useState('');
  const [menu, setMenu] = React.useState(null); // { x, y }
  const [device, setDevice] = React.useState('fit');
  const [customW, setCustomW] = React.useState('390');
  const [reloadKey, setReloadKey] = React.useState(0);
  const [file, setFile] = React.useState(null); // { path, text } | { error }
  const [occluded, setOccluded] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState(null);
  const [logins, setLogins] = React.useState([]); // HTTP authentication a page (or a popup) is waiting on
  const addressRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const slotRef = React.useRef(null); // where the page goes

  const tab = tabs.find((t) => t.id === activeId) || tabs[0];
  const k = kindOf(tab.url);
  const page = isPage(k) || !!tab.opened;
  const web = tab.web;
  const failed = page && web && web.error ? web.error : null;
  const showing = visible && page && !failed && !occluded;

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

  const dropTab = React.useCallback((id) => {
    setTabs((current) => {
      if (!current.some((t) => t.id === id)) return current;
      const rest = current.filter((t) => t.id !== id);
      if (!rest.length) {
        const fresh = blankTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      const gone = current.find((t) => t.id === id); // back to the tab that opened it, as a sign-in expects
      const next = rest.find((t) => t.id === gone.from) || rest[rest.length - 1];
      setActiveId((active) => (id === (active || current[0].id) ? next.id : active));
      return rest;
    });
  }, []);

  // A tab the person asked for is loaded here; one a page opened arrives with its view already made (id).
  const openTab = React.useCallback((url, id, from) => {
    const next = { ...blankTab(), url: url || 'about:blank', from: from || null, ...(id ? { id, opened: true } : {}) };
    if (!id) quiet(api.browserOpen(next.id, url));
    setTabs((current) => [...current, next]);
    setActiveId(next.id);
  }, []);

  React.useEffect(() => { if (initialUrl) openTab(initialUrl); }, [initialUrl, openTab]);

  // The page reports where it is; a tab showing a file or a sandbox keeps its own address.
  React.useEffect(() => {
    const offState = api.onBrowserState((state) => setTabs((current) => current.map((t) => (
      t.id === state.id ? { ...t, web: state, url: (t.opened || isPage(kindOf(t.url))) && state.url ? state.url : t.url } : t
    ))));
    const offOpen = api.onBrowserOpenTab(({ url, id, from }) => openTab(url, id, from));
    const offClosed = api.onBrowserClosed(({ id }) => dropTab(id));
    const offLogin = api.onBrowserLogin((request) => setLogins((current) => [...current, request]));
    const offFocus = api.onBrowserFocusAddress(() => { if (addressRef.current) { addressRef.current.focus(); addressRef.current.select(); } });
    const onAsk = (event) => { if (event.detail && event.detail.url) openTab(event.detail.url); }; // a link clicked in the terminal
    window.addEventListener(OPEN_IN_BROWSER, onAsk);
    return () => { offState(); offOpen(); offClosed(); offLogin(); offFocus(); window.removeEventListener(OPEN_IN_BROWSER, onAsk); quiet(api.browserCloseAll()); };
  }, [openTab, dropTab]);

  // The address follows the page unless it is being typed in.
  React.useEffect(() => {
    if (document.activeElement !== addressRef.current) setDraft(stripScheme(tab.url));
  }, [tab.id, tab.url]);

  // Anything marked data-overlay that reaches over the page would sit under the native view.
  React.useEffect(() => {
    if (!visible || !page) { setOccluded(false); return undefined; }
    let timer = 0; // a timer, not a frame: frames stop while the window is covered
    const check = () => {
      timer = 0;
      const slot = slotRef.current;
      if (!slot) return;
      const r = slot.getBoundingClientRect();
      let hit = false;
      for (const overlay of document.querySelectorAll('[data-overlay]')) {
        if (overlay.contains(slot)) continue; // the browser may itself be inside a preview dialog
        const b = overlay.getBoundingClientRect();
        if (b.width && b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) { hit = true; break; }
      }
      setOccluded(hit);
    };
    const schedule = () => { if (!timer) timer = setTimeout(check, 16); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-overlay'] });
    check();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [visible, page, tab.id]);

  // The view follows the placeholder; one page shows at a time, and none when there is no place for it.
  React.useLayoutEffect(() => {
    let cancelled = false;
    if (!showing) {
      quiet(api.browserHide({ snapshot: visible && page && !failed && occluded }).then((picture) => { if (!cancelled) setSnapshot(picture || null); }));
      return () => { cancelled = true; };
    }
    const slot = slotRef.current;
    const place = () => {
      const r = slot.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { quiet(api.browserHide()); return; }
      quiet(api.browserShow(tab.id, { x: r.left, y: r.top, width: r.width, height: r.height }).then(() => { if (!cancelled) setSnapshot(null); }));
    };
    const observer = new ResizeObserver(place);
    observer.observe(slot);
    if (slot.parentElement) observer.observe(slot.parentElement);
    window.addEventListener('resize', place);
    place();
    return () => { cancelled = true; observer.disconnect(); window.removeEventListener('resize', place); };
  }, [showing, visible, page, !!failed, occluded, tab.id, device, customW]);

  // A local server that is not up yet: keep knocking while its tab is in front.
  React.useEffect(() => {
    if (!visible || k.kind !== 'local' || !failed || failed.code !== ERR_CONNECTION_REFUSED) return undefined;
    const timer = setTimeout(() => quiet(api.browserCommand(tab.id, 'reload')), RETRY_MS);
    return () => clearTimeout(timer);
  }, [visible, k.kind, failed, tab.id]);

  const update = (id, fn) => setTabs((current) => current.map((t) => (t.id === id ? fn(t) : t)));

  // A page main refuses (a file outside the home directory) fails like one that did not load.
  const load = (id, url) => api.browserOpen(id, url).catch((error) => update(id, (t) => ({ ...t, web: { ...(t.web || {}), id, url, error: { code: 0, description: errorMessage(error), url } } })));

  const navigate = async (input) => {
    let next = kindOf(input);
    if (next.kind !== 'local' && next.kind !== 'sandbox' && next.kind !== 'blank' && !hasScheme(input)) {
      const found = await api.resolvePageFile(projectId, input).catch(() => null); // `a/report.html`: a file if it exists, else a site
      if (found) next = { kind: 'disk', url: found.url };
    }
    if (isPage(next)) load(tab.id, next.url);
    update(tab.id, (t) => ({ ...t, opened: false, url: next.url || input, web: isPage(next) && t.web ? { ...t.web, error: null } : t.web }));
    setDraft(stripScheme(next.url || input));
    setMenu(null);
    if (addressRef.current) addressRef.current.blur();
  };
  // Back and forward are the page's own history; from a file or a sandbox, back is the page underneath.
  const canBack = page ? !!(web && web.canGoBack) : !!(web && web.url);
  const canForward = page && !!(web && web.canGoForward);
  const back = () => {
    if (!canBack) return;
    if (page) quiet(api.browserCommand(tab.id, 'back'));
    else update(tab.id, (t) => ({ ...t, url: t.web.url }));
  };
  const forward = () => { if (canForward) quiet(api.browserCommand(tab.id, 'forward')); };
  const loading = page && !!(web && web.loading) && !failed;
  const reload = () => {
    if (page) quiet(api.browserCommand(tab.id, loading ? 'stop' : 'reload'));
    else setReloadKey((v) => v + 1);
  };
  const newTab = () => {
    const fresh = blankTab();
    setTabs((current) => [...current, fresh]);
    setActiveId(fresh.id);
    setDraft('');
    requestAnimationFrame(() => { if (addressRef.current) addressRef.current.focus(); });
  };
  const closeTab = (id) => { quiet(api.browserClose(id)); dropTab(id); };
  const select = (t) => { setActiveId(t.id); setDraft(stripScheme(t.url)); setMenu(null); };
  const go = (event) => { event.preventDefault(); const v = draft.trim(); if (v) navigate(v); };

  const dev = DEVICES.find((d) => d.id === device);
  const width = device === 'custom' ? (Number(customW) || 390) : (dev ? dev.w : 0);
  const slotStyle = width ? { flex: 'none', width, height: '100%', background: '#fff', margin: '0 auto' } : { flex: 1, width: '100%', background: '#fff' };
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
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.url === 'about:blank' ? 'New tab' : (isPage(kk) && t.web && t.web.title) || stripScheme(t.url)}</span>
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); closeTab(t.id); }} aria-label="Close tab" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '12px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            </div>
          );
        })}
        <button type="button" className="hov-ink-wash" onClick={newTab} aria-label="New tab" style={{ flex: 'none', alignSelf: 'center', width: 26, height: 26, marginLeft: 4, padding: 0, border: 0, borderRadius: 6, background: 'transparent', font: '16px/1 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer' }}>+</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #eaeaea', flex: 'none' }}>
        <button type="button" className="hov-wash" onClick={back} aria-label="Back" style={{ ...ICON_BUTTON, color: canBack ? '#171717' : '#c9c9c9' }}>←</button>
        <button type="button" className="hov-wash" onClick={forward} aria-label="Forward" style={{ ...ICON_BUTTON, color: canForward ? '#171717' : '#c9c9c9' }}>→</button>
        <button type="button" className="hov-wash" onClick={reload} aria-label={loading ? 'Stop' : 'Reload'} style={{ ...ICON_BUTTON, color: '#4d4d4d' }}>{loading ? '×' : '↻'}</button>
        <form onSubmit={go} className="focus-bd2" style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px', borderRadius: 8, background: '#fafafa', border: '1px solid transparent', transition: 'border-color 120ms' }}>
          <input ref={addressRef} value={draft} onChange={(event) => setDraft(event.target.value)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === 'Escape') { setDraft(stripScheme(tab.url)); event.target.blur(); } }} spellCheck={false} aria-label="Address" style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '12.5px/1.4 var(--font-mono)', color: '#171717', textAlign: 'left' }} />
        </form>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button type="button" className="hov-wash" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right, y: r.bottom }); }} aria-label="More" style={{ ...ICON_BUTTON, background: menu ? '#f2f2f2' : 'transparent', font: '600 16px/1 var(--font-sans)', color: '#4d4d4d' }}>⋮</button>
          {menu && (
            <div data-overlay="1" style={{ position: 'fixed', left: clamp(menu.x - menuW, 8, (window.innerWidth || 1200) - menuW - 8), top: menu.y + 6, zIndex: 60, width: menuW, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
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
              {page && web && (
                <div style={{ borderTop: '1px solid #eaeaea', marginTop: 4, paddingTop: 4 }}>
                  <div className="hov-wash" onClick={() => { quiet(api.openExternal(web.url || tab.url)); setMenu(null); }} style={{ padding: '7px 10px 7px 34px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Open in default browser</div>
                  <div className="hov-wash" onClick={() => { quiet(api.browserCommand(tab.id, 'devtools')); setMenu(null); }} style={{ padding: '7px 10px 7px 34px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Developer tools</div>
                </div>
              )}
            </div>
          )}
        </div>
        <button type="button" className="hov-ink" onClick={onExpand} aria-label="Expand" title="Expand" style={{ ...ICON_BUTTON, font: '700 20px/1 var(--font-sans)', color: '#4d4d4d', transition: 'color 120ms' }}>⤢</button>
      </div>

      {k.kind === 'blank' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'radial-gradient(ellipse at 50% 30%, #f2f2f2, #fafafa 70%)' }} />
      )}
      {page && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center', background: '#f2f2f2', overflow: 'hidden' }}>
          <div ref={slotRef} data-browser-slot="1" style={{ ...slotStyle, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
            {failed ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, background: '#fafafa', textAlign: 'center' }}>
                <span style={{ font: '500 14px/1.4 var(--font-sans)', color: '#171717', overflowWrap: 'anywhere' }}>{stripScheme(failed.url || tab.url)}</span>
                <span style={{ font: '12px/1.6 var(--font-mono)', color: '#8f8f8f' }}>{failed.description || `error ${failed.code}`}</span>
              </div>
            ) : snapshot && !showing ? (
              <img src={snapshot} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top', userSelect: 'none' }} />
            ) : null}
          </div>
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
      {logins[0] && createPortal(
        <LoginPrompt
          key={logins[0].requestId}
          request={logins[0]}
          onAnswer={(credentials) => { quiet(api.browserLoginReply(logins[0].requestId, credentials)); setLogins((current) => current.slice(1)); }}
        />,
        document.body,
      )}
    </div>
  );
}
