# Zotero connection

Open **Connections → Zotero → Connect**, then sign in inside Stage. Once the web library loads, **Papers → Browse Zotero…** opens a popover listing papers from **My Library**, newest additions first. All sections start collapsed on app load; saved papers appear directly under **Papers**, and Browse opens only when clicked. Search matches titles, authors, and publication dates. Clicking a paper opens its Zotero record in Stage. The list has no Recently added caption or Refresh button; automatic updates remain, and the connection menu provides Open Zotero, Refresh papers, and Disconnect.

The catalog includes bibliographic items and standalone PDF records. Child attachments, notes, annotations, and trashed items are excluded. This connection lists synced online library metadata; it does not download PDFs, import records into Canvas's library, or fetch paper contents for Bart. Group libraries are not included.

## Implementation

- Stage's persistent browser session owns login. The user does not register an OAuth app or paste an API key.
- The isolated preload reads the authenticated website's `zotero-web-library-config`. Zotero's existing website key is used only within that preload for read-only requests to `https://api.zotero.org`. It is never sent through Canvas IPC or saved to the metadata cache. Redirects are rejected and request URLs are constructed locally.
- A hidden page sharing Stage's session refreshes the catalog without navigating visible tabs. Requests use `/users/<id>/items/top`, 100 results per page, with `dateAdded` descending. Pagination is checked, rate limits/backoff are honored, and a changing library version requires a retry. Lists above 10,000 raw items are explicitly marked incomplete.
- Only account identity and paper metadata reach the application. The local `zotero-browser.json` cache is encrypted with Electron safeStorage; if encryption is unavailable, paper metadata stays in memory. Disconnect removes the cache and cancels in-flight work without signing other Stage tabs out.
- Expired access clears the old catalog. Transient failures retain cached papers and offer Retry. New accounts replace the catalog. Refresh occurs on reconnection, startup, window focus when stale, and every five minutes while the list is mounted.

This depends on Zotero's web-library configuration remaining compatible. Its [configuration contract](https://github.com/zotero/web-library#configuration) and [read API documentation](https://www.zotero.org/support/dev/web_api/v3/basics) informed the implementation. It is a Stage-session connector, not a separately registered OAuth integration.

## Sign-in browser verification

Stage sets its existing Chromium user agent through Electron's global `app.userAgentFallback` before sessions or pages are created. A session-only override can leave cross-origin verification iframe requests using Electron's default identity, causing inconsistent headers during a security check. A full app restart is required after this change; reloading a tab does not update the running process. See [Electron's global user-agent setting](https://www.electronjs.org/docs/latest/api/app#appuseragentfallback) and the [corresponding Electron app fix](https://github.com/simstudioai/sim/pull/8192).

`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/smoke-browser-identity.cjs` checks actual loopback HTTP headers and JavaScript identities for a page, a cross-origin iframe, images, fetch, XHR, and workers. Its optional `--session-override` argument exercises the previous setup for comparison. Live Zotero verification still needs to be completed by the user.

## Verification

`node --test test/zotero.test.cjs` checks account parsing, origin restrictions, fixed read-only endpoints, paper filtering, pagination, credentials staying inside the preload, auth/rate-limit errors, IPC sender validation, encrypted cache restoration, account replacement, and cancellation.

After `npm run build`, run `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/smoke-zotero.cjs` on macOS. It runs an isolated app with disposable local Zotero-shaped pages and verifies Stage sign-in, redirected-tab reuse, automatic population, pagination past 100 items, search, opening records, workspace switching, reloads, cache restoration, expiration, and disconnect during refresh. It does not use a real Zotero account.
