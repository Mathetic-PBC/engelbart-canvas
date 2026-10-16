'use strict';

// Linear and Evernote through their official MCP servers, and a connector whose sign-in ended (2026-10-16, the onboarding
// beta's K1-K3): the catalog entries, the scope asked for, refresh and its refusal, the server asked whether a sign-in
// works, and what status says for each.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const sources = require('../src/shared/connect-sources.cjs');
const flow = require('../src/shared/import-flow.cjs');
const { officialServers } = require('../src/main/connect/own-connectors.cjs');
const { CONNECTORS, createConnectors, probeServer } = require('../src/main/connect/connectors.cjs');

const crypt = { available: () => true, encrypt: (text) => Buffer.from(text).toString('base64'), decrypt: (text) => Buffer.from(text, 'base64').toString('utf8') };

test('Linear and Evernote are connector apps on their official servers, Evernote with the browser as its fallback, Linear under Other', () => {
  const { APPS } = sources;
  assert.equal(APPS.Linear.reach, 'connector');
  assert.equal(APPS.Linear.mcp, 'https://mcp.linear.app/mcp/readonly', 'the read-only endpoint');
  assert.equal(APPS.Linear.scope, 'read');
  assert.equal(APPS.Evernote.reach, 'connector');
  assert.equal(APPS.Evernote.mcp, 'https://mcp.evernote.com/mcp');
  assert.equal(APPS.Evernote.scope, 'read', 'never its write or delete scopes');
  assert.equal(APPS.Evernote.fallback, 'web');
  assert.deepEqual(APPS.Evernote.sites, ['evernote.com'], 'the fallback keeps its browser route');
  assert.equal(sources.fallbackOf('Evernote'), 'web');
  assert.equal(sources.fallbackOf('Linear'), null);
  assert.equal(sources.fallbackOf('ChatGPT'), null);
  assert.equal(sources.sourceOfApp('Linear'), 'other');
  assert.equal(sources.sourceOfApp('Evernote'), 'notes');
  assert.ok(sources.ITEM_SOURCES.includes('Linear'));
  for (const app of ['Linear', 'Evernote']) {
    assert.ok(CONNECTORS[app], `${app} is a connector`);
    assert.ok(APPS[app].reads.list.length && APPS[app].reads.read.length, `${app} names its reading tools`);
    assert.ok(![...APPS[app].reads.list, ...APPS[app].reads.read].some((tool) => /^(create|edit|delete|save|move|update|restore|rename|start|finalize)_/.test(tool)), `${app}: reading tools only`);
  }
  assert.deepEqual(Object.keys(CONNECTORS).sort(), ['Evernote', 'Granola', 'Linear', 'Notion']);
});

test('the picker lists Linear in Other (no new category); a tool agent naming it among the others counts for it', () => {
  const other = flow.GROUPS[flow.GROUPS.length - 1];
  assert.deepEqual({ id: other.id, label: other.label, apps: [...other.apps] }, { id: 'other', label: 'Other', apps: ['Linear'] });
  assert.equal(flow.GROUP_IDS.filter((id) => id === 'other').length, 1);
  assert.equal(flow.groupOfApp('Linear'), 'other');
  assert.equal(flow.reachOf('Linear'), 'connector');
  assert.deepEqual(flow.catalogTool('Linear'), { id: 'Linear', name: 'Linear', group: 'other', local: false });
  const out = flow.readTools(JSON.stringify({ tools: [], additional: [{ name: 'Linear', website: 'https://linear.app', used: true, evidence: 'daily visits', category: 'code' }, { name: 'Figma', used: true }] }));
  assert.deepEqual(out.tools.find((tool) => tool.id === 'Linear'), { id: 'Linear', used: true, evidence: 'daily visits', method: 'agent' });
  assert.deepEqual(out.additional.map((tool) => tool.name), ['Figma']);
  const said = flow.readTools(JSON.stringify({ tools: [{ id: 'Linear', used: false, evidence: 'never' }], additional: [{ name: 'Linear', used: true }] }));
  assert.equal(said.tools.find((tool) => tool.id === 'Linear').used, false, 'its own answer wins');
});

