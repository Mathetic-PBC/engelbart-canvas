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
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'signed-in', browser: 'Chrome', profile: 'Me', opened: false }, 'Chrome has two profiles: the one it came from is named');
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.imports, [{ browser: 'chrome', profile: 'Default', domains: ['chatgpt.com', 'openai.com'], quiet: true }], 'the profile that has it, quietly');
  assert.equal(await web.signedIn('ChatGPT'), true);
});

test('not signed in there: the sign-in page opens in the default browser and is waited for', async () => {
  const { web, calls } = fixture({ after: 3 });
  let told = '';
  const out = await web.signIn('ChatGPT', { onOpened: (name) => { told = name; } });
  assert.deepEqual(out, { status: 'signed-in', browser: 'Chrome', profile: 'Me', opened: true });
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
  assert.deepEqual(await refused.web.signIn('ChatGPT'), { status: 'denied', browser: 'Chrome', browserId: 'chrome' });
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
  assert.deepEqual(await web.signInQuiet('ChatGPT'), { signedIn: false, browser: '', noBrowser: true });
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
  assert.deepEqual(await web.signInQuiet('ChatGPT', { denied }), { signedIn: false, browser: '', refused: 'Chrome', refusedId: 'chrome' });
  assert.deepEqual(await web.signInQuiet('ChatGPT', { denied }), { signedIn: false, browser: '', refused: 'Chrome', refusedId: 'chrome' }, 'refused before: still named, macOS not asked');
  assert.deepEqual(calls.keychain, ['chrome']);
  assert.deepEqual([calls.opened, calls.openedIn], [[], []]);
  const fine = machine({ browsers: { chrome: { signedIn: true } } });
  assert.deepEqual(await fine.web.signInQuiet('ChatGPT'), { signedIn: true, browser: 'Chrome' });
  assert.deepEqual(await fine.web.signInQuiet('ChatGPT'), { signedIn: true, browser: '' }, 'held already');
});

test('signIn when the sign-in is held already (a check at tick time brought it over): signed in, nothing imported', async () => {
  const { web, calls } = fixture();
  assert.deepEqual(await web.signInQuiet('ChatGPT'), { signedIn: true, browser: 'Chrome', profile: 'Me' });
  calls.imports.length = 0;
  calls.names = 0;
  assert.deepEqual(await web.signIn('ChatGPT'), { status: 'signed-in', browser: '', opened: false });
  assert.deepEqual([calls.imports, calls.names, calls.opened], [[], 0, []], 'no import, no look at the browser, nothing opened');
});

test('keychainTarget: the browser macOS will be asked about, until it has been', async () => {
  const { web } = machine({ browsers: { firefox: { signedIn: true }, chrome: {} } });
  assert.deepEqual(web.keychainTarget('ChatGPT'), null, 'Firefox holds it: no Keychain');
  const chrome = machine({ browsers: { chrome: { signedIn: true } } });
  assert.deepEqual(chrome.web.keychainTarget('ChatGPT'), { id: 'chrome', name: 'Chrome' });
  await chrome.web.signInQuiet('ChatGPT');
  assert.equal(chrome.web.keychainTarget('ChatGPT'), null, 'asked once this run');
  const none = machine({ browsers: { chrome: {} } });
  assert.deepEqual(none.web.keychainTarget('ChatGPT'), { id: 'chrome', name: 'Chrome' }, 'held by none: where its sign-in page opens');
  assert.equal(none.web.keychainTarget('ChatGPT', { holdersOnly: true }), null, 'holdersOnly: no browser holds it, none named');
  assert.equal(none.web.keychainNote('ChatGPT', { holdersOnly: true }), '');
});

