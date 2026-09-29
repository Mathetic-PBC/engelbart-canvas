'use strict';

// The run step's tools (2026-09-29; ./run-step.cjs), served to Claude Code by ./run-mcp.cjs over the sandbox setup's
// loopback bridge (../sandbox/local-tools.cjs openToolBridge). The sandbox's run_command, read_file, write_file and
// list_files, and its start_app / app_status in the form a repository's runnables need, but on this Mac: every path is
// inside the Build's worktree (a link that leads out is refused, and so is .git), and every command runs there. They
// run one at a time. run_command refuses the common ways around start_runnable (a server, something in the background,
// kill); like a Build agent's own shell it is not a sandbox (./policy.cjs).

const fs = require('node:fs');
const path = require('node:path');

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const TYPE = { type: 'string', enum: ['ui', 'app', 'terminal'] };
const RUNNABLE = schema({ name: text, folder: text, type: TYPE }, ['name', 'folder', 'type']);
const IGNORE = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build']);
const MAX_READ = 64_000;
const MAX_LIST = 300;

const RUN_TOOLS = [
  { name: 'declare_runnables', description: 'Name everything this repository can run, all at once, before starting any: each web UI ("ui": served on a port and used in a browser), desktop app ("app": opens a window of its own) and terminal program ("terminal": used from a terminal). A backend or API that a UI needs is part of that UI (one run command starts both), not a runnable of its own; libraries, tests and build tools are not runnables. name: a short label ("web", "desktop", "cli"); folder: where its commands run, relative to the repository root ("." for the root). Calling it again replaces the list (what is already running stays). Returns each runnable with its stored commands, its state and its time left.', inputSchema: schema({ runnables: { type: 'array', maxItems: 8, items: RUNNABLE } }, ['runnables']) },
  { name: 'start_runnable', description: 'Run a declared runnable\'s install_command (optional; to its end, e.g. "npm install") and then its run_command in its folder, as a process Engelbart owns, and check it the same way every time: a "ui" must answer on the port Engelbart gives it (put {port} in run_command where the port goes, e.g. "npm run dev -- --port {port}" or "PORT={port} npm start"), an "app" must still be running 10 seconds after it starts, a "terminal" command must exit 0 by itself with no input. A pass saves the commands, keeps it running and shows it to the person: move on to the next runnable. A failure stops what was started and returns the failed check and the output: fix the cause, then call again. Each runnable has 20 minutes from its first start_runnable.', inputSchema: schema({ name: text, install_command: text, run_command: text }, ['name', 'run_command']) },
  { name: 'runnable_status', description: 'Engelbart\'s fresh state of every declared runnable: whether it runs, its address, its last error and recent output, its time left. Starts and stops nothing.', inputSchema: schema({}, []) },
  { name: 'run_command', description: 'Run a command to its end in the Build\'s worktree on this Mac: installs, builds, code generation, a quick look at something. Never a server or an app (start_runnable launches those), never in the background, never kill. cwd is relative to the repository root. Returns the exit code and the end of the output.', inputSchema: schema({ command: text, cwd: text, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } }, ['command']) },
  { name: 'read_file', description: 'Read a UTF-8 file of the repository (the first 64 KB). The path is relative to the repository root.', inputSchema: schema({ path: text }, ['path']) },
  { name: 'write_file', description: 'Write a UTF-8 file in the repository. Only when a runnable cannot run without the change, and as little as it takes: what you change is committed as the run step and shown to the person apart from the Build\'s own work.', inputSchema: schema({ path: text, content: text }, ['path', 'content']) },
  { name: 'list_files', description: 'List a folder of the repository (files, and folders with a trailing /), without running anything. Dependency and build folders are left out.', inputSchema: schema({ path: text }, []) },
];

const inside = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);
const present = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };

/** `value` (relative to `root`) as a path inside the worktree: never outside it, through a link, or into .git. */
function worktreePath(root, value = '.') {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('Invalid repository path');
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, value);
  if (!inside(base, resolved)) throw new Error('Paths must be inside the repository');
  if (path.relative(base, resolved).split(path.sep).includes('.git')) throw new Error('.git is Engelbart\'s; it cannot be read or written');
  let probe = resolved;
  while (!present(probe)) probe = path.dirname(probe);
  let real;
  try { real = fs.realpathSync(probe); } catch { throw new Error('Paths must be inside the repository'); }
  if (!inside(base, real)) throw new Error('Paths must be inside the repository');
  return resolved;
}

