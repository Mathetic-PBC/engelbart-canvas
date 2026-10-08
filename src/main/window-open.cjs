'use strict';

// Where a link the app's own page would open in a new window or tab goes (its setWindowOpenHandler: a ⌘-click on a link
// nothing else handled, target=_blank, window.open). A website opens in a new Stage tab, as every website does
// (2026-09-29), while a Stage is there to take it; with none (the all-projects screen) it goes to the default browser, and
// so do GitHub's sign-in pages always, where the person's login is (shared/github.cjs). Anything but http(s) stays closed.

const { parseExternalUrl } = require('./ipc-validation.cjs');
const { isGithubSignIn } = require('../shared/github.cjs');

/** → { to: 'stage' | 'external', url } or null (nothing opens). */
function windowOpenRoute(value, { stage = false } = {}) {
  let url;
  try {
    url = parseExternalUrl(value).href;
  } catch {
    return null;
  }
  if (stage && !isGithubSignIn(url)) return { to: 'stage', url };
  return { to: 'external', url };
}

module.exports = { windowOpenRoute };
