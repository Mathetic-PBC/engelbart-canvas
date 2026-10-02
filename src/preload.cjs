'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Listener must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// The window has no title bar on macOS: styles.css moves the header off the traffic lights by these two marks.
function markWindow() {
  const root = document.documentElement;
  if (!root) return;
  root.dataset.platform = process.platform;
}
if (document.documentElement) markWindow(); else document.addEventListener('DOMContentLoaded', markWindow, { once: true });
ipcRenderer.on('window:fullscreen', (_event, on) => { if (document.documentElement) document.documentElement.toggleAttribute('data-fullscreen', !!on); });

// Wider resize edges: App.jsx's strips report press / move / release; main reads the cursor itself.
contextBridge.exposeInMainWorld('engelbartWindow', Object.freeze({
  edgeResize: (phase, edge) => ipcRenderer.send('window:edge-resize', String(phase), edge == null ? null : String(edge)),
}));

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
  views: invoke('views'),
  setView: invoke('set-view'),
  nav: invoke('nav'),
  recordEdit: invoke('record-edit'),
  seenAgents: invoke('seen-agents'),
  onNav: (callback) => subscribe('engelbart:nav', callback),
  // the library changed behind the screen's back (a pdf saved as a link became a saved pdf: store/web-pdfs.cjs)
  onLibraryChanged: (callback) => subscribe('engelbart:library-changed', callback),
  // GitHub: the device-flow sign-in (status { configured, connected, login, pending: { userCode, verificationUri }, error, installUrl }) and the App's repositories.
  githubStatus: invoke('github-status'),
  githubConnect: invoke('github-connect'),
  githubCancel: invoke('github-cancel'),
  githubDisconnect: invoke('github-disconnect'),
  githubRepos: invoke('github-repos'),
  githubOpen: invoke('github-open'),
  onGithub: (callback) => subscribe('engelbart:github', callback),
  // ⌘J pressed while a Browser page has the keyboard (src/main/browser/views.cjs); the app's own pages see the key themselves.
  onNextWorkspace: (callback) => subscribe('engelbart:next-workspace', callback),
  listProjects: invoke('list-projects'),
  createProject: invoke('create-project'),
  createProjectWithWelcome: invoke('create-project-with-welcome'),
  // Onboarding (src/main/store/onboarding.cjs).
  instructions: invoke('instructions'),
  setInstructions: invoke('set-instructions'),
  freeFolder: invoke('free-folder'),
  checkFolder: invoke('check-folder'),
  startProject: invoke('start-project'),
  discardLibraryItem: invoke('discard-library-item'),
  renameProject: invoke('rename-project'),
  loadProject: invoke('load-project'),
  setProjectDirectory: invoke('set-project-directory'),
  createWorkspace: invoke('create-workspace'),
  renameWorkspace: invoke('rename-workspace'),
  trashWorkspace: invoke('trash-workspace'),
  restoreWorkspace: invoke('restore-workspace'),
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
  // Build (src/main/build): a workspace's coding agent in a worktree of its own. Every change of one arrives on onBuild as
  // its record; onBuildProgress carries what a running turn is doing ({ projectId, id, activity, log, lines }).
  buildModels: invoke('build-models'), // ('quick' for a post-it's Build)
  rememberModelChoice: invoke('remember-model-choice'), // ('build' | 'quick', { provider, model, effort })
  // Where a Build works: the default repo (a folder named after the project, in the project folder), the project folder,
  // or a library repository ({ kind, id }); a GitHub one is cloned into repos/<name> first (buildClone).
  buildTargets: invoke('build-targets'),
  buildSetDefault: invoke('build-set-default'),
  buildPreflight: invoke('build-preflight'),
  buildInit: invoke('build-init'),
  buildClone: invoke('build-clone'),
  buildStart: invoke('build-start'),
  buildList: invoke('build-list'),
  buildGet: invoke('build-get'),
  buildReply: invoke('build-reply'),
  buildStop: invoke('build-stop'),
  buildResume: invoke('build-resume'),
  buildReview: invoke('build-review'),
  buildAccept: invoke('build-accept'),
  buildFix: invoke('build-fix'),
  buildDiscard: invoke('build-discard'),
  buildPromote: invoke('build-promote'),
  onBuild: (callback) => subscribe('engelbart:build', callback),
  onBuildProgress: (callback) => subscribe('engelbart:build-progress', callback),
  // What a Build has changed since it started, as its worktree stands: after each thing a turn does, and when it ends
  // ({ projectId, id, files, patch, truncated, running }).
  onBuildDiff: (callback) => subscribe('engelbart:build-diff', callback),
  // A runnable its run step got running ({ projectId, id, kind: 'ui' | 'app' | 'terminal', name, url?, session? }):
  // a UI opens in the Stage, a terminal program's session in the terminal.
  onBuildRun: (callback) => subscribe('engelbart:build-run', callback),
  buildRunShow: invoke('build-run-show'),
  buildRunStop: invoke('build-run-stop'),
  buildRunStopRunnable: invoke('build-run-stop-runnable'), // (projectId, id, name | null): an accepted Build's runnable, or all
  // A post-it's Build button asks the window for its Build popup, with the card's text, and where the card and the
  // button are ({ projectId, postItId, text, card, button }, CSS px of the window).
  onBuildQuick: (callback) => subscribe('engelbart:build-quick', callback),
  // A click on a post-it's quick-task state: that task, beside the card ({ projectId, id, postItId, card, button }).
  onBuildQuickOpen: (callback) => subscribe('engelbart:build-quick-open', callback),
  // Clear and the archived versions of a workspace (src/main/store/archive.cjs).
  clearWorkspace: invoke('clear-workspace'),
  restoreArchive: invoke('restore-archive'),
  readArchive: invoke('read-archive'),
  readTextFile: invoke('read-text-file'),
  resolvePageFile: invoke('resolve-page-file'),
  stageFile: invoke('stage-file'),
  library: invoke('library'),
  projectsForLibraryItem: invoke('projects-for-library-item'),
  libraryForProject: invoke('library-for-project'),
  addLibraryItem: invoke('add-library-item'),
  addLibraryPdf: invoke('add-library-pdf'),
  lookupLibraryItem: invoke('lookup-library-item'),
  pickLibraryPaths: invoke('pick-library-paths'),
  linkToWorkspace: invoke('link-to-workspace'),
  unlinkFromWorkspace: invoke('unlink-from-workspace'),
  // E2B previews of saved GitHub repositories (src/main/sandbox). Adding or linking one starts it, and the answer carries
  // `sandbox_error` when it could not start. onSandboxProgress: { dataRoot, run, message, notification? } per change.
  sandboxRuns: invoke('sandbox-runs'),
  ensureSandboxes: invoke('sandbox-ensure'),
  startSandbox: invoke('sandbox-start'),
  stopSandbox: invoke('sandbox-stop'),
  sandboxEnvironment: invoke('sandbox-environment'),
  saveSandboxEnvironment: invoke('sandbox-save-environment'),
  restartSandbox: invoke('sandbox-restart'),
  onSandboxProgress: (callback) => subscribe('engelbart:sandbox-progress', callback),
  previewLibraryItem: invoke('preview-library-item'),
  // A file dropped on the window: where it is on disk (the renderer's File no longer says).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  renameLibraryItem: invoke('rename-library-item'),
  readLibraryFile: invoke('read-library-file'),
  readAnnotations: invoke('read-annotations'),
  writeAnnotations: invoke('write-annotations'),
  // Git, Claude Code and Codex (src/main/tools): what the last check saw, and the setup dialog's buttons.
  // Every change arrives on onTools as a whole snapshot; onToolsOpen is Engelbart ▸ Set Up Tools….
  tools: invoke('tools'),
  toolsCheck: invoke('tools-check'),
  toolsInstall: invoke('tools-install'),
  toolsUpdate: invoke('tools-update'),
  toolsSignIn: invoke('tools-sign-in'),
  toolsCancelSignIn: invoke('tools-cancel-sign-in'),
  toolsSkip: invoke('tools-skip'),
  toolsAskAgain: invoke('tools-ask-again'),
  toolsSetUpdates: invoke('tools-set-updates'),
  onTools: (callback) => subscribe('engelbart:tools', callback),
  onToolsOpen: (callback) => subscribe('engelbart:tools-open', callback),
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
  browserFind: (id, text, options) => ipcRenderer.invoke('browser:find', id, text, options),
  browserStopFind: (id) => ipcRenderer.invoke('browser:stop-find', id),
  onBrowserFound: (callback) => subscribe('browser:found', callback),
  // ⌘T / ⌘W from a page, and the Edit menu's Find items: { name, tab } (tab: the page that had the keyboard, else null).
  onBrowserShortcut: (callback) => subscribe('browser:shortcut', callback),
  // A tab's pdf: { id, url, name, under, loading | bytes | error } (src/main/browser/views.cjs).
  onBrowserPdf: (callback) => subscribe('browser:pdf', callback),
  readPageAnnotations: invoke('read-page-annotations'),
  writePageAnnotations: invoke('write-page-annotations'),
  postItsActivate: (projectId) => ipcRenderer.invoke('post-its:activate', projectId),
  postItsCreate: (projectId) => ipcRenderer.invoke('post-its:create', projectId),
  // The app's own open menus and dialogs (window CSS px): a card under one of them steps aside until it closes.
  postItsBlock: (rects) => ipcRenderer.invoke('post-its:block', rects),
  postItsLayout: () => ipcRenderer.invoke('post-its:layout'),
  // The sidebar's show/hide toggle: every card out of sight (true) or back (false); nothing is created or deleted.
  postItsHide: (hidden) => ipcRenderer.invoke('post-its:hide', !!hidden),
  onPostItsHidden: (callback) => subscribe('post-its:hidden', callback),
  // The trash (2026-09-22): the cards in it, newest first, each { id, text, deleted, expires }; and taking one back out.
  postItsTrashed: (projectId) => ipcRenderer.invoke('post-its:trashed', projectId),
  postItsRestore: (projectId, id) => ipcRenderer.invoke('post-its:restore', projectId, id),
  onPostItsTrash: (callback) => subscribe('post-its:trash', callback),
  onPostItsOpenNote: (callback) => subscribe('post-its:open-note', callback),
  onPostItsOpenLink: (callback) => subscribe('post-its:open-link', callback),
  // Where the sidebar's trash can is (window pixels), so a post-it dropped on it is thrown away; null when there is none.
  postItsTrashRect: (rect) => ipcRenderer.invoke('post-its:trash-rect', rect),
  onPostItsDrag: (callback) => subscribe('post-its:drag', callback),
  onPostItsError: (callback) => subscribe('post-its:error', callback),
  // Pictures of the cards a covering panel is over, to draw under it ({ projectId, cards: [{ id, x, y, width, height, url }] }).
  onPostItsStandIns: (callback) => subscribe('post-its:stand-ins', callback),
  // "Delete task": the post-it into the trash, once its task went to a workspace.
  postItsThrowOut: (projectId, id) => ipcRenderer.invoke('post-its:throw-out', projectId, id),
});

contextBridge.exposeInMainWorld('terminalAPI', terminalAPI);
contextBridge.exposeInMainWorld('engelbartAPI', engelbartAPI);
