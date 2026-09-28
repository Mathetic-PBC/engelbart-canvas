Engelbart feature flows

Current workspace implementation; reviewed 2026-09-27. Illustrative values; no proposed redesign.

Starts at 2 to follow the supplied GitHub URL / sandbox flow.

Conventions:

- Before/After snapshots show relevant fields only; these are projections, not complete replacement records.
- Each feature is an independent example; alternatives branch from the named step.
- Wrappers such as recording, bundle, preview, document, status, catalog and session label examples; they are not SQL tables.
- Requests use public preload method names with positional args; these envelopes document calls, not a new HTTP API.
- Null file/object means absent; empty arrays mean no entries. Sample paths and IDs are placeholders.
- Only library, captured_sites, sandbox_runs and notes refer to SQL tables here.
- JSONL stores one complete JSON object per line; it is not one JSON document.

2.) Behavior: Record a Stage page

Storage: `<dataRoot>/recordings/<projectId>/<recordingId>/meta.json`; `<dataRoot>/recordings/<projectId>/<recordingId>/capture.jsonl`; `library.pglite: library, captured_sites`

- Example: existing repository preview; libraryId and runId already exist.
- recording = meta.json; activeRecording = transient controller state.
- Recording timestamps: Unix milliseconds.

2.1.) Decision: Can recording start?

Cases:

```json
[
  {
    "when": "Another recording is active",
    "then": "Reject; stop the existing recording first."
  },
  {
    "when": "Page loading, closed, or not HTTP(S)",
    "then": "Reject."
  },
  {
    "when": "Loaded HTTP(S) page; no active recording",
    "then": "Resolve source; create capture files."
  }
]
```

2.2.) Event: Resolve the capture source

Cases:

```json
[
  {
    "when": "Known sandbox preview",
    "then": "Use repository library.id and sandbox_runs.id."
  },
  {
    "when": "Known website",
    "then": "Reuse library.id; sourceKind = site."
  },
  {
    "when": "Unsaved website",
    "then": "Create website library row; sourceKind = site; runId = null."
  }
]
```

Before:

```json
{
  "captured_sites": []
}
```

After:

```json
{
  "captured_sites": [
    {
      "site": "https://example-preview-host.example",
      "library_id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "kind": "repo"
    }
  ]
}
```

2.3.) Event: Create recording metadata and empty capture file

Request:

```json
{
  "method": "recordingStart",
  "args": [
    "stage-tab-1",
    "11111111-1111-4111-8111-111111111111"
  ]
}
```

Before:

```json
{
  "recording": null,
  "activeRecording": null
}
```

After:

```json
{
  "recording": {
    "version": 1,
    "id": "33333333-3333-4333-8333-333333333333",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "name": "My app",
    "url": "https://example-preview-host.example/settings",
    "libraryId": "a27b6e09-f342-4f91-8c58-64ba719312ef",
    "sourceKind": "repo",
    "runId": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
    "status": "starting",
    "createdAt": 1790524800000,
    "startedAt": null,
    "stoppedAt": null,
    "durationMs": 0,
    "bytes": 0,
    "events": 0,
    "snapshots": 0,
    "frames": 0,
    "warnings": []
  },
  "activeRecording": "33333333-3333-4333-8333-333333333333"
}
```

- Create capture.jsonl; send browser:record-command with type = start.

2.4.) Event: Save first full snapshot; acknowledge batch

Before:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "starting",
    "startedAt": null,
    "events": 0,
    "snapshots": 0
  }
}
```

After:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "recording",
    "startedAt": 1790524800100,
    "events": 2,
    "snapshots": 1
  }
}
```

- Append one JSON object per capture.jsonl line; sync before acknowledgement.
- Update bytes, durationMs, frames and warnings from saved batches.
- Same-origin reload: new documentId; retain earlier batches.
- Stage tab switch: continue recording the original tab.

2.5.) Event: Stop and save recording

Request:

```json
{
  "method": "recordingStop",
  "args": []
}
```

Before:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "recording",
    "stoppedAt": null
  },
  "activeRecording": "33333333-3333-4333-8333-333333333333"
}
```

After:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "saved",
    "stoppedAt": 1790524830000,
    "durationMs": 29800,
    "warnings": []
  },
  "activeRecording": null
}
```

- Flush final batch; close capture file; open recordings list.
- Sandbox run unchanged.

2.6.) Alternative: Capture interrupted

Branch from: 2.4

Before:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "recording",
    "stoppedAt": null,
    "warnings": []
  }
}
```

After:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "status": "interrupted",
    "stoppedAt": 1790524830000,
    "warnings": [
      "Recording stopped when the tab moved to a different site."
    ]
  }
}
```

- Other causes: page crash, capture limit, missing final flush, missing initial snapshot.
- App restart: recover complete JSONL lines; ignore an incomplete final line.

2.7.) Event: Generate descriptive title after saving

Branch from: 2.5

