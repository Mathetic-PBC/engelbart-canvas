'use strict';

// What the app window would open in a new window or tab (its setWindowOpenHandler, src/main/index.cjs): a website goes to
// a new Stage tab while a Stage is there, else to the default browser; GitHub's sign-in pages always to the default browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowOpenRoute } = require('../src/main/window-open.cjs');

test('with a Stage: a website opens in a new Stage tab', () => {
  assert.deepEqual(windowOpenRoute('https://github.com/mqo00/rope', { stage: true }), { to: 'stage', url: 'https://github.com/mqo00/rope' });
  assert.deepEqual(windowOpenRoute('http://127.0.0.1:3000/a?b=1#c', { stage: true }), { to: 'stage', url: 'http://127.0.0.1:3000/a?b=1#c' });
});

test('with no Stage (the all-projects screen): the default browser, as before', () => {
  assert.deepEqual(windowOpenRoute('https://github.com/mqo00/rope', { stage: false }), { to: 'external', url: 'https://github.com/mqo00/rope' });
  assert.deepEqual(windowOpenRoute('https://example.org/'), { to: 'external', url: 'https://example.org/' }, 'no Stage unless one says so');
});

test('GitHub sign-in pages go to the default browser even with a Stage', () => {
  for (const url of ['https://github.com/login', 'https://github.com/login/oauth/authorize?client_id=x', 'https://github.com/apps/engelbart/installations/new']) {
    assert.deepEqual(windowOpenRoute(url, { stage: true }), { to: 'external', url }, url);
  }
});

test('anything but http(s) stays closed, with or without a Stage', () => {
  for (const url of ['mailto:a@b.org', 'file:///etc/passwd', 'javascript:alert(1)', 'zoommtg://zoom.us/join', 'not a url', '', null, 'https://x.org/' + 'a'.repeat(5000)]) {
    assert.equal(windowOpenRoute(url, { stage: true }), null, String(url).slice(0, 40));
    assert.equal(windowOpenRoute(url, { stage: false }), null, String(url).slice(0, 40));
  }
});
