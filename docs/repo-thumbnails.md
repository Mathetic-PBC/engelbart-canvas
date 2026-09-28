# Repository preview thumbnails

The first visible, loaded Stage visit to a ready repository preview automatically
captures the **page viewport only**, without opening another page or delaying the
build. Stage allows 1.2 seconds to settle and makes one additional attempt at 4
seconds if necessary. Successful capture is remembered per sandbox run. This is
not continuous recording, and ordinary websites/GitHub repository pages are not
captured. A loading/error/hidden/closed/navigated page is not eligible; annotation
mode also suppresses capture. A client-rendered loading screen can still be present
after this settling period; it is not semantic app-readiness detection.

`library` contains three nullable columns:

- `thumbnail_path`: relative to the active data root, e.g.
  `assets/repo-thumbnails/<library-id>-<run-id>-<image-id>.jpg`.
- `thumbnail_captured_at`: time the image was saved.
- `thumbnail_run_id`: provenance of the snapshot, not a new ownership relation.

Normal data lives in `~/.engelbart`, test data in `~/.engelbart/test`. JPEGs fit
within 640×480, retain their aspect ratio, and are capped at 512 KiB. Files are
private (0600), and saved before publishing their library reference. Thumbnail
writes do not alter the repository URL/path or `last_edited`. A failed capture or
build leaves the last successful thumbnail intact. A later ready run replaces it
on its first Stage visit; only then is the superseded generated image removed.
Stopping a sandbox does not remove its thumbnail. A missing image can be captured
again on a later visit. No image is uploaded or sent to an agent. Screenshots can
include private information already visible in the preview.

Sidebar hover uses its existing 350 ms delay and a consistent 320×210 frame.
Images fill the frame without stretching, keeping the top visible and cropping
lower content in tall captures.
The frame aligns with the hovered row beside the sidebar, follows sidebar/window
resizing, and moves inward at viewport edges. No-image repositories show no hover card. Reads
use a trusted IPC request by library id, never an arbitrary renderer-supplied path.
Reading and decoding start during the hover delay. A bounded, in-memory cache keeps
up to 24 images per mounted sidebar and shares pending reads; repeat hovers reuse
the image. A new `thumbnail_path` invalidates the previous version, and failed or
missing reads can retry on the next hover. The cache is not persisted separately.
The image continues to work offline and after the sandbox stops or Canvas restarts.

Relevant code: `store/repo-thumbnails.cjs`, `browser/views.cjs`, `Stage.jsx`,
`Rail.jsx`, `RepoThumbnail.jsx`, and `model/repo-thumbnail.js`. The E2B worker/build lifecycle is unchanged.