Before:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "My app"
  }
}
```

After:

```json
{
  "recording": {
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "Updating account settings",
    "pageName": "My app",
    "title": {
      "version": 1,
      "status": "ready",
      "attempts": 1,
      "updatedAt": 1790524860000,
      "stats": {
        "rawEvents": 80,
        "actions": 3,
        "included": 3,
        "omitted": 0
      }
    }
  }
}
```

- Queue after save or list opening; summarize observed actions through configured model.
- Title states: pending, ready, fallback, failed.
- No usable title: retain page title; capture.jsonl unchanged.

2.8.) Event: Open saved playback

Request:

```json
{
  "method": "recordingRead",
  "args": [
    "11111111-1111-4111-8111-111111111111",
    "33333333-3333-4333-8333-333333333333"
  ]
}
```

- Read metadata and batches; replay locally at engelbart://replay.
- Play, pause, scrub; close player to return to live page.
- No replay network requests; original page actions are not executed.
- List filtered by current project and source; capture file unchanged.

Sources: [recordings.cjs](../src/main/store/recordings.cjs), [recordings.cjs](../src/main/browser/recordings.cjs), [recording-titles.cjs](../src/main/browser/recording-titles.cjs), [captured-sites.cjs](../src/main/store/captured-sites.cjs)

3.) Behavior: Annotate a Stage element

Storage: `<dataRoot>/annotations/interface/<sha256(projectId + newline + scope)>.json`; `library.pglite: library, captured_sites`

- bundle = saved JSON file; picker = transient UI state.
- Example: same repository preview as recording flow.

3.1.) Event: Enter annotation mode; select element

Before:

```json
{
  "picker": {
    "active": false,
    "selected": null
  }
}
```

After:

```json
{
  "picker": {
    "active": true,
    "selected": "button#save-settings"
  }
}
```

- Intercept selection click; open composer; keep page width.
- Capture anchor; no saved annotation yet.

3.2.) Decision: Choose composer action

Cases:

```json
[
  {
    "when": "Add note",
    "then": "Continue to 3.3."
  },
  {
    "when": "Ask Bart",
    "then": "Send text and element/page context to workspace Bart; no implicit saved note."
  },
  {
    "when": "Cancel or Escape",
    "then": "Discard draft; clear selection; restore normal interaction."
  },
  {
    "when": "Save or Bart handoff fails",
    "then": "Keep draft; display error."
  }
]
```

3.3.) Event: Add note

Request:

```json
{
  "method": "createInterfaceAnnotation",
  "args": [
    {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "url": "https://example-preview-host.example/settings"
    },
    {
      "body": "Make this button easier to find.",
      "anchor": {
        "element": {
          "tag": "button",
          "selector": "#save-settings",
          "id": "save-settings",
          "role": "button",
          "text": "Save settings",
          "classes": [
            "primary"
          ]
        },
        "ancestors": [],
        "frames": [],
        "route": "/settings",
        "documentTitle": "My app"
      }
    }
  ]
}
```

Before:

```json
{
  "bundle": null
}
```

After:

```json
{
  "bundle": {
    "version": 1,
    "projectId": "11111111-1111-4111-8111-111111111111",
    "scope": "repo:a27b6e09-f342-4f91-8c58-64ba719312ef",
    "libraryId": "a27b6e09-f342-4f91-8c58-64ba719312ef",
    "notes": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "body": "Make this button easier to find.",
        "anchor": {
          "element": {
            "tag": "button",
            "selector": "#save-settings",
            "id": "save-settings",
            "role": "button",
            "text": "Save settings",
            "classes": [
              "primary"
            ]
          },
          "ancestors": [],
          "frames": [],
          "route": "/settings",
          "documentTitle": "My app"
        },
        "url": "https://example-preview-host.example/settings",
        "libraryId": "a27b6e09-f342-4f91-8c58-64ba719312ef",
        "runId": "7e41c6b2-580a-4bda-9d9f-82f094312abc",
        "createdAt": "2026-09-27T16:00:00.000Z",
        "updatedAt": "2026-09-27T16:00:00.000Z"
      }
    ]
  }
}
```

- Resolve or create library source; record captured_sites alias.
- Validate text and anchor route; write bundle atomically.
- Close composer; clear selection.

3.4.) Event: Open Annotations; locate saved target

Cases:

```json
[
  {
    "when": "Exact target",
    "then": "Highlight; open note popover."
  },
  {
    "when": "Closest match",
    "then": "Highlight candidate; show matching feedback."
  },
  {
    "when": "Missing target or different route",
    "then": "Keep note readable; offer Open page when available."
  }
]
```

- Filter by project and source; include other routes on the same source.
- Latest ready repository preview supplies sourceUrl; retain original note.url.
- Bundle unchanged.

3.5.) Event: Edit note

Before:

```json
{
  "notes": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "body": "Make this button easier to find.",
      "updatedAt": "2026-09-27T16:00:00.000Z"
    }
  ]
}
```

After:

```json
{
  "notes": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "body": "Move this button above the form.",
      "updatedAt": "2026-09-27T16:00:01.000Z"
    }
  ]
}
```

- Preserve id, createdAt, anchor and capture URL.

3.6.) Event: Ask Bart about a saved note

- Send note text and page/anchor context into the workspace conversation.
- Saved annotation unchanged; continue with 6 or Builder Bart flow 5.

3.7.) Event: Delete note

Before:

```json
{
  "notes": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "body": "Move this button above the form."
    }
  ]
}
```

After:

```json
{
  "notes": []
}
```

- Retain library source and other annotations.

Sources: [interface-annotations.cjs](../src/main/store/interface-annotations.cjs), [interface-annotations.cjs](../src/shared/interface-annotations.cjs), [InterfaceAnnotations.jsx](../src/renderer/workspace/InterfaceAnnotations.jsx)

4.) Behavior: Connect accounts; browse provider catalogs

Storage: `<dataRoot>/github.json`; `<dataRoot>/google-browser.json`; `<dataRoot>/overleaf-browser.json`; `<dataRoot>/zotero-browser.json`; `Stage session: persist:browser`

- Account state shared across workspaces; status and catalog examples are public responses.
- Credentials/encrypted payloads omitted; no connections SQL table.
- Opening catalog links in Stage leaves library and sandbox_runs unchanged.

4.1.1.) Event: GitHub: start sign-in

Before:

```json
{
  "github": {
    "connected": false,
    "pending": null
  }
}
```

After:

```json
{
  "github": {
    "connected": false,
    "pending": {
      "kind": "browser"
    }
  }
}
```

- Open authorization in Stage; reuse pending sign-in tab.
- Shared GitHub App: browser authorization and loopback callback.
- Custom registration may use device code.

4.1.2.) Event: GitHub: verify account; store encrypted tokens

Before:

```json
{
  "github": {
    "configured": true,
    "connected": false,
    "login": "",
    "name": "",
    "avatarUrl": "",
    "persisted": true,
    "pending": {
      "kind": "browser"
    },
    "error": "",
    "installUrl": "https://github.com/apps/engelbart-mathetic/installations/new"
  }
}
```

After:

```json
{
  "github": {
    "configured": true,
    "connected": true,
    "login": "example-user",
    "name": "Example User",
    "avatarUrl": "https://avatars.githubusercontent.com/u/123456?v=4",
    "persisted": true,
    "pending": null,
    "error": "",
    "installUrl": "https://github.com/apps/engelbart-mathetic/installations/new"
  }
}
```

- Complete callback/code exchange; clear pending sign-in.
- Secure storage unavailable: persisted = false; tokens remain in memory.

4.1.3.) Event: GitHub: browse authorized repositories

Before:

```json
{
  "catalog": {
    "repos": []
  }
}
```

After:

```json
{
  "catalog": {
    "repos": [
      {
        "id": "123456789",
        "fullName": "owner/my-app",
        "url": "https://github.com/owner/my-app",
        "private": true
      }
    ]
  }
}
```

- List accessible GitHub App installation repositories.
- Select result: open GitHub page in Stage.
- Explicitly save/add repository to enter the library/build flow.

4.1.4.) Event: GitHub: disconnect

Before:

```json
{
  "github": {
    "connected": true,
    "login": "example-user",
    "pending": null
  }
}
```

After:

```json
{
  "github": {
    "connected": false,
    "login": "",
    "pending": null
  }
}
```

- Remove stored connection; cancel pending authorization; clear account catalog.
- Retain saved library repositories and existing sandbox runs.

4.2.1.) Event: Google Docs: open Drive sign-in in Stage

Before:

```json
{
  "google": {
    "configured": true,
    "method": "stage",
    "connected": false,
    "account": null,
    "persisted": false,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 0
  }
}
```

After:

```json
{
  "google": {
    "configured": true,
    "method": "stage",
    "connected": false,
    "account": null,
    "persisted": false,
    "pending": {
      "kind": "stage"
    },
    "loading": false,
    "error": "",
    "updatedAt": 0
  }
}
```

- Reuse Stage browser session; no OAuth registration required.

4.2.2.) Event: Google Docs: read recent document catalog

Before:

```json
{
  "google": {
    "connected": false,
    "account": null
  },
  "catalog": null
}
```

After:

```json
{
  "google": {
    "configured": true,
    "method": "stage",
    "connected": true,
    "account": {
      "id": "reader@example.com",
      "email": "reader@example.com",
      "name": "Example Reader"
    },
    "persisted": true,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 1790524800000
  },
  "catalog": {
    "accountId": "reader@example.com",
    "since": "2026-09-20",
    "documents": [
      {
        "id": "example-document-id",
        "name": "Research notes",
        "url": "https://docs.google.com/document/d/example-document-id/edit?authuser=reader%40example.com",
        "modifiedTime": null
      }
    ],
    "incomplete": false,
    "updatedAt": 1790524800000,
    "dateFiltered": true
  }
}
```

- Filter: native Google Docs modified after the date seven calendar days earlier.
- Unknown modification timestamp: null.
- Cache metadata; document bodies are not fetched.
- Select document: open its URL in Stage.

4.3.1.) Event: Overleaf: connect and read project catalog

Before:

```json
{
  "overleaf": {
    "configured": true,
    "method": "stage",
    "connected": false,
    "account": null,
    "persisted": false,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 0
  },
  "catalog": null
}
```

After:

```json
{
  "overleaf": {
    "configured": true,
    "method": "stage",
    "connected": true,
    "account": {
      "id": "64b000000000000000000001",
      "email": "reader@example.com"
    },
    "persisted": true,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 1790524800000
  },
  "catalog": {
    "accountId": "64b000000000000000000001",
    "projects": [
      {
        "id": "64b000000000000000000002",
        "name": "Research paper",
        "modifiedTime": "2026-09-27T16:00:00.000Z",
        "archived": false,
        "url": "https://www.overleaf.com/project/64b000000000000000000002"
      }
    ],
    "updatedAt": 1790524800000
  }
}
```

- Open Overleaf in Stage; pending.kind = stage until signed in and loaded.
- Include accessible non-trashed projects, including shared and archived; newest first.
- No seven-day filter; no project-body extraction.
- Select project: open in Stage.

4.4.1.) Event: Zotero: connect and read personal library

Before:

```json
{
  "zotero": {
    "configured": true,
    "method": "stage",
    "connected": false,
    "account": null,
    "persisted": false,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 0
  },
  "catalog": null
}
```

After:

```json
{
  "zotero": {
    "configured": true,
    "method": "stage",
    "connected": true,
    "account": {
      "id": "1234567",
      "name": "example-reader"
    },
    "persisted": true,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 1790524800000
  },
  "catalog": {
    "accountId": "1234567",
    "papers": [
      {
        "id": "ABCD1234",
        "name": "Example research paper",
        "authors": "Example Author",
        "date": "2026",
        "itemType": "journalArticle",
        "dateAdded": "2026-09-27T16:00:00.000Z",
        "url": "https://www.zotero.org/example-reader/items/ABCD1234/library"
      }
    ],
    "incomplete": false,
    "updatedAt": 1790524800000
  }
}
```

- Open Zotero in Stage; pending.kind = stage until signed in and loaded.
- Read personal top-level items; exclude notes, annotations and child attachments.
- Include standalone PDFs; group libraries excluded.
- Select paper: open Zotero item in Stage; no automatic PDF download.

4.5.) Decision: Google Docs / Overleaf / Zotero: refresh result

Cases:

```json
[
  {
    "when": "Complete catalog",
    "then": "Replace cached catalog; update updatedAt."
  },
  {
    "when": "Confirmed empty catalog",
    "then": "Clear previous entries."
  },
  {
    "when": "Expired login",
    "then": "Clear account/catalog; display reconnect error."
  },
  {
    "when": "Temporary network or layout failure",
    "then": "Keep previous catalog; display error and Retry."
  },
  {
    "when": "Different authenticated account",
    "then": "Replace account/catalog; do not merge accounts."
  },
  {
    "when": "Secure storage unavailable",
    "then": "Persist opt-in only; metadata remains in memory."
  }
]
```

4.6.) Event: Google Docs / Overleaf / Zotero: disconnect

Before:

```json
{
  "status": {
    "configured": true,
    "method": "stage",
    "connected": true,
    "account": {
      "id": "reader@example.com",
      "email": "reader@example.com",
      "name": "Example Reader"
    },
    "persisted": true,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 1790524800000
  },
  "catalog": {
    "documents": [
      {
        "id": "example-document-id",
        "name": "Research notes",
        "url": "https://docs.google.com/document/d/example-document-id/edit?authuser=reader%40example.com",
        "modifiedTime": null
      }
    ]
  }
}
```

After:

```json
{
  "status": {
    "configured": true,
    "method": "stage",
    "connected": false,
    "account": null,
    "persisted": false,
    "pending": null,
    "loading": false,
    "error": "",
    "updatedAt": 0
  },
  "catalog": null
}
```

- Example shown: Google Docs; same lifecycle for Overleaf and Zotero.
- Cancel in-flight reads; delete provider cache; prevent late responses restoring it.
- Keep provider sign-in in other Stage tabs; retain explicitly saved library items.

4.7.) Event: Cancel pending connection

- Abort pending work; clear pending state.
- Reopening a still-pending sign-in focuses its Stage tab.
- Saved library rows unchanged.

Sources: [connection.cjs](../src/main/github/connection.cjs), [browser-auth.cjs](../src/main/github/browser-auth.cjs), [browser-connection.cjs](../src/main/google/browser-connection.cjs), [browser-connection.cjs](../src/main/overleaf/browser-connection.cjs), [browser-connection.cjs](../src/main/zotero/browser-connection.cjs)

5.) Behavior: Build or update an interface through @bart

Storage: `<dataRoot>/<project>/<workspace>/workspace.md`; `<dataRoot>/.local-apps/<projectId>/<workspaceId>/state.json`; `<dataRoot>/.local-apps/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/app/engelbart-preview.json`; `library.pglite: library`; `<project>/project.json: sidebarContext`

- Example: @bart Make a timer using this workspace context.
- preview = persisted local state projection; document.text = Markdown file contents.
- One app folder per workspace; later approved builds update it.
- Local preview uses state.json; it does not create a sandbox_runs row.

5.1.) Event: Submit @bart request

Request:

```json
{
  "method": "askBart",
  "args": [
    "11111111-1111-4111-8111-111111111111",
    {
      "askId": "77777777-7777-4777-8777-777777777777",
      "ref": {
        "kind": "workspace",
        "workspaceId": "22222222-2222-4222-8222-222222222222"
      },
      "workspaceId": "22222222-2222-4222-8222-222222222222",
      "text": "Make a timer using this workspace context.",
      "turns": []
    }
  ]
}
```

Before:

```json
{
  "document": {
    "text": "@bart Make a timer using this workspace context."
  }
}
```

After:

```json
{
  "document": {
    "text": "@bart Make a timer using this workspace context.\nbart~> 77777777-7777-4777-8777-777777777777"
  }
}
```

5.2.) Decision: Route request

Cases:

```json
[
  {
    "when": "Factual question or design discussion",
    "then": "Read-only answer; continue to flow 6."
  },
  {
    "when": "Create/update working browser interface",
    "then": "Bart returns build proposal; start planning."
  },
  {
    "when": "Explicit --build flag",
    "then": "Start planning directly."
  }
]
```

Response:

```json
{
  "buildProposal": {
    "name": "Timer",
    "request": "Build a timer with start, pause and reset using the workspace context."
  }
}
```

- Model/effort flags select coding agent.
- Proposal is not build approval.

5.3.) Event: Claude prepares read-only plan

Before:

```json
{
  "preview": null
}
```

After:

```json
{
  "preview": {
    "id": "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    "projectId": "11111111-1111-4111-8111-111111111111",
    "workspaceId": "22222222-2222-4222-8222-222222222222",
    "directory": "<dataRoot>/.local-apps/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/app",
    "name": "Timer",
    "status": "planning",
    "runId": "99999999-9999-4999-8999-999999999999",
    "askId": "77777777-7777-4777-8777-777777777777",
    "startedAt": "2026-09-27T16:00:00.000Z",
    "readyAt": null,
    "url": null,
    "recipe": null,
    "libraryId": null,
    "plan": null,
    "approval": null,
    "error": null
  }
}
```

- Read workspace, current note, mentioned notes and catalog.
- Require Claude Code sign-in; planning failure becomes failed.
- No coding, Git initialization, installs or server launch before approval.

5.4.) Event: Show plan in Notifications; wait for approval

Before:

```json
{
  "preview": {
    "status": "planning",
    "plan": null,
    "approval": null
  }
}
```

After:

```json
{
  "preview": {
    "status": "confirming",
    "plan": {
      "name": "Timer",
      "summary": "Build a timer with start, pause and reset.",
      "steps": [
        {
          "id": "step-1",
          "phase": "code",
          "title": "Create timer controls",
          "instructions": "Implement start, pause and reset; write the launch manifest.",
          "status": "pending"
        },
        {
          "id": "step-2",
          "phase": "install",
          "title": "Check dependencies",
          "instructions": "Install only if required by the manifest.",
          "status": "pending"
        },
        {
          "id": "step-3",
          "phase": "compile",
          "title": "Prepare timer app",
          "instructions": "Compile only if required by the manifest.",
          "status": "pending"
        },
        {
          "id": "step-4",
          "phase": "start",
          "title": "Start timer server",
          "instructions": "Run the foreground server on the allocated loopback port.",
          "status": "pending"
        },
        {
          "id": "step-5",
          "phase": "verify",
          "title": "Verify rendered timer",
          "instructions": "Confirm that the timer interface renders successfully.",
          "status": "pending"
        }
      ],
      "by": "Claude",
      "model": null
    },
    "approval": {
      "id": "88888888-8888-4888-8888-888888888888",
      "workspaceId": "22222222-2222-4222-8222-222222222222",
      "kind": "build",
      "message": "Build a timer with start, pause and reset.",
      "label": "Build locally"
    }
  }
}
```

- One to four coding steps, then install, compile, start and verify.
- Plan review offers Build locally and Not now.

5.5.) Decision: User approves this build?

Cases:

```json
[
  {
    "when": "Build locally",
    "then": "Consume one-time approval; continue to 5.6."
  },
  {
    "when": "Not now",
    "then": "Restore previous preview state; retain any existing live app."
  },
  {
    "when": "Stale or different workspace approval",
    "then": "Reject."
  }
]
```

Request:

```json
{
  "method": "approveLocalPreview",
  "args": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "88888888-8888-4888-8888-888888888888",
    true
  ]
}
```

5.6.) Event: Initialize or reuse app folder; execute coding steps

Before:

```json
{
  "preview": {
    "status": "confirming",
    "approval": {
      "id": "88888888-8888-4888-8888-888888888888",
      "workspaceId": "22222222-2222-4222-8222-222222222222",
      "kind": "build",
      "message": "Build a timer with start, pause and reset.",
      "label": "Build locally"
    }
  }
}
```

After:

```json
{
  "preview": {
    "status": "building",
    "approval": null
  }
}
```

- Stop prior server after approval; git init if needed.
- Run each coding step in its own bounded agent turn.
- Write app files in workspace app folder; preserve original context files.
- No automatic Git commit, remote creation or push.

5.7.) Event: Write launch manifest

Before:

```json
{
  "manifest": null
}
```

After:

```json
{
  "manifest": {
    "version": 1,
    "kind": "interface",
    "buildId": "77777777-7777-4777-8777-777777777777",
    "name": "Timer",
    "cwd": ".",
    "install": null,
    "build": null,
    "command": "node server.cjs {port}",
    "path": "/"
  }
}
```

- File: app/engelbart-preview.json.
- buildId must match current askId; command must contain {port}.
- Example: dependency-free app; server binds to 127.0.0.1.

5.8.) Event: Install, compile, start and verify

Transitions:

```json
[
  {
    "phase": "install",
    "preview_status": "installing",
    "result": "done or skipped"
  },
  {
    "phase": "compile",
    "preview_status": "building",
    "result": "done or skipped"
  },
  {
    "phase": "start",
    "preview_status": "starting",
    "result": "done"
  },
  {
    "phase": "verify",
    "preview_status": "checking",
    "result": "done"
  }
]
```

- Reuse unchanged dependencies when available; run configured compile command.
- Allocate port; verify owned listener, HTML response and rendered interface.
- Persist step outcomes, recipe and bounded logs.

5.9.) Event: Attach app folder to Context; publish ready preview

Before:

```json
{
  "preview": {
    "status": "checking",
    "url": null,
    "libraryId": null,
    "readyAt": null
  }
}
```

After:

```json
{
  "preview": {
    "status": "ready",
    "url": "http://127.0.0.1:43123/",
    "libraryId": "66666666-6666-4666-8666-666666666666",
    "readyAt": "2026-09-27T16:01:00.000Z",
    "error": null
  },
  "library": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "name": "Timer",
      "type": "folder",
      "folder_path": "<dataRoot>/.local-apps/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/app",
      "tags": [
        "git"
      ]
    }
  ],
  "sidebarContext": {
    "version": 1,
    "context": [
      "66666666-6666-4666-8666-666666666666"
    ],
    "removed": []
  }
}
```

- Reuse existing library folder entry on later builds.
- Open/focus preview in requesting workspace; other workspaces receive notification only.
- Replace pending Bart marker with answer and live-preview link.
- Context indexing failure is logged; otherwise-valid preview can still become ready.

5.10.) Alternative: Launch or verification fails

Branch from: 5.8

Before:

```json
{
  "preview": {
    "status": "checking",
    "url": null
  }
}
```

After:

```json
{
  "preview": {
    "status": "repairing",
    "url": null
  }
}
```

- Stop owned server; send actual error and recent logs to coding agent.
- Allow one launch repair; retry runtime phases.
- Coding/planning failures do not imply automatic launch repair.

5.11.) Alternative: Retry fails

Branch from: 5.10

Before:

```json
{
  "preview": {
    "status": "checking",
    "url": null
  }
}
```

After:

```json
{
  "preview": {
    "status": "failed",
    "url": null,
    "error": "No HTML interface responded on the owned loopback port. Check the command, {port}, and 127.0.0.1 binding."
  }
}
```

- Stop owned server; retain app files, recipe, plan and logs.
- Bart reply shows failure.

5.12.) Event: Stop preview

Branch from: 5.9

Request:

```json
{
  "method": "stopLocalPreview",
  "args": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ]
}
```

Before:

```json
{
  "preview": {
    "status": "ready",
    "url": "http://127.0.0.1:43123/"
  }
}
```

After:

```json
{
  "preview": {
    "status": "stopped",
    "url": null,
    "error": null
  }
}
```

- Stop owned process group; retain files and library association.
- Closing Stage tab alone leaves server running.

5.13.) Event: Restart saved preview

Request:

```json
{
  "method": "restartLocalPreview",
  "args": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ]
}
```

Before:

```json
{
  "preview": {
    "status": "stopped",
    "url": null
  }
}
```

After:

```json
{
  "preview": {
    "status": "confirming",
    "url": null,
    "approval": {
      "kind": "restart",
      "label": "Run locally"
    }
  }
}
```

- Generate fresh approval ID; require Run locally.
- Reread manifest; skip coding; rerun required runtime phases.
- App relaunch restores files/state but never automatically starts the server or restores approval.

Sources: [ipc.cjs](../src/main/ipc.cjs), [build-proposal.cjs](../src/main/bart/build-proposal.cjs), [manager.cjs](../src/main/local-preview/manager.cjs), [plan.cjs](../src/main/local-preview/plan.cjs), [files.cjs](../src/main/local-preview/files.cjs)

6.) Behavior: Ask @bart a question

Storage: `<workspace>/workspace.md or <project>/<note>.md`; `<dataRoot>/state.json: agents`

- document.text represents Markdown contents; no conversation SQL table.

6.1.) Event: Submit question; insert pending marker

Before:

```json
{
  "document": {
    "text": "@bart What should I test next?"
  }
}
```

After:

```json
{
  "document": {
    "text": "@bart What should I test next?\nbart~> 77777777-7777-4777-8777-777777777777"
  }
}
```

- Read workspace/current note, mentioned notes and library catalog.
- Read relevant source files; run signed-in provider CLI with read-only tools.

6.2.) Event: Receive answer; replace pending marker

Before:

```json
{
  "document": {
    "text": "@bart What should I test next?\nbart~> 77777777-7777-4777-8777-777777777777"
  }
}
```

After:

```json
{
  "document": {
    "text": "@bart What should I test next?\nbart> Test saving settings and reopening the page.\nbart>\nbart> *Sol · medium · 12 s*"
  }
}
```

- Persist answer automatically; no separate Save step.
- Track model, effort and elapsed time in attribution.
- Automatic model escalation allowed unless choice pinned.

6.3.) Event: Ask follow-up or regenerate

- Follow-up: append @bart line; include prior turns from current document.
- Reuse compatible live conversation when available; otherwise rebuild from document.
- Regenerate: replace selected answer with a new pending marker.

6.4.) Alternative: Question fails

Branch from: 6.1

Before:

```json
{
  "document": {
    "text": "@bart What should I test next?\nbart~> 77777777-7777-4777-8777-777777777777"
  }
}
```

After:

```json
{
  "document": {
    "text": "@bart What should I test next?\nbart> **No answer.** The run failed."
  }
}
```

6.5.) Event: Collapse, delete or stop

- Collapse: bart> becomes bart+>; fold persists in Markdown.
- Delete: remove selected question and answer; stop it if still running.
- Stop: abort run; clear its pending marker.

Sources: [ask.cjs](../src/main/bart/ask.cjs), [reply.cjs](../src/main/bart/reply.cjs), [projects.cjs](../src/main/store/projects.cjs), [DocEditor.jsx](../src/renderer/workspace/DocEditor.jsx)

7.) Behavior: Create a project and nested workspaces

Storage: `<project>/project.json`; `<workspace>/meta.json`; `<workspace>/workspace.md`; `<project>/notes.pglite`

- Current hierarchy: project → nested workspaces; legacy notes.topic_id stores workspace ID.

7.1.) Event: Create project

Before:

```json
{
  "project": null
}
```

After:

```json
{
  "project": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Example project",
    "created": "2026-09-27T16:00:00.000Z"
  }
}
```

- Create project directory and notes database.
- Optional selected code directory stored as project.directory.

7.2.) Event: Create workspace

Before:

```json
{
  "workspaceMeta": null,
  "document": null
}
```

After:

```json
{
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "status": "open",
    "context": [],
    "created": "2026-09-27T16:00:01.000Z",
    "chars": 0
  },
  "document": {
    "text": ""
  }
}
```

- Create workspace directory under project or selected parent workspace.
- Workspace name comes from directory name.
- First-run welcome flow also creates Getting started workspace and Welcome! note.

7.3.) Event: Change workspace status

Before:

```json
{
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "status": "open"
  }
}
```

After:

```json
{
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "status": "progress"
  }
}
```

- Allowed statuses: open, progress, done.

7.4.) Event: Edit workspace document

Before:

```json
{
  "document": {
    "text": ""
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "chars": 0
  }
}
```

After:

```json
{
  "document": {
    "text": "Plan the next test."
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "chars": 19
  }
}
```

- Write workspace.md atomically; update character count.

Sources: [projects.cjs](../src/main/store/projects.cjs)

8.) Behavior: Create notes; edit text and tasks

Storage: `<project>/<note>.md`; `<project>/notes.pglite: notes`; `library.pglite: library`

8.1.) Event: Create empty note

Before:

```json
{
  "notes": [],
  "library": []
}
```

After:

```json
{
  "notes": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "name": "Test plan",
      "path": "Test plan.md",
      "goal_id": null,
      "topic_id": "22222222-2222-4222-8222-222222222222",
      "created": "2026-09-27T16:00:00.000Z",
      "last_edited": "2026-09-27T16:00:00.000Z"
    }
  ],
  "library": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "name": "Test plan",
      "type": "md",
      "path": "<dataRoot>/example-project/Test plan.md",
      "url": null,
      "folder_path": null,
      "project_id": "11111111-1111-4111-8111-111111111111",
      "created": "2026-09-27T16:00:00.000Z",
      "last_edited": "2026-09-27T16:00:00.000Z",
      "summary": null,
      "summary_edited": null,
      "char_count": 0,
      "github_id": null,
      "tags": [
        "note"
      ],
      "categorized": null,
      "thumbnail_path": null,
      "thumbnail_captured_at": null,
      "thumbnail_run_id": null
    }
  ],
  "document": {
    "text": ""
  }
}
```

- Same ID in notes and library; plain Markdown content on disk.

8.2.) Event: Save note containing task

Before:

```json
{
  "document": {
    "text": ""
  },
  "library": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "char_count": 0,
      "last_edited": "2026-09-27T16:00:00.000Z"
    }
  ]
}
```

After:

```json
{
  "document": {
    "text": "- [ ] Test save button"
  },
  "notes": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "last_edited": "2026-09-27T16:00:01.000Z"
    }
  ],
  "library": [
    {
      "id": "55555555-5555-4555-8555-555555555555",
      "char_count": 22,
      "last_edited": "2026-09-27T16:00:01.000Z"
    }
  ]
}
```

- Update note and library edit timestamps; summary may refresh later.

8.3.) Event: Complete task

Before:

```json
{
  "document": {
    "text": "- [ ] Test save button"
  }
}
```

After:

```json
{
  "document": {
    "text": "- [x] Test save button"
  }
}
```

- Task state stored in Markdown; normal document save updates metadata.

8.4.) Decision: Did saved text change?

Cases:

```json
[
  {
    "when": "Same text",
    "then": "No write; no timestamp change."
  },
  {
    "when": "Different text",
    "then": "Save file; update timestamps and character count."
  }
]
```

Sources: [projects.cjs](../src/main/store/projects.cjs), [db.cjs](../src/main/store/db.cjs), [doc.js](../src/renderer/model/doc.js)

9.) Behavior: Attach or remove shared project context

Storage: `<project>/project.json: sidebarContext`; `<workspace>/meta.json: context, removed`

- Example: existing library row; shared context already initialized.

9.1.) Event: Attach existing library item

Before:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [],
    "removed": []
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "context": [],
    "removed": []
  }
}
```

After:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ],
    "removed": []
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "context": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ],
    "removed": []
  }
}
```

- Visible in every workspace sidebar in this project; library row reused.

9.2.) Event: Remove source from sidebar

Before:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ],
    "removed": []
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "context": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ],
    "removed": []
  }
}
```

After:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [],
    "removed": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ]
  },
  "workspaceMeta": {
    "id": "22222222-2222-4222-8222-222222222222",
    "context": [],
    "removed": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ]
  }
}
```

- Hide across project; retain library row and underlying file.
- Removed list prevents old mentions/attachments restoring it.

9.3.) Event: Explicitly attach source again

Before:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [],
    "removed": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ]
  }
}
```

After:

```json
{
  "sidebarContext": {
    "version": 1,
    "context": [
      "a27b6e09-f342-4f91-8c58-64ba719312ef"
    ],
    "removed": []
  }
}
```

- Restore shared visibility; update attaching workspace provenance.

Sources: [project-context.cjs](../src/main/store/project-context.cjs), [projects.cjs](../src/main/store/projects.cjs)

10.) Behavior: Highlight a PDF; add a margin note

Storage: `<dataRoot>/annotations/<libraryId>.json`; `<dataRoot>/annotations/pages/<addressHash>.json for unsaved PDFs`

- marks = actual page-number-keyed annotation object; independent of interface annotation bundles.
- Geometry normalized by page width.

