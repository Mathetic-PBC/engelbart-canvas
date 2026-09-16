'use strict';

const DEFAULT_CHUNK_BYTES = 48 * 1024;
const UTF8_ENCODER = new TextEncoder();

function byteLength(value) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function splitUtf8Chunks(value, maximumBytes = DEFAULT_CHUNK_BYTES) {
  if (typeof value !== 'string') throw new TypeError('Terminal input must be a string');
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('Chunk size must be a positive integer');
  }
  if (!value) return [];

  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (characterBytes > maximumBytes) {
      throw new RangeError('Chunk limit cannot contain one complete character');
    }
    if (current.length && currentBytes + characterBytes > maximumBytes) {
      chunks.push(current.join(''));
      current = [];
      currentBytes = 0;
    }
    current.push(character);
    currentBytes += characterBytes;
  }
  if (current.length) chunks.push(current.join(''));
  return chunks;
}

function terminalKeyAction(event) {
  if (!event || event.isComposing) return null;
  if (
    event.key === 'Enter'
    && event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
  ) return 'line-feed';
  if (
    typeof event.key === 'string'
    && event.key.toLowerCase() === 'c'
    && event.metaKey
    && !event.altKey
    && !event.ctrlKey
  ) return 'copy';
  return null;
}

function handleTerminalKeyEvent(event, send) {
  const action = terminalKeyAction(event);
  if (action === 'line-feed') {
    event.preventDefault?.();
    if (event.type === 'keydown') send('\n');
    return false;
  }
  if (action === 'copy') return false;
  return true;
}

function workspaceKeyAction(event, { dialogOpen = false, findOpen = false } = {}) {
  if (!event || dialogOpen) return null;
  if (event.metaKey && !event.altKey && !event.ctrlKey && event.key === '+') {
    return { type: 'font-increase' };
  }
  if (event.metaKey && !event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
    return { type: 'activate-session', index: Number(event.key) - 1 };
  }
  if (event.key === 'Escape' && findOpen) return { type: 'close-find' };
  return null;
}

class CrossSourceShortcutGate {
  constructor(windowMs = 100) {
    this.windowMs = windowMs;
    this.last = null;
  }

  allow(action, source, now) {
    if (
      this.last
      && this.last.action === action
      && this.last.source !== source
      && now >= this.last.now
      && now - this.last.now <= this.windowMs
    ) return false;
    this.last = { action, source, now };
    return true;
  }
}

function initialTerminalGeometry(snapshot) {
  const cols = snapshot?.cols;
  const rows = snapshot?.rows;
  if (
    !Number.isInteger(cols) || cols < 2 || cols > 500
    || !Number.isInteger(rows) || rows < 1 || rows > 500
  ) throw new TypeError('Snapshot dimensions are invalid');
  return { cols, rows };
}

const CHROME_FOCUS_ACTIONS = new Set(['tab', 'tab-close', 'sidebar', 'sidebar-close']);

function preservedChromeFocus(candidate, sessionIds) {
  if (
    !candidate
    || typeof candidate.sessionId !== 'string'
    || !CHROME_FOCUS_ACTIONS.has(candidate.action)
    || !new Set(sessionIds).has(candidate.sessionId)
  ) return null;
  return { sessionId: candidate.sessionId, action: candidate.action };
}

function openTerminalLink(uri, openExternal, onError) {
  return Promise.resolve()
    .then(() => openExternal(uri))
    .catch((error) => onError(error));
}

class PendingEvents {
  constructor({ maxEntries = 1200, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.order = [];
    this.exits = new Map();
    this.entryCount = 0;
    this.bytes = 0;
  }

  pushData(payload) {
    if (
      !payload
      || typeof payload.id !== 'string'
      || !Number.isInteger(payload.sequence)
      || payload.sequence < 1
      || typeof payload.data !== 'string'
    ) return [];
    let sessionEntries = this.entries.get(payload.id);
    if (!sessionEntries) {
      sessionEntries = new Map();
      this.entries.set(payload.id, sessionEntries);
    }
    if (sessionEntries.has(payload.sequence)) return [];
    const stored = { id: payload.id, sequence: payload.sequence, data: payload.data };
    stored.bytes = byteLength(stored.data);
    sessionEntries.set(stored.sequence, stored);
    this.order.push(stored);
    this.entryCount += 1;
    this.bytes += stored.bytes;

    const dropped = [];
    while (this.entryCount > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.order.shift();
      if (!oldest) break;
      const candidates = this.entries.get(oldest.id);
      if (!candidates || candidates.get(oldest.sequence) !== oldest) continue;
      candidates.delete(oldest.sequence);
      if (candidates.size === 0) this.entries.delete(oldest.id);
      this.entryCount -= 1;
      this.bytes -= oldest.bytes;
      dropped.push({ id: oldest.id, sequence: oldest.sequence, data: oldest.data });
    }
    return dropped;
  }

  pushExit(payload) {
    if (!payload || typeof payload.id !== 'string') return;
    this.exits.set(payload.id, { ...payload });
  }

  take(id, history = []) {
    const merged = new Map();
    for (const entry of history) {
      if (entry && Number.isInteger(entry.sequence) && typeof entry.data === 'string') {
        merged.set(entry.sequence, { sequence: entry.sequence, data: entry.data });
      }
    }
    const sessionEntries = this.entries.get(id);
    if (sessionEntries) {
      for (const entry of sessionEntries.values()) {
        merged.set(entry.sequence, { sequence: entry.sequence, data: entry.data });
        this.entryCount -= 1;
        this.bytes -= entry.bytes;
      }
      this.entries.delete(id);
      this.order = this.order.filter((entry) => entry.id !== id);
    }
    const exit = this.exits.get(id) || null;
    this.exits.delete(id);
    return {
      data: [...merged.values()].sort((left, right) => left.sequence - right.sequence),
      exit,
    };
  }
}

module.exports = {
  CrossSourceShortcutGate,
  DEFAULT_CHUNK_BYTES,
  handleTerminalKeyEvent,
  initialTerminalGeometry,
  openTerminalLink,
  PendingEvents,
  preservedChromeFocus,
  splitUtf8Chunks,
  terminalKeyAction,
  workspaceKeyAction,
};
