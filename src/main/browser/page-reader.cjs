'use strict';
const { randomUUID } = require('node:crypto');

// Only the requested page's top-frame preload can answer. Responses never
// invoke app actions; they are metadata that the connection validates/stores.
function readPage(page, query, advance, origin, { signal, timeoutMs = 1500, provider = 'google' } = {}) {
  return new Promise(resolve => {
    if (page.isDestroyed() || signal?.aborted) { resolve({ kind: 'unavailable' }); return; }
    const id = randomUUID();
    const done = value => {
      clearTimeout(timer);
      page.removeListener('ipc-message', message); page.removeListener('destroyed', stop);
      signal?.removeEventListener('abort', stop);
      resolve(value);
    };
    const stop = () => done({ kind: 'unavailable' });
    const message = (event, channel, replyId, value) => {
      if (channel !== `${provider}:listing` || replyId !== id || event.senderFrame !== page.mainFrame) return;
      done(value);
    };
    const timer = setTimeout(stop, timeoutMs);
    page.on('ipc-message', message); page.once('destroyed', stop);
    signal?.addEventListener('abort', stop, { once: true });
    try { page.send(`${provider}:read-listing`, { id, query, advance, origin }); } catch { stop(); }
  });
}
module.exports = { readPage };
