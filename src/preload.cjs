'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Listener must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Experimental Terminal bridge, v1 — unchanged contract (see docs in that repo).
const terminalAPI = Object.freeze({
  bootstrap: () => ipcRenderer.invoke('terminal:bootstrap'),
  providers: () => ipcRenderer.invoke('terminal:providers'),
  createSession: (request) => ipcRenderer.invoke('terminal:create', request),
  writeSession: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeSession: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  closeSession: (id) => ipcRenderer.invoke('terminal:close', id),
  acknowledge: (id, sequence) => ipcRenderer.send('terminal:acknowledge', id, sequence),
  pickDirectory: (current) => ipcRenderer.invoke('terminal:pick-directory', current),
  saveSettings: (settings) => ipcRenderer.invoke('terminal:save-settings', settings),
  openExternal: (url) => ipcRenderer.invoke('terminal:open-external', url),
  onData: (callback) => subscribe('terminal:data', callback),
  onExit: (callback) => subscribe('terminal:exit', callback),
  onMenu: (callback) => subscribe('terminal:menu', callback),
});

const invoke = (channel) => (...args) => ipcRenderer.invoke(`engelbart:${channel}`, ...args);

const engelbartAPI = Object.freeze({
  config: invoke('config'),
  setTestMode: invoke('set-test-mode'),
  listProjects: invoke('list-projects'),
  createProject: invoke('create-project'),
  renameProject: invoke('rename-project'),
  loadProject: invoke('load-project'),
  createGoal: invoke('create-goal'),
  renameGoal: invoke('rename-goal'),
  setFuture: invoke('set-future'),
  createTopic: invoke('create-topic'),
  renameTopic: invoke('rename-topic'),
  setTopicStatus: invoke('set-topic-status'),
  setTopicContext: invoke('set-topic-context'),
  createNote: invoke('create-note'),
  renameNote: invoke('rename-note'),
  readDoc: invoke('read-doc'),
  writeDoc: invoke('write-doc'),
  library: invoke('library'),
  readLibraryFile: invoke('read-library-file'),
  readAnnotations: invoke('read-annotations'),
  writeAnnotations: invoke('write-annotations'),
  openExternal: invoke('open-external'),
  reveal: invoke('reveal'),
});

contextBridge.exposeInMainWorld('terminalAPI', terminalAPI);
contextBridge.exposeInMainWorld('engelbartAPI', engelbartAPI);
