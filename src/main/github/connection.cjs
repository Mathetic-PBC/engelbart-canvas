'use strict';

// GitHub App access for the repository picker. The shared registration uses browser authorization
// with PKCE through the server broker; a random loopback callback returns to Engelbart automatically.
// Old device-flow tokens and custom registrations remain supported. Tokens stay in main, encrypted
// with the system keychain. tokenFlow records whether refresh needs the broker or GitHub directly.

const fs = require('node:fs');
const path = require('node:path');

const WEB = 'https://github.com';
const API = 'https://api.github.com';
const TIMEOUT_MS = 15000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// What GitHub's device flow errors mean to the person.
const FAILURES = {
  access_denied: 'Cancelled on GitHub.',
  expired_token: 'The code expired. Try again.',
  token_expired: 'The code expired. Try again.',
  device_flow_disabled: 'Device flow is off in the GitHub App’s settings.',
  incorrect_client_credentials: 'GitHub does not know this client id.',
  incorrect_device_code: 'GitHub did not accept the code. Try again.',
  unsupported_grant_type: 'GitHub refused the sign-in.',
};

class GithubError extends Error {
  constructor(message, code = 'github') { super(message); this.code = code; }
}

const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

function shapeRepo(repo) {
  const fullName = typeof repo.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.full_name) ? repo.full_name : null;
  if (!fullName || !Number.isSafeInteger(repo.id)) return null;
  return {
    id: String(repo.id),
    fullName,
    url: `https://github.com/${fullName}`,
    owner: fullName.split('/')[0],
    private: !!repo.private,
    description: typeof repo.description === 'string' ? repo.description.slice(0, 300) : '',
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : '',
  };
}

