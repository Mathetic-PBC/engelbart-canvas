'use strict';

// A GitHub repository's code for an E2B sandbox, read with the person's GitHub sign-in without the sign-in ever leaving
// this process (2026-09-29). The App reads contents (docs/github-app-setup.md), so a private repository it is installed
// on can be read:
//   describe  whether the repository is private, its default branch, and whether it wants Docker (compose or Supabase
//             files), asked with the sign-in so a private repository answers too
//   archive   a private repository's download link: GitHub answers /tarball with a codeload.github.com address carrying
//             a token of its own, good for that one archive for about five minutes. The sandbox gets that link (as an
//             environment variable of one command, redacted from its output), never the sign-in, and nothing that
//             could read another repository or write anywhere.
// A public repository needs neither: the sandbox clones it as anyone could.

const { API } = require('./connection.cjs');

const TIMEOUT_MS = 20_000;
const DOCKER_FILES = /(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)supabase\/config\.toml$/i;
const BRANCH = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[\w./-]{1,200}$/;
const ARCHIVE_HOSTS = ['codeload.github.com'];

function createRepoAccess({ token = async () => null, fetch = globalThis.fetch, api = API, installUrl = () => '', archiveHosts = ARCHIVE_HOSTS } = {}) {
  const base = (repo) => `${api}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  /** A GET of GitHub's API, signed in when there is a sign-in. → { response, signed } */
  async function get(url, { redirect = 'follow' } = {}) {
    const value = await token().catch(() => null);
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'engelbart-canvas', ...(value ? { authorization: `Bearer ${value}` } : {}) };
    return { response: await fetch(url, { headers, redirect, credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) }), signed: !!value };
  }

  async function wantsDocker(repo) {
    try {
      const { response } = await get(`${base(repo)}/git/trees/HEAD?recursive=1`);
      if (!response.ok) return undefined;
      const body = await response.json();
      return (body.tree || []).some((entry) => DOCKER_FILES.test(String(entry && entry.path)));
    } catch { return undefined; }
  }

  /**
   * → { private, branch, docker }. A repository GitHub cannot show throws a message that says what to do. Anything else
   * GitHub cannot answer now (a rate limit, an outage) leaves it to the sandbox's clone, as for a public repository.
   */
  async function describe(repo) {
    const name = `${repo.owner}/${repo.name}`;
    let answer;
    try { answer = await get(base(repo)); } catch { return { private: false, branch: null, docker: undefined }; }
    const { response, signed } = answer;
    if (response.status === 404) {
      const install = String(installUrl() || '');
      throw new Error(signed
        ? `Engelbart's GitHub App cannot see ${name}. If it is private, install the App for ${repo.owner} with access to it${install ? ` (${install})` : ''}.`
        : `${name} was not found on GitHub. If it is private, sign in to GitHub in Engelbart.`);
    }
    if (!response.ok) return { private: false, branch: null, docker: undefined };
    const data = await response.json().catch(() => ({}));
    const branch = typeof data.default_branch === 'string' && BRANCH.test(data.default_branch) ? data.default_branch : null;
    return { private: data.private === true, branch, docker: await wantsDocker(repo) };
  }

  /** A private repository's download link: one archive, minutes long. The sign-in goes to GitHub's API only (never followed to codeload). */
  async function archive(repo) {
    const name = `${repo.owner}/${repo.name}`;
    const { response, signed } = await get(`${base(repo)}/tarball`, { redirect: 'manual' });
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch { /* nothing to read */ }
    if (!signed) throw new Error(`Sign in to GitHub in Engelbart to prepare ${name}: it is private.`);
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error(`GitHub would not hand over ${name}'s code (${response.status}).`);
    let url;
    try { url = new URL(location, api); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !archiveHosts.includes(url.hostname) || url.username || url.password) throw new Error(`GitHub answered with an unexpected download address for ${name}.`);
    return url.href;
  }

  return { describe, archive };
}

module.exports = { createRepoAccess, BRANCH };
