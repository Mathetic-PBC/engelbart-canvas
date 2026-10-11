'use strict';

// The organizations the person works in, for MATH-111: GitHub only lets the App see an account it is installed on, and
// installing it on an organization needs an owner's OK, so Engelbart can only name the ones still missing and open
// GitHub's install page for each. Two places say which organizations they are:
//   - GitHub: GET /user/orgs with the App's user token (./connection.cjs). Not checked against the real API yet (no App
//     token could be had without a keychain prompt); fine-grained tokens get an empty list there, and an App's user token
//     is expected to list only the organizations the App is installed on. Either way it is only added to what the Mac
//     says, and an installed one is never missing, so a short or failed answer leaves the remotes alone.
//   - This Mac: the GitHub remotes of the repositories Connect finds (../connect/scan.cjs localRepos and gitFolders).
// Everything here only reads.

const fs = require('node:fs');
const path = require('node:path');

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The owner of a github.com remote URL (https, ssh://, git@github.com:, git://), or null for any other host. */
function remoteOwner(url) {
  const value = String(url || '').trim();
  const scp = /^[\w.-]+@(?:www\.)?github\.com:\/?([^/\s]+)\/[^/\s]+$/i.exec(value);
  if (scp) return LOGIN.test(scp[1]) ? scp[1] : null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!/^(https?|ssh|git|git\+ssh):$/.test(parsed.protocol) || !/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
  return owner && repo && LOGIN.test(owner) ? owner : null;
}

/** The remote URLs in a git config's text ([remote "…"] url = …). */
function remoteUrls(config) {
  const out = [];
  let inRemote = false;
  for (const raw of String(config || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inRemote = /^\[remote\s+"[^"]*"\]$/.test(line); continue; }
    const url = inRemote && /^(?:push)?url\s*=\s*(.+)$/i.exec(line);
    if (url) out.push(url[1].trim().replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

/** A repository folder's git config: .git/config, or, for a worktree (.git a file), its common folder's. */
function configOf(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return fs.readFileSync(path.join(dotGit, 'config'), 'utf8');
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!pointer) return '';
    const gitdir = path.resolve(dir, pointer[1].trim());
    let common = gitdir;
    try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    return fs.readFileSync(path.join(common, 'config'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * The GitHub owners of the repositories in `dirs` → [{ login, repos: [dir] }], the person's own `login` left out (in any
 * case), each owner once (named as its first remote spelled it), most repositories first.
 */
function macOrgs(dirs, { login = '' } = {}) {
  const me = String(login || '').toLowerCase();
  const byOwner = new Map();
  for (const dir of [...new Set((dirs || []).filter((entry) => typeof entry === 'string' && entry))]) {
    const owners = new Set(remoteUrls(configOf(dir)).map(remoteOwner).filter(Boolean));
    const seen = new Set();
    for (const owner of owners) {
      const key = owner.toLowerCase();
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      const held = byOwner.get(key) || { login: owner, repos: [] };
      held.repos.push(dir);
      byOwner.set(key, held);
    }
  }
  return [...byOwner.values()].sort((a, b) => b.repos.length - a.repos.length || a.login.localeCompare(b.login));
}

/** The App's install page for one account: straight to its permissions with its id, else the page that lets them pick. */
function installUrlFor(base, id) {
  return base && id ? `${base}/permissions?target_id=${encodeURIComponent(id)}` : base;
}

/**
 * The organizations without the App → [{ login, id, repos: [dir on this Mac], installUrl }]. `accounts`: the installations'
 * ({ login }); `fromGithub`: /user/orgs's answer ({ login, id }); `fromMac`: macOrgs's. Logins compare case-insensitively;
 * the person's own login is never one. `ids` (login lowercased → id) fills in ids the two lists did not carry.
 */
function missingOrgs({ accounts = [], fromGithub = [], fromMac = [], login = '', base = '', ids = new Map() }) {
  const installed = new Set(accounts.map((account) => String(account.login || '').toLowerCase()));
  installed.add(String(login || '').toLowerCase());
  const out = new Map();
  for (const org of fromGithub) {
    if (!org || typeof org.login !== 'string' || !LOGIN.test(org.login)) continue;
    const key = org.login.toLowerCase();
    if (!installed.has(key) && !out.has(key)) out.set(key, { login: org.login, id: org.id == null ? null : String(org.id), repos: [] });
  }
  for (const org of fromMac) {
    const key = String(org.login || '').toLowerCase();
    if (!key || installed.has(key)) continue;
    const held = out.get(key) || { login: org.login, id: null, repos: [] };
    held.repos = [...new Set([...held.repos, ...(org.repos || [])])];
    out.set(key, held);
  }
  return [...out.values()].map((org) => {
    const id = org.id || ids.get(org.login.toLowerCase()) || null;
    return { ...org, id, installUrl: installUrlFor(base, id) };
  });
}

module.exports = { remoteOwner, remoteUrls, configOf, macOrgs, missingOrgs, installUrlFor };
