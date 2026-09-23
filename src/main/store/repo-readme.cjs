'use strict';

const { githubRepo } = require('../sandbox/runs.cjs');
const MAX_README_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_MS = 5 * 60_000;

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned an empty README response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('This README is too large to display. Open it on GitHub instead.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('GitHub returned an unreadable README response.'); }
}

function sourceUrl(value, host) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === host && !url.port && !url.username && !url.password) {
      url.search = ''; url.hash = '';
      return url.href;
    }
  } catch { /* reject non-GitHub source addresses */ }
  throw new Error('GitHub returned an invalid README source address.');
}

// Public GitHub README only. No sandbox/model calls, local file reads, or credentials.
// The bounded session cache avoids repeated GitHub requests when switching tabs.
function createRepoReadmeReader({ fetch = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function retrieve(repo) {
    const signal = AbortSignal.timeout(15_000);
    let url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/readme`;
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      try {
        response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'engelbart-canvas' }, credentials: 'omit', redirect: 'manual', signal });
      } catch { throw new Error('Could not load the README from GitHub. Check your connection and retry.'); }
      if (![301, 302, 307, 308].includes(response.status)) break;
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next || redirects === 3) throw new Error('GitHub redirected the README too many times.');
      url = sourceUrl(new URL(next, url).href, 'api.github.com');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return { status: 'missing', repositoryUrl: repo.url };
      if (response.status === 403 || response.status === 429) throw new Error('GitHub could not serve the README (access or rate limit). Try again later, or open GitHub.');
      throw new Error(`GitHub could not load the README (${response.status}).`);
    }
    const data = await boundedJson(response);
    if (!data || typeof data !== 'object') throw new Error('GitHub returned an unreadable README response.');
    if (data.size > MAX_README_BYTES) throw new Error('This README is too large to display. Open it on GitHub instead.');
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || typeof data.path !== 'string'
        || !data.path || data.path.length > 4096 || data.path.split('/').some((part) => !part || part === '.' || part === '..') || /[\x00-\x1f\\]/.test(data.path)) {
      throw new Error('GitHub returned an unsupported README response. Open it on GitHub instead.');
    }
    const encoded = data.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('GitHub returned an unreadable README.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_README_BYTES) throw new Error('This README is too large to display. Open it on GitHub instead.');
    const htmlUrl = sourceUrl(data.html_url, 'github.com');
    const rawUrl = sourceUrl(data.download_url, 'raw.githubusercontent.com');
    const filePath = data.path.split('/').map(encodeURIComponent).join('/');
    if (![htmlUrl, rawUrl].every((url) => new URL(url).pathname.endsWith(`/${filePath}`))) throw new Error('GitHub returned an invalid README path.');
    return { status: 'ready', repositoryUrl: repo.url, path: data.path, htmlUrl, rawUrl, content: bytes.toString('utf8'),
      format: /(?:\.(?:md|markdown|mdown|mkd)|(?:^|\/)readme)$/i.test(data.path) ? 'markdown' : 'text' };
  }
  return async function readReadme(url, { refresh = false } = {}) {
    const repo = githubRepo(url);
    if (!repo) throw new Error('Choose a saved GitHub repository.');
    const key = repo.url.toLowerCase();
    const known = cache.get(key);
    if (!refresh && known && now() - known.at < CACHE_MS) return known.result;
    if (pending.has(key)) return pending.get(key);
    const request = retrieve(repo).then((result) => {
      cache.delete(key);
      cache.set(key, { at: now(), result });
      if (cache.size > 50) cache.delete(cache.keys().next().value);
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

module.exports = { createRepoReadmeReader, MAX_README_BYTES };
