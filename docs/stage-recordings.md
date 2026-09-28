# Local Stage recordings

Recordings capture one HTTP(S) page in Stage, not the desktop, terminal, entire
Canvas window, network trace, or agent activity. The E2B worker/build pipeline is
unchanged. Capture, storage and playback are local; there is no Supabase upload.

## Use

1. Open a page in Stage and press the **Record** circle icon. A small spinner
   changes to a muted-red **Stop** square after a full page snapshot has been saved.
   Elapsed time is available in the icon's hover label.
2. Interact normally. One recording can run at a time. Switching Stage tabs keeps
   recording the original tab; Stop remains available and its tooltip names it.
3. Press **Stop** to flush and save. The compact recordings popover opens, matching the annotations list. Stop does not
   stop the sandbox.
4. Open a row to play, pause and scrub. **×** returns to the live page without
   reloading or rerunning it. Saved recordings are also in **More → Recordings**.

The list uses the same 300px-wide, up-to-420px-tall floating panel as annotations,
with internal scrolling and Close, Escape, or outside-click dismissal. It leaves
the page at its full width behind Stage's snapshot overlay. Choosing a recording
opens the existing full-size player; Back returns to the compact list.
The heading has no count. Each row shows its recording title, source website or
repository, and duration, without a date or storage/naming metadata line.

The list shows only recordings for the current website or repository within the
project, including other routes on that site. Switching Stage tabs or websites
refreshes the collection and closes any previous playback. A blank Stage asks you
to open a website. Saved recordings survive app restarts and preview URL changes. Recording a repo preview
also saves its library/run association when the current preview host matches a
known sandbox run. It does not modify that run or library row.

## Descriptive titles

After saving, a background job generates a short title describing the observed
activity. The original page title is the immediate fallback until a descriptive
title is available. The row's secondary text identifies the source website or
repository; saving, starting another recording and playback do not wait for naming.
Opening the list also queues existing recordings that have no generated title.

The job streams the saved rrweb batches locally and resolves interaction targets
against the DOM at the time of the event, including DOM mutations and document
segments after reloads. Clicks on nested icons/text resolve to their enclosing
control. Field labels use accessible names, associated labels and placeholders.
Repeated edits become one action; repeated adjacent clicks are counted. Mouse
paths, focus/blur, scrolling, CSS/animation changes, images and canvas pixels are
excluded. Explicit dialogs and status/alert feedback shortly after an interaction
provide outcome evidence. A click on Save alone is not considered a successful
save. Canvas-only activity and poorly labeled controls may keep the page title.

The model receives at most **40 actions / 8,000 characters**. Long timelines retain
their endpoints, a spread of actions and episode boundaries/outcomes, with an
explicit omitted-action count. Node IDs, raw DOM, assets and full URLs are not
sent. Input values and contenteditable text are excluded from labels, and known
field values echoed into feedback are redacted. Visible control/feedback text and
query-free route paths are still page content; this is not a general PII detector.

The title request uses the existing configured `summarizer` provider/model through
its signed-in CLI, with a dedicated prompt, private run directory and text-only
invocation (agent, execution, browsing and connector tools disabled). **This action
summary is sent to that model provider; capture files and replay remain local.**
There is one title job at a time, a 90-second model deadline, and up to three failed
attempts with a five-minute cooldown (retried on a later list opening). A model
failure or insufficient evidence preserves the original title. Pending work can
resume on the next list opening after quit or a data-mode switch. Titles and their
generation status/statistics are stored in `meta.json`; `capture.jsonl` is never
modified by naming.

`ENGELBART_RECORDING_TITLES=off` disables naming; `ENGELBART_SUMMARIES=off` also
disables background model work for scripted/offline runs.
`ENGELBART_RECORDING_TITLES_FAKE=1` supplies a deterministic title for UI checks
without contacting a provider.

## Storage and recovery

Under the active data root (normally `~/.engelbart`):

```
recordings/<project-id>/<recording-id>/
  meta.json        # version, page/name, library owner, source kind, run ID, times, state, warnings
  capture.jsonl    # append-only batches: rrweb events, canvas bitmaps, visual assets
```

Every recording links to a library source. An unsaved website is registered locally
when recording starts; an existing site is reused. Repo previews link to their
repository. The shared `captured_sites` table preserves preview-origin aliases
across rebuilds. Older unlinked recordings are repaired on startup/listing.
The list shows each recording's source. Playback has no extra source-title/Open row; the bottom bar provides icon play/pause, a progress track, and elapsed/total time. An offline preview never prevents playback.

