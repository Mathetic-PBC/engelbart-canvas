'use strict';

const { contextBridge, ipcRenderer } = require('electron');
let latestText = null;
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// Main awaits this barrier before closing a view: the last renderer edit may
// still be crossing IPC when a native Quit or project switch is requested.
const flush = () => (latestText == null ? Promise.resolve() : ipcRenderer.invoke('post-it:edit', latestText));
// No project id or card id accepted: main binds every call to the sending card.
contextBridge.exposeInMainWorld('postItAPI', Object.freeze({
  ready: () => ipcRenderer.invoke('post-it:ready').then((card) => { latestText = card.text; return card; }),
  edit: (text) => { latestText = text; return ipcRenderer.invoke('post-it:edit', text); },
  flush,
  gesture: (input) => ipcRenderer.send('post-it:gesture', input),
  // The text needs more room than the card has: → the height (CSS px) main could give it.
  grow: (height) => ipcRenderer.invoke('post-it:grow', height),
  toNote: () => flush().then(() => ipcRenderer.invoke('post-it:to-note')),
  // Build (2026-09-25): the window opens the Build dialog with this card's text; a click on the card's state opens its task.
  build: () => flush().then(() => ipcRenderer.invoke('post-it:build')),
  openBuild: (id) => ipcRenderer.invoke('post-it:build-open', id),
  onBuildState: (fn) => subscribe('post-it:build-state', fn),
  copy: (text) => ipcRenderer.invoke('post-it:copy', text),
  openLink: (url) => ipcRenderer.invoke('post-it:open-link', url),
  onTrash: (fn) => subscribe('post-it:trash', fn),
  onCrumple: (fn) => subscribe('post-it:crumple', fn),
  onCancel: (fn) => subscribe('post-it:gesture-cancelled', fn),
}));