10.1.) Event: Save highlight and margin note

Before:

```json
{
  "marks": {}
}
```

After:

```json
{
  "marks": {
    "1": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "rects": [
          {
            "x": 0.12,
            "y": 0.2,
            "w": 0.48,
            "h": 0.025
          }
        ],
        "side": "right",
        "y": 0.2,
        "note": "Check this assumption.",
        "text": "Selected passage from the paper.",
        "pos": null
      }
    ]
  }
}
```

- Use library ID when saved; otherwise hash canonical PDF address.
- Original PDF bytes unchanged.

10.2.) Event: Edit margin note

Before:

```json
{
  "marks": {
    "1": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "rects": [
          {
            "x": 0.12,
            "y": 0.2,
            "w": 0.48,
            "h": 0.025
          }
        ],
        "side": "right",
        "y": 0.2,
        "note": "Check this assumption.",
        "text": "Selected passage from the paper.",
        "pos": null
      }
    ]
  }
}
```

After:

```json
{
  "marks": {
    "1": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "rects": [
          {
            "x": 0.12,
            "y": 0.2,
            "w": 0.48,
            "h": 0.025
          }
        ],
        "side": "right",
        "y": 0.2,
        "note": "Compare with the previous result.",
        "text": "Selected passage from the paper.",
        "pos": null
      }
    ]
  }
}
```

