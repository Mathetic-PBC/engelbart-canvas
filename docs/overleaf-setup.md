# Overleaf through Stage

**Connections → Overleaf → Connect** opens Overleaf in Stage and reuses its normal browser sign-in. Once signed in,
**Overleaf → Browse projects…** opens a popover listing all accessible non-trashed projects with Overleaf icons, most recently updated first. Shared and archived
projects are included; there is no seven-day filter. A project link opens in Stage.
The compact connected row uses the same options menu as GitHub and Google Docs: Open Overleaf, Refresh projects,
and Disconnect. No OAuth app registration, API key, Git integration, or automatic build is required.

## Reading the catalog

A temporary sandboxed browser window shares Stage's `persist:browser` session and visits
`https://www.overleaf.com/project`. Its isolated preload reads only allowlisted metadata from the DOM:

- `ol-user_id` and `ol-usersEmail` identify the account.
- `ol-prefetchedProjectsBlob` contains the project catalog, including projects beyond the first rendered rows.
- Only project IDs, names, modification dates, and archive flags leave the reader. Canonical links are constructed
  locally. Collaborator details and all other project fields are discarded.

The reader does not inspect credentials, copy cookies, use page JavaScript globals, call private APIs, or open and
extract project contents. Stage's shared preload can answer a narrow account-only request to detect completed
sign-in; website scripts receive no Canvas or Node API. The main process accepts replies only from the requested
page's top frame with a matching request ID. Extraction starts at DOM readiness, without waiting for unrelated
subframes or background assets to finish loading.

The blob's `totalSize` must match the number of projects supplied. Missing, malformed or partial data is an error,
never a successful empty result. The reader has a 45-second deadline and limits of 10,000 projects and 16 MB of
catalog metadata. A complete zero-project list clears old links. Refresh uses a separate temporary browser window
and never navigates or scrolls the user's visible Stage tab.

## Persistence and recovery

`<dataRoot>/overleaf-browser.json` stores the opt-in flag and an encrypted local metadata cache using Electron
safeStorage, with owner-only permissions. It contains no authentication token or copied browser cookie. If secure
storage is unavailable, metadata stays in memory and only the opt-in flag is saved.

The account and projects are shared across workspaces. All sections start collapsed on app load. Saved projects appear directly under Overleaf. Cached account projects appear when Browse is opened after restart; startup,
focus after one minute, manual refresh, and five-minute sidebar updates recheck the catalog. Temporary failures
retain previous links and show an error. An expired sign-in clears them and asks for reconnection. Switching the
Stage account replaces the catalog instead of combining accounts.

Cancel and Disconnect abort in-flight work so late replies cannot restore links. Disconnect deletes the local
catalog but leaves normal Overleaf sign-in in Stage intact. While connecting, Open sign-in in Stage reuses the
pending tab. Initial listing failures offer Retry without requiring another sign-in.

This is a website integration, so Overleaf can change the metadata or challenge embedded browsing. Such failures
are reported instead of bypassing sign-in restrictions. The live signed-in project list and metadata names were
inspected in Stage on 2026-09-27. Automated end-to-end verification uses a local Overleaf-shaped fixture; it does
not prove every live account or sign-in provider works.

## Verification

- `npm run build`
- `node --test test/overleaf.test.cjs test/google-page-reader.test.cjs test/browser.test.cjs test/rail-model.test.cjs test/rail-ui.test.cjs`
- `npx electron scripts/smoke-overleaf.cjs`: isolated app/profile and local site covering real shared HttpOnly
  cookies, sign-in and tab reuse, cancel/retry, all projects beyond visible rows, sorting, minimal metadata,
  encrypted cache restoration, workspace/reload persistence, partial/empty/error states, account changes,
  menu refresh, Stage opening, disconnect races and expired sign-in. It also checks no imports or builds occur.
- Google Docs, Connections and recording smoke tests exercise the shared Stage preload and existing controls.

Schema references from Overleaf's own source:
[project-list template](https://github.com/overleaf/overleaf/blob/main/services/web/app/views/project/list-react.pug),
[catalog controller](https://github.com/overleaf/overleaf/blob/main/services/web/app/src/Features/Project/ProjectListController.mjs),
[project-list context](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/project-list/context/project-list-context.tsx).
