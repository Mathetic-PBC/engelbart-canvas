'use strict';

// The Agent trace window's bridge (./trace.html): the entries kept, each new one, Save as HTML, the folder they are in.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('traceApi', {
  list: () => ipcRenderer.invoke('trace:list'),
  save: (html) => ipcRenderer.invoke('trace:save', html),
  reveal: () => ipcRenderer.invoke('trace:reveal'),
  onEntry: (listener) => {
    const handler = (_event, entry) => listener(entry);
    ipcRenderer.on('trace:entry', handler);
    return () => ipcRenderer.removeListener('trace:entry', handler);
  },
});