10.3.) Event: Clear margin note

Before:

```json
{
  "marks": {
    "1": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "rects": [
          {
            "x": 0.12,
            "y": 0.2,
            "w": 0.48,
            "h": 0.025
          }
        ],
        "side": "right",
        "y": 0.2,
        "note": "Compare with the previous result.",
        "text": "Selected passage from the paper.",
        "pos": null
      }
    ]
  }
}
```

After:

```json
{
  "marks": {
    "1": [
      {
        "id": "44444444-4444-4444-8444-444444444444",
        "rects": [
          {
            "x": 0.12,
            "y": 0.2,
            "w": 0.48,
            "h": 0.025
          }
        ],
        "side": "right",
        "y": 0.2,
        "note": null,
        "text": "Selected passage from the paper.",
        "pos": null
      }
    ]
  }
}
```

- Highlight remains; an empty note without highlight rectangles is removed.

Sources: [library.cjs](../src/main/store/library.cjs), [PaperView.jsx](../src/renderer/pdf/PaperView.jsx)

11.) Behavior: Add a website or local file to the library

Storage: `library.pglite: library`

- Independent example; user-provided GitHub/sandbox flow remains separate.

11.1.) Decision: Resolve added URL or path

Cases:

```json
[
  {
    "when": "Existing matching item",
    "then": "Reuse through lookup/link flow; direct duplicate add may return EXISTS."
  },
  {
    "when": "New HTTP(S) URL",
    "then": "Create website row; infer supported tags."
  },
  {
    "when": "Supported local file/folder",
    "then": "Link original path; infer format and tags."
  },
  {
    "when": "Invalid URL/path or unsupported format",
    "then": "Show error; no library row."
  }
]
```

