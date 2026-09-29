// Terminal session store — a module-level singleton so PTY sessions and their xterm
// instances survive React unmounts (the workspace hides the pane; the shell keeps running).
// Port of ~/experimental-terminal/src/renderer/index.js (session records, output queueing,
// pending-event merge, flow-control acknowledgements) against the unchanged
// `window.terminalAPI` bridge (docs/bridge-contract.md in Experimental Terminal).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  DEFAULT_CHUNK_BYTES,
  handleTerminalKeyEvent,
  initialTerminalGeometry,
  openTerminalLink,
  browserLink,
  PendingEvents,
  splitUtf8Chunks,
} from './helpers.cjs';
import { OPEN_IN_BROWSER } from '../model/address.js';

const PROVIDER_NAMES = { shell: 'Shell', claude: 'Claude Code', codex: 'Codex' };
const DEFAULT_FONT_SIZE = 12.5;

const THEME = {
  background: '#ffffff',
  foreground: '#171717',
  cursor: '#0070f3',
  cursorAccent: '#ffffff',
  selectionBackground: '#dbe8fb',
  selectionForeground: '#171717',
  black: '#171717',
  red: '#c8102e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0070f3',
  magenta: '#8250df',
  cyan: '#0e7490',
  white: '#e2e2e2',
  brightBlack: '#8f8f8f',
  brightRed: '#e70022',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#3291ff',
  brightMagenta: '#a475f9',
  brightCyan: '#0891b2',
  brightWhite: '#ffffff',
};

const state = {
  ready: false,
  bootstrapping: null,
  bootstrapComplete: false,
  home: '',
  settings: { fontSize: DEFAULT_FONT_SIZE, lastCwd: '', sidebarVisible: true },
  sessions: new Map(),
  providers: new Map([['shell', { id: 'shell', name: 'Shell', available: true }]]),
  // Sessions created through this store remember the project that owns them.
  projectOf: new Map(),
  errors: [],
};
const pending = new PendingEvents();
const listeners = new Set();
let listenersRegistered = false;
let overflowNotified = false;

function api() {
  const bridge = window.terminalAPI;
  if (!bridge) throw new Error('Terminal bridge is unavailable');
  return bridge;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // A failing listener must not break the others.
    }
  }
}

function pushError(message) {
  state.errors = [...state.errors.slice(-9), { at: Date.now(), message }];
  notify();
}

export function providerName(id) {
  return state.providers.get(id)?.name || PROVIDER_NAMES[id] || id;
}

function truncateTitle(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, 160) : fallback;
}

function inputFor(record, value) {
  if (!record || record.snapshot.status !== 'running' || !value) return;
  let chunks;
  try {
    chunks = splitUtf8Chunks(value, DEFAULT_CHUNK_BYTES);
  } catch (error) {
    pushError(`Input could not be sent: ${errorMessage(error)}`);
    return;
  }
  record.inputChain = record.inputChain
    .then(async () => {
      for (const chunk of chunks) await api().writeSession(record.snapshot.id, chunk);
    })
    .catch((error) => pushError(`Input could not be sent: ${errorMessage(error)}`));
}

function openLink(uri) {
  void openTerminalLink(
    uri,
    (value) => { window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: browserLink(value) } })); },
    (error) => pushError(`Link could not be opened: ${errorMessage(error)}`),
  );
}

