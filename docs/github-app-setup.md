# GitHub sign-in

The shared **Engelbart Mathetic** GitHub App (`engelbart-mathetic`, client ID `Iv23liAZNYl96zlluMDs`) belongs to
Mathetic-PBC. It is public, with **Contents: Read-only** and **Metadata: Read-only**. Users authorize access and install
it on the repositories they choose; they never visit Developer Settings.

## User experience

Connections also supports [Google Docs](google-docs-setup.md). Overleaf and Zotero remain disabled placeholders
marked **Not available yet**, without sign-in flows, network calls, or stored account state.

**Connections → Connect** and **+ → Add from GitHub…** open sign-in in **Stage**, bringing Stage forward if Terminal
was showing. The account controls show **Finish signing in in Stage**, **Open sign-in in Stage**, and **Cancel**.
Reopening a pending attempt focuses its existing tab even after redirects, preserving the form instead of reloading
it. If the tab was closed, it opens again. There is no device code to copy for the shared registration.

After authorization the browser redirects to a temporary listener on `127.0.0.1`. Engelbart exchanges the one-use code,
verifies the account, and updates Connections and the existing repository picker. Stage shows the completion page.
**Repository access** in the GitHub **⋯** menu and **Choose repositories in Stage…** open the GitHub App installation page in Stage too.

Sign-in uses Stage's existing isolated browser session; cookies are not imported from the user's personal browser.
The remote page receives no Engelbart API. Repository listing and file access continue through GitHub's API, with
access/refresh tokens kept in main. Opening Connections or signing in does not import repositories or start sandboxes.

The sidebar's **GitHub** section shows saved workspace repositories directly, followed by **Browse repositories…**.
Browse opens a searchable popover of repositories shared with the connected GitHub App, including private and
permitted organization repositories. Names lead each result; owners appear as secondary text. Clicking a result
opens its GitHub page in Stage and closes the popover without importing it or starting a build. The catalog fetches
only while Browse is open and refreshes when the window regains focus. All main sections and source browsers start
closed on app load. Signing out clears account results while retaining saved workspace repositories.
**Refresh repositories**, **Repository access**, and **Disconnect** live in the GitHub **⋯** menu in Connections. Existing context additions, builds, and hover previews are unchanged.

## Server setup

The broker source lives in the `Mathetic-PBC/engelbart` website checkout:

- `lib/github-auth.cjs`: stateless authorization, callback and token/refresh exchange.
- `api/github/{start,callback,token}.js`: Vercel entrypoints.
- Fixed public origin: `https://engelbart.mathetic.com`.
- GitHub App callback URL: `https://engelbart.mathetic.com/api/github/callback`.
- Server-only Vercel environment variable: `GITHUB_CLIENT_SECRET`.

The new authorization-code flow requires one client secret, unlike the previous device flow. It belongs only in the
server's encrypted environment, never the desktop app, config.json, Git history, logs, or renderer. No private key is
needed. Until the secret is provisioned, the broker returns 503 `not_configured`. Deploy the broker and register the
callback before distributing the updated desktop app.

Activated on September 23, 2026: the callback is registered, the secret is provisioned as a sensitive production
variable, and the broker is deployed. Live authorization, account/installation lookup, and token refresh were verified.
People installing Engelbart do not provision secrets or register their own GitHub Apps. Mathetic maintains this endpoint.

Desktop defaults remain the public client ID and slug in `src/main/store/home.cjs`. Custom registrations use the older
device flow in Stage; existing device-flow tokens still refresh directly with GitHub without a secret.

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
- Connections: `npx electron scripts/smoke-connections.cjs` (Stage redirects and callback, fixed footer, account controls).
- Repository subsection: `npx electron scripts/smoke-repository-browser.cjs` (isolated catalog, collapsed startup/reload, nested folding, Stage links, compact layout, and account controls).
- Broker: `node --test test/github-auth.test.cjs` in the website checkout.

The headless checks exercise Stage sign-in, no code-entry UI, cancel/retry/reopen, the real loopback callback,
PKCE, tab reuse after redirects, repository picking, and account-management navigation. They do not authorize a
real GitHub account. `ENGELBART_GITHUB_BROKER`, `ENGELBART_GITHUB_WEB`, and `ENGELBART_GITHUB_API` are test overrides.