11.2.) Event: Add ordinary website

Before:

```json
{
  "library": []
}
```

After:

```json
{
  "library": [
    {
      "id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "name": "Example reference",
      "type": "website",
      "path": null,
      "url": "https://example.com/reference",
      "folder_path": null,
      "project_id": null,
      "created": "2026-09-27T16:00:00.000Z",
      "last_edited": "2026-09-27T16:00:00.000Z",
      "summary": null,
      "summary_edited": null,
      "char_count": null,
      "github_id": null,
      "tags": [],
      "categorized": 1,
      "thumbnail_path": null,
      "thumbnail_captured_at": null,
      "thumbnail_run_id": null
    }
  ]
}
```

- Attach to project context when added from a workspace.
- Ordinary website does not start a repository sandbox.

11.3.) Event: Background summary completes

Before:

```json
{
  "library": [
    {
      "id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "summary": null,
      "summary_edited": null
    }
  ]
}
```

After:

```json
{
  "library": [
    {
      "id": "a27b6e09-f342-4f91-8c58-64ba719312ef",
      "summary": "Reference material for the project.",
      "summary_edited": "2026-09-27T16:01:00.000Z"
    }
  ]
}
```

- Only when summarization is enabled and content can be read.

Sources: [library.cjs](../src/main/store/library.cjs), [db.cjs](../src/main/store/db.cjs), [ipc.cjs](../src/main/ipc.cjs)

