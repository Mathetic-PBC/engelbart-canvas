'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const pty = require('node-pty');
const { createLaunchSpec, PROVIDERS } = require('./launch.cjs');

const DEFAULT_MAX_SESSIONS = 12;
const DEFAULT_MAX_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_MAX_REPLAY_ENTRIES = 600;
const DEFAULT_MAX_UNACKED_BYTES = 512 * 1024;
const DEFAULT_RESUME_UNACKED_BYTES = 128 * 1024;
const DEFAULT_MAX_OUTPUT_BATCH_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

function validateSessionId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 128) {
    throw new TypeError('Session id must be a string');
  }
}

function validateDimensions(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500) {
    throw new TypeError('cols must be an integer between 2 and 500');
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 500) {
    throw new TypeError('rows must be an integer between 1 and 500');
  }
}

function utf8Tail(value, maximumBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function splitUtf8Prefix(value, maximumBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return [value, ''];
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  if (end === 0) end = maximumBytes;
  return [bytes.subarray(0, end).toString('utf8'), bytes.subarray(end).toString('utf8')];
}

function waitForExit(record, timeout) {
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve('exited');
    };
    const timer = setTimeout(() => {
      const index = record.closeWaiters.indexOf(waiter);
      if (index !== -1) record.closeWaiters.splice(index, 1);
      resolve('timeout');
    }, timeout);
    record.closeWaiters.push(waiter);
  });
}

