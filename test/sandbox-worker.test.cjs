'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, safePreview } = require('../src/main/sandbox/worker.cjs');
const { launchWorker } = require('../src/main/sandbox/transport.cjs');

// Setup is the local Claude Code subscription's (local-setup.cjs); these fakes stand in for it and for its sign-in check.
const claude = { prepareClaude: async () => ({ file: 'claude', env: {} }) };

test('worker waits for the persisted sandbox ID, sets up through Claude, and cleans up when the app ends', async () => {
  const events = [], commands = [];
  let ack = false, kills = 0, endApp;
  const done = new Promise((resolve) => { endApp = resolve; });
  const sandbox = {
    sandboxId: 'sb-test', getHost: () => 'preview.example', kill: async () => { kills++; }, setTimeout: async () => {},
    files: { write: async () => {} },
    commands: { async run(command) { assert.ok(ack, 'sandbox must be persisted before any commands'); commands.push(command); return { exitCode: 0 }; } },
  };
  const runtime = createRuntime({
    ...claude,
    Sandbox: { create: async (_template, options) => {
      assert.equal(options.metadata.canvasRunId, 'run-test');
      assert.equal(options.metadata.runId, undefined, 'web worker must not adopt or sweep Canvas sandboxes');
      return sandbox;
    } }, env: { E2B_API_KEY: 'test' },
    detectDocker: async () => false, waitForAck: async () => { assert.equal(events.at(-1).event, 'sandbox_created'); ack = true; },
    localSetup: async ({ onEvent }) => {
      onEvent({ phase: 'stage', stage: 'install', command: 'npm ci', status: 'installing' });
      return { preview_url: 'https://preview.example/app', port: 3000, done };
    },
    audit: async () => {},
    emit(event) { events.push(event); if (event.event === 'ready') endApp(); },
  });
  await runtime.run({ run_id: 'run-test', github_url: 'https://github.com/owner/app' });
  assert.deepEqual(events.filter((event) => ['sandbox_created', 'ready', 'stopped'].includes(event.event)).map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
  assert.deepEqual(events.find((event) => event.event === 'ready'), { event: 'ready', kind: 'interface', preview_url: 'https://preview.example/app', port: 3000 });
  assert.ok(commands[0].startsWith('git clone'));
  assert.ok(!commands.some((command) => /launch\.py$/.test(command)), 'no hc setup');
  assert.equal(kills, 1);
  const install = events.find((event) => event.kind === 'command');
  assert.equal(install.message, 'npm ci');
  assert.equal(install.data.stage, 'install');
  assert.ok(events.some((event) => event.data?.lifecycle === 'cloned'));
  assert.ok(events.some((event) => event.data?.phase === 'check'));
});

test('a restart streams split JSON events from the saved plan, verifies the preview, and passes no API key', async () => {
  const events = [];
  let kills = 0, finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const sandbox = {
    sandboxId: 'existing', getHost: () => 'preview.example', kill: async () => { kills++; }, setTimeout: async () => {},
    files: { write: async () => {} },
    commands: { async run(command, options) {
      if (command.includes('--restart')) {
        assert.deepEqual(Object.keys(options.envs).filter((key) => /ANTHROPIC|HC_USE_API_KEY|HC_CHAT_PROVIDER|_MODEL$|_BUDGET_USD$/.test(key)), []);
        options.onStdout('{"phase":"stage","stage":"start","command":"npm start","status":"running"}\n{"phase":"rea');
        options.onStdout('dy","port":3000,"url":"http://localhost:3000/app"}\n');
        return { wait: () => exited };
      }
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({ Sandbox: { connect: async () => sandbox }, env: { E2B_API_KEY: 'test', ANTHROPIC_API_KEY: 'unused', HC_SETUP_MODEL: 'unused' },
    prepareClaude: () => assert.fail('a restart needs no Claude'), localSetup: () => assert.fail('a restart runs no setup'),
    checkPreview: async (url) => { assert.equal(url, 'https://preview.example/app'); return true; },
    emit(event) { events.push(event); if (event.event === 'ready') finish(); } });
  await runtime.run({ command: 'restart', sandbox_id: 'existing', run_id: 'run-test', github_url: 'https://github.com/owner/app' });
  assert.deepEqual(events.filter((event) => !['progress'].includes(event.event)).map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
  assert.equal(events.find((event) => event.kind === 'command').message, 'npm start');
  assert.equal(kills, 1);
});

test('restart reconnects without cloning/installing; configuration failures keep the sandbox', async () => {
  const commands = [], files = [], events = [];
  let kills = 0;
  const sandbox = { sandboxId: 'existing', setTimeout: async () => {}, kill: async () => { kills++; },
    files: { write: async (name, value) => files.push({ name, value }) },
    commands: { async run(command, options) {
      commands.push(command);
      if (command.includes('--restart')) {
        options.onStdout('{"phase":"error","message":"Invalid app settings"}\n');
        return { wait: async () => {} };
      }
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({ Sandbox: { connect: async (id) => { assert.equal(id, 'existing'); return sandbox; }, create: () => assert.fail('must reuse sandbox') },
    env: { E2B_API_KEY: 'test' }, emit: (event) => events.push(event),
    prepareClaude: () => assert.fail('environment restart must not check Claude sign-in'),
    localSetup: () => assert.fail('environment restart must not run setup'),
  });
  await runtime.run({ command: 'restart', sandbox_id: 'existing', run_id: 'run-test', github_url: 'https://github.com/owner/app', environment: { values: { NEW: 'new' }, removed: ['OLD'] } });
  assert.equal(kills, 0);
  assert.ok(!commands.some((command) => /git clone|npm install/.test(command)));
  assert.ok(commands.findIndex((command) => command.includes('--stop')) < commands.findIndex((command) => command.includes('--restart')));
  assert.deepEqual(JSON.parse(files.find((file) => file.name.endsWith('environment.json')).value), { values: { NEW: 'new' }, removed: ['OLD'] });
  assert.equal(events.at(-1).event, 'failed');
  await runtime.stop();
  assert.equal(kills, 0, 'disconnect after a failed restart must not kill the retained sandbox');
});

test('clone failure kills the sandbox and reports failure', async () => {
  const events = [];
  let killed = false;
  const runtime = createRuntime({ ...claude,
    Sandbox: { create: async () => ({ sandboxId: 'sb-test', kill: async () => { killed = true; }, commands: { run: async () => { throw new Error('Repository not found'); } } }) },
    env: { E2B_API_KEY: 'test' }, detectDocker: async () => false, emit: (event) => events.push(event),
  });
  await runtime.run({ run_id: 'run-test', github_url: 'https://github.com/owner/missing' });
  assert.equal(killed, true);
  assert.equal(events.at(-1).event, 'failed');
  assert.match(events.at(-1).error, /Repository not found/);
});

test('probe distinguishes missing sandboxes from network failures', async () => {
  const runtime = createRuntime({ Sandbox: { getInfo: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  assert.deepEqual(await runtime.probe({ sandbox_id: 'gone' }), { state: 'gone' });
  const offline = createRuntime({ Sandbox: { getInfo: async () => { throw new Error('timeout'); } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  await assert.rejects(() => offline.probe({ sandbox_id: 'maybe' }), /timeout/);
  assert.throws(() => safePreview('file:///etc/passwd'));
});

test('probe recovers a sandbox created before its ID reached the database', async () => {
  const runtime = createRuntime({ Sandbox: { list(options) {
    assert.deepEqual(options.query.metadata, { canvasRunId: 'interrupted-run', app: 'engelbart-canvas' });
    return { nextItems: async () => [{ sandboxId: 'sb-recovered' }] };
  } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  assert.deepEqual(await runtime.probe({ run_id: 'interrupted-run' }), { state: 'interrupted', sandbox_id: 'sb-recovered' });
});

test('real worker transport delivers configuration failure without network or secrets', async () => {
  const events = [];
  const worker = launchWorker({ run_id: 'no-credentials', command: 'start', github_url: 'https://github.com/owner/app' }, {}, (event) => events.push(event));
  await worker.done;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'failed');
  assert.equal(events[0].error, 'Sign in to GitHub in Engelbart to use sandboxes.');
});

test('every E2B call needs the signed-in key, including the restart check', async () => {
  const refuse = () => assert.fail('no E2B call without a key');
  const runtime = createRuntime({ Sandbox: { connect: refuse, getInfo: refuse, kill: refuse, list: refuse, pause: refuse }, env: {}, emit() {} });
  await assert.rejects(runtime.probe({ sandbox_id: 'sb' }), /^Error: Sign in to GitHub in Engelbart to use sandboxes\.$/);
  await assert.rejects(runtime.kill({ sandbox_id: 'sb' }), /Sign in to GitHub/);
  await assert.rejects(runtime.pause({ sandbox_id: 'sb' }), /Sign in to GitHub/);
  await assert.rejects(runtime.can_restart({ sandbox_id: 'sb', port: 3000 }), /Sign in to GitHub/);
});

test('the sandbox metadata names the GitHub login only when a valid one is given', async () => {
  const seen = [];
  const attempt = async (request) => {
    const events = [];
    const runtime = createRuntime({ ...claude,
      Sandbox: { create: async (_template, options) => { seen.push(options.metadata); throw new Error('stop after create'); } },
      env: { E2B_API_KEY: 'test' }, detectDocker: async () => false, emit: (event) => events.push(event),
    });
    await runtime.run({ run_id: 'run-login', github_url: 'https://github.com/owner/app', ...request });
    assert.equal(events.at(-1).event, 'failed');
  };
  await attempt({ github_login: 'octocat' });
  await attempt({});
  await attempt({ github_login: 'not a login' });
  assert.deepEqual(seen[0], { canvasRunId: 'run-login', repo: 'https://github.com/owner/app', app: 'engelbart-canvas', githubLogin: 'octocat' });
  assert.equal('githubLogin' in seen[1], false);
  assert.equal('githubLogin' in seen[2], false);
});

test('a private repository comes from the link the ack carries: in one command\'s environment, never its command line or output (2026-09-29)', async () => {
  const LINK = 'https://codeload.github.com/owner/app/legacy.tar.gz/refs/heads/main?token=AAAAONEARCHIVEONLYTOKEN';
  const events = [], runs = [];
  let templates = [], finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const sandbox = {
    sandboxId: 'sb-private', getHost: () => 'preview.example', kill: async () => {}, setTimeout: async () => {},
    files: { write: async () => {} },
    commands: { async run(command, options = {}) {
      runs.push({ command, envs: options.envs || {} });
      if (command.includes('curl')) options.onStderr('curl: fetching AAAAONEARCHIVEONLYTOKEN\n');
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({ ...claude, audit: async () => {},
    localSetup: async () => ({ preview_url: 'https://preview.example/', port: 3000, done: exited }),
    Sandbox: { create: async (template) => { templates.push(template); return sandbox; } },
    env: { E2B_API_KEY: 'test' },
    detectDocker: async () => assert.fail('Docker was decided with the sign-in'),
    waitForAck: async () => ({ command: 'ack', archive_url: LINK, branch: 'main' }),
    checkPreview: async () => true,
    emit(event) { events.push(event); if (event.event === 'ready') finish(); },
  });
  await runtime.run({ run_id: 'run-private', github_url: 'https://github.com/owner/app', docker: true });
  assert.deepEqual(templates, ['engelbart-runner-docker']);
  const fetch = runs.find((item) => item.command.includes('curl'));
  assert.ok(fetch, 'downloaded, not cloned');
  assert.ok(!runs.some((item) => item.command.startsWith('git clone')));
  assert.ok(!runs.some((item) => item.command.includes('codeload') || item.command.includes('AAAAONEARCHIVEONLYTOKEN')), 'the link is never in a command line');
  assert.match(fetch.command, /curl -fsS --proto =https .*"\$ENGELBART_ARCHIVE_URL"/);
  assert.match(fetch.command, /tar -xzf .* --strip-components=1 -C '\/home\/user\/repository'/);
  assert.match(fetch.command, /git symbolic-ref HEAD "refs\/heads\/\$ENGELBART_BRANCH" && git add -A && git .*commit/);
  assert.deepEqual(fetch.envs, { ENGELBART_ARCHIVE_URL: LINK, ENGELBART_BRANCH: 'main' });
  assert.ok(!JSON.stringify(events).includes('AAAAONEARCHIVEONLYTOKEN'), 'its token is redacted from what the sandbox prints');
  assert.ok(events.some((event) => event.data?.lifecycle === 'cloned'), 'the timeline sees it as cloned');
});

test('a download link that is not GitHub\'s codeload is refused before anything runs, and the sandbox goes', async () => {
  const runs = [], events = [];
  let killed = false;
  const runtime = createRuntime({ ...claude,
    Sandbox: { create: async () => ({ sandboxId: 'sb', kill: async () => { killed = true; }, files: { write: async () => {} }, commands: { run: async (command) => { runs.push(command); return { exitCode: 0 }; } } }) },
    env: { E2B_API_KEY: 'test' },
    detectDocker: async () => false,
    waitForAck: async () => ({ command: 'ack', archive_url: 'https://evil.example/app.tar.gz' }),
    emit: (event) => events.push(event),
  });
  await runtime.run({ run_id: 'run-evil', github_url: 'https://github.com/owner/app' });
  assert.deepEqual([events.at(-1).event, events.at(-1).error], ['failed', 'Invalid repository download link']);
  assert.equal(killed, true);
  assert.ok(!runs.some((command) => /curl|git clone/.test(command)));
});

// A ready preview sleeps instead of ending (2026-10-02): E2B pauses its sandbox once nobody has looked at it for 10
// minutes, and a request to its address wakes it. These fakes follow what a live sandbox did (worker.cjs's asleep).
function sleepyFixture({ info = ['paused'], appEnd } = {}) {
  const events = [], timeouts = [], looks = [];
  let kills = 0, created, endApp, readyFinish;
  const ended = new Promise((resolve, reject) => { endApp = appEnd === 'exit' ? () => resolve({ exitCode: 0 }) : () => reject(Object.assign(new Error('[unavailable] the connection to sandbox ended before the stream completed'), { name: 'TimeoutError' })); });
  ended.catch(() => {});
  const readyNow = new Promise((resolve) => { readyFinish = resolve; });
  const sandbox = {
    sandboxId: 'sb-sleepy', getHost: () => 'preview.example', kill: async () => { kills++; },
    setTimeout: async (ms) => { timeouts.push(ms); }, files: { write: async () => {} },
    commands: { async run() { return { exitCode: 0 }; } },
  };
  const runtime = createRuntime({
    Sandbox: {
      create: async (_template, options) => { created = options; return sandbox; },
      getInfo: async (id) => { looks.push(id); return { state: info[Math.min(looks.length - 1, info.length - 1)] }; },
    },
    env: { E2B_API_KEY: 'test' }, audit: async () => {},
    detectDocker: async () => false, checkPreview: async () => true,
    prepareClaude: async () => ({ file: 'claude', env: {} }),
    localSetup: async ({ onReady }) => { const launched = { preview_url: 'https://preview.example/', port: 3000, done: ended }; onReady(launched); return launched; },
    emit(event) { events.push(event); if (event.event === 'ready') readyFinish(); },
  });
  return { runtime, events, timeouts, looks, kills: () => kills, created: () => created, readyNow, endApp };
}

test('a new sandbox pauses at its timeout and wakes on a request; ready puts it on a 10-minute timer, once', async () => {
  const f = sleepyFixture();
  const running = f.runtime.run({ run_id: 'run-sleepy', github_url: 'https://github.com/owner/app' });
  await f.readyNow;
  assert.deepEqual(f.created().lifecycle, { onTimeout: 'pause', autoResume: true });
  assert.equal(f.created().timeoutMs, 60 * 60_000, 'setup keeps the hour, so it never sleeps partway through');
  assert.deepEqual(f.timeouts, [600_000]);
  f.endApp();
  await running;
  assert.deepEqual(f.timeouts, [600_000]);
});

test('the app stream ending while the sandbox sleeps says paused and kills nothing; ending awake still stops it', async () => {
  // E2B reports the pause a moment after the stream breaks: it is looked at again.
  const f = sleepyFixture({ info: ['running', 'paused'] });
  const sleeping = f.runtime.run({ run_id: 'run-sleepy', github_url: 'https://github.com/owner/app' });
  await f.readyNow;
  f.endApp();
  await sleeping;
  assert.deepEqual(f.events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'ready', 'paused']);
  assert.deepEqual(f.looks, ['sb-sleepy', 'sb-sleepy']);
  assert.equal(f.kills(), 0);
  await f.runtime.stop(); // the worker's disconnect, as it leaves
  assert.equal(f.kills(), 0, 'leaving does not kill a sleeping sandbox');
  const awake = sleepyFixture({ info: ['running'], appEnd: 'exit' });
  const running = awake.runtime.run({ run_id: 'run-awake', github_url: 'https://github.com/owner/app' });
  await awake.readyNow;
  awake.endApp();
  await running;
  assert.equal(awake.events.at(-1).event, 'stopped');
  assert.equal(awake.looks.length, 1, 'an exit code is the app\'s own end: one look');
  assert.equal(awake.kills(), 1);
});

test('probe reports a sleeping sandbox as paused without a request to its preview, which would wake it', async () => {
  let checks = 0;
  const probe = (info) => createRuntime({ Sandbox: { getInfo: async () => info }, env: { E2B_API_KEY: 'test' }, emit() {},
    checkPreview: async () => { checks++; return true; } }).probe({ sandbox_id: 'sb', preview_url: 'https://preview.example/' });
  assert.deepEqual(await probe({ state: 'paused' }), { state: 'paused' });
  assert.equal(checks, 0);
  assert.deepEqual(await probe({ state: 'running', endAt: new Date(Date.now() + 10_000) }), { state: 'ready' });
  assert.equal(checks, 0, 'nor one about to sleep');
  assert.deepEqual(await probe({ state: 'running', endAt: new Date(Date.now() + 5 * 60_000) }), { state: 'ready' });
  assert.equal(checks, 1);
});

test('pause puts a sandbox to sleep, and says whether it was awake', async () => {
  const asked = [];
  const runtime = createRuntime({ Sandbox: { pause: async (id) => { asked.push(id); return asked.length === 1; } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  assert.deepEqual(await runtime.pause({ sandbox_id: 'sb' }), { state: 'paused', paused: true });
  assert.deepEqual(await runtime.pause({ sandbox_id: 'sb' }), { state: 'paused', paused: false });
  assert.deepEqual(asked, ['sb', 'sb']);
});

// No API fallback (2026-10-03): a failed local setup is a failed run.
test('no fallback: a local setup failure ends the run failed, kills the sandbox and never starts hc', async () => {
  const events = [], commands = [];
  let kills = 0;
  const runtime = createRuntime({ ...claude, env: { E2B_API_KEY: 'test', ANTHROPIC_API_KEY: 'sk-ant-present' }, detectDocker: async () => false,
    Sandbox: { create: async () => ({ sandboxId: 'sb', kill: async () => { kills++; }, files: { write: async () => {} }, commands: { run: async (command) => { commands.push(command); return { exitCode: 0 }; } } }) },
    localSetup: async () => { throw new Error('Claude Code did not finish: error_max_turns.'); },
    emit: (event) => events.push(event) });
  await runtime.run({ run_id: 'run-fails', github_url: 'https://github.com/owner/app' });
  assert.deepEqual([events.at(-1).event, events.at(-1).error], ['failed', 'Claude Code did not finish: error_max_turns. Retry from build details.']);
  assert.equal(kills, 1);
  assert.ok(!commands.some((command) => /launch\.py( |$)/.test(command) && !/--stop|--check/.test(command)), 'hc never runs');
  assert.ok(!events.some((event) => /API|fallback/i.test(JSON.stringify(event))));
});

// How a person uses the repository (2026-10-03): a terminal is ready with no app and no preview, and keeps its sandbox.
function kindFixture(result) {
  const events = [], timeouts = [], commands = [];
  let kills = 0, audits = 0, finishAudit;
  const audited = new Promise((resolve) => { finishAudit = resolve; });
  const sandbox = { sandboxId: 'sb-kind', getHost: () => 'preview.example', kill: async () => { kills++; }, setTimeout: async (ms) => { timeouts.push(ms); },
    files: { write: async () => {} }, commands: { run: async (command) => { commands.push(command); return { exitCode: 0 }; } } };
  const runtime = createRuntime({ ...claude, env: { E2B_API_KEY: 'test' }, detectDocker: async () => false,
    Sandbox: { create: async (_template, options) => { assert.deepEqual(options.lifecycle, { onTimeout: 'pause', autoResume: true }); return sandbox; } },
    checkPreview: () => assert.fail('the worker itself never checks a terminal\'s preview'),
    audit: async () => { audits++; await audited; },
    localSetup: async ({ onReady }) => { onReady(result); return result; },
    emit: (event) => events.push(event) });
  return { runtime, events, timeouts, commands, kills: () => kills, audits: () => audits, finishAudit };
}

test('terminal-only reaches ready without start_app or a preview check, sleeps when idle, and leaves without killing its sandbox', async () => {
  const terminal = { cwd: 'cli', hint: 'python main.py --help' };
  const f = kindFixture({ kind: 'terminal', reason: 'A Python CLI', terminal });
  const running = f.runtime.run({ run_id: 'run-terminal', github_url: 'https://github.com/owner/cli' });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20 && !f.events.some((event) => event.event === 'ready'); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events.find((event) => event.event === 'ready'), { event: 'ready', kind: 'terminal', terminal });
  assert.ok(f.events.some((event) => event.message === 'Terminal verified' && event.data.cwd === 'cli'));
  assert.ok(!f.events.some((event) => event.message === 'Preview verified'));
  assert.deepEqual(f.timeouts, [600_000], 'the preview\'s lifecycle: asleep 10 minutes after the last use');
  assert.equal(f.audits(), 1, 'the background audit runs as for a preview');
  let left = false;
  running.then(() => { left = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(left, false, 'the worker stays for its audit');
  f.finishAudit();
  await running;
  assert.ok(!f.commands.some((command) => /proxy\.mjs|--local/.test(command)), 'nothing was launched');
  assert.deepEqual(f.events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'ready']);
  await f.runtime.stop(); // the worker's disconnect, as it leaves
  assert.equal(f.kills(), 0, 'the terminal\'s sandbox stays');
});

test('a terminal-only setup stopped while its audit runs still kills its sandbox', async () => {
  const f = kindFixture({ kind: 'terminal', reason: 'A CLI', terminal: { cwd: '.', hint: 'make help' } });
  const running = f.runtime.run({ run_id: 'run-terminal', github_url: 'https://github.com/owner/cli' });
  for (let i = 0; i < 20 && !f.events.some((event) => event.event === 'ready'); i++) await new Promise((resolve) => setImmediate(resolve));
  await f.runtime.stop();
  f.finishAudit();
  await running;
  assert.equal(f.kills(), 1);
  assert.equal(f.events.at(-1).event, 'stopped');
});

test('both: ready carries the preview and the terminal, and the app is watched as a preview\'s', async () => {
  let endApp;
  const done = new Promise((resolve) => { endApp = resolve; });
  const terminal = { cwd: '.', hint: 'npx tool --help' };
  const f = kindFixture({ kind: 'both', reason: 'A web UI and a CLI', preview_url: 'https://preview.example/', port: 5173, done, terminal });
  f.finishAudit();
  const running = f.runtime.run({ run_id: 'run-both', github_url: 'https://github.com/owner/both' });
  for (let i = 0; i < 20 && !f.events.some((event) => event.event === 'ready'); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events.find((event) => event.event === 'ready'), { event: 'ready', kind: 'both', preview_url: 'https://preview.example/', port: 5173, terminal });
  assert.ok(f.events.some((event) => event.message === 'Preview verified'));
  assert.ok(f.events.some((event) => event.message === 'Terminal verified'));
  endApp();
  await running;
  assert.equal(f.events.at(-1).event, 'stopped', 'its app ending ends it, as a preview\'s does');
  assert.equal(f.kills(), 1);
});

test('probe: a running terminal sandbox is ready without any preview request; one without a preview of another kind is interrupted', async () => {
  const probe = (request) => createRuntime({ Sandbox: { getInfo: async () => ({ state: 'running', endAt: new Date(Date.now() + 5 * 60_000) }) }, env: { E2B_API_KEY: 'test' }, emit() {},
    checkPreview: () => assert.fail('no preview to check') }).probe({ sandbox_id: 'sb', ...request });
  assert.deepEqual(await probe({ kind: 'terminal' }), { state: 'ready' });
  assert.deepEqual(await probe({}), { state: 'interrupted' });
  assert.deepEqual(await createRuntime({ Sandbox: { getInfo: async () => ({ state: 'paused' }) }, env: { E2B_API_KEY: 'test' }, emit() {} }).probe({ sandbox_id: 'sb', kind: 'terminal' }), { state: 'paused' });
});
