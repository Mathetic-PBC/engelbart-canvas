'use strict';
// Every website opens on the Stage (2026-09-29), GitHub's included. Signing in to GitHub is the exception: its pages
// go to the person's default browser, where their login, saved passwords and passkeys already are. GitHub API/file
// requests stay in main.
const HOSTS = ['github.com', 'www.github.com', 'gist.github.com'];
// Sign-in, sign-up and the pages that grant an app access (the GitHub App's installation, authorized OAuth apps).
const SIGN_IN = [
  /^\/(login|logout|session|sessions|signup|join|password_reset)(\/|$)/,
  /^\/login\/(oauth|device)(\/|$)/,
  /^\/auth(\/|$)/,
  /^\/apps\/[^/]+\/installations(\/|$)/,
  /^\/settings\/(installations|connections\/applications|apps\/authorizations)(\/|$)/,
];

function isGithubSignIn(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.includes(url.hostname) || url.username || url.password) return false;
    return SIGN_IN.some((path) => path.test(url.pathname));
  } catch { return false; }
}
module.exports = { isGithubSignIn };