function makeTerminalRecord(snapshot, projectId) {
  const terminal = new Terminal({
    ...initialTerminalGeometry(snapshot),
    allowProposedApi: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none', // no hollow cursor in a transcript that is not taking keys
    fontFamily: "'Source Code Pro', Menlo, SFMono-Regular, monospace",
    fontSize: state.settings.fontSize || DEFAULT_FONT_SIZE,
    lineHeight: 1.18,
    letterSpacing: 0,
    linkHandler: {
      activate: (_event, uri) => openLink(uri),
    },
    macOptionIsMeta: true,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    scrollback: 10000,
    scrollSensitivity: 2.5,
    fastScrollSensitivity: 10,
    smoothScrollDuration: 90,
    theme: THEME,
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));

  // The view stays detached until a pane adopts it; xterm renders into it once it is
  // in the document (open() is deferred to mountView so measurements are real).
  const view = document.createElement('div');
  view.className = 'terminal-view';
  view.id = `terminal-${snapshot.id}`;
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-label', `${providerName(snapshot.provider)} terminal`);
  // Geometry lives in terminal.css, shared with the shell's command dock.

  const record = {
    snapshot: { ...snapshot, history: undefined },
    displayTitle: snapshot.title || providerName(snapshot.provider),
    terminal,
    fitAddon,
    searchAddon,
    view,
    opened: false,
    lastQueuedSequence: 0,
    inputChain: Promise.resolve(),
    lastDimensions: { cols: snapshot.cols, rows: snapshot.rows },
    disposables: [],
    projectId: projectId || snapshot.projectId || state.projectOf.get(snapshot.id) || null,
    shell: { integrated: false, busy: snapshot.provider !== 'shell', command: '', cwd: snapshot.cwd },
    inputLocked: false,
    onLockedKey: null,
    onLockedFocus: null,
  };

  // While the pane's own box is the input, the transcript never holds focus (so it shows no
  // cursor and a click does nothing); dragging still selects text for ⌘C.
  // A press on empty space there starts nothing: only a drag that begins on printed text selects.
  view.addEventListener('mousedown', (event) => {
    if (!record.inputLocked || textUnder(record, event)) return;
    event.preventDefault();
    event.stopPropagation();
    terminal.clearSelection();
  }, true);
  view.addEventListener('focusin', () => {
    if (!record.inputLocked) return;
    terminal.blur();
    if (record.onLockedFocus) record.onLockedFocus();
  });

  // Shell-integration marks from the zsh wrappers (src/main/shell-rc.cjs): A = ready for a command,
  // C = a command started, E;<line> = its command line, P;Cwd=<dir> = where the shell is.
  record.disposables.push(terminal.parser.registerOscHandler(633, (data) => { applyShellMark(record, data); return true; }));
  record.disposables.push(terminal.onData((data) => inputFor(record, data)));
  record.disposables.push(terminal.onTitleChange((title) => {
    record.displayTitle = truncateTitle(title, record.snapshot.title || providerName(record.snapshot.provider));
    notify();
  }));
  terminal.attachCustomKeyEventHandler((event) => {
    // While the pane's own box is the input (shell idle), the transcript does not take typing.
    if (record.inputLocked && !event.metaKey) {
      if (event.type === 'keydown' && record.onLockedKey) record.onLockedKey(event);
      return false;
    }
    return handleTerminalKeyEvent(event, (data) => inputFor(record, data));
  });
  return record;
}

/** Whether the pointer is over a printed character of the transcript (not blank space or an empty row). */
function textUnder(record, event) {
  const screen = record.view.querySelector('.xterm-screen');
  if (!screen) return false;
  const box = screen.getBoundingClientRect();
  const { cols, rows, buffer } = record.terminal;
  if (!box.width || !box.height || event.clientX < box.left || event.clientY < box.top) return false;
  const col = Math.floor((event.clientX - box.left) / (box.width / cols));
  const row = Math.floor((event.clientY - box.top) / (box.height / rows));
  if (col >= cols || row >= rows) return false;
  const line = buffer.active.getLine(buffer.active.viewportY + row);
  return !!line && col < line.translateToString(true).length;
}

function applyShellMark(record, data) {
  const text = String(data || '');
  const kind = text[0];
  const rest = text.length > 2 ? text.slice(2) : '';
  const shell = record.shell;
  if (kind === 'A') record.shell = { ...shell, integrated: true, busy: false, command: '' };
  else if (kind === 'C') record.shell = { ...shell, integrated: true, busy: true };
  else if (kind === 'E') record.shell = { ...shell, command: rest };
  else if (kind === 'P' && rest.startsWith('Cwd=')) record.shell = { ...shell, cwd: rest.slice(4) || shell.cwd };
  else return;
  notify();
}

function queueOutput(record, entry) {
  if (!record || !entry || entry.sequence <= record.lastQueuedSequence) return;
  record.lastQueuedSequence = entry.sequence;
  record.terminal.write(entry.data, () => api().acknowledge(record.snapshot.id, entry.sequence));
}

