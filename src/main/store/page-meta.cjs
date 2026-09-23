'use strict';

// The only network the library does: a page added by its address is asked once for its own title
// and description; a GitHub repository, added by address or as a clone, is asked once who it is
// (its id, which is what the library knows it by, its current name and its description); and a
// repository that has no clone is asked for its top-level files when its row is hovered. Best
// effort: a timeout, a size cap, http(s) only, no cookies; any failure means "nothing to say"
// and the row keeps what it has. GitHub's API is asked signed in when the person has connected
// GitHub (`auth`, src/main/github/connection.cjs), so a private repository answers too; a token
// GitHub refuses is dropped for that request and the question asked again signed out.

const TIMEOUT_MS = 4000;
const MAX_HTML_CHARS = 300000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = (text) => String(text || '')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&(\w+);/g, (whole, name) => ENTITIES[name] ?? whole)
  .replace(/\s+/g, ' ')
  .trim();

function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!new RegExp(`\\b(?:name|property)\\s*=\\s*["']${key}["']`, 'i').test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (content) return decode(content[1] ?? content[2]);
  }
  return '';
}

/** `<title>` and the description a page gives of itself, from its html. */
function readHtmlMeta(html) {
  const text = String(html || '').slice(0, MAX_HTML_CHARS);
  const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return { title: decode(title ? title[1] : '') || metaContent(text, 'og:title'), description: metaContent(text, 'description') || metaContent(text, 'og:description') };
}

async function get(url, { fetch, headers }) {
  if (!/^https?:\/\//i.test(url)) throw new TypeError('Only http(s) addresses are read');
  const response = await fetch(url, { redirect: 'follow', credentials: 'omit', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The address answered ${response.status}`);
  return response;
}

/**
 * Who a GitHub repository is. `id` never changes; a renamed or transferred repository answers under
 * its old name too (GitHub redirects), with the name and address it has now. Signed out: a private
 * repository answers 404 like one that does not exist, and the caller falls back to the address.
 */
/** A GET of GitHub's API, signed in when `auth` gives headers; a refused token is tried once more without them. */
async function githubGet(url, { fetch, auth }) {
  const plain = { accept: 'application/vnd.github+json' };
  const signed = auth ? await auth().catch(() => ({})) : {};
  if (signed && signed.authorization) {
    try { return await get(url, { fetch, headers: { ...plain, ...signed } }); } catch (error) { if (!/ 40[13]$/.test(error.message)) throw error; }
  }
  return get(url, { fetch, headers: plain });
}

function createRepoIdentifier({ fetch = globalThis.fetch, auth = null } = {}) {
  return async function identifyRepo(owner, name) {
    const repo = await (await githubGet(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { fetch, auth })).json();
    if (!repo || !Number.isSafeInteger(repo.id) || repo.id <= 0) throw new Error('GitHub did not give the repository an id');
    const fullName = typeof repo.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.full_name) ? repo.full_name : `${owner}/${name}`;
    return { id: String(repo.id), fullName, url: `https://github.com/${fullName}`, description: typeof repo.description === 'string' ? repo.description : '' };
  };
}

/** What `library.addItem` asks of a page before it writes the row. */
function createDescriber({ fetch = globalThis.fetch } = {}) {
  return async function describe(found) {
    const response = await get(found.url, { fetch, headers: { accept: 'text/html' } });
    if (!/html/i.test(response.headers.get('content-type') || '')) return null;
    return readHtmlMeta(await response.text());
  };
}

/** Top-level files of a GitHub repository, folders first; remembered for as long as the app runs. */
function createRemoteFileLister({ fetch = globalThis.fetch, auth = null, limit = 40 } = {}) {
  const known = new Map();
  return async function listRemoteFiles(owner, repo) {
    const key = `${owner}/${repo}`.toLowerCase();
    if (known.has(key)) return known.get(key);
    const entries = await (await githubGet(`https://api.github.com/repos/${owner}/${repo}/contents`, { fetch, auth })).json();
    const files = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.name === 'string')
      .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((entry) => entry.name + (entry.type === 'dir' ? '/' : ''));
    known.set(key, files);
    return files;
  };
}

module.exports = { readHtmlMeta, createDescriber, createRepoIdentifier, createRemoteFileLister };
