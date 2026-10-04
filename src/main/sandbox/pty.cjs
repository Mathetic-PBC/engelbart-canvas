'use strict';

// A shell in a repository's E2B sandbox, shaped like the part of node-pty that ../terminal/session-manager.cjs uses:
// spawn() → { pid, onData, onExit, write, resize, kill, pause, resume }, and wake().
//
// What a live sandbox did (engelbart-runner, 2026-10-03): a pty is an interactive bash that resizes and prints UTF-8
// as any terminal. It outlives its sandbox's pause, shell state and all, but its output stream does not: wait() rejects
// with a TimeoutError ("[unavailable] … ended before the stream completed") within seconds of the pause. Once
// Sandbox.connect has resumed the sandbox, pty.connect(pid) takes the same shell back; what it printed in between is
// lost. So a dropped stream is sleep, not an exit: the terminal says so, and the next keystroke, or opening it again,
// wakes it ("Waking…" until the shell answers). An exit is an exit code. A pid the sandbox no longer has (the shell
// ended while it slept) gets a new shell; a sandbox E2B no longer has ends the session.
//
// The E2B key is asked for at each connection (`apiKey`), never kept. Saved environment values go in as the pty's
// environment (`env`), never on a command line. Flow control (pause/resume) cannot hold back a remote shell: no-ops.
const IDLE = 10 * 60_000; // worker.cjs's: a sandbox woken here sleeps again 10 minutes after its last use (or ping)
const MAX_PENDING = 64 * 1024;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const CLEAR_LINE = '\r\x1b[2K';
const ASLEEP = '[sandbox asleep · press Enter to wake it]';
const notFound = (error) => error?.name === 'NotFoundError' || error?.name === 'SandboxNotFoundError' || error?.status === 404;
const exitCodeOf = (error) => (Number.isInteger(error?.exitCode) ? error.exitCode : null);