12.) Behavior: Open and use a terminal session

Storage: `Main-process PTY session memory`

- session = live public session snapshot; not a database row.

12.1.) Event: Create shell session

Before:

```json
{
  "session": null
}
```

After:

```json
{
  "session": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "provider": "shell",
    "title": "zsh",
    "cwd": "/Users/example/project",
    "shell": "/bin/zsh",
    "pid": 12345,
    "cols": 100,
    "rows": 30,
    "status": "running",
    "createdAt": "2026-09-27T16:00:00.000Z",
    "history": []
  }
}
```

- Validate launch request; spawn PTY.
- Other supported providers use installed Claude Code or Codex CLIs.

12.2.) Event: Write input; stream output

Request:

```json
{
  "method": "terminalAPI.writeSession",
  "args": [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "pwd\r"
  ]
}
```

- Write to PTY; stream terminal:data batches; acknowledge sequence numbers.
- Resize forwards cols/rows to PTY.

12.3.) Event: Process exits

Before:

```json
{
  "session": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "status": "running"
  }
}
```

After:

```json
{
  "session": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "status": "exited",
    "exitCode": 0
  }
}
```

- Emit terminal:exit; reject further writes to exited process.

12.4.) Event: Close terminal session

Request:

```json
{
  "method": "terminalAPI.closeSession",
  "args": [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  ]
}
```

- Stop process if running; remove session and release PTY resources.

Sources: [session-manager.cjs](../src/main/terminal/session-manager.cjs), [launch.cjs](../src/main/terminal/launch.cjs), [preload.cjs](../src/preload.cjs)
