'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { faviconPage, iconUrl, loadFavicon, MAX_ICON_BYTES } = require('../src/main/browser/favicons.cjs');
const signal = () => new AbortController().signal;

test('favicon pages exclude E2B and non-web documents without excluding lookalike names', () => {
  for (const url of ['https://chatgpt.com/', 'http://localhost:3000', 'https://e2b.app.example.com', 'https://note2b.app']) assert.equal(faviconPage(url), true, url);
  for (const url of ['https://3000-sandbox.e2b.app', 'https://x.e2b.dev', 'https://E2B.APP./', 'file:///tmp/page.html', 'about:blank', 'engelbart://app/', 'bad']) assert.equal(faviconPage(url), false, url);
});

test('only bounded image data or HTTP(S) favicon URLs are accepted', () => {
  const data = 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E';
  assert.equal(iconUrl(data), data);
  assert.equal(iconUrl('https://example.com/icon.ico'), 'https://example.com/icon.ico');
  for (const value of ['file:///etc/passwd', 'engelbart://app/index.html', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'blob:https://example.com/a', 'https://name:secret@example.com/icon.png', 'data:image/png;base64,' + 'a'.repeat(MAX_ICON_BYTES * 2), null]) assert.equal(iconUrl(value), null);
});

test('favicon fetch uses the browser session and embeds only image bytes', async () => {
  const requests = [];
  const session = { fetch: async (url, options) => { requests.push([url, options]); return new Response('image bytes', { headers: { 'content-type': 'image/png' } }); } };
  const icon = await loadFavicon(session, ['https://example.com/icon.png'], signal());
  assert.equal(icon, 'data:image/png;base64,' + Buffer.from('image bytes').toString('base64'));
  assert.equal(requests[0][1].redirect, 'manual');
  assert.equal(requests[0][1].bypassCustomProtocolHandlers, true);
  assert.ok(requests[0][1].signal instanceof AbortSignal);
  const data = 'data:image/png;base64,YQ==';
  assert.equal(await loadFavicon(session, [data], signal()), data);
  assert.equal(requests.length, 1, 'data icons require no network request');
});

test('bad responses fall back, candidates are bounded, and oversized streams are cancelled', async () => {
  let calls = 0;
  const session = { fetch: async () => { calls++; return new Response('not found', { status: 404 }); } };
  assert.equal(await loadFavicon(session, Array(8).fill('https://example.com/missing.png'), signal()), null);
  assert.equal(calls, 3);
  session.fetch = async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(await loadFavicon(session, ['https://example.com/icon.png'], signal()), null);
  let cancelled = false;
  session.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_ICON_BYTES + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/png' } });
  assert.equal(await loadFavicon(session, ['https://example.com/large.png'], signal()), null);
  assert.equal(cancelled, true);
});

test('redirects are bounded and cannot reach file or application protocols', async () => {
  let calls = 0;
  const session = { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }); } };
  assert.equal(await loadFavicon(session, ['https://example.com/redirect'], signal()), null);
  assert.equal(calls, 1);
  session.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: '/loop' } }); };
  calls = 0;
  assert.equal(await loadFavicon(session, ['https://example.com/loop'], signal()), null);
  assert.equal(calls, 4);
  session.fetch = async url => url.endsWith('/redirect') ? new Response(null, { status: 302, headers: { location: '/icon.ico' } }) : new Response('ico', { headers: { 'content-type': 'image/x-icon' } });
  assert.equal(await loadFavicon(session, ['https://example.com/redirect'], signal()), 'data:image/x-icon;base64,aWNv');
  const controller = new AbortController(); controller.abort();
  session.fetch = () => { throw new Error('must not fetch'); };
  assert.equal(await loadFavicon(session, ['https://example.com/icon.ico'], controller.signal), null);
});