Metadata and captures are deliberately separate. Identifiers are validated, project access uses the existing store,
directories are private, and capture files use mode 0600. Batches are synced before
the recorder receives its acknowledgement; metadata is replaced atomically.

A same-origin reload starts a new document segment without discarding old batches.
Canvas image IDs are scoped to their segment during replay, because rrweb reuses
IDs after reloads. An ordinary tab close and app quit request a final flush.
Unexpected page loss or app termination leaves the already-written portion
recoverable as **Interrupted**. An unacknowledged in-flight tail can still be lost;
the UI does not label that capture complete. Next listing recovers complete JSONL
lines, tolerating an incomplete final line. Navigation to a different origin stops
recording, rather than silently following the user onto another site.

Limits: 8 MiB per IPC batch, 128 MiB per recording; asset fetches are bounded to
200 resources, 4 MiB per resource, 24 MiB total, three concurrent requests. Reaching
a limit ends capture and preserves the available portion with a warning.

## Capture and privacy

`recording-preload.js` is bundled with pinned `@rrweb/record` 2.1.6 and runs in the
page's sandboxed isolated world. It exposes no app API to page scripts. Capture
starts only on a main-process command; incoming batches must match the active
recording, its actual WebContents and main frame. Sequences reject duplicates.
No per-page filesystem path or arbitrary IPC handler is exposed.

Ordinary text/number inputs, textareas and contenteditable text retain their actual
values in new recordings, both in initial snapshots and subsequent edits. Passwords
(including fields marked by rrweb after a password-reveal toggle) and `.rr-mask`
content stay masked; `.rr-block` and `[data-private]` content is excluded, as are
annotation overlays. This is not a general secret detector: sensitive values typed
into ordinary fields, rendered text, URLs and images can still be saved. Recording
metadata omits URL query/hash components, but rrweb events can contain the page's
original addresses. Previously recorded masked values cannot be recovered.

DOM snapshots/mutations and interactions use rrweb. Canvas images are sampled at
approximately 3 fps, including reachable nested frames and open shadow roots.
Unchanged images are deduplicated. Audio/video are not captured. Cross-origin or
otherwise inaccessible frames, protected/oversized canvases, and asset failures
produce capture warnings. WebGL drawing buffers and closed shadow roots are not
guaranteed to replay faithfully; this is not pixel-perfect video capture.

## Durable, isolated playback

Images and fonts are embedded where readable. Asset requests run in the page's
normal security context, with CSP/CORS intact; main-process fetching is not used
to bypass access controls. CSS imported from an inaccessible external stylesheet
and unavailable/oversized resources may be missing. Therefore playback remains
available after a sandbox stops, but exact visual completeness is not guaranteed
for every site. Missing resources are not silently fetched from the live site.

The player runs on `engelbart://replay`, a different origin from the privileged
`engelbart://app` renderer, without a preload/app bridge. Its CSP prohibits network
connections and permits only embedded image/font data. The app permits frames
only from this dedicated local replay origin. Messages validate both source and
origin. rrweb's inner replay iframe has scripts disabled; `UNSAFE_replayCanvas`
remains false. Sampled canvas bitmaps use the web player's safe image-substitution
approach. Watching a click never repeats the app's underlying operation.

This isolation follows rrweb's [documented canvas replay warning](https://github.com/rrweb-io/rrweb/issues/296):
enabling unsafe canvas replay also enables scripts. That mode is not used here.

## Verification

```
npm run build
node --test test/recordings.test.cjs test/recording-actions.test.cjs test/browser.test.cjs test/interface-annotations.test.cjs test/repo-markdown.test.cjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/smoke-recordings.cjs
```

The Electron smoke test uses a disposable app/data root and local HTTP fixtures.
It covers Record/Stop, exact text/number/multiline input replay, private-field masking
(including password-reveal toggles), same-site reload, nested-frame canvases, explicit
cross-origin limitations, pinned-tab ownership, an ordinary tab close, play/pause,
real pointer scrubbing, first-frame rendering, saved assets after the source server
is shut down, zero replay network requests, script-disabled replay, separate
origin/no app API, app-renderer reload, and screenshots at normal/narrow widths.
Unit tests cover protocol validation, path/project isolation, interrupted recovery,
duplicate/untrusted batches, final-flush ordering and unresponsive/crashed pages.

No running user Canvas instance or active sandbox needs to be restarted for tests.
Run the smoke script with `--restore <reported-root>` to verify the saved fixture
in a new Electron process: library links, an empty collection on a blank Stage, site filtering, and offline playback.
