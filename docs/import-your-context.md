# Import your context (2026-10-13)

The onboarding's "Connect your library" became **Import your context**: the mockup in
`Desktop/Codex Readings/Onboarding.html` built as `src/renderer/import/ImportFlow.jsx`, with the backend in
`src/main/onboarding/` and the direct mode of `src/main/connect/session.cjs`.

## Where things are

- Flow: `src/renderer/import/ImportFlow.jsx` (screens and dialogs), `import-api.js` (the preload calls), `ImportStatus.jsx`
  (Imports in progress / Your imports are done, with every sign-in or permission as a card).
- Backend: `src/main/onboarding/` — `providers.cjs` (which agent runs it), `browsers.cjs` (the keychain browser),
  `discover.cjs` (the project and tool agents), `disk-access.cjs` (Full Disk Access and the relaunch), `trace.cjs` +
  `trace-window.cjs` + `trace.html` (View ▸ Agent Trace, ⌥⌘T).
- Shared: `src/shared/import-flow.cjs` (roles, catalog, each tool's import plan).
- The standalone page: `npm run build && node scripts/build-import-mockup.mjs` →
  `design/onboarding-implemented/Onboarding.html` (mock api, Edit panel, every popup in the Popups menu, Save HTML).
- The real-app check: `npm run build && npx electron scripts/smoke-import-context.cjs` (fakes for providers, browsers,
  Full Disk Access and the agents; `ENGELBART_IMPORT_SHOTS=<dir>` saves pictures).

## Decisions

- **Provider before mode.** The provider is settled (asked only if both are subscribed) right after Import, so the
  project agent starts while the person answers the role and work questions; the tool agent starts after the keychain
  step in auto mode.
- **One project per picked project.** Run makes a project for each pick (the first opens, with the session); an
  existing folder found by discovery is used as the project's folder.
- **Library only.** What an import brings in goes on the project's list, never into a workspace's context. That was the
  "Context has too many entries" error: imports filled the context to its limit and the next link threw. The limit is
  now 2000 (`MAX_TREE_ENTRIES`) and a context over it reads leniently instead of failing the workspace.
- **A signed-out web app is a card, not left out.** In the run it waits as a held sign-in card in Imports in progress;
  Log in opens it in the keychain browser (or Engelbart's window), Skip leaves it out. Done appears only when every
  import has ended and no card is waiting.
- **One agent per tool**, each limited to the picked projects; tools outside the catalog go to one "Other tools" job.
- **Full Disk Access** relaunches by itself back to the same step once the switch is on (the flow is saved first);
  folder-by-folder access is the fallback.
- **Safari** sign-ins can't be read (its cookies are sandboxed): the keychain dialog offers another installed browser or
  signing in inside Engelbart.
- **An updating agent counts as ready** (Codex's background update no longer blocks the flow).

## Not done

- Native-browser headless agents (agents driving the person's own Chrome/Arc profile) and the Windows keychain.
- The old Connect your library picker (`ConnectLibrary.jsx`) was not reworked; the new picker replaces it in onboarding.
- `scripts/smoke-connect.cjs` walks the old Create/Connect path, which onboarding no longer shows.
