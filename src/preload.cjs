'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  resetTestData: invoke('reset-test-data'),
  lastOpen: invoke('last-open'),
  setLastOpen: invoke('set-last-open'),
  listProjects: invoke('list-projects'),
  createProject: invoke('create-project'),
  createProjectWithWelcome: invoke('create-project-with-welcome'),
  renameProject: invoke('rename-project'),
  loadProject: invoke('load-project'),
  setProjectDirectory: invoke('set-project-directory'),
  createWorkspace: invoke('create-workspace'),
  renameWorkspace: invoke('rename-workspace'),
  setWorkspaceStatus: invoke('set-workspace-status'),
  setWorkspaceContext: invoke('set-workspace-context'),
  saveImage: invoke('save-image'),
  readImage: invoke('read-image'),
  createNote: invoke('create-note'),
  renameNote: invoke('rename-note'),
  readDoc: invoke('read-doc'),
  writeDoc: invoke('write-doc'),
  copyDoc: invoke('copy-doc'),
  askBart: invoke('ask-bart'),
  stopBart: invoke('stop-bart'),
  bartModels: invoke('bart-models'),
  copyText: invoke('copy-text'),
  onBartProgress: (callback) => subscribe('engelbart:bart-progress', callback),
  readTextFile: invoke('read-text-file'),
  resolvePageFile: invoke('resolve-page-file'),
  library: invoke('library'),
  projectsForLibraryItem: invoke('projects-for-library-item'),
  libraryForProject: invoke('library-for-project'),
  addLibraryItem: invoke('add-library-item'),
  previewLibraryItem: invoke('preview-library-item'),
  // A file dropped on the window: where it is on disk (the renderer's File no longer says).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  renameLibraryItem: invoke('rename-library-item'),
  readLibraryFile: invoke('read-library-file'),
  readAnnotations: invoke('read-annotations'),
  writeAnnotations: invoke('write-annotations'),
  shellHistory: invoke('shell-history'),
  openExternal: invoke('open-external'),
  reveal: invoke('reveal'),
  // Browser pane: pages are native views in the main process (src/main/browser/views.cjs).
  browserOpen: (id, url) => ipcRenderer.invoke('browser:open', id, url),
  browserShow: (id, rect) => ipcRenderer.invoke('browser:show', id, rect),
  browserHide: (options) => ipcRenderer.invoke('browser:hide', options),
  browserCommand: (id, name) => ipcRenderer.invoke('browser:command', id, name),
  browserClose: (id) => ipcRenderer.invoke('browser:close', id),
  browserCloseAll: () => ipcRenderer.invoke('browser:close-all'),
  browserLoginReply: (requestId, credentials) => ipcRenderer.invoke('browser:login-reply', requestId, credentials),
  onBrowserState: (callback) => subscribe('browser:state', callback),
  onBrowserClosed: (callback) => subscribe('browser:closed', callback),
  onBrowserLogin: (callback) => subscribe('browser:login', callback),
  onBrowserOpenTab: (callback) => subscribe('browser:open-tab', callback),
  onBrowserFocusAddress: (callback) => subscribe('browser:focus-address', callback),
  postItsActivate: (projectId) => ipcRenderer.invoke('post-its:activate', projectId),
  postItsCreate: (projectId) => ipcRenderer.invoke('post-its:create', projectId),
  postItsSuspend: (value) => ipcRenderer.invoke('post-its:suspend', value),
  postItsLayout: () => ipcRenderer.invoke('post-its:layout'),
  onPostItsDrag: (callback) => subscribe('post-its:drag', callback),
  onPostItsError: (callback) => subscribe('post-its:error', callback),
});

contextBridge.exposeInMainWorld('terminalAPI', terminalAPI);
contextBridge.exposeInMainWorld('engelbartAPI', engelbartAPI);
