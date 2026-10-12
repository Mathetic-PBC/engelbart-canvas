'use strict';

// Whether this library's context has been imported (2026-10-12, "show only the context tick-and-import modal when context
// has not yet been imported"): MEMORY.md is in the data root (./memory.cjs), or a session of Connect your library
// (./session.cjs, saved as <dataRoot>/.connect/<id>/session.json) finished: Import was pressed (finished) or the librarian
// said it was done (done). The "Import Context" offer over the workspace (renderer ui/GuidedSetup.jsx ImportContextOffer)
// is shown only while it has not, and has not been dismissed here (ipc guided-offer).

const fs = require('node:fs');
const path = require('node:path');
const { memoryPath } = require('./memory.cjs');
const gettingStarted = require('../store/getting-started.cjs');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a session saved in this data root finished its import. */
function finishedSession(dataRoot) {
  let names = [];
  try { names = fs.readdirSync(path.join(dataRoot, '.connect')).filter((name) => ID_RE.test(name)); } catch { return false; }
  for (const id of names) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, '.connect', id, 'session.json'), 'utf8'));
      if (saved && typeof saved === 'object' && (saved.finished === true || saved.done === true)) return true;
    } catch { /* a session that cannot be read: not this one */ }
  }
  return false;
}

/** Whether this data root's context has been imported: MEMORY.md, or a saved Connect session that finished. */
function contextImported(dataRoot) {
  if (!dataRoot) return false;
  try { if (fs.statSync(memoryPath(dataRoot)).isFile()) return true; } catch { /* none */ }
  return finishedSession(dataRoot);
}

/**
 * Whether the "Import Context" offer is shown in this data root: never with ENGELBART_CONNECT_OFFER=off (the smokes that
 * are not about Connect: it would cover their workspace), nor once the context is imported, nor once it was dismissed
 * (Not now). Shown, or Import pressed and the popup closed before an import began, it comes back on a later launch.
 */
function importOfferDue(ctx, env = process.env) {
  if (env.ENGELBART_CONNECT_OFFER === 'off') return false;
  if (contextImported(ctx.dataRoot)) return false;
  return !gettingStarted.guidedOfferDismissed(ctx);
}

module.exports = { contextImported, importOfferDue };
