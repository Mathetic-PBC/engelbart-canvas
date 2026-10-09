'use strict';

// Connect your library, 2026-10-08 ("Agent onboarding"): a web app's sign-in made in the person's default browser and
// brought over into Engelbart's (src/main/connect/web-signin.cjs), done only once Engelbart holds it; another browser when
// the default's cookies can't be read (Safari) or macOS refuses one (2026-10-09); and "which
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
    sources: () => [{ id: 'chrome', name: 'Chrome', family: 'chromium', bundle: 'com.google.Chrome', profiles: [{ id: 'Profile 1', name: 'Work' }, { id: 'Default', name: 'Me' }] }],
    cookieNames: (id, profile, domains) => {
      calls.names += 1;
      assert.deepEqual(domains, ['chatgpt.com', 'openai.com']);
      return profile === 'Default' && calls.names > after * 2 ? [{ domain: 'chatgpt.com', name: '__Secure-next-auth.session-token' }, { domain: 'openai.com', name: 'oai-did' }] : [{ domain: 'chatgpt.com', name: 'oai-did' }];
    },
    import: async (options) => {
      if (deny) throw Object.assign(new Error('Engelbart needs Keychain access to read Chrome\'s cookies, and the request was denied. Nothing was imported.'), { denied: true });
      calls.imports.push(options);
      held.push({ domain: '.chatgpt.com', name: '__Secure-next-auth.session-token' });
    },
  };
  const getSession = () => ({ cookies: { get: async ({ domain }) => held.filter((cookie) => cookie.domain.endsWith(domain)) } });
  const web = createWebSignIn({ cookieImport, defaultBrowser: () => browser, openExternal: async (url) => { calls.opened.push(url); }, getSession, pollMs: 1, timeoutMs: 200, sleep: () => new Promise((resolve) => setImmediate(resolve)) });
  return { web, calls };
}

/**
 * Several installed browsers (2026-10-09): `browsers` { id: { signedIn, deny } }, in the order sources() lists them.
 * `keychain` counts what macOS was asked (a Chromium import); Firefox needs none. A sign-in made later: `later` { id: looks }.
 */
function machine({ defaultName = 'Safari', browsers = {}, later = {} } = {}) {
  const NAMES = { chrome: ['Chrome', 'chromium', 'com.google.Chrome'], brave: ['Brave', 'chromium', 'com.brave.Browser'], firefox: ['Firefox', 'firefox', 'org.mozilla.firefox'] };
  const held = [];
  const calls = { keychain: [], imports: [], opened: [], openedIn: [], looks: {} };
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: [{ id: 'Default', name: 'Me' }] })),
    cookieNames: (id) => {
      calls.looks[id] = (calls.looks[id] || 0) + 1;
      const signedIn = browsers[id].signedIn || (later[id] != null && calls.looks[id] > later[id]);
      return signedIn ? [{ domain: 'chatgpt.com', name: '__Secure-next-auth.session-token' }] : [];
    },
    import: async ({ browser: id, profile, domains, quiet }) => {
      if (NAMES[id][1] === 'chromium') calls.keychain.push(id);
      if (browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
      calls.imports.push({ browser: id, profile, domains, quiet });
      held.push({ domain: '.chatgpt.com', name: '__Secure-next-auth.session-token' });
    },
  };
  const getSession = () => ({ cookies: { get: async ({ domain }) => held.filter((cookie) => cookie.domain.endsWith(domain)) } });
  const web = createWebSignIn({
    cookieImport, defaultBrowser: () => defaultName, getSession, pollMs: 1, timeoutMs: 200, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    openExternal: async (url) => { calls.opened.push(url); },
    openIn: async (id, url) => { calls.openedIn.push([id, url]); },
  });
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

test('a sign-in never made times out; Skip cancels; a Keychain refusal is said', async () => {
  assert.equal((await fixture({ after: 1e9 }).web.signIn('ChatGPT')).status, 'timeout');
  const controller = new AbortController();
  const pending = fixture({ after: 1e9 }).web.signIn('ChatGPT', { signal: controller.signal, onOpened: () => controller.abort() });
  assert.deepEqual(await pending, { status: 'cancelled' });
  const refused = fixture({ deny: true });
  assert.deepEqual(await refused.web.signIn('ChatGPT'), { status: 'denied', browser: 'Chrome' });
  assert.deepEqual(refused.calls.opened, [], 'no page opened once macOS said no');
});

