# GitHub sign-in

The shared **Engelbart Mathetic** GitHub App (`engelbart-mathetic`, client ID `Iv23liAZNYl96zlluMDs`) belongs to
Mathetic-PBC. It is public, with **Contents: Read-only** and **Metadata: Read-only**. Users authorize access and install
it on the repositories they choose; they never visit Developer Settings.

## User experience

**+ → Add from GitHub…** opens the user's default browser. GitHub can use that browser's existing login, saved
passwords, and passkeys. The app menu shows **Finish signing in with GitHub in your browser**, **Open browser again**,
and **Cancel**. There is no device code to copy for the shared registration.

After authorization the browser redirects to a temporary listener on `127.0.0.1`. Engelbart exchanges the one-use code,
verifies the account, brings its window forward, and shows the repository picker. The browser shows a completion page.
**Choose repositories in browser…** opens the GitHub App installation page. Returning to Engelbart refreshes the list.

GitHub website links (github.com, www.github.com, gist.github.com) open in the default browser, including links clicked
inside Stage pages and popup/redirect requests. Repository listing and file access continue through GitHub's API in
Engelbart. Website cookies remain in the external browser; they are never imported.

## Server setup

The server source lives in the `Mathetic-PBC/landing` checkout, deployed as the `landing` Vercel project (`mathetic.com`):

- `api/_lib/github-auth.cjs`: stateless authorization, callback and token/refresh exchange.
- `api/github/{start,callback,token}.js`: Vercel entrypoints for the broker.
- `api/_lib/e2b-key.cjs` and `api/e2b/key.js`: `POST /api/e2b/key`, which returns `{ e2bApiKey }` to any token GitHub's
  check-token API confirms was issued to this App, sent with `x-engelbart-client: engelbart-desktop/<version>`.
- Fixed public broker origin: `https://engelbart.mathetic.com`. Once `Mathetic-PBC/engelbart` PR #3 is merged, that site
  rewrites `/api/github/*` to `https://mathetic.com/api/github/*`, so shipped desktop builds keep working. Until then it
  still serves its own copy of the broker.
- GitHub App callback URL: `https://engelbart.mathetic.com/api/github/callback`.
- E2B key origin: `https://mathetic.com` itself (`KEY_HOST` in `src/main/github/e2b-key.cjs`); it is not rewritten.
- Server-only Vercel environment variables on the `landing` project: `GITHUB_CLIENT_SECRET` and `E2B_API_KEY`.

The new authorization-code flow requires one client secret, unlike the previous device flow. It belongs only in the
server's encrypted environment, never the desktop app, config.json, Git history, logs, or renderer. No private key is
needed. Until the secret is provisioned, the broker returns 503 `not_configured`; so does `/api/e2b/key` without
`E2B_API_KEY`. Deploy the broker and register the callback before distributing the updated desktop app.

Activated on September 23, 2026: the callback is registered, the secret is provisioned as a sensitive production
variable, and the broker is deployed. Live authorization, account/installation lookup, and token refresh were verified.
People installing Engelbart do not provision secrets or register their own GitHub Apps. Mathetic maintains this endpoint.

Desktop defaults remain the public client ID and slug in `src/main/store/home.cjs`. Custom registrations use the older
device flow in the external browser; existing device-flow tokens still refresh directly with GitHub without a secret.

## Security and lifecycle

The desktop generates a random state and PKCE verifier in main. The broker signs a short-lived state containing the
loopback port, state and PKCE challenge. Its callback redirects only to literal `127.0.0.1`, carrying a code and signed
ticket, never access/refresh tokens. Token exchange requires the matching verifier, and GitHub enforces code reuse
and expiry. The broker stores no user tokens or sessions, and refreshes tokens only on request from the desktop.

The loopback listener checks the Host, path, state and method, rejects requests with an Origin header, expires after
ten minutes, and closes on cancellation/completion. Cancelled sign-ins and stale refreshes cannot resurrect a session.
All broker responses disable caching; callback responses suppress referrers. The server does not log credentials.

Tokens are encrypted with Electron safeStorage in `~/.engelbart/github.json`; without a keychain, they remain only in
memory. Sign out deletes them. Revocation is available in GitHub Settings → Applications → Authorized GitHub Apps.

## Verification

- Desktop: `npm test` and `npm run build`.
- Headless app: `npx electron scripts/smoke-github-signin.cjs` (local service fixture, disposable app data).
- Server: `node --test test/*.test.cjs` in the `Mathetic-PBC/landing` checkout.

The headless check exercises external-browser handoff, no code-entry UI, cancel/retry/reopen, the real loopback callback,
PKCE, automatic app return, repository picking, and external installation/website navigation. It does not authorize a
real GitHub account. `ENGELBART_GITHUB_BROKER`, `ENGELBART_GITHUB_WEB`, `ENGELBART_GITHUB_API`, and
`ENGELBART_E2B_KEY_HOST` are test overrides.
