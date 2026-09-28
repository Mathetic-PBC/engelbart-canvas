'use strict';

/** Keep Chromium's platform and version, removing only desktop app product tokens. */
function cleanUserAgent(userAgent, appName) {
  const names = ['Electron', appName].filter(Boolean).map(name => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return String(userAgent || '').replace(new RegExp(` (?:${names.join('|')})/\\S+`, 'gi'), '');
}

function installBrowserUserAgent(app) {
  // Set this before any session or page exists. Session/tab overrides can leave
  // cross-origin iframe subresources and workers using Electron's original UA,
  // giving a sign-in verification service conflicting identities in one page.
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback, app.getName());
}

module.exports = { cleanUserAgent, installBrowserUserAgent };