test('an import plan for a connector app reads through its tools; the fallback route reads in the browser', () => {
  const projects = [{ title: 'Tutoring study' }];
  assert.match(flow.importPlan({ app: 'Linear', projects }), /through Linear's own tools \(its connector\), only reading/);
  assert.match(flow.importPlan({ app: 'Evernote', projects }), /through Evernote's own tools/);
  assert.match(flow.importPlan({ app: 'Evernote', projects, connector: false }), /Engelbart's browser/);
  assert.match(flow.importPlan({ app: 'Evernote', projects, browser: 'Chrome' }), /own Chrome/);
  assert.match(flow.importPlan({ app: 'Overleaf', projects }), /Engelbart's browser/);
});

test('a person\'s own Linear server is matched by its read-write and SSE addresses too', () => {
  const servers = officialServers();
  assert.equal(servers['https://mcp.linear.app/mcp/readonly'], 'Linear');
  assert.equal(servers['https://mcp.linear.app/mcp'], 'Linear');
  assert.equal(servers['https://mcp.linear.app/sse'], 'Linear');
  assert.equal(servers['https://mcp.evernote.com/mcp'], 'Evernote');
  assert.equal(servers['https://mcp.granola.ai/mcp'], 'Granola');
});

/** An OAuth server as Linear's and Evernote's are: dynamic registration, PKCE, refresh. `refresh` decides each refresh's answer. */
async function oauthServer({ refresh = () => ({ status: 200, body: { access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2' } }), first = { access_token: 'access-1', token_type: 'Bearer', expires_in: 600, refresh_token: 'refresh-1' } } = {}) {
  const seen = { registered: null, authorizeScope: null, refreshed: 0 };
  let base;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'create', 'write', 'delete'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { seen.registered = JSON.parse(body); return json({ ...seen.registered, client_id: 'client-1' }, 201); }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') return json(first);
      if (form.get('grant_type') === 'refresh_token') { seen.refreshed += 1; const out = refresh(form); return json(out.body, out.status); }
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const openExternal = async (href) => {
    const asked = new URL(href);
    seen.authorizeScope = asked.searchParams.get('scope');
    const back = new URL(asked.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'the-code');
    back.searchParams.set('state', asked.searchParams.get('state'));
    setTimeout(() => { fetch(back.href).catch(() => {}); }, 10);
  };
  return { seen, base, openExternal, close: () => server.close() };
}

function setUp(t, app, oauth, { probe = async () => ({ status: 200, tools: sources.APPS[app].reads.list }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connectors-'));
  t.after(() => { oauth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const clock = { at: Date.now() };
  const changes = [];
  const probes = [];
  const connectors = createConnectors({
    file: () => path.join(dir, 'connectors.json'), crypt, openExternal: oauth.openExternal, now: () => clock.at,
    urls: { [app]: `${oauth.base}/mcp` }, onChange: (status) => changes.push(status.state),
    probe: async (asked) => { probes.push(asked.token); return probe(asked, probes.length); },
  });
  return { connectors, clock, changes, probes };
}

test('a connector signs in asking only its read scope, and the server is asked at once whether it takes the account', async (t) => {
  const oauth = await oauthServer();
  const { connectors, probes } = setUp(t, 'Evernote', oauth);
  const before = connectors.status('Evernote');
  assert.equal(before.state, 'signed-out');
  assert.equal(before.action, 'Connect Evernote');
  assert.equal(before.fallback, 'web');
  const status = await connectors.signIn('Evernote');
  assert.equal(oauth.seen.authorizeScope, 'read', 'not the read create write delete the server lists');
  assert.equal(oauth.seen.registered.scope, 'read');
  assert.equal(status.state, 'connected');
  assert.equal(status.connected, true);
  assert.equal(status.action, undefined);
  assert.deepEqual(probes, ['access-1']);
});

test('a refresh the server refuses (invalid_grant) asks to be connected again, never connected or left out silently', async (t) => {
  const oauth = await oauthServer({ refresh: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } }) });
  const { connectors, clock, changes } = setUp(t, 'Linear', oauth);
  await connectors.signIn('Linear');
  clock.at += 500_000; // within two minutes of its end: refreshed first, and refused
  assert.equal(await connectors.accessToken('Linear'), null);
  assert.equal(oauth.seen.refreshed, 1);
  const status = connectors.status('Linear');
  assert.equal(status.state, 'reconnect');
  assert.equal(status.reason, 'revoked');
  assert.equal(status.connected, false);
  assert.equal(status.action, 'Connect Linear');
  assert.ok(changes.includes('reconnect'), 'onChange heard it');
  assert.deepEqual(await connectors.serversFor(['Linear']), []);
  assert.equal(connectors.list().find((one) => one.app === 'Linear').state, 'reconnect');
  // Connecting again works and clears it.
  const again = await connectors.signIn('Linear');
  assert.equal(again.state, 'connected');
  assert.equal(again.reason, null);
});

test('a refresh that only fails to be asked (a 5xx, offline) keeps the sign-in: the token is used while it lasts', async (t) => {
  let answer = { status: 503, body: { error: 'temporarily_unavailable' } };
  const oauth = await oauthServer({ refresh: () => answer });
  const { connectors, clock } = setUp(t, 'Linear', oauth);
  await connectors.signIn('Linear');
  clock.at += 500_000;
  assert.equal(await connectors.accessToken('Linear'), 'access-1', 'still within its lifetime');
  assert.equal(connectors.status('Linear').state, 'connected');
  clock.at += 200_000; // past its end, the server still down
  assert.equal(await connectors.accessToken('Linear'), null);
  assert.equal(connectors.status('Linear').state, 'connected', 'nothing said it was refused: refreshed when it can be');
  answer = { status: 200, body: { access_token: 'access-3', token_type: 'Bearer', expires_in: 3600 } };
  assert.equal(await connectors.accessToken('Linear'), 'access-3');
  assert.equal(connectors.status('Linear').refreshable, true, 'the refresh token is kept when the server gives no new one');
});

test('a token that ended with nothing to refresh it says expired', async (t) => {
  const oauth = await oauthServer({ first: { access_token: 'short', token_type: 'Bearer', expires_in: 600 } });
  const { connectors, clock } = setUp(t, 'Linear', oauth);
  await connectors.signIn('Linear');
  clock.at += 601_000;
  const status = connectors.status('Linear');
  assert.deepEqual([status.state, status.reason, status.connected, status.action], ['reconnect', 'expired', false, 'Connect Linear']);
  assert.equal(await connectors.accessToken('Linear'), null);
});

test('the server refusing a token (401) refreshes once and asks again; refused again is revoked', async (t) => {
  const oauth = await oauthServer();
  const answers = [{ status: 200, tools: ['list_issues'] }, { status: 401 }, { status: 200, tools: ['list_issues'] }, { status: 401 }, { status: 401 }];
  const { connectors, probes } = setUp(t, 'Linear', oauth, { probe: async (asked, n) => answers[n - 1] });
  await connectors.signIn('Linear');
  let status = await connectors.check('Linear', { force: true });
  assert.equal(status.state, 'connected', 'refreshed and taken');
  assert.equal(oauth.seen.refreshed, 1);
  assert.deepEqual(probes, ['access-1', 'access-1', 'access-2']);
  status = await connectors.check('Linear', { force: true });
  assert.deepEqual([status.state, status.reason], ['reconnect', 'revoked']);
  assert.equal(await connectors.reaches('Linear', 'anthropic'), false);
});

test('a server that refuses the account (403) or has none of its reading tools is unavailable, and Evernote falls back to the browser', async (t) => {
  const oauth = await oauthServer();
  const answers = [{ status: 403 }, { status: 200, tools: ['create_note'] }, { status: 0 }, { status: 200, tools: ['search_notes', 'get_note'] }];
  const { connectors, clock } = setUp(t, 'Evernote', oauth, { probe: async (asked, n) => answers[n - 1] });
  let status = await connectors.signIn('Evernote');
  assert.deepEqual([status.state, status.reason, status.connected, status.fallback, status.action], ['unavailable', 'refused', false, 'web', undefined]);
  assert.equal(await connectors.accessToken('Evernote'), null);
  assert.deepEqual(await connectors.serversFor(['Evernote']), [], 'cached: not asked again within five minutes');
  clock.at += 6 * 60_000;
  status = await connectors.check('Evernote');
  assert.deepEqual([status.state, status.reason], ['unavailable', 'no-tools']);
  status = await connectors.check('Evernote', { force: true });
  assert.equal(status.unchecked, true, 'could not tell: nothing changes');
  assert.equal(status.state, 'unavailable');
  status = await connectors.check('Evernote', { force: true });
  assert.equal(status.state, 'connected', 'let in since');
  const servers = await connectors.serversFor(['Evernote']);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'evernote');
});

test('a server that can\'t be asked leaves a connector connected, unchecked', async (t) => {
  const oauth = await oauthServer();
  const { connectors } = setUp(t, 'Linear', oauth, { probe: async () => ({ status: 0 }) });
  const status = await connectors.signIn('Linear');
  assert.equal(status.connected, true);
  assert.equal(status.unchecked, true);
  assert.deepEqual((await connectors.serversFor(['Linear'])).map((one) => one.token), ['access-1']);
});

test('probeServer asks a real MCP server: its tools on 200, the status it refused with', async (t) => {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.headers.authorization !== 'Bearer good') { res.writeHead(401, { 'www-authenticate': 'Bearer' }); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'list_issues', inputSchema: { type: 'object' } }, { name: 'get_issue', inputSchema: { type: 'object' } }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  assert.deepEqual(await probeServer({ url, token: 'good' }), { status: 200, tools: ['list_issues', 'get_issue'] });
  assert.deepEqual(await probeServer({ url, token: 'bad' }), { status: 401 });
  assert.deepEqual(await probeServer({ url: 'http://127.0.0.1:1/mcp', token: 'good', timeoutMs: 2000 }), { status: 0 });
});