class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.environment = options.environment || process.env;
    // Read at each start: what changes while the app runs (Engelbart's own Git once the tool check chose it).
    this.extraEnvironment = options.extraEnvironment || (() => ({}));
    this.pty = options.pty || pty;
    this.maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
    this.maxReplayBytes = options.maxReplayBytes || DEFAULT_MAX_REPLAY_BYTES;
    this.maxReplayEntries = options.maxReplayEntries || DEFAULT_MAX_REPLAY_ENTRIES;
    this.maxUnackedBytes = options.maxUnackedBytes || DEFAULT_MAX_UNACKED_BYTES;
    this.resumeUnackedBytes = options.resumeUnackedBytes || DEFAULT_RESUME_UNACKED_BYTES;
    this.maxOutputBatchBytes = options.maxOutputBatchBytes || DEFAULT_MAX_OUTPUT_BATCH_BYTES;
    this.batchDelayMs = Number.isInteger(options.batchDelayMs) ? options.batchDelayMs : 8;
    this.closeTimeoutMs = Number.isInteger(options.closeTimeoutMs) ? options.closeTimeoutMs : 1500;
    this.forceCloseTimeoutMs = Number.isInteger(options.forceCloseTimeoutMs) ? options.forceCloseTimeoutMs : 500;
    this.sessions = new Map();
    this.rendererAttached = true;
  }

  create(request) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`At most ${this.maxSessions} sessions may be open`);
    }
    const launch = createLaunchSpec(request, { ...this.environment, ...this.extraEnvironment() });
    const id = randomUUID();
    const processHandle = this.pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: launch.cols,
      rows: launch.rows,
      cwd: launch.cwd,
      env: launch.env,
    });
    const record = {
      id,
      provider: launch.provider,
      title: launch.provider === 'shell' ? path.basename(launch.file) : PROVIDERS[launch.provider].name,
      cwd: launch.cwd,
      shell: launch.file,
      pid: processHandle.pid,
      cols: launch.cols,
      rows: launch.rows,
      status: 'running',
      createdAt: new Date().toISOString(),
      history: [],
      historyBytes: 0,
      sequence: 0,
      acknowledged: 0,
      outstanding: new Map(),
      unackedBytes: 0,
      paused: false,
      outputBatch: '',
      batchTimer: null,
      closeWaiters: [],
      process: processHandle,
      disposables: [],
    };
    this.sessions.set(id, record);
    record.disposables.push(processHandle.onData((data) => this.#queueOutput(record, data)));
    record.disposables.push(processHandle.onExit(({ exitCode, signal }) => this.#handleExit(record, exitCode, signal)));
    return this.#snapshot(record);
  }

  list() {
    return [...this.sessions.values()].map((record) => this.#snapshot(record));
  }

  get(id) {
    validateSessionId(id);
    const record = this.sessions.get(id);
    return record ? this.#snapshot(record) : null;
  }

  write(id, data) {
    const record = this.#running(id);
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) {
      throw new TypeError(`Terminal input must be a string of at most ${MAX_INPUT_BYTES} bytes`);
    }
    record.process.write(data);
  }

  resize(id, cols, rows) {
    const record = this.#running(id);
    validateDimensions(cols, rows);
    record.process.resize(cols, rows);
    record.cols = cols;
    record.rows = rows;
  }

  acknowledge(id, sequence) {
    if (typeof id !== 'string' || !Number.isInteger(sequence)) return false;
    const record = this.sessions.get(id);
    if (!record || sequence <= record.acknowledged || sequence > record.sequence) return false;
    for (const [candidate, bytes] of record.outstanding) {
      if (candidate <= sequence) {
        record.unackedBytes -= bytes;
        record.outstanding.delete(candidate);
      }
    }
    record.acknowledged = sequence;
    record.unackedBytes = Math.max(0, record.unackedBytes);
    if (record.paused && record.unackedBytes <= this.resumeUnackedBytes) this.#resume(record);
    return true;
  }

  attachRenderer() {
    this.rendererAttached = true;
    for (const record of this.sessions.values()) {
      record.acknowledged = record.sequence;
      record.outstanding.clear();
      record.unackedBytes = 0;
      this.#resume(record);
    }
  }

  detachRenderer() {
    this.rendererAttached = false;
    for (const record of this.sessions.values()) {
      record.acknowledged = record.sequence;
      record.outstanding.clear();
      record.unackedBytes = 0;
      this.#resume(record);
    }
  }

  flowState(id) {
    validateSessionId(id);
    const record = this.sessions.get(id);
    if (!record) return null;
    return { paused: record.paused, unackedBytes: record.unackedBytes, acknowledged: record.acknowledged };
  }

  async close(id) {
    validateSessionId(id);
    const record = this.sessions.get(id);
    if (!record) return false;
    if (record.status === 'running') {
      const exited = waitForExit(record, this.closeTimeoutMs);
      record.process.kill();
      if (await exited === 'timeout' && record.status === 'running') {
        const forcedExit = waitForExit(record, this.forceCloseTimeoutMs);
        record.process.kill('SIGKILL');
        if (await forcedExit === 'timeout' && record.status === 'running') {
          throw new Error('PTY did not exit after termination signals');
        }
      }
    }
    this.#dispose(record);
    this.sessions.delete(id);
    return true;
  }

  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  #running(id) {
    validateSessionId(id);
    const record = this.sessions.get(id);
    if (!record) throw new Error('Unknown session');
    if (record.status !== 'running') throw new Error('Session has exited');
    return record;
  }

  #queueOutput(record, data) {
    if (typeof data !== 'string' || data.length === 0 || record.status !== 'running') return;
    record.outputBatch += data;
    while (Buffer.byteLength(record.outputBatch) > this.maxOutputBatchBytes) {
      const [batch, remainder] = splitUtf8Prefix(record.outputBatch, this.maxOutputBatchBytes);
      record.outputBatch = batch;
      this.#flushOutput(record);
      record.outputBatch = remainder;
    }
    if (!record.batchTimer) {
      record.batchTimer = setTimeout(() => this.#flushOutput(record), this.batchDelayMs);
    }
  }

  #flushOutput(record) {
    if (record.batchTimer) clearTimeout(record.batchTimer);
    record.batchTimer = null;
    if (!record.outputBatch) return;
    const data = record.outputBatch;
    record.outputBatch = '';
    const sequence = ++record.sequence;
    let replayData = utf8Tail(data, this.maxReplayBytes);
    const replayBytes = Buffer.byteLength(replayData);
    record.history.push({ sequence, data: replayData });
    record.historyBytes += replayBytes;
    while (record.history.length > this.maxReplayEntries || record.historyBytes > this.maxReplayBytes) {
      const removed = record.history.shift();
      record.historyBytes -= Buffer.byteLength(removed.data);
    }
    if (this.rendererAttached) {
      const outputBytes = Buffer.byteLength(data);
      record.outstanding.set(sequence, outputBytes);
      record.unackedBytes += outputBytes;
    }
    this.emit('data', { id: record.id, sequence, data });
    if (this.rendererAttached && record.unackedBytes > this.maxUnackedBytes && !record.paused) {
      record.process.pause();
      record.paused = true;
    }
  }

  #handleExit(record, exitCode, signal) {
    this.#flushOutput(record);
    record.status = 'exited';
    record.exitCode = exitCode;
    if (signal) record.signal = signal;
    this.emit('exit', { id: record.id, exitCode, ...(signal ? { signal } : {}) });
    for (const resolve of record.closeWaiters.splice(0)) resolve('exited');
  }

  #resume(record) {
    if (!record.paused) return;
    record.process.resume();
    record.paused = false;
  }

  #dispose(record) {
    if (record.batchTimer) clearTimeout(record.batchTimer);
    for (const disposable of record.disposables) disposable.dispose();
    record.disposables = [];
  }

  #snapshot(record) {
    return {
      id: record.id,
      provider: record.provider,
      title: record.title,
      cwd: record.cwd,
      shell: record.shell,
      pid: record.pid,
      cols: record.cols,
      rows: record.rows,
      status: record.status,
      ...(record.status === 'exited' ? { exitCode: record.exitCode } : {}),
      createdAt: record.createdAt,
      history: record.history.map((entry) => ({ ...entry })),
    };
  }
}

module.exports = { SessionManager };