test('the line before macOS is first asked for a browser\'s sign-ins, gone once it has been', async () => {
  const { web } = machine({ browsers: { chrome: {} }, later: { chrome: 1 } });
  assert.equal(web.keychainNote('ChatGPT'), 'macOS will ask to use Chrome\'s sign-ins. Choose Allow.');
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

/* ------------------------------------------- 2026-10-12: a copy checked before it counts, profiles picked, four browsers */

/**
 * A Mac for Google's sign-in. `browsers` { id: { profiles: [{ id, name, email, signedIn, stamp }], deny } } in the order
 * sources() lists them; `checks` the answers Google's check page gives, in turn (true, false, null for no answer);
 * `held` a copy already in Engelbart's browser. Only fakes: no real profile, Keychain or network.
 */
function google({ defaultName = 'Google Chrome', browsers = {}, checks = [], held: already = false, picks = {} } = {}) {
  const NAMES = { chrome: ['Chrome', 'chromium', 'com.google.Chrome'], brave: ['Brave', 'chromium', 'com.brave.Browser'], firefox: ['Firefox', 'firefox', 'org.mozilla.firefox'] };
  let jar = already ? [{ domain: '.google.com', name: 'SID', path: '/', secure: true }] : [];
  const calls = { checks: 0, imports: [], keychain: [], opened: [], openedIn: [], log: [], removed: 0 };
  const answers = [...checks];
  const cookieImport = {
    sources: () => Object.keys(browsers).map((id) => ({ id, name: NAMES[id][0], family: NAMES[id][1], bundle: NAMES[id][2], profiles: browsers[id].profiles.map(({ id: pid, name, email }) => ({ id: pid, name, ...(email ? { email } : {}) })) })),
    cookieNames: (id, profileId, domains) => {
      assert.deepEqual(domains, ['google.com']);
      const profile = browsers[id].profiles.find((each) => each.id === profileId);
      return profile && profile.signedIn ? [{ domain: 'google.com', name: 'SID', stamp: profile.stamp || 1 }, { domain: 'google.com', name: 'NID', stamp: 1 }] : [{ domain: 'google.com', name: 'NID', stamp: 1 }];
    },
    check: async (domain) => {
      assert.equal(domain, 'google.com');
      calls.checks += 1;
      return answers.length ? answers.shift() : true;
    },
    import: async ({ browser: id, profile, domains, quiet }) => {
      if (NAMES[id][1] === 'chromium') calls.keychain.push(id);
      if (browsers[id].deny) throw Object.assign(new Error('Keychain access was denied'), { denied: true });
      calls.imports.push({ browser: id, profile, domains, quiet });
      jar = [...jar.filter((cookie) => cookie.name !== 'SID'), { domain: '.google.com', name: 'SID', path: '/', secure: true }];
    },
  };
  const getSession = () => ({ cookies: {
    get: async ({ domain }) => jar.filter((cookie) => cookie.domain.endsWith(domain)),
    remove: async (url, name) => { assert.equal(url, 'https://google.com/'); calls.removed += 1; jar = jar.filter((cookie) => cookie.name !== name); },
  } });
  const stored = { ...picks };
  const web = createWebSignIn({
    cookieImport, defaultBrowser: () => defaultName, getSession, pollMs: 1, timeoutMs: 200, sleep: () => new Promise((resolve) => setImmediate(resolve)),
    openExternal: async (url) => { calls.opened.push(url); }, openIn: async (id, url) => { calls.openedIn.push([id, url]); },
    picks: { get: (key) => stored[key] || null, set: (key, pick) => { stored[key] = pick; } }, log: (line) => { calls.log.push(line); },
  });
  return { web, calls, stored, jar: () => jar, browsers };
}
const me = (extra = {}) => ({ id: 'Default', name: 'Me', signedIn: true, ...extra });

test('a dead copy held already: checked, copied again from Chrome, checked again and good', async () => {
  const { web, calls } = google({ held: true, checks: [false, true], browsers: { chrome: { profiles: [me()] } } });
  assert.deepEqual(await web.signInQuiet('Gmail'), { signedIn: true, browser: 'Chrome' });
  assert.equal(calls.checks, 2, 'the held copy, then the new one');
  assert.equal(calls.imports.length, 1, 'copied again, over it');
  assert.equal(calls.removed, 1, 'the dead one taken out first');
});

test('dead in Chrome too: not signed in, nothing left counting as held, and Sign in waits for Chrome to sign in anew', async () => {
  const { web, calls, jar, browsers } = google({ held: true, checks: [false, false, false, true], browsers: { chrome: { profiles: [me({ stamp: 5 })] } } });
  assert.deepEqual(await web.signInQuiet('Gmail'), { signedIn: false, browser: '', refused: '', refusedId: '' });
  assert.deepEqual(jar(), [], 'the dead copy is gone from Engelbart\'s browser');
  assert.equal(await web.signedIn('Gmail'), false);
  // Sign in: the dead copy is not copied over and over while waiting; once Chrome sets the sign-in again, it comes over.
  calls.imports.length = 0;
  let looks = 0;
  const out = await web.signIn('Gmail', { timeoutMs: Infinity, onOpened: () => {}, signal: { get aborted() { looks += 1; if (looks === 6) browsers.chrome.profiles[0].stamp = 9; return false; } } });
  assert.equal(out.status, 'signed-in');
  assert.equal(out.opened, true);
  assert.deepEqual(calls.imports.map((each) => each.profile), ['Default', 'Default'], 'once before the page opened, once after Chrome signed in again');
  assert.deepEqual(calls.opened, ['https://accounts.google.com/']);
  assert.equal(calls.checks, 4, 'Google asked once per new copy, not at every look');
});

test('the check not answering (offline, timed out): held, said, and the log notes it', async () => {
  const { web, calls } = google({ checks: [null], browsers: { chrome: { profiles: [me()] } } });
  assert.deepEqual(await web.signInQuiet('Gmail'), { signedIn: true, browser: 'Chrome', unchecked: true });
  assert.match(calls.log.join('\n'), /No answer checking the Google sign-in/);
});

test('one check for every Google app ticked within a few minutes', async () => {
  const { web, calls } = google({ browsers: { chrome: { profiles: [me()] } } });
  assert.equal((await web.signInQuiet('Gmail')).signedIn, true);
  assert.equal((await web.signInQuiet('Google Docs')).signedIn, true);
  assert.equal((await web.signInQuiet('Gemini')).signedIn, true);
  assert.equal(calls.checks, 1);
  assert.equal(calls.imports.length, 1);
});

test('an app with no check page keeps the cookie-only check', async () => {
  const { web, calls } = machine({ browsers: { chrome: { signedIn: true } } });
  assert.equal((await web.signInQuiet('ChatGPT')).signedIn, true);
  assert.equal(calls.imports.length, 1);
});

test('two profiles holding Google: both offered, with the email when Chrome has it; the pick remembered and copied first', async () => {
  const { web, calls, stored } = google({ browsers: { chrome: { profiles: [me(), { id: 'Profile 1', name: 'Work', email: 'me@work.example', signedIn: true }] } } });
  assert.deepEqual(web.holdersOf('Gmail'), [
    { browserId: 'chrome', browser: 'Chrome', profileId: 'Default', name: 'Me', email: '', keychain: true },
    { browserId: 'chrome', browser: 'Chrome', profileId: 'Profile 1', name: 'Work', email: 'me@work.example', keychain: true },
  ]);
  assert.equal(web.picked('Gmail'), null);
  assert.equal(web.choose('Gmail', { browser: 'chrome', profile: 'Profile 1' }), true);
  assert.deepEqual(stored, { 'google.com': { browser: 'chrome', profile: 'Profile 1' } }, 'ids only, per sign-in');
  assert.deepEqual(web.picked('Google Docs'), { browser: 'chrome', profile: 'Profile 1' }, 'one pick for every Google app');
  assert.deepEqual(await web.signInQuiet('Google Docs'), { signedIn: true, browser: 'Chrome', profile: 'Work' }, 'the row names the profile');
  assert.equal(calls.imports[0].profile, 'Profile 1');
});

test('a remembered pick whose copy is dead: the other profile next, and the copies made again try the pick first', async () => {
  const { web, calls } = google({ held: true, checks: [false, false, true], picks: { 'google.com': { browser: 'chrome', profile: 'Profile 1' } }, browsers: { chrome: { profiles: [me(), { id: 'Profile 1', name: 'Work', signedIn: true }] } } });
  assert.deepEqual(await web.signInQuiet('Gmail'), { signedIn: true, browser: 'Chrome', profile: 'Me' });
  assert.deepEqual(calls.imports.map((each) => each.profile), ['Profile 1', 'Default']);
});

test('one profile holding it: offered alone (no question), and the row names no profile', async () => {
  const { web } = google({ browsers: { chrome: { profiles: [me(), { id: 'Profile 1', name: 'Work', signedIn: false }] } } });
  assert.equal(web.holdersOf('Gmail').length, 1);
  assert.deepEqual(await web.signInQuiet('Gmail'), { signedIn: true, browser: 'Chrome', profile: 'Me' }, 'Chrome has two profiles, so it is named');
  const lone = google({ browsers: { chrome: { profiles: [me()] } } });
  assert.deepEqual(await lone.web.signInQuiet('Gmail'), { signedIn: true, browser: 'Chrome' }, 'a browser with one profile: no profile named');
});

test('Google\'s Sign in waits with no time limit, until it is cancelled', async () => {
  const { web, calls } = google({ browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  const controller = new AbortController();
  let told = '';
  const pending = web.signIn('Gmail', { timeoutMs: Infinity, signal: controller.signal, onOpened: (name) => { told = name; } });
  await new Promise((resolve) => { setTimeout(resolve, 300); }); // longer than the fixture's 200 ms timeout
  controller.abort();
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(told, 'Chrome');
  assert.deepEqual(calls.opened, ['https://accounts.google.com/']);
});

/* The four browsers to get right (2026-10-12): Chrome, Brave, Firefox and Safari. */

test('Chrome as the default: its sign-in page opens there, macOS asked about Chrome', async () => {
  const { web, calls, browsers } = google({ browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] }, firefox: { profiles: [{ id: 'x.default', name: 'default', signedIn: false }] } } });
  assert.equal(web.opensIn('Gmail'), 'Chrome');
  assert.deepEqual(web.keychainTarget('Gmail'), { id: 'chrome', name: 'Chrome' });
  let looks = 0;
  const out = await web.signIn('Gmail', { signal: { get aborted() { looks += 1; if (looks === 3) browsers.chrome.profiles[0].signedIn = true; return false; } } });
  assert.deepEqual(out, { status: 'signed-in', browser: 'Chrome', opened: true });
  assert.deepEqual([calls.opened, calls.openedIn, calls.keychain], [['https://accounts.google.com/'], [], ['chrome']]);
});

test('Brave as the default: it opens and is read, Chrome left alone', async () => {
  const { web, calls, browsers } = google({ defaultName: 'Brave Browser', browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] }, brave: { profiles: [{ id: 'Default', name: 'Personal', signedIn: false }] } } });
  assert.equal(web.opensIn('Gmail'), 'Brave');
  assert.deepEqual(web.keychainTarget('Gmail'), { id: 'brave', name: 'Brave' });
  let looks = 0;
  const out = await web.signIn('Gmail', { signal: { get aborted() { looks += 1; if (looks === 3) browsers.brave.profiles[0].signedIn = true; return false; } } });
  assert.deepEqual(out, { status: 'signed-in', browser: 'Brave', opened: true });
  assert.deepEqual([calls.opened, calls.keychain], [['https://accounts.google.com/'], ['brave']]);
});