// `Sandbox`: E2B's (tests pass a fake). `requestTimeoutMs`: each E2B request's limit.
function createSandboxPty({ Sandbox = null, idleMs = IDLE, requestTimeoutMs = 30_000 } = {}) {
  const sdk = () => Sandbox || require('e2b').Sandbox;
  // `file`: the sandbox's id (node-pty's place for the program). options: { cols, rows, cwd, env, apiKey: async () →
  // the E2B key, banner: text shown once, above the first shell's prompt }.
  function spawn(sandboxId, _args, options = {}) {
    const { cwd, env = {}, apiKey, banner = '' } = options;
    const dataListeners = new Set(), exitListeners = new Set();
    const encoder = new TextEncoder();
    let state = 'connecting'; // 'connecting' | 'live' | 'asleep' | 'closed'
    let sandbox = null, pid = null, generation = 0, connecting = null, opened = false;
    let size = { cols: options.cols || 80, rows: options.rows || 24 };
    let pending = [], pendingBytes = 0, sending = Promise.resolve();
    const emit = (text) => { for (const listener of [...dataListeners]) listener(text); };
    const subscribe = (set) => (listener) => { set.add(listener); return { dispose: () => set.delete(listener) }; };

    function finish(event) {
      if (state === 'closed') return;
      state = 'closed';
      pending = []; pendingBytes = 0;
      queueMicrotask(() => { for (const listener of [...exitListeners]) listener(event); });
    }
    function asleep(gen) {
      if (gen !== generation || state !== 'live') return;
      state = 'asleep';
      emit(`\r\n${dim(ASLEEP)}\r\n`);
    }
    function watch(handle, gen) {
      handle.wait().then(() => { if (gen === generation) finish({ exitCode: 0 }); }, (error) => {
        if (gen !== generation) return;
        const code = exitCodeOf(error);
        if (code !== null) finish({ exitCode: code });
        else asleep(gen);
      });
    }
    function send(data) {
      const target = sandbox, at = pid, gen = generation;
      sending = sending.then(() => target.pty.sendInput(at, encoder.encode(data), { requestTimeoutMs })).catch(() => asleep(gen));
    }
    function flush() {
      const queued = pending;
      pending = []; pendingBytes = 0;
      for (const data of queued) send(data);
    }
    function connect() {
      if (connecting || state === 'closed') return connecting || Promise.resolve();
      state = 'connecting';
      const gen = ++generation;
      emit(dim('Waking…'));
      connecting = (async () => {
        const decoder = new TextDecoder();
        const early = [];
        let shown = false;
        const onData = (bytes) => {
          if (gen !== generation || state === 'closed') return;
          const text = decoder.decode(bytes, { stream: true });
          if (text) { if (shown) emit(text); else early.push(text); }
        };
        try {
          const key = await apiKey();
          try { sandbox = await sdk().connect(sandboxId, { apiKey: key, timeoutMs: idleMs, requestTimeoutMs }); }
          catch (error) {
            if (!notFound(error)) throw error;
            if (gen !== generation) return;
            emit(`${CLEAR_LINE}${red('This sandbox is gone. Build the repository again from its build details.')}\r\n`);
            finish({ exitCode: null });
            return;
          }
          let handle = null, fresh = false;
          if (pid !== null) {
            try { handle = await sandbox.pty.connect(pid, { onData, timeoutMs: 0, requestTimeoutMs }); }
            catch (error) { if (!notFound(error)) throw error; }
          }
          if (!handle) {
            handle = await sandbox.pty.create({ cols: size.cols, rows: size.rows, cwd, envs: env, onData, timeoutMs: 0, requestTimeoutMs });
            fresh = true;
          }
          if (state === 'closed' || gen !== generation) { sandbox.pty.kill(handle.pid, { requestTimeoutMs }).catch(() => {}); return; }
          const replaced = fresh && pid !== null;
          pid = handle.pid;
          state = 'live';
          emit(CLEAR_LINE);
          if (replaced) emit(`${dim('[the shell had ended while the sandbox slept; this is a new one]')}\r\n`);
          if (fresh && !opened && banner) emit(banner);
          opened = true;
          shown = true;
          for (const text of early.splice(0)) emit(text);
          watch(handle, gen);
          // A size changed while it slept; and a full-screen program redraws on the change.
          if (!fresh) sandbox.pty.resize(pid, size, { requestTimeoutMs }).catch(() => {});
          flush();
        } catch (error) {
          if (state === 'closed' || gen !== generation) return;
          state = 'asleep';
          emit(`${CLEAR_LINE}${red(`Could not reach the sandbox: ${String(error?.message || error).slice(0, 200)}`)}\r\n${dim('[press Enter to try again]')}\r\n`);
        } finally { if (gen === generation || state === 'closed') connecting = null; }
      })();
      return connecting;
    }

    // After the caller has subscribed (it does as soon as spawn returns), so "Waking…" is seen.
    queueMicrotask(() => { void connect(); });
    return {
      get pid() { return pid; },
      onData: subscribe(dataListeners),
      onExit: subscribe(exitListeners),
      write(data) {
        if (state === 'closed') return;
        if (state === 'live') { send(data); return; }
        const bytes = Buffer.byteLength(data);
        if (pendingBytes + bytes <= MAX_PENDING) { pending.push(data); pendingBytes += bytes; }
        if (state === 'asleep') void connect();
      },
      resize(cols, rows) {
        size = { cols, rows };
        if (state === 'live') sandbox.pty.resize(pid, size, { requestTimeoutMs }).catch(() => {});
      },
      // Ends the shell, never the sandbox. One asleep is left in its sandbox rather than waking it to end it.
      kill() {
        if (state === 'closed') return;
        const live = state === 'live', target = sandbox, at = pid;
        generation++;
        finish({ exitCode: 0 });
        if (live && target && at !== null) target.pty.kill(at, { requestTimeoutMs }).catch(() => {});
      },
      pause() {},
      resume() {},
      // Asleep, connected again (opening its tab again does this); otherwise nothing.
      wake() { return state === 'asleep' ? connect() : Promise.resolve(); },
    };
  }
  return { spawn };
}

module.exports = { createSandboxPty, ASLEEP };
