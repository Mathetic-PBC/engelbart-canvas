'use strict';

// Connect your library, 2026-10-08 ("Agent onboarding"): a web app's sign-in made in the person's default browser and
// brought over into Engelbart's (src/main/connect/web-signin.cjs), done only once Engelbart holds it; and "which
// repositories" asked with the GitHub list (readReply's "repos" question). Fakes only: no real browser profile or Keychain.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebSignIn, browserIdOf, domainsOf } = require('../src/main/connect/web-signin.cjs');
const { readReply, cleanChoices } = require('../src/main/connect/session.cjs');

/** A fake Stage session and a fake importer whose Chrome profile gains ChatGPT's sign-in cookie after `after` looks. */
function fixture({ browser = 'Google Chrome', after = 0, deny = false } = {}) {
  const held = [];
  const calls = { names: 0, imports: [], opened: [] };
  const cookieImport = {
    sources: () => [{ id: 'chrome', name: 'Chrome', family: 'chromium', profiles: [{ id: 'Profile 1', name: 'Work' }, { id: 'Default', name: 'Me' }] }],
    cookieNames: (id, profile, domains) => {
      calls.names += 1;
      assert.deepEqual(domains, ['chatgpt.com', 'openai.com']);
      return profile === 'Default' && calls.names > after * 2 ? [{ domain: 'chatgpt.com', name: '__Secure-next-auth.session-token' }, { domain: 'openai.com', name: 'oai-did' }] : [{ domain: 'chatgpt.com', name: 'oai-did' }];
    },
    import: async (options) => {
      if (deny) throw new Error('Engelbart needs Keychain access to read Chrome\'s cookies, and the request was denied. Nothing was imported.');
      calls.imports.push(options);
      held.push({ domain: '.chatgpt.com', name: '__Secure-next-auth.session-token' });
    },
  };
  const getSession = () => ({ cookies: { get: async ({ domain }) => held.filter((cookie) => cookie.domain.endsWith(domain)) } });
  const web = createWebSignIn({ cookieImport, defaultBrowser: () => browser, openExternal: async (url) => { calls.opened.push(url); }, getSession, pollMs: 1, timeoutMs: 200, sleep: () => new Promise((resolve) => setImmediate(resolve)) });
  return { web, calls };
}

test('signed in already in the default browser: the sign-in comes over, nothing opens', async () => {
  const { web, calls } = fixture();
  assert.equal(await web.signedIn('ChatGPT'), false);
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'signed-in', browser: 'Chrome', opened: false });
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.imports, [{ browser: 'chrome', profile: 'Default', domains: ['chatgpt.com', 'openai.com'], quiet: true }], 'the profile that has it, quietly');
  assert.equal(await web.signedIn('ChatGPT'), true);
});

test('not signed in there: the sign-in page opens in the default browser and is waited for', async () => {
  const { web, calls } = fixture({ after: 3 });
  let told = '';
  const out = await web.signIn('ChatGPT', { onOpened: (name) => { told = name; } });
  assert.deepEqual(out, { status: 'signed-in', browser: 'Chrome', opened: true });
  assert.deepEqual(calls.opened, ['https://chatgpt.com/auth/login']);
  assert.equal(told, 'Chrome');
  assert.equal(calls.imports.length, 1, 'nothing written until the sign-in cookie is there');
});

test('a sign-in never made times out; Skip cancels; a Keychain refusal is said; Safari falls back', async () => {
  assert.equal((await fixture({ after: 1e9 }).web.signIn('ChatGPT')).status, 'timeout');
  const controller = new AbortController();
  const pending = fixture({ after: 1e9 }).web.signIn('ChatGPT', { signal: controller.signal, onOpened: () => controller.abort() });
  assert.deepEqual(await pending, { status: 'cancelled' });
  await assert.rejects(fixture({ deny: true }).web.signIn('ChatGPT'), /Keychain access/);
  const safari = fixture({ browser: 'Safari' });
  assert.deepEqual(await safari.web.signIn('ChatGPT'), { status: 'unsupported', browser: 'Safari' });
  assert.deepEqual(safari.calls.opened, [], 'nothing opened where it could not be brought back');
});

test('which apps and browsers it knows', () => {
  const { web } = fixture();
  assert.equal(web.supports('ChatGPT'), true);
  assert.equal(web.supports('Claude'), true);
  assert.equal(web.supports('Notion'), false, 'a connector signs in through OAuth');
  assert.equal(web.supports('Evernote'), false, 'no known sign-in cookie: the agent\'s window');
  assert.deepEqual(['Google Chrome', 'Brave Browser', 'Arc', 'Firefox', 'Microsoft Edge', 'Safari', 'Google Chrome Canary'].map(browserIdOf), ['chrome', 'brave', 'arc', 'firefox', 'edge', null, null]);
  assert.deepEqual(domainsOf('Gemini'), ['google.com']);
});

test('"which repositories" is asked with the GitHub list, whatever kind the librarian gave it', () => {
  const choices = cleanChoices({ sources: { code: { on: true } } }, '/tmp');
  assert.deepEqual(readReply('{"say":"","ask":{"source":"code","kind":"repos","title":"Which repositories?"}}', choices).ask, { source: 'code', kind: 'repos', title: 'Which repositories?', options: [], placeholder: '' });
  assert.equal(readReply('{"ask":{"source":"code","kind":"multi","title":"Which repositories should come in?","options":["a/b","c/d"]}}', choices).ask.kind, 'repos');
  assert.equal(readReply('{"ask":{"source":"code","kind":"single","title":"Notebooks and data too, or only the code?","options":["Code only","Everything"]}}', choices).ask.kind, 'single');
});
