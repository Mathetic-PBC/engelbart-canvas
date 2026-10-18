'use strict';

// The terminal pane's box recalls commands with ↑/↓ like a shell. It is seeded from the shell's
// own history file, read here (tail only), so yesterday's commands are there on the first ↑.
// Nothing leaves the machine; the list lives in the renderer's memory.
// Windows (2026-10-07, docs/windows-port-log.md): the terminal is PowerShell, so its history comes first: PSReadLine's
// ConsoleHost_history.txt, one command a line, a line ending in ` going on to the next; then Git Bash's.

const fs = require('node:fs');
const path = require('node:path');

const TAIL_BYTES = 512 * 1024;
const MAX_ENTRY = 2000;

// zsh writes its history "metafied": a byte 0x83 means "the next byte, xor 0x20".
function unmetafy(buffer) {
  const out = Buffer.alloc(buffer.length);
  let n = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x83 && i + 1 < buffer.length) { i += 1; out[n] = buffer[i] ^ 0x20; } else out[n] = buffer[i];
    n += 1;
  }
  return out.subarray(0, n);
}

/** Commands from history text, oldest first, duplicates collapsed onto their latest use. */
function parseHistory(text, limit = 300, { continuation = '\\' } = {}) {
  const entries = [];
  let pending = null;
  for (const raw of String(text).split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (pending != null) { line = `${pending}\n${line}`; pending = null; }
    if (line.endsWith(continuation)) { pending = line.slice(0, -1); continue; }
    const command = line.replace(/^: \d+:\d+;/, '').trim();
    if (command && command.length <= MAX_ENTRY) entries.push(command);
  }
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (seen.has(entries[i])) continue;
    seen.add(entries[i]);
    out.push(entries[i]);
  }
  return out.reverse();
}

function readShellHistory({ homeDir, environment = process.env, limit = 300, platform = process.platform } = {}) {
  const powershell = platform === 'win32' ? path.join(environment.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt') : null;
  const candidates = [powershell, environment.HISTFILE, path.join(homeDir, '.zsh_history'), path.join(homeDir, '.zhistory'), path.join(homeDir, '.bash_history')]
    .filter((file) => typeof file === 'string' && file);
  for (const file of candidates) {
    let handle;
    try {
      handle = fs.openSync(file, 'r');
      const size = fs.fstatSync(handle).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      let text = (file === powershell ? buffer : unmetafy(buffer)).toString('utf8'); // only zsh metafies
      if (length < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
      return parseHistory(text, limit, file === powershell ? { continuation: '`' } : {});
    } catch {
      // try the next candidate
    } finally {
      if (handle !== undefined) try { fs.closeSync(handle); } catch { /* ignore */ }
    }
  }
  return [];
}

module.exports = { readShellHistory, parseHistory, unmetafy };
