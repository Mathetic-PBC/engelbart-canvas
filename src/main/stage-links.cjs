'use strict';

// A link the app's own window asks to open in a new tab or window (a ⌘-click Chromium follows, a window.open) opens in a
// new Stage tab while a workspace shows the Stage (2026-10-02), as every website does; with no Stage (the all-projects
// screen), and for GitHub's sign-in pages, it goes to the default browser as before. The workspace says it is there by
// listening (preload's onStageOpenLink): each listener counts once, and a page that goes takes its listeners with it.

const { isGithubSignIn } = require('../shared/github.cjs');
const { parseExternalUrl } = require('./ipc-validation.cjs');

/** send(channel, payload) → whether it was delivered; openExternal(url) → a promise. */
function createStageLinks({ send, openExternal }) {
  let listening = 0;

  const listen = (on) => { listening = on ? listening + 1 : Math.max(0, listening - 1); };
  const reset = () => { listening = 0; };

  /** The main window's setWindowOpenHandler: never a window of its own. */
  function windowOpen({ url }) {
    let parsed;
    try { parsed = parseExternalUrl(url); } catch { return { action: 'deny' }; } // untrusted schemes remain closed
    const web = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (web && listening > 0 && !isGithubSignIn(parsed.href) && send('stage:open-link', { url: parsed.href, newTab: true })) return { action: 'deny' };
    void Promise.resolve(openExternal(parsed.href)).catch(() => {});
    return { action: 'deny' };
  }

  return { listen, reset, windowOpen, listening: () => listening > 0 };
}

module.exports = { createStageLinks };