test('Firefox as the default: no Keychain, so nothing to ask before, and its profiles offered by name with no email', async () => {
  const { web, calls } = google({ defaultName: 'Firefox', browsers: { chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] }, firefox: { profiles: [{ id: 'a.default-release', name: 'default-release', signedIn: true }, { id: 'b.work', name: 'Work stuff', signedIn: true }] } } });
  assert.equal(web.opensIn('Gmail'), 'Firefox');
  assert.equal(web.keychainTarget('Gmail'), null);
  assert.equal(web.keychainNote('Gmail'), '');
  assert.deepEqual(web.holdersOf('Gmail').map(({ name, email, keychain }) => [name, email, keychain]), [['default-release', '', false], ['Work stuff', '', false]]);
  assert.deepEqual(await web.signIn('Gmail'), { status: 'signed-in', browser: 'Firefox', profile: 'default-release', opened: false });
  assert.deepEqual(calls.keychain, []);
});

test('Safari as the default with Chrome installed: Sign in opens in Chrome, never Safari', async () => {
  const { web, calls } = google({ defaultName: 'Safari', browsers: { firefox: { profiles: [{ id: 'a', name: 'default', signedIn: false }] }, brave: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] }, chrome: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  assert.equal(web.opensIn('Gmail'), 'Chrome');
  let told = '';
  assert.equal((await web.signIn('Gmail', { onOpened: (name) => { told = name; } })).status, 'timeout');
  assert.deepEqual([calls.opened, calls.openedIn, told], [[], [['chrome', 'https://accounts.google.com/']], 'Chrome']);
  const brave = google({ defaultName: 'Safari', browsers: { firefox: { profiles: [{ id: 'a', name: 'default', signedIn: false }] }, brave: { profiles: [{ id: 'Default', name: 'Me', signedIn: false }] } } });
  assert.equal(brave.web.opensIn('Gmail'), 'Brave', 'no Chrome: Brave before Firefox');
});

test('Safari as the default with only Firefox: Sign in opens in Firefox, and macOS is never asked', async () => {
  const { web, calls } = google({ defaultName: 'Safari', browsers: { firefox: { profiles: [{ id: 'a', name: 'default', signedIn: false }] } } });
  assert.equal(web.opensIn('Gmail'), 'Firefox');
  assert.equal(web.keychainNote('Gmail'), '');
  assert.equal((await web.signIn('Gmail')).status, 'timeout');
  assert.deepEqual([calls.openedIn, calls.keychain], [[['firefox', 'https://accounts.google.com/']], []]);
});

test('Safari only: nothing to read or open, and the browsers named are Chrome, Brave or Firefox', async () => {
  const { web, calls } = google({ defaultName: 'Safari', browsers: {} });
  assert.equal(web.opensIn('Gmail'), '');
  assert.deepEqual(await web.signIn('Gmail', { timeoutMs: Infinity }), { status: 'no-browser' });
  assert.deepEqual([calls.opened, calls.openedIn], [[], []]);
  assert.equal(require('../src/main/connect/web-signin.cjs').READABLE_NAMES, 'Chrome, Brave or Firefox');
});
