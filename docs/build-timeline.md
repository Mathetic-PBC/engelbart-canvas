# Canvas Build timeline

The Repo tab's **Build** overview ports `components/run-timeline.tsx` and `lib/run-steps.ts` from
`divadbaroon/engelbart-web` at `afd4af9351850b454d438082f5c8d5ac3a34a8e0`.
That version has seven setup steps plus an eighth **Live** row.

`RunTimeline.jsx` preserves the web row layout, Geist font, status icons, numbered
labels, summaries, durations, and single expanded output panel. Its Tailwind
styles are translated into scoped `run-timeline.css`; no Tailwind runtime or
web application dependencies are required. The bounded Canvas log renders
directly instead of using the web's virtualizer. The font's license is beside
the bundled font asset.

The inspector opens with **Build** selected, alongside **Logs** and **Environment**.
Logs reuses the expanded-step log renderer for chronological output from the current
attempt. Completion copy is shortened only in presentation; step outcomes, durations,
and saved events are unchanged. Repo identity, status, GitHub, and Close live in the
header; sandbox state and Stop / Retry live in the footer.

`canvas-build.js` adapts Canvas's run statuses and persisted log entries to the
web model. The worker and manager retain pipeline `kind` and `data` alongside
each message, so phase/stage grouping survives reloads. Existing message-only
logs are supported; absent details are marked unrecorded. The existing limit
of 300 events per run still applies.

Desktop adaptations to the copied model identify the current step when repair
loops revisit earlier steps, stop timers on stopped builds, and distinguish an
ongoing preview check from a failed check. Only a verified preview marks Live.

Validation: `npm run build` and `node --test test/build-steps.test.cjs
test/sandbox-worker.test.cjs test/sandbox-manager.test.cjs test/sandbox-runs.test.cjs`.