function createGithub({
  fetch = globalThis.fetch,
  settings = () => ({ clientId: '', appSlug: '' }),
  file,
  crypt = { available: () => false, encrypt: () => { throw new Error('no keychain'); }, decrypt: () => { throw new Error('no keychain'); } },
  openVerification = () => {},
  closeVerification = () => {},
  browserAuth = () => null,
  onConnected = () => {},
  onChange = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  web = WEB,
  api = API,
} = {}) {
  let saved; // undefined: not read yet; null: signed out; else { login, name, avatarUrl, id, access, accessExpiresAt, refresh, refreshExpiresAt }
  let pending = null; // { userCode, verificationUri, deviceCode, interval, expiresAt }
  let problem = '';
  let persisted = true;
  let refreshing = null;
  let starting = null;
  let generation = 0;

  const clientId = () => String((settings() || {}).clientId || '');
  const appSlug = () => String((settings() || {}).appSlug || '');
  const changed = () => { try { onChange(status()); } catch { /* a listener never breaks the flow */ } };

  async function call(url, { method = 'GET', form = null, token = null } = {}) {
    const headers = { accept: form ? 'application/json' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const response = await fetch(url, { method, headers, body, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { status: response.status, ok: response.ok, data, link: (response.headers && response.headers.get && response.headers.get('link')) || '' };
  }

  /* ------------------------------------------------------------- storage */

  function load() {
    if (saved !== undefined) return saved;
    saved = null;
    if (!file) return saved;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.v === 1 && typeof raw.access === 'string' && crypt.available()) {
        saved = {
          login: String(raw.login || ''), name: String(raw.name || ''), avatarUrl: String(raw.avatarUrl || ''), id: raw.id == null ? null : String(raw.id),
          access: crypt.decrypt(raw.access),
          accessExpiresAt: positive(raw.accessExpiresAt),
          refresh: typeof raw.refresh === 'string' ? crypt.decrypt(raw.refresh) : null,
          refreshExpiresAt: positive(raw.refreshExpiresAt),
          tokenFlow: raw.tokenFlow === 'browser' ? 'browser' : 'device',
        };
      }
    } catch {
      saved = null; // missing, unreadable, or encrypted by another keychain: signed out
    }
    return saved;
  }

  function keep(next) {
    saved = next;
    persisted = !!file && crypt.available();
    if (!persisted) return;
    const out = {
      v: 1, login: next.login, name: next.name, avatarUrl: next.avatarUrl, id: next.id,
      access: crypt.encrypt(next.access), accessExpiresAt: next.accessExpiresAt,
      refresh: next.refresh ? crypt.encrypt(next.refresh) : null, refreshExpiresAt: next.refreshExpiresAt,
      tokenFlow: next.tokenFlow || 'device',
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function forget(reason = '') {
    saved = null;
    refreshing = null;
    if (file) { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } }
    problem = reason;
  }

  /** The tokens GitHub answered, as they are kept: expiry times in milliseconds since the epoch. */
  function tokensFrom(answer, at) {
    const accessIn = positive(answer.expires_in), refreshIn = positive(answer.refresh_token_expires_in);
    return {
      access: String(answer.access_token),
      accessExpiresAt: accessIn ? at + accessIn * 1000 : null,
      refresh: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : null,
      refreshExpiresAt: refreshIn ? at + refreshIn * 1000 : null,
    };
  }

  /* -------------------------------------------------------------- status */

  function status() {
    const account = load();
    return {
      configured: !!clientId(),
      connected: !!account,
      login: account ? account.login : '',
      name: account ? account.name : '',
      avatarUrl: account ? account.avatarUrl : '',
      persisted: account ? persisted : true,
      pending: pending ? { kind: pending.kind || 'device', ...(pending.userCode ? { userCode: pending.userCode } : {}), verificationUri: pending.verificationUri, expiresAt: pending.expiresAt } : null,
      error: problem,
      installUrl: appSlug() ? `${web}/apps/${appSlug()}/installations/new` : '',
    };
  }

  /* ---------------------------------------------------------- device flow */

  /** Starts signing in (or shows the window again for a sign-in already waiting). Answers the status, with the code. */
  function connect() {
    if (!starting) starting = begin().finally(() => { starting = null; });
    return starting;
  }

  async function begin() {
    if (!clientId()) throw new GithubError('GitHub is not set up: put the GitHub App’s client id in ~/.engelbart/config.json (github.clientId).', 'unconfigured');
    if (pending && now() < pending.expiresAt) { await openVerification(pending.verificationUri); return status(); }
    if (pending && pending.cancel) pending.cancel();
    const attempt = ++generation;
    problem = '';
    const browser = browserAuth();
    if (browser) {
      const auth = await browser.start();
      if (attempt !== generation) { auth.cancel(); return status(); }
      const flow = { kind: 'browser', verificationUri: auth.url, expiresAt: auth.expiresAt, cancel: auth.cancel };
      pending = flow;
      changed();
      void auth.result.then(async data => {
        if (pending !== flow) return;
        await accept(data, () => pending === flow, 'browser');
        if (pending !== flow) return;
        pending = null; problem = ''; changed(); onConnected();
      }).catch(error => {
        if (pending !== flow) return;
        pending = null; problem = error.message; changed();
      });
      try { await openVerification(flow.verificationUri); }
      catch (error) { cancel(); problem = 'Could not open your browser. Try signing in again.'; changed(); throw error; }
      return status();
    }
    const answer = await call(`${web}/login/device/code`, { method: 'POST', form: { client_id: clientId() } });
    const data = answer.data || {};
    if (attempt !== generation) return status();
    if (!answer.ok || !data.device_code || !data.user_code) {
      problem = FAILURES[data.error] || data.error_description || `GitHub answered ${answer.status}.`;
      changed();
      throw new GithubError(problem, data.error || 'device-code');
    }
    const flow = {
      userCode: String(data.user_code),
      verificationUri: typeof data.verification_uri === 'string' && /^https:\/\//.test(data.verification_uri) ? data.verification_uri : `${web}/login/device`,
      deviceCode: String(data.device_code),
      interval: positive(data.interval) || 5,
      expiresAt: now() + (positive(data.expires_in) || 900) * 1000,
    };
    pending = flow;
    changed();
    await openVerification(flow.verificationUri);
    void wait(flow);
    return status();
  }

  async function wait(flow) {
    let interval = flow.interval;
    while (pending === flow && now() < flow.expiresAt) {
      await sleep(interval * 1000);
      if (pending !== flow) return;
      let answer;
      try {
        answer = await call(`${web}/login/oauth/access_token`, { method: 'POST', form: { client_id: clientId(), device_code: flow.deviceCode, grant_type: DEVICE_GRANT } });
      } catch {
        continue; // the network blinked: keep waiting until the code expires
      }
      const data = answer.data || {};
      if (pending !== flow) return;
      if (data.access_token) {
        try {
          await accept(data, () => pending === flow);
          if (pending !== flow) return;
          problem = '';
        } catch (error) {
          problem = error.message;
        }
        if (pending === flow) pending = null;
        closeVerification();
        changed();
        if (saved) onConnected();
        return;
      }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { interval = positive(data.interval) || interval + 5; continue; }
      if (pending !== flow) return;
      pending = null;
      problem = FAILURES[data.error] || data.error_description || `GitHub answered ${answer.status}.`;
      closeVerification();
      changed();
      return;
    }
    if (pending === flow) { pending = null; problem = FAILURES.expired_token; closeVerification(); changed(); }
  }

  /** A token arrived: who it belongs to, then keep it. */
  async function accept(data, active = () => true, tokenFlow = 'device') {
    const tokens = tokensFrom(data, now());
    const who = await call(`${api}/user`, { token: tokens.access });
    if (!who.ok || !who.data || typeof who.data.login !== 'string') throw new GithubError('GitHub gave a token but would not say whose it is.', 'user');
    if (!active()) return;
    keep({ login: who.data.login, name: typeof who.data.name === 'string' ? who.data.name : '', avatarUrl: typeof who.data.avatar_url === 'string' ? who.data.avatar_url : '', id: who.data.id == null ? null : String(who.data.id), ...tokens, tokenFlow });
  }

  function cancel() {
    generation += 1;
    if (!pending) return status();
    if (pending.cancel) pending.cancel();
    pending = null;
    closeVerification();
    changed();
    return status();
  }

  function disconnect() {
    cancel();
    forget('');
    changed();
    return status();
  }

  /* --------------------------------------------------------------- tokens */

  /** A token that works now (refreshed when it is about to expire), or null when signed out. */
  async function token() {
    const account = load();
    if (!account) return null;
    if (!account.accessExpiresAt || now() < account.accessExpiresAt - REFRESH_EARLY_MS) return account.access;
    if (!account.refresh || (account.refreshExpiresAt && now() >= account.refreshExpiresAt)) {
      forget('The GitHub sign-in expired. Sign in again.');
      changed();
      return null;
    }
    if (!refreshing) {
      refreshing = (async () => {
        let answer;
        try {
          if (account.tokenFlow === 'browser') {
            const browser = browserAuth();
            if (!browser) throw new Error('Browser authorization unavailable');
            answer = { data: await browser.refresh(account.refresh) };
          } else answer = await call(`${web}/login/oauth/access_token`, { method: 'POST', form: { client_id: clientId(), grant_type: 'refresh_token', refresh_token: account.refresh } });
        } catch {
          return null; // offline: nothing works now; the refresh token is still good for later
        }
        const data = answer.data || {};
        if (saved !== account) return null;
        if (!data.access_token && !data.error) return null; // GitHub had a bad moment: keep the sign-in for later
        if (!data.access_token) {
          forget(data.error === 'bad_refresh_token' ? 'The GitHub sign-in expired. Sign in again.' : (data.error_description || 'GitHub would not renew the sign-in. Sign in again.'));
          changed();
          return null;
        }
        const renewed = tokensFrom(data, now());
        keep({ ...account, ...renewed, refresh: renewed.refresh || account.refresh, refreshExpiresAt: renewed.refresh ? renewed.refreshExpiresAt : account.refreshExpiresAt });
        return saved.access;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  /** Headers that sign a request to GitHub's API in, or none. */
  async function authHeaders() {
    const value = await token();
    return value ? { authorization: `Bearer ${value}` } : {};
  }

  /** A signed-in GET of the API; a token GitHub no longer accepts signs the person out. */
  async function signedGet(url) {
    const value = await token();
    if (!value) throw new GithubError('Not signed in to GitHub.', 'signed-out');
    const answer = await call(url, { token: value });
    if (answer.status === 401) { forget('GitHub no longer accepts the sign-in. Sign in again.'); changed(); throw new GithubError(problem, 'signed-out'); }
    if (!answer.ok) throw new GithubError((answer.data && answer.data.message) || `GitHub answered ${answer.status}.`, 'api');
    return answer;
  }

  async function pages(url, key) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await signedGet(`${url}${url.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`);
      const items = Array.isArray(answer.data && answer.data[key]) ? answer.data[key] : [];
      out.push(...items);
      if (items.length < PER_PAGE || !/rel="next"/.test(answer.link)) break;
    }
    return out;
  }

  /**
   * The repositories the App can read for the person, most recently pushed first, and the accounts it is installed on
   * ({ login, type, all }: `all` when every repository of the account is included). An account the App is not
   * installed on shows nothing: installing it there is `installUrl`.
   */
  async function repos() {
    const installations = await pages(`${api}/user/installations`, 'installations');
    const seen = new Set();
    const list = [];
    for (const installation of installations) {
      if (!Number.isSafeInteger(installation && installation.id)) continue;
      for (const repo of await pages(`${api}/user/installations/${installation.id}/repositories`, 'repositories')) {
        const shaped = repo && shapeRepo(repo);
        if (shaped && !seen.has(shaped.id)) { seen.add(shaped.id); list.push(shaped); }
      }
    }
    list.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt) || a.fullName.localeCompare(b.fullName));
    const accounts = installations
      .filter((installation) => installation && installation.account && typeof installation.account.login === 'string')
      .map((installation) => ({ login: installation.account.login, type: String(installation.account.type || ''), all: installation.repository_selection === 'all' }));
    return { repos: list, accounts };
  }

  return { status, connect, cancel, disconnect, token, authHeaders, repos };
}

module.exports = { createGithub, GithubError, shapeRepo, WEB, API };
