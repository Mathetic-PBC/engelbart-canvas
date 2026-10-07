'use strict';
// The card beside a selected box (MATH-70 build 2, 2026-10-07): its own small view (views.cjs `card`, one per window),
// engelbart://app/box-card.html, drawn by src/renderer/box-card/BoxCard.jsx. These are its only channels, on its own
// view's ipc; main binds every one to the box the card is showing, so the card names no box, tab or page.
//   in:  state { mark: { id, note, asks }, running }: the box's note and answers as kept, and what is being asked from it
//   out: ready(), note(text), ask(question), stop(askId), remove(), size({ height })
// Sandboxed and isolated: the card's page gets `window.boxCardAPI` and nothing else.

const CHANNELS = Object.freeze({
  state: 'box-card:state', ready: 'box-card:ready', note: 'box-card:note', ask: 'box-card:ask',
  stop: 'box-card:stop', remove: 'box-card:remove', size: 'box-card:size',
});

function runInCard() {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('boxCardAPI', Object.freeze({
    ready: () => ipcRenderer.send(CHANNELS.ready),
    onState: (fn) => {
      const listener = (_event, value) => fn(value);
      ipcRenderer.on(CHANNELS.state, listener);
      return () => ipcRenderer.removeListener(CHANNELS.state, listener);
    },
    note: (text) => ipcRenderer.send(CHANNELS.note, String(text)),
    ask: (question) => ipcRenderer.send(CHANNELS.ask, String(question)),
    stop: (askId) => ipcRenderer.send(CHANNELS.stop, String(askId)),
    remove: () => ipcRenderer.send(CHANNELS.remove),
    size: ({ height } = {}) => ipcRenderer.send(CHANNELS.size, { height: Number(height) }),
  }));
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof require === 'function') runInCard();
else if (typeof module === 'object' && module && module.exports) module.exports = { CHANNELS };
