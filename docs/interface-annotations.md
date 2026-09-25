# Interface annotations

Open a web page, local app preview, or HTML file in **Stage**, then choose **Annotate** in the address toolbar. Selection starts directly, without a sidebar or any change to the page width. The toolbar reads **Annotating · Esc to cancel**. Hovering an element shows a pointer cursor, a thin neutral outline, and its readable semantic name (not a tag, selector, or dimensions). Escape or the toolbar action exits selection and removes its overlays and temporary cursor override.

Click an element to freeze the selection and open a compact contextual composer. The click is intercepted before the page's controls activate. **Ask Bart** is selected by default: write a question and send it, together with the page and selected element's context, to the existing Bart conversation in the workspace document. Asking does not implicitly create a saved annotation. Choose **Add note** instead to save an annotation with **Save note**. Switching actions preserves the draft; every new selection defaults to Ask Bart. ⌘/Ctrl+Enter performs the selected action. Sending, saving, Cancel, or Escape closes the composer, clears the selection, and restores normal page interaction. Handoff errors leave the draft in place. The composer uses Stage's existing overlay/snapshot mechanism, so the page stays the same size and the selected element remains visible behind it; the underlying native page is temporarily covered by its snapshot while writing.

Choose **More (⋮) → Annotations** to explicitly open the existing saved-notes panel. Clicking a note or its numbered marker highlights its element and scrolls it into view. Notes can be edited, deleted, or sent to **Ask Bart**, which adds the observation and element context to the current workspace document and starts the existing Bart flow. **Select an element** leaves the panel and enters direct selection. Closing the panel removes the overlays and listeners without reloading the page.

Notes belong to a project and site. Known sandbox preview origins map to their repository's library ID, so annotations remain available after a rebuild changes the preview hostname. Local HTML files use their file URL. Routes are stored with each anchor; a note on another route offers **Open page**. Credentials and query strings are not stored. PDF ink continues to use its existing independent format.

## Implementation

- `src/main/browser/annotation-page.cjs`: DOM picker, overlays, same-origin child frames, open shadow roots, and target recognition. The main process installs this script on demand with `executeJavaScriptInIsolatedWorld` (world 1739). Canvas does not modify the server's HTML response.
- `src/main/browser/annotations.cjs`: per-tab controller. Only the trusted app renderer can invoke its small command vocabulary. Main polls the isolated context while annotating or browsing saved notes. A pick includes bounded, temporary viewport coordinates for composer placement; those coordinates are not saved in the anchor. Websites receive no preload, IPC API, note text, filesystem capability, or message listener. Navigation and tab closure invalidate pending results and stop polling.
- `src/shared/interface-annotations.cjs`: bounded, allowlisted anchors and note validation, plus the shared display label used by the overlay, composer, and saved-notes list. Text-entry values and contenteditable contents are excluded from captured element descriptions.
- `src/main/store/interface-annotations.cjs`: atomic per-record mutations to `<dataRoot>/annotations/interface/<hash>.json`. Keys include project ID and repository/site identity. Storage failures remain visible in the editor. Concurrent additions do not replace one another.
- `src/renderer/workspace/InterfaceAnnotations.jsx`: the existing editor and saved-notes list. Direct selection renders nothing until a target is picked, then reuses the editor in a viewport-clamped popover. Only explicitly browsing saved notes opens the resizable page/side-panel layout.

Matching tries a unique test ID, element ID, and selector (including open shadow-root hops), followed by a unique best candidate using tag, role, text, classes, and ancestors. The UI distinguishes **found**, **closest match**, and **not found**. Screen coordinates never determine identity. Markers update as the page changes or scrolls.

Cross-origin or opaque sandboxed frames cannot be inspected internally. Their iframe element can be selected, and the panel reports the limitation. Closed shadow roots and graphics within a canvas are represented by their host element. A DOM anchor does not automatically identify a framework component or source line. URL query parameters are deliberately excluded from page identity.

## Verification

```sh
npm run build
node --test test/interface-annotations.test.cjs test/interface-annotations-ui.test.cjs test/browser.test.cjs test/library.test.cjs test/stage-model.test.cjs test/right-pane.test.cjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/smoke-interface-annotations.cjs
```

The Electron smoke test uses a disposable home and a loopback fixture with strict CSP, nested frames, and a private input. It opens a temporary window without taking keyboard focus and exits afterward. It exercises full-width selection, neutral semantic hover, pointer restoration, Escape from the page and toolbar, contextual composing, the actual Stage controls, persistence, matching, frame selection, Ask Bart, deletion, and cleanup. The final output reports screenshots and the disposable data directory.
