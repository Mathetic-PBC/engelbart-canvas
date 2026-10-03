'use strict';

// The main window's new-tab links (src/main/stage-links.cjs, 2026-10-02): to a new Stage tab while a workspace listens,
// to the default browser when none does and for GitHub's sign-in pages; other schemes stay closed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStageLinks } = require('../src/main/stage-links.cjs');

function setup({ delivered = true } = {}) {
  const sent = [], opened = [];
  const links = createStageLinks({
    send: (channel, payload) => { sent.push({ channel, payload }); return delivered; },
    openExternal: async (url) => { opened.push(url); },
  });
  return { links, sent, opened };
}

test('with a Stage listening, an http(s) link goes to it as a new tab, never to the default browser', () => {
  const { links, sent, opened } = setup();
  links.listen(true);
  assert.deepEqual(links.windowOpen({ url: 'https://github.com/mqo00/rope', disposition: 'background-tab' }), { action: 'deny' });
  assert.deepEqual(links.windowOpen({ url: 'http://example.org/a', disposition: 'new-window' }), { action: 'deny' });
  assert.deepEqual(sent, [
    { channel: 'stage:open-link', payload: { url: 'https://github.com/mqo00/rope', newTab: true } },
    { channel: 'stage:open-link', payload: { url: 'http://example.org/a', newTab: true } },
  ]);
  assert.deepEqual(opened, []);
});

test('with no Stage (the all-projects screen), the default browser opens it as before', () => {
  const { links, sent, opened } = setup();
  assert.deepEqual(links.windowOpen({ url: 'https://example.org/a', disposition: 'foreground-tab' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.org/a']);
  assert.deepEqual(sent, []);
});

test('a listener that stops, or a page that goes, leaves no Stage behind', () => {
  const { links, sent, opened } = setup();
  links.listen(true); links.listen(true); links.listen(false);
  assert.equal(links.listening(), true, 'one listener is still there');
  links.listen(false); links.listen(false);
  assert.equal(links.listening(), false, 'never below none');
  links.listen(true);
  links.listen(true);
  links.reset(); // did-start-loading, render-process-gone, closed
  links.windowOpen({ url: 'https://example.org/b', disposition: 'background-tab' });
  assert.deepEqual(sent, []);
  assert.deepEqual(opened, ['https://example.org/b']);
});

test('a window that cannot be told falls back to the default browser', () => {
  const { links, sent, opened } = setup({ delivered: false });
  links.listen(true);
  links.windowOpen({ url: 'https://example.org/c', disposition: 'background-tab' });
  assert.equal(sent.length, 1);
  assert.deepEqual(opened, ['https://example.org/c']);
});

test('GitHub sign-in still goes to the default browser, Stage or not', () => {
  const { links, sent, opened } = setup();
  links.listen(true);
  links.windowOpen({ url: 'https://github.com/login/oauth/authorize?client_id=x', disposition: 'foreground-tab' });
  links.windowOpen({ url: 'https://github.com/apps/engelbart/installations/new', disposition: 'background-tab' });
  assert.deepEqual(sent, []);
  assert.deepEqual(opened, ['https://github.com/login/oauth/authorize?client_id=x', 'https://github.com/apps/engelbart/installations/new']);
});

test('other schemes stay closed: neither the Stage nor the default browser', () => {
  for (const listening of [true, false]) {
    const { links, sent, opened } = setup();
    if (listening) links.listen(true);
    for (const url of ['file:///etc/passwd', 'mailto:a@b.org', 'javascript:alert(1)', 'engelbart://app/index.html', 'not a url', '']) {
      assert.deepEqual(links.windowOpen({ url, disposition: 'foreground-tab' }), { action: 'deny' });
    }
    assert.deepEqual(sent, []);
    assert.deepEqual(opened, []);
  }
});
