# Google Docs through Stage

**Connections → Google Docs → Connect** opens Google Drive in Stage. Sign in there if needed. When Drive's account
and file listing become available, **Documents → Browse Google Docs…** opens a popover of links modified in the past seven days. Each title carries its provider icon.
No Google Cloud project, OAuth registration, client JSON or API token is required by this flow.
While connecting, **Open sign-in in Stage** brings the existing sign-in tab forward. Once Google is signed in,
the status changes to **Loading recent Docs…**. If that fails, **Retry loading Docs** retries the listing without
requiring another sign-in or creating another tab.

The connection uses Stage's existing persistent browser session (`persist:browser`). It doesn't copy cookies or
credentials to a second account store, inspect the sign-in form, or export them through IPC. Clicking a document
opens it in Stage with the selected Google account. The account and catalog are shared across workspaces.

## How the list is read

Main opens a temporary background browser page in the same session and visits Drive's ordinary search:
`type:document after:YYYY-MM-DD`. This uses Drive's documented modified-date search and a date seven days ago in the
local calendar. It is a calendar-date filter, not an exact 168-hour API query. The page requests English labels.

An isolated DOM reader collects file IDs, names and native Google Docs type labels from Drive's grid/list. Word
files can also appear under Drive's document search, so they are excluded explicitly. The reader scrolls through
loaded result batches, deduplicates links, and stops at the end, 1,000 documents, or a time limit. It doesn't open
individual documents or extract their bodies. Drive itself may load normal website assets such as thumbnails.
Grid view may omit modification timestamps; missing dates stay unknown, with the search establishing the range.
The sidebar preserves Drive's result order when exact dates are unavailable.
Drive may convert the search text into filter chips and clear its input on page load; the reader validates the
committed URL's query instead. A sandboxed preload answers a narrow main-process request for DOM metadata, so
unfinished preload frames cannot suspend reading the ready main document. It exposes no API to website scripts.

Refresh and five-minute updates use that temporary page without navigating or scrolling the user's visible Stage
tab. Refresh follows a Google account selected in a Drive tab. Opening Google Drive again while sign-in is pending
focuses the existing tab, retaining partially completed sign-in. After connection it can open a fresh filtered view.

## Local state and failures

`~/.engelbart/google-browser.json` stores the opt-in flag and an encrypted metadata cache using Electron safeStorage,
with owner-only permissions. The cache and Stage's normal cookie persistence allow restoration across restarts;
the browser session is checked again on startup. No OAuth access or refresh tokens are created. If encryption isn't
available, only the opt-in flag is persisted and metadata remains in memory. All sections start collapsed on app load. Saved documents appear directly under Documents; the Google Docs browser opens only when Browse is clicked.

Disconnect stops in-flight reads and deletes this catalog cache. It intentionally leaves the user signed into Google
in other Stage tabs. A cancelled or disconnected request cannot put old links back. An expired browser login clears
the catalog and asks the user to reconnect. Account changes replace the list instead of mixing accounts. Temporary
network/layout failures retain any previous list and display an error. An explicit empty Drive search clears it.
Unrecognized page markup must never be reported as a successful empty result; incomplete extraction is labeled.

This is website automation, so Google can change its layout or reject embedded sign-in. The app does not bypass
Google's sign-in restrictions. A signed-in Drive session and the filtered listing were inspected live in Stage on
2026-09-27; new-account sign-in and every Google account type are not guaranteed by that check. The earlier OAuth
implementation remains in `google/connection.cjs`, `auth.cjs` and `settings.cjs` for reference/tests, but is no longer
wired to Connections or main. Its registration file is not needed for Stage mode.

## Verification

- `npm run build`
- `node --test test/google-browser.test.cjs test/google-page-reader.test.cjs test/google-connection-ui.test.cjs test/browser.test.cjs test/connections-ui.test.cjs test/rail-ui.test.cjs`
- `npx electron scripts/smoke-google-docs.cjs`: isolated app and local Drive-shaped website; real shared HttpOnly
  session cookies, account discovery, grid/list metadata, scrolling, encrypted cache restoration, workspace/reload
  persistence, cancel/reopen, initial failure/retry, filter chips with an empty input, unfinished preload frames,
  empty/layout-error/retry, account changes, Stage links, disconnect races and expired login.
- `npx electron scripts/smoke-connections.cjs`: existing GitHub and remaining placeholder behavior.

Sources: [Google Drive search operators](https://support.google.com/drive/answer/2375114?hl=en-GB),
[Electron isolated-world execution](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptinisolatedworldworldid-scripts-usergesture).
