'use strict';

// The profile picked for a sign-in, remembered in <dataRoot>/.connect/signin-profiles.json (2026-10-12): ids only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSigninProfiles } = require('../src/main/connect/signin-profiles.cjs');

test('a pick is kept per sign-in, by id, and read back; nothing else is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picks-'));
  const picks = createSigninProfiles({ dataRoot: () => root });
  assert.equal(picks.get('google.com'), null);
  assert.equal(picks.set('google.com', { browser: 'chrome', profile: 'Profile 1', email: 'me@work.example', cookie: 'x' }), true);
  assert.deepEqual(picks.get('google.com'), { browser: 'chrome', profile: 'Profile 1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.connect', 'signin-profiles.json'), 'utf8')), { 'google.com': { browser: 'chrome', profile: 'Profile 1' } });
  assert.equal(picks.set('google.com', { browser: 'chrome', profile: '../../x' }), false, 'no path in an id');
  fs.writeFileSync(path.join(root, '.connect', 'signin-profiles.json'), 'not json');
  assert.equal(picks.get('google.com'), null, 'a broken file is no pick');
});
