'use strict';

// Someone using Engelbart (2026-10-04): any keyboard, mouse or scroll input in any of its windows, Stage pages included,
// calls `onActive`, at most once per `every`. The manager's wakeAll keeps every ready sandbox awake while it is called,
// so with no input for 10 minutes they sleep. Every web contents is watched, those made later too.
function watchActivity({ app, webContents, onActive, every = 60_000, now = Date.now }) {
  let last = -Infinity;
  const input = () => {
    const at = now();
    if (at - last < every) return;
    last = at;
    try { onActive(); } catch { /* never the input's problem */ }
  };
  const watch = (contents) => contents.on('input-event', input);
  for (const contents of webContents.getAllWebContents()) watch(contents);
  app.on('web-contents-created', (_event, contents) => watch(contents));
}

module.exports = { watchActivity };
