// Import your context's calls in the app (2026-10-13): the preload bridge's (src/preload.cjs). The standalone page
// (./standalone.jsx) gives ImportFlow a mock with the same names instead.
import { api } from '../api.js';

const none = () => () => {};

export const importApi = {
  flow: () => api.importFlow(),
  saveFlow: (flow) => api.importFlowSave(flow),
  providers: (fresh) => api.importProviders(fresh === true),
  rememberProvider: (id) => api.importProviderRemember(id),
  browsers: () => api.importBrowsers(),
  chooseBrowser: (id) => api.importBrowserChoose(id),
  keychain: (answer) => api.importKeychain(answer),
  browserAgents: (input) => api.importBrowserAgents(input || {}),
  browserAgentsAnswer: (answer) => api.importBrowserAgentsAnswer(answer),
  discovery: () => api.importDiscovery(),
  discoverProjects: (input) => api.importDiscoverProjects(input || {}),
  discoverTools: (input) => api.importDiscoverTools(input || {}),
  onDiscovery: (callback) => (api.onDiscovery ? api.onDiscovery(callback) : none()),
  diskAccess: () => api.importDiskAccess(),
  foldersAsk: (ids) => api.connectFoldersAsk(ids),
  foldersAsked: () => api.connectFoldersAsked(),
  notesPermission: () => api.connectNotesPermission(),
  tools: () => api.tools(),
  onTools: (callback) => api.onTools(callback),
  toolsInstall: (ids) => api.toolsInstall(ids),
  toolsSignIn: (id) => api.toolsSignIn(id),
  // Connect Claude Code / Codex (2026-10-14): installed, checked and signed in, whichever it still needs, from one press.
  toolsConnect: (id) => api.toolsConnect(id),
  toolsCancelSignIn: (id) => api.toolsCancelSignIn(id),
  openExternal: (url) => api.openExternal(url),
  detect: () => api.connectDetect(),
  pickDirectory: () => window.terminalAPI.pickDirectory(undefined),
  // "Choose files" under Specify context (round 3): files and folders, several at once (the sidebar's Choose from disk…).
  pickFiles: async () => (await api.pickLibraryPaths('any').catch(() => [])).map((file) => ({ path: file, name: file.split('/').filter(Boolean).pop() || file })),
  // Obsidian's vaults for its own Choose files picker (./ObsidianPicker.jsx).
  obsidianTree: () => api.importObsidianTree(),
  connectStart: (choices) => api.connectStart(choices),
  startProject: (input) => api.startProject(input),
  openTrace: () => api.importTraceOpen(),
};
