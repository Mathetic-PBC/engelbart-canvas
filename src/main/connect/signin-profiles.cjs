'use strict';

// Connect your library (2026-10-12): the browser profile the person picked for a sign-in, when more than one holds it
// (two Chrome profiles, or Chrome and Brave), kept in <dataRoot>/.connect/signin-profiles.json so they are asked once:
// { "google.com": { "browser": "chrome", "profile": "Profile 1" } }. Ids only, never a cookie or an email.
// ./web-signin.cjs tries the remembered profile first.

const nodeFs = require('node:fs');
const path = require('node:path');

const FILE = 'signin-profiles.json';
const ID = /^[\w .@()-]{1,120}$/;

/** `dataRoot()` where Engelbart keeps its data → { get(key), set(key, { browser, profile }) }. */
function createSigninProfiles({ dataRoot, fs = nodeFs }) {
  const file = () => path.join(dataRoot(), '.connect', FILE);
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  }
  function get(key) {
    const pick = read()[key];
    return pick && ID.test(String(pick.browser)) && ID.test(String(pick.profile)) ? { browser: String(pick.browser), profile: String(pick.profile) } : null;
  }
  function set(key, pick) {
    if (!ID.test(String(key)) || !pick || !ID.test(String(pick.browser)) || !ID.test(String(pick.profile))) return false;
    const all = read();
    all[key] = { browser: String(pick.browser), profile: String(pick.profile) };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), `${JSON.stringify(all, null, 2)}\n`);
    return true;
  }
  return { get, set };
}

module.exports = { createSigninProfiles, FILE };
