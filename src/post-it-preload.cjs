'use strict';

const { contextBridge, ipcRenderer } = require('electron');
let latestText = null;
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// No project id or card id accepted: main binds every call to the sending card.
contextBridge.exposeInMainWorld('postItAPI', Object.freeze({
  ready: () => ipcRenderer.invoke('post-it:ready').then((card) => { latestText = card.text; return card; }),
  edit: (text) => { latestText = text; return ipcRenderer.invoke('post-it:edit', text); },
  // Main awaits this barrier before closing a view: the last renderer edit may
  // still be crossing IPC when a native Quit or project switch is requested.
  flush: () => latestText == null ? Promise.resolve() : ipcRenderer.invoke('post-it:edit', latestText),
  gesture: (input) => ipcRenderer.send('post-it:gesture', input),
  copy: (text) => ipcRenderer.invoke('post-it:copy', text),
  openLink: (url) => ipcRenderer.invoke('post-it:open-link', url),
  onTrash: (fn) => subscribe('post-it:trash', fn),
  onCancel: (fn) => subscribe('post-it:gesture-cancelled', fn),
}));
