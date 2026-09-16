'use strict';

// Only the app's own page may call into main. The renderer is served from the
// privileged engelbart:// scheme, so the trusted origin is a fixed URL.

function assertTrustedRenderer(event, trustedUrl) {
  const mainFrame = event && event.sender && event.sender.mainFrame;
  if (!mainFrame || event.senderFrame !== mainFrame || typeof mainFrame.url !== 'string') {
    throw new Error('IPC rejected: untrusted renderer');
  }
  let url;
  try {
    url = new URL(mainFrame.url);
  } catch {
    throw new Error('IPC rejected: untrusted renderer');
  }
  const expected = new URL(trustedUrl);
  if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname) {
    throw new Error('IPC rejected: untrusted renderer');
  }
}

function parseExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('URL must be a bounded string');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('URL protocol must be http or https');
  }
  return parsed;
}

module.exports = { assertTrustedRenderer, parseExternalUrl };
