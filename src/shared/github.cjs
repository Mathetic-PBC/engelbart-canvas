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
// The cookies that say who is signed in to GitHub. When GitHub has ended that sign-in, it sends every page to /login.
const GITHUB_SESSION_COOKIES = ['user_session', '__Host-user_session_same_site'];

/** A GitHub page (not a sign-in page) redirected to GitHub's /login: GitHub no longer takes the sign-in the browser holds. */
function endedGithubSession(from, to) {
  try {
    const page = new URL(from), login = new URL(to);
    if (page.protocol !== 'https:' || !HOSTS.includes(page.hostname) || isGithubSignIn(from)) return false;
    return isGithubSignIn(to) && login.hostname === 'github.com' && login.pathname.replace(/\/+$/, '') === '/login';
  } catch { return false; }
}
module.exports = { isGithubSignIn, endedGithubSession, GITHUB_SESSION_COOKIES };