function applyExit(record, event) {
  if (!record || record.snapshot.status === 'exited') return;
  record.snapshot.status = 'exited';
  record.snapshot.exitCode = event.exitCode;
  record.snapshot.signal = event.signal;
  notify();
}

function addSession(snapshot, projectId) {
  if (!snapshot || state.sessions.has(snapshot.id)) return state.sessions.get(snapshot.id);
  const record = makeTerminalRecord(snapshot, projectId);
  state.sessions.set(snapshot.id, record);
  if (record.projectId) state.projectOf.set(snapshot.id, record.projectId);
  const staged = pending.take(snapshot.id, snapshot.history || []);
  for (const entry of staged.data) queueOutput(record, entry);
  if (snapshot.status === 'exited') {
    record.snapshot.status = 'exited';
    record.snapshot.exitCode = snapshot.exitCode;
  }
  if (staged.exit) applyExit(record, staged.exit);
  notify();
  return record;
}

function removeSession(id) {
  const record = state.sessions.get(id);
  if (!record) return;
  for (const disposable of record.disposables) disposable.dispose();
  record.terminal.dispose();
  record.view.remove();
  state.sessions.delete(id);
  state.projectOf.delete(id);
  notify();
}

function registerListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;
  const bridge = api();
  bridge.onData((payload) => {
    const record = state.sessions.get(payload?.id);
    if (record) {
      queueOutput(record, payload);
      return;
    }
    const dropped = pending.pushData(payload);
    for (const item of dropped) bridge.acknowledge(item.id, item.sequence);
    if (dropped.length && state.bootstrapComplete && !overflowNotified) {
      overflowNotified = true;
      pushError('Terminal output arrived faster than the workspace could attach. The oldest pending output was released.');
    }
  });
  bridge.onExit((payload) => {
    const record = state.sessions.get(payload?.id);
    if (record) applyExit(record, payload);
    else pending.pushExit(payload);
  });
}

/** Bootstrap once: attach listeners before the snapshot, merge buffered events, discover providers. */
export function bootstrap() {
  if (state.bootstrapping) return state.bootstrapping;
  state.bootstrapping = (async () => {
    try {
      registerListeners();
      const initial = await api().bootstrap();
      state.home = initial.home;
      state.settings = { ...state.settings, ...(initial.settings || {}) };
      for (const snapshot of initial.sessions || []) addSession(snapshot);
      state.ready = true;
    } catch (error) {
      pushError(`Terminal workspace could not start: ${errorMessage(error)}`);
    } finally {
      state.bootstrapComplete = true;
      notify();
    }
    void api().providers().then((available) => {
      for (const provider of available) state.providers.set(provider.id, provider);
      notify();
    }).catch((error) => {
      pushError(`CLI availability could not be checked: ${errorMessage(error)}`);
    });
    return state;
  })();
  return state.bootstrapping;
}

export function getState() {
  return state;
}

