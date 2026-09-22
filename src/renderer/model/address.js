// What the Browser pane's address means: nothing, a sandbox, a file, a page on disk, a local server,
// the web, or words to search for. Local servers speak http unless the address says otherwise; the
// web gets https; anything that names no host is a Google search.
// Whether a typed path is an html file to render is the main process's to say (resolve-page-file):
// a path here is a `file` until it answers, and a `disk` page once it has a file: address.

const FILE = /^(\.{0,2}\/|~\/|\/)|^[\w.-]+\.(md|txt|py|js|ts|json|csv|html|css|pdf)$/i;
const SCHEME = /^https?:\/\//i;
const DISK = /^file:\/\//i;
const SEARCH = 'https://www.google.com/search?q=';

/** The window event by which the rest of the app (a link in the terminal) asks for a page in a new tab: detail { url }. */
export const OPEN_IN_BROWSER = 'engelbart:open-in-browser';

/** A name the web could resolve: dotted with a lettered last label, or an IP address. */
function isWebHost(host) {
  if (/^\[[0-9a-f:.]+\]$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /^([a-z0-9-]+\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,}$/i.test(host);
}

/** This machine, the local network, or a bare name with a port (`devbox:8080`). */
export function isLocalHost(host, hasPort) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '[::1]' || h === '0.0.0.0') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h) || /^10(\.\d{1,3}){3}$/.test(h) || /^192\.168(\.\d{1,3}){2}$/.test(h) || /^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  return !!hasPort && /^[a-z0-9-]+$/.test(h);
}

export function kindOf(input) {
  const u = String(input || '').trim();
  if (!u || u === 'about:blank') return { kind: 'blank' };
  if (/^sandbox:/i.test(u)) return { kind: 'sandbox', name: u.replace(/^sandbox:\/*/i, '') || 'sandbox' };
  if (DISK.test(u)) return { kind: 'disk', url: u };
  if (FILE.test(u)) return { kind: 'file', path: u };
  const port = /^:?(\d{2,5})(\/.*)?$/.exec(u); // `3000`, `:5173/docs`
  if (port) return { kind: 'local', url: `http://localhost:${port[1]}${port[2] || ''}` };
  const scheme = SCHEME.test(u) ? u.match(SCHEME)[0].toLowerCase() : '';
  const authority = u.slice(scheme.length).split(/[/?#]/)[0].replace(/^[^@]*@/, '');
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  const hasPort = /:\d+$/.test(authority);
  if (isLocalHost(host, hasPort)) {
    const rest = u.slice(scheme.length).replace(/^0\.0\.0\.0(?=[:/?#]|$)/, 'localhost'); // what dev servers print, not an address
    return { kind: 'local', url: `${scheme || 'http://'}${rest}` };
  }
  if (scheme) return { kind: 'web', url: u };
  if (/\s/.test(u) || !isWebHost(host)) return { kind: 'web', url: SEARCH + encodeURIComponent(u) };
  return { kind: 'web', url: `https://${u}` };
}

/** The address as shown: without its scheme when typing it back would lead to the same place. */
export function stripScheme(u) {
  if (!u || u === 'about:blank') return '';
  if (DISK.test(u)) {
    try { return decodeURIComponent(u.replace(DISK, '').replace(/^[^/]*/, '')); } catch { return u; }
  }
  const bare = u.replace(SCHEME, '').replace(/^([^/?#]+)\/$/, '$1');
  const back = kindOf(bare).url;
  return back && (back === u || `${back}/` === u) ? bare : u;
}
