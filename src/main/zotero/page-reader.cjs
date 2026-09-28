'use strict';
const { randomUUID } = require('node:crypto');
function readPage(page, start, origin, { signal, timeoutMs = start === null ? 1500 : 18000 } = {}) {
  return new Promise(resolve => {
    if (page.isDestroyed() || signal?.aborted) { resolve({ kind: 'unavailable' }); return; }
    const id = randomUUID();
    const done = value => {
      clearTimeout(timer); page.removeListener('ipc-message', message); page.removeListener('destroyed', stop);
      signal?.removeEventListener('abort', stop); resolve(value);
    };
    const stop = () => done({ kind: 'unavailable' });
    const message = (event, channel, replyId, value) => {
      if (channel !== 'zotero:library' || replyId !== id || event.senderFrame !== page.mainFrame) return;
      done(value);
    };
    const timer = setTimeout(stop, timeoutMs);
    page.on('ipc-message', message); page.once('destroyed', stop);
    signal?.addEventListener('abort', stop, { once: true });
    try { page.send('zotero:read-library', { id, start, origin }); } catch { stop(); }
  });
}
module.exports = { readPage };