test('Safari as the default: Chrome signed in already brings it over, nothing opens', async () => {
  const { web, calls } = machine({ browsers: { chrome: { signedIn: true } } });
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'signed-in', browser: 'Chrome', opened: false });
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.openedIn, []);
});

test('Safari as the default, Chrome not signed in: the page opens in Chrome, and the sign-in made there comes over', async () => {
  const { web, calls } = machine({ browsers: { firefox: {}, chrome: {} }, later: { chrome: 1 } });
  let told = '';
  assert.deepEqual(await web.signIn('ChatGPT', { onOpened: (name) => { told = name; } }), { status: 'signed-in', browser: 'Chrome', opened: true });
  assert.deepEqual(calls.openedIn, [['chrome', 'https://chatgpt.com/auth/login']], 'Chrome before the first listed');
  assert.deepEqual(calls.opened, [], 'never Safari');
  assert.equal(told, 'Chrome');
});

test('a browser that holds the sign-in comes before Chrome; the default browser is opened as itself', async () => {
  const brave = machine({ browsers: { chrome: {}, brave: { signedIn: true } } });
  assert.deepEqual(await brave.web.signIn('ChatGPT'), { status: 'signed-in', browser: 'Brave', opened: false });
  const own = machine({ defaultName: 'Brave Browser', browsers: { chrome: {}, brave: {} }, later: { brave: 1 } });
  assert.equal((await own.web.signIn('ChatGPT')).browser, 'Brave');
  assert.deepEqual(own.calls.opened, ['https://chatgpt.com/auth/login'], 'its own default, through openExternal');
  assert.deepEqual(own.calls.openedIn, []);
});

test('Safari only: no browser whose sign-ins can be read, and nothing opened', async () => {
  const { web, calls } = machine({ browsers: {} });
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'no-browser' });
  assert.deepEqual([calls.opened, calls.openedIn], [[], []]);
  assert.deepEqual(await web.signInQuiet('ChatGPT'), { signedIn: false, browser: '', refused: '' });
});

test('Chrome refused by macOS, Firefox signed in: the sign-in comes from Firefox', async () => {
  const { web, calls } = machine({ defaultName: 'Google Chrome', browsers: { chrome: { signedIn: true, deny: true }, firefox: { signedIn: true } } });
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'signed-in', browser: 'Firefox', opened: false });
  assert.deepEqual(calls.keychain, ['chrome'], 'macOS asked once');
  assert.deepEqual(calls.opened, []);
});

test('signInQuiet never opens a page, and one round asks macOS once per browser', async () => {
  const { web, calls } = machine({ browsers: { chrome: { signedIn: true, deny: true } } });
  const denied = new Set();
  assert.deepEqual(await web.signInQuiet('ChatGPT', { denied }), { signedIn: false, browser: '', refused: 'Chrome' });
  assert.deepEqual(await web.signInQuiet('ChatGPT', { denied }), { signedIn: false, browser: '', refused: '' });
  assert.deepEqual(calls.keychain, ['chrome']);
  assert.deepEqual([calls.opened, calls.openedIn], [[], []]);
  const fine = machine({ browsers: { chrome: { signedIn: true } } });
  assert.deepEqual(await fine.web.signInQuiet('ChatGPT'), { signedIn: true, browser: 'Chrome' });
  assert.deepEqual(await fine.web.signInQuiet('ChatGPT'), { signedIn: true, browser: '' }, 'held already');
});

test('the line before macOS is first asked for a browser\'s sign-ins, gone once it has been', async () => {
  const { web } = machine({ browsers: { chrome: {} }, later: { chrome: 1 } });
  assert.equal(web.keychainNote('ChatGPT'), 'macOS will ask to use Chrome\'s sign-ins. Choose Always Allow so it doesn\'t ask again.');
  await web.signIn('ChatGPT');
  assert.equal(web.keychainNote('ChatGPT'), '');
  assert.equal(machine({ browsers: { firefox: {} } }).web.keychainNote('ChatGPT'), '', 'Firefox needs no Keychain');
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