function validateRunTool(name, args) {
  const tool = RUN_TOOLS.find((entry) => entry.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown run step tool');
  const { properties, required } = tool.inputSchema;
  if (required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw new Error('Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key];
    if (type.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length > (key === 'content' ? 256_000 : 8000))) throw new Error(`Invalid ${key}`);
    if (type.type === 'integer' && (!Number.isInteger(value) || value < type.minimum || value > type.maximum)) throw new Error(`Invalid ${key}`);
    if (type.type === 'array') {
      if (!Array.isArray(value) || value.length > type.maxItems) throw new Error(`Invalid ${key}`);
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((field) => !Object.hasOwn(RUNNABLE.properties, field)) || RUNNABLE.required.some((field) => typeof item[field] !== 'string')) throw new Error(`Invalid ${key}`);
        if (!TYPE.enum.includes(item.type)) throw new Error(`Invalid runnable type ${item.type}: ui, app or terminal`);
      }
    }
  }
  if ('command' in args && !args.command.trim()) throw new Error('Command is empty');
  if ('run_command' in args && !args.run_command.trim()) throw new Error('run_command is empty');
  return args;
}

// A guardrail for the common ways around start_runnable, not a security boundary.
const LAUNCHES = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:concurrently|nodemon|pkill|killall|nohup|disown|sudo)\b|(?:^|[;|&\n]\s*)\s*(?:vite\b(?!\s+(?:build|optimize)\b)|kill\b|open\b)|&\s*$|\belectron\s+\./;

/**
 * The tools of one run step. `root`: the repository's folder in the Build's worktree. `runnables`: the run step's own
 * handlers (declare, start, status). `processes`: ./run-processes.cjs. `key`: the prefix of the processes it starts.
 */
function createRunTools({ root, runnables, processes, key, signal, onActivity = () => {} }) {
  let chain = Promise.resolve();
  let closed = false;
  let commands = 0;
  const perform = async (name, raw) => {
    if (closed) throw new Error('The run step is over; its tools are closed');
    if (signal) signal.throwIfAborted();
    const args = validateRunTool(name, raw);
    onActivity({
      declare_runnables: 'Naming what runs', start_runnable: `Starting ${args.name}`, runnable_status: 'Checking what runs',
      run_command: `Running ${String(args.command || '').split('\n')[0].slice(0, 80)}`, read_file: `Reading ${args.path}`,
      write_file: `Changing ${args.path}`, list_files: `Listing ${args.path || '.'}`,
    }[name]);
    if (name === 'declare_runnables') return runnables.declare(args.runnables);
    if (name === 'start_runnable') return runnables.start(args);
    if (name === 'runnable_status') return runnables.status();
    if (name === 'read_file') {
      const file = worktreePath(root, args.path);
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(MAX_READ + 1);
        const size = fs.readSync(handle, buffer, 0, buffer.length, 0);
        return { content: buffer.subarray(0, Math.min(size, MAX_READ)).toString('utf8'), truncated: size > MAX_READ };
      } finally { fs.closeSync(handle); }
    }
    if (name === 'write_file') {
      const file = worktreePath(root, args.path);
      try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('That path is a link; it cannot be written'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, args.content);
      return { written: path.relative(fs.realpathSync(root), file) };
    }
    if (name === 'list_files') {
      const dir = worktreePath(root, args.path || '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !IGNORE.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
      return { entries: entries.slice(0, MAX_LIST).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)), truncated: entries.length > MAX_LIST };
    }
    // run_command
    if (LAUNCHES.test(args.command)) throw new Error('Launch a server or an app only with start_runnable, and never stop processes yourself: Engelbart owns them. run_command is for commands that end by themselves (installs, builds, checks).');
    const cwd = worktreePath(root, args.cwd || '.');
    commands += 1;
    const out = await processes.runToExit(`${key}:command:${commands}`, args.command, cwd, { timeoutMs: (args.timeout_seconds || 120) * 1000, signal, env: { CI: '1' } });
    return { exit_code: out.code, timed_out: out.timedOut, output: out.output.slice(-16_000) };
  };
  const call = (name, args) => {
    if (closed) return Promise.reject(new Error('The run step is over; its tools are closed'));
    const result = chain.then(() => perform(name, args));
    chain = result.catch(() => {});
    return result;
  };
  call.close = async () => { closed = true; await chain; };
  return call;
}

module.exports = { RUN_TOOLS, worktreePath, validateRunTool, createRunTools };