export function subscribe(listener) {
  if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionsFor(projectId) {
  return [...state.sessions.values()].filter((record) => record.projectId === projectId);
}

/** Estimate cols/rows from a stage element before the PTY exists (ET estimateDimensions). */
export function estimateDimensions(element, fontSize = state.settings.fontSize || DEFAULT_FONT_SIZE) {
  const bounds = element ? element.getBoundingClientRect() : { width: 800, height: 300 };
  return {
    cols: Math.max(20, Math.min(500, Math.floor((bounds.width - 24) / (fontSize * 0.61)))),
    rows: Math.max(5, Math.min(500, Math.floor((bounds.height - 18) / (fontSize * 1.2)))),
  };
}

export async function createSession({ provider = 'shell', cwd, projectId, workspaceId, cols, rows } = {}) {
  await bootstrap();
  const dimensions = Number.isInteger(cols) && Number.isInteger(rows) ? { cols, rows } : estimateDimensions(null);
  const workingDirectory = cwd || state.settings.lastCwd || state.home;
  const snapshot = await api().createSession({ provider, cwd: workingDirectory, projectId, workspaceId, ...dimensions });
  const record = addSession(snapshot, projectId);
  state.settings.lastCwd = snapshot.cwd;
  void api().saveSettings({ lastCwd: snapshot.cwd }).catch(() => {});
  return record;
}

/** Ask main to close the PTY; a running process is ended without asking. */
export async function closeSession(id) {
  try {
    const closed = await api().closeSession(id);
    if (!closed) return false;
    removeSession(id);
    return true;
  } catch (error) {
    pushError(`Session could not be closed: ${errorMessage(error)}`);
    return false;
  }
}

/** Wipe a session's transcript, scrollback and all; whatever runs in it is left alone (the last tab's ×, 2026-09-25). */
export function clearSession(id) {
  const record = state.sessions.get(id);
  if (!record) return false;
  record.terminal.clear();
  record.terminal.clearSelection();
  return true;
}

/** Put a session's view into a stage element (opening xterm on first mount) and fit it. */
export function mountView(id, stage) {
  const record = state.sessions.get(id);
  if (!record || !stage) return null;
  if (record.view.parentElement !== stage) stage.appendChild(record.view);
  record.view.hidden = false;
  if (!record.opened) {
    record.terminal.open(record.view);
    record.opened = true;
    useGpuRenderer(record);
  }
  return record;
}

// The GPU renderer is what makes scrolling a long transcript smooth; the DOM renderer remains
// the fallback when WebGL is unavailable or its context is lost.
function useGpuRenderer(record) {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    record.terminal.loadAddon(addon);
  } catch {
    // DOM renderer.
  }
}

export function unmountView(id) {
  const record = state.sessions.get(id);
  if (!record) return;
  record.view.hidden = true;
  record.view.remove();
}

/** Fit the terminal to its view and tell the PTY when the grid changed (ET fitActiveTerminal). */
export function fitSession(id) {
  const record = state.sessions.get(id);
  if (!record || !record.opened || record.view.hidden || !record.view.isConnected) return null;
  try {
    record.fitAddon.fit();
  } catch {
    return null;
  }
  const { cols, rows } = record.terminal;
  if (
    record.snapshot.status === 'running'
    && (cols !== record.lastDimensions.cols || rows !== record.lastDimensions.rows)
  ) {
    record.lastDimensions = { cols, rows };
    void api().resizeSession(record.snapshot.id, cols, rows).catch((error) => {
      pushError(`Terminal could not be resized: ${errorMessage(error)}`);
    });
  }
  return { cols, rows };
}

export function focusSession(id) {
  const record = state.sessions.get(id);
  if (record && record.opened) record.terminal.focus();
}

export function setFontSize(next) {
  const fontSize = Math.max(10, Math.min(24, next));
  if (fontSize === state.settings.fontSize) return;
  state.settings.fontSize = fontSize;
  for (const record of state.sessions.values()) record.terminal.options.fontSize = fontSize;
  void api().saveSettings({ fontSize }).catch(() => {});
  notify();
}

export function dismissError(at) {
  state.errors = state.errors.filter((entry) => entry.at !== at);
  notify();
}

export { PROVIDER_NAMES };

/** Send raw input to a running session: a command line typed in the pane's own box, or a control character. */
export function sendInput(id, data) {
  const record = state.sessions.get(id);
  if (record) inputFor(record, data);
}

/** The native folder picker (main process); resolves to a path or null. */
export function pickDirectory(current) {
  return api().pickDirectory(current);
}

/** While locked, keys pressed in the transcript go to `onKey` (the pane's box) instead of the PTY. */
export function setInputLock(id, locked, onKey = null, onFocus = null) {
  const record = state.sessions.get(id);
  if (!record) return;
  record.inputLocked = !!locked;
  record.onLockedKey = locked ? onKey : null;
  record.onLockedFocus = locked ? onFocus : null;
  record.view.classList.toggle('locked', !!locked);
  if (locked && record.opened && record.view.contains(document.activeElement)) record.terminal.blur();
}

/** The text selected in a session's transcript ('' when none). */
export function selectionText(id) {
  const record = state.sessions.get(id);
  return record && record.opened ? record.terminal.getSelection() : '';
}
