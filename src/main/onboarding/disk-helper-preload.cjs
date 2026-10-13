'use strict';

// The Full Disk Access helper's bridge (./disk-access.cjs): its state in, its buttons out. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskHelper', {
  onState: (callback) => { ipcRenderer.on('disk-helper:state', (_event, state) => callback(state)); },
  action: (name) => ipcRenderer.send('disk-helper:action', String(name)),
});
