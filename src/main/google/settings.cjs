'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Google's downloaded Desktop app registration. Never use endpoints from this file,
// and never send the registration or account tokens through renderer IPC.
function readGoogleSettings(root, env = process.env) {
  let registration = {};
  try {
    registration = JSON.parse(fs.readFileSync(env.ENGELBART_GOOGLE_CLIENT_FILE || path.join(root, 'google-client.json'), 'utf8')).installed || {};
  } catch { /* no registration yet */ }
  const clientId = env.ENGELBART_GOOGLE_CLIENT_ID || registration.client_id || '';
  const clientSecret = env.ENGELBART_GOOGLE_CLIENT_SECRET || registration.client_secret || '';
  return {
    clientId: typeof clientId === 'string' && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) ? clientId : '',
    clientSecret: typeof clientSecret === 'string' && clientSecret.length <= 512 ? clientSecret : '',
  };
}

module.exports = { readGoogleSettings };
