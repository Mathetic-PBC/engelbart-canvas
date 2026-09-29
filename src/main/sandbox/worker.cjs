'use strict';

// Canvas's adapter to the hc pipeline already installed in engelbart-web's E2B
// runner template. No Supabase, web queue, trace capture, or renderer access.
const { githubRepo } = require('./runs.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { redact, redactOutput, redactEvent } = require('./environment.cjs');
const { prepareLocalClaude } = require('./local-claude.cjs');
const { runLocalSetup } = require('./local-setup.cjs');
const { runNpmAudit } = require('./npm-audit.cjs');
const ADAPTER_DIR = '/home/user/.engelbart-canvas';
const ADAPTER = `${ADAPTER_DIR}/launch.py`;
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const HOUR = 60 * 60_000;
const PROXY_PORT = 43110;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// The key comes only from the GitHub sign-in (manager.cjs); without it no E2B call is made.
const MISSING_KEY = 'Sign in to GitHub in Engelbart to use sandboxes.';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safePreview(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid preview URL');
  return url.href;
}

async function previewResponds(url, fetcher = fetch) {
  return respondsAt(safePreview(url), fetcher);
}

/** Whether an address answers like a page: below 500, and not a dev server turning the host away. A Build's run step checks a web UI on this Mac with it too (../build/run-processes.cjs). */
async function respondsAt(href, fetcher = fetch) {
  const response = await fetcher(href, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  // Avoid downloading an unbounded page just to check reachability.
  const reader = response.body?.getReader();
  let text = '';
  try { if (reader) text = new TextDecoder().decode((await reader.read()).value).slice(0, 1000); }
  finally { await reader?.cancel(); }
  return response.status < 500 && !/Invalid Host header|not allowed/i.test(text);
}

// A private repository comes as GitHub's archive, from the download link the ack carries (manager.cjs,
// ../github/repo-access.cjs): one archive, minutes long, never the GitHub sign-in. Anything else there is refused.
const ARCHIVE_HOSTS = ['codeload.github.com'];
const BRANCH = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[\w./-]{1,200}$/;
function archiveSource(ack) {
  if (!ack || typeof ack.archive_url !== 'string') return null;
  let url;
  try { url = new URL(ack.archive_url); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || !ARCHIVE_HOSTS.includes(url.hostname) || url.username || url.password) throw new Error('Invalid repository download link');
  return { url: url.href, branch: typeof ack.branch === 'string' && BRANCH.test(ack.branch) ? ack.branch : null };
}

// Public repositories only: the manager asks GitHub with the sign-in and says (request.docker) when it can.
async function wantsDocker(repo) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/HEAD?recursive=1`, {
      headers: { 'User-Agent': 'engelbart-canvas', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return (body.tree || []).some(({ path }) => /(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)supabase\/config\.toml$/i.test(path));
  } catch { return false; }
}

function createRuntime({ Sandbox, emit: send, env = process.env, waitForAck = async () => {}, detectDocker = wantsDocker, checkPreview = previewResponds, prepareClaude = prepareLocalClaude, localSetup = runLocalSetup, audit = runNpmAudit }) {
  const secrets = [env.E2B_API_KEY, env.ANTHROPIC_API_KEY].filter(Boolean);
  const emit = (event) => send(redactEvent(event, secrets));
  let sandbox = null;
  let cancelled = false;
  let ready = false;
  let stopPromise = null;
  let detached = false;
  const localController = new AbortController();
  const auditController = new AbortController();
  let auditStarted = false;
  function auditAfterReady() {
    if (auditStarted || cancelled || detached) return;
    auditStarted = true;
    const onEvent = (data) => {
      if (!auditController.signal.aborted && !cancelled && !detached) emit({ event: 'progress', kind: 'status', message: data.message, data });
    };
    // No await: registry latency/findings cannot delay the preview or fail setup.
    Promise.resolve().then(() => audit({ sandbox, signal: auditController.signal, onEvent })).catch(() => {
      onEvent({ phase: 'audit', status: 'unavailable', message: 'Background npm audit unavailable; preview remains ready. No dependencies changed.' });
    });
  }
  async function stop() {
    if (detached) return;
    cancelled = true;
    localController.abort();
    auditController.abort();
    if (!sandbox) return;
    if (!stopPromise) stopPromise = sandbox.kill({ requestTimeoutMs: 10_000 }).catch((error) => { stopPromise = null; throw error; });
    await stopPromise;
  }
  async function installAdapter(target) {
    await target.commands.run(`mkdir -p ${ADAPTER_DIR} && chmod 700 ${ADAPTER_DIR}`, { timeoutMs: 10_000 });
    await target.files.write(ADAPTER, fs.readFileSync(path.join(__dirname, 'launch.py'), 'utf8'));
  }
  async function can_restart(request) {
    if (!env.E2B_API_KEY) throw new Error(MISSING_KEY);
    const target = await Sandbox.connect(request.sandbox_id, { requestTimeoutMs: 10_000 });
    await installAdapter(target);
    await target.commands.run(`python3 ${ADAPTER} --check`, { timeoutMs: 20_000, envs: { ENGELBART_CANVAS_PORT: String(request.port || 0), HUMAN_COMPACT_HOME: '/home/user/.human-compact' } });
    return { state: 'restartable' };
  }
  function checkCancelled() { if (cancelled) throw new Error('Setup stopped'); }
  async function probe(request) {
    if (!env.E2B_API_KEY) throw new Error(MISSING_KEY);
    // Recover the handle if Canvas died between E2B creation and saving the ID.
    if (!request.sandbox_id) {
      const list = Sandbox.list({ query: { metadata: { canvasRunId: request.run_id, app: 'engelbart-canvas' }, state: ['running', 'paused'] }, requestTimeoutMs: 10_000 });
      const found = (await list.nextItems())[0];
      return found ? { state: 'interrupted', sandbox_id: found.sandboxId } : { state: 'gone' };
    }
    try {
      const info = await Sandbox.getInfo(request.sandbox_id, { requestTimeoutMs: 10_000 });
      if (info.state !== 'running') return { state: 'inactive' };
      if (!request.preview_url) return { state: 'interrupted' };
      return { state: await checkPreview(request.preview_url) ? 'ready' : 'unreachable' };
    } catch (error) {
      if (error.name === 'NotFoundError' || error.name === 'SandboxNotFoundError' || error.status === 404) return { state: 'gone' };
      throw error; // a timeout/authentication failure is not proof of a dead sandbox
    }
  }
  async function kill(request) {
    if (!env.E2B_API_KEY) throw new Error(MISSING_KEY);
    if (request.sandbox_id) await Sandbox.kill(request.sandbox_id, { requestTimeoutMs: 10_000 });
    return { state: 'gone' };
  }
  async function run(request) {
    let deadline;
    const restarting = request.command === 'restart';
    secrets.push(...Object.values(request.environment?.values || {}));
    try {
      const repo = githubRepo(request.github_url);
      if (!repo) throw new Error('A GitHub repository URL is required');
      const provider = env.ENGELBART_SANDBOX_SETUP || 'auto';
      if (!['auto', 'api', 'claude-local'].includes(provider)) throw new Error('ENGELBART_SANDBOX_SETUP must be auto, api or claude-local');
      if (!env.E2B_API_KEY) throw new Error(MISSING_KEY);
      if (!restarting && provider === 'api' && !env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY, or select ENGELBART_SANDBOX_SETUP=auto in ~/.engelbart/sandbox.env');
      function fallbackToApi(error) {
        checkCancelled(); // Stop must never turn into another setup attempt.
        if (ready) throw error; // A published preview is never another setup attempt.
        if (provider !== 'auto') throw error;
        const reason = redactOutput(String(error.message || 'Local Claude unavailable'), secrets).slice(-800);
        if (!env.ANTHROPIC_API_KEY) throw new Error(`${reason} No ANTHROPIC_API_KEY is configured for fallback. Check Claude sign-in/usage or add a fallback key in ~/.engelbart/sandbox.env.`);
        emit({ event: 'progress', kind: 'status', message: `Local Claude setup unavailable or unsuccessful: ${reason} Falling back to Anthropic API-key setup (API usage is billed separately).`,
          data: { phase: 'setup', status: 'fallback', provider: 'api', previous_provider: 'claude-local' } });
      }
      let auth;
      if (!restarting && provider !== 'api') {
        emit({ event: 'progress', message: 'Checking local Claude subscription sign-in' });
        try { auth = await prepareClaude(env); }
        catch (error) { fallbackToApi(error); }
        checkCancelled();
      }
      emit({ event: 'progress', message: restarting ? 'Connecting to existing sandbox' : 'Creating sandbox' });
      const docker = restarting ? false : typeof request.docker === 'boolean' ? request.docker : await detectDocker(repo);
      checkCancelled();
      const template = env.E2B_TEMPLATE || 'engelbart-runner';
      sandbox = restarting ? await Sandbox.connect(request.sandbox_id, { requestTimeoutMs: 10_000 }) : await Sandbox.create(docker ? (env.E2B_DOCKER_TEMPLATE || `${template}-docker`) : template, {
        timeoutMs: HOUR, requestTimeoutMs: 60_000,
        // The web worker sweeps every sandbox carrying `runId` if it is absent
        // from Supabase. Canvas owns its runs locally and must use a separate key.
        // githubLogin: who asked, as the desktop reported it (a hint for tracing, not proof).
        metadata: { canvasRunId: request.run_id, repo: repo.url, app: 'engelbart-canvas', ...(typeof request.github_login === 'string' && GITHUB_LOGIN.test(request.github_login) ? { githubLogin: request.github_login } : {}) },
      });
      checkCancelled();
      emit({ event: 'sandbox_created', sandbox_id: sandbox.sandboxId });
      const source = archiveSource(await waitForAck()); // do not clone until Canvas has persisted the handle
      // The link's own token is what must not show (the address around it is only the repository's name). Not the whole
      // link: output that ends in "https" would lose its tail to redactOutput's split-value guard.
      if (source) secrets.push(...[...new URL(source.url).searchParams.values()].filter((value) => value.length >= 16));
      checkCancelled();
      const workdir = '/home/user/repository';
      const progress = (text) => { if (String(text).trim()) emit({ event: 'progress', message: redactOutput(text, secrets).trim().slice(-2000) }); };
      if (!restarting) {
      emit({ event: 'progress', message: 'Cloning repository' });
      if (source) {
        // A private repository: its archive, unpacked into a history of one commit as a shallow clone would leave it.
        // The link is in this one command's environment, never in the command line or anything it prints.
        const archive = '/tmp/engelbart-repository.tar.gz';
        await sandbox.commands.run([
          `mkdir -p ${quote(workdir)}`,
          `curl -fsS --proto =https --max-time 280 -o ${archive} "$ENGELBART_ARCHIVE_URL"`,
          `tar -xzf ${archive} --strip-components=1 -C ${quote(workdir)}`,
          `rm -f ${archive}`,
          `cd ${quote(workdir)}`,
          'git init -q',
          ...(source.branch ? ['git symbolic-ref HEAD "refs/heads/$ENGELBART_BRANCH"'] : []),
          'git add -A',
          `git -c user.name=Engelbart -c user.email=sandbox@engelbart.local commit -q --no-verify --allow-empty -m ${quote(`Snapshot of ${repo.url}`)}`,
          `git remote add origin ${quote(`${repo.url}.git`)}`,
        ].join(' && '), {
          timeoutMs: 5 * 60_000, envs: { ENGELBART_ARCHIVE_URL: source.url, ...(source.branch ? { ENGELBART_BRANCH: source.branch } : {}) }, onStdout: progress, onStderr: progress,
        });
      } else {
        await sandbox.commands.run(`git clone --progress --depth 1 ${quote(`${repo.url}.git`)} ${quote(workdir)}`, {
          timeoutMs: 5 * 60_000, envs: { GIT_TERMINAL_PROMPT: '0' }, onStdout: progress, onStderr: progress,
        });
      }
      emit({ event: 'progress', message: 'Repository cloned', kind: 'status', data: { lifecycle: 'cloned' } });
      checkCancelled();
      // The existing runner includes npm/pnpm/bun but not Yarn. hc deliberately
      // refuses npm fallback for yarn.lock repositories, so supply the missing tool.
      await sandbox.commands.run(`if [ -f ${quote(`${workdir}/yarn.lock`)} ]; then command -v yarn >/dev/null 2>&1 || npm install --global yarn@1.22.22; fi`, {
        user: 'root', timeoutMs: 120_000, envs: { npm_config_audit: 'false' }, onStdout: progress, onStderr: progress,
      });
      checkCancelled();
      if (docker) {
        emit({ event: 'progress', message: 'Starting repository services' });
        await sandbox.commands.run('dockerd > /var/log/dockerd.log 2>&1', { background: true, user: 'root', timeoutMs: HOUR });
        await sandbox.commands.run('for i in $(seq 1 30); do docker info >/dev/null 2>&1 && chmod 666 /var/run/docker.sock && exit 0; sleep 1; done; exit 1', { user: 'root', timeoutMs: 40_000 });
      }
      }
      await installAdapter(sandbox);
      if (restarting) {
        await sandbox.commands.run(`python3 ${ADAPTER} --stop`, { timeoutMs: 20_000 });
        await sandbox.setTimeout(HOUR);
      }
      const environment = request.environment || { values: {}, removed: [] };
      async function writeEnvironment() {
        // Secrets travel as a file, never as shell arguments or template env.
        await sandbox.files.write(`${ADAPTER_DIR}/environment.json`, JSON.stringify(environment));
        await sandbox.commands.run(`chmod 600 ${ADAPTER_DIR}/environment.json`, { timeoutMs: 10_000 });
      }
      await writeEnvironment();
      if (auth) {
        deadline = setTimeout(() => localController.abort(new Error('Local Claude setup exceeded 15 minutes')), 15 * 60_000);
        let launched, published;
        function publishPreview(result) {
          checkCancelled();
          if (ready) return;
          published = result;
          ready = true;
          clearTimeout(deadline);
          // Continue supervising the app even while Claude writes its final
          // response. An app exit cancels that response, not vice versa.
          result.done.then(() => localController.abort(new Error('Application exited')),
            error => localController.abort(error));
          emit({ event: 'progress', message: 'Preview verified', kind: 'status', data: { phase: 'check', status: 'ok', provider: 'claude-local' } });
          emit({ event: 'ready', preview_url: result.preview_url, port: result.port });
          if (!restarting) auditAfterReady();
        }
        try {
          launched = await localSetup({ sandbox, auth, environment,
            model: env.ENGELBART_SANDBOX_CLAUDE_MODEL || 'sonnet', signal: localController.signal, checkPreview,
            onReady: publishPreview,
            onEvent(event) {
              if (localController.signal.aborted) return;
              const kind = event.phase === 'stage' ? 'command' : event.phase === 'log' ? (event.stream === 'stderr' ? 'stderr' : 'stdout') : 'status';
              const message = String(event.command || event.text || event.message || event.phase || '').slice(-2000);
              const data = { ...event };
              for (const key of ['text', 'message', 'command']) if (typeof data[key] === 'string') data[key] = redactOutput(data[key].slice(-8000), secrets);
              emit({ event: 'progress', message: redactOutput(message, secrets), kind, data: redact(data, secrets) });
            },
          });
        } catch (error) {
          clearTimeout(deadline);
          if (published) {
            // Final-summary errors/timeout cannot tear down a verified app or
            // start API fallback. Its own done promise remains authoritative.
            launched = published;
          } else {
            localController.abort();
            fallbackToApi(error);
            // The local task has closed its bridge and drained its tools. Keep the
            // same sandbox/files, but confirm its app stopped and discard the local
            // recipe so launch.py enters the API pipeline, not the old app command.
            await sandbox.commands.run(`python3 ${ADAPTER} --stop --reset-local`, { timeoutMs: 20_000 });
            checkCancelled();
            await writeEnvironment(); // a local launch may have consumed this file
          }
        } finally { clearTimeout(deadline); }
        if (launched) {
          checkCancelled();
          publishPreview(launched);
          await launched.done; // failures after readiness do not start another setup
          await stop();
          emit({ event: 'stopped' });
          return;
        }
      }
      checkCancelled();
      if (!restarting) emit({ event: 'progress', kind: 'status', message: 'Using Anthropic API-key setup (API usage is billed separately)', data: { phase: 'setup', status: 'starting', provider: 'api' } });
      emit({ event: 'progress', message: restarting ? 'Restarting application with saved environment' : 'Analyzing and setting up repository' });
      let resolveReady, rejectReady;
      const outcome = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // A rejection can arrive in an output callback before commands.run returns.
      outcome.catch(() => {});
      deadline = setTimeout(() => rejectReady(new Error('Repository setup exceeded 45 minutes')), 45 * 60_000);
      let buffer = '';
      let events = Promise.resolve();
      async function handleEvent(event) {
        if (ready || cancelled) return;
        if (!event || typeof event !== 'object') return;
        const protocol = Object.fromEntries(['phase', 'status', 'stage', 'port', 'host', 'url', 'services'].filter((key) => key in event).map((key) => [key, event[key]]));
        event = { ...redact(event, secrets), ...protocol };
        for (const key of ['text', 'stdout', 'stderr', 'output']) {
          if (typeof event[key] === 'string') event[key] = redactOutput(event[key], secrets);
        }
        // Keep the pipeline phase and stage: the web Build UI partitions these
        // same events into steps. Flattening them to prose loses that evidence.
        // "ready" is recorded only after Canvas verifies the public preview.
        if (event.phase !== 'ready') {
          const kind = event.phase === 'stage' ? 'command' : event.phase === 'log' ? (event.stream === 'stderr' ? 'stderr' : 'stdout') : event.phase === 'error' ? 'error' : 'status';
          const message = event.phase === 'stage' ? (event.command || event.stage) : event.text || event.message || event.summary || event.reason || [event.phase, event.stage, event.status].filter(Boolean).join(' · ');
          // Large patches/output must not exceed the worker transport limit.
          const data = JSON.stringify(event).length <= 64_000 ? event : Object.fromEntries(['phase', 'stage', 'status', 'step', 'attempt', 'source'].filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
          emit({ event: 'progress', message: String(message || '').slice(-2000), kind, data });
        }
        if (event.phase === 'ready' && Number.isInteger(event.port)) {
          emit({ event: 'progress', message: 'Verifying live preview', kind: 'status', data: { phase: 'check', status: 'checking' } });
          const wanted = Array.isArray(event.services) && event.services.length ? [...event.services].sort((a, b) => Number(!!b.isEntry) - Number(!!a.isEntry)) : [{ port: event.port, host: event.host }];
          for (const service of wanted) {
            if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error('Invalid application port');
            if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(service.host || '127.0.0.1')) throw new Error('Invalid application host');
          }
          const specs = wanted.map((service, i) => quote(`${PROXY_PORT + i}:${service.port}:${service.host || '127.0.0.1'}`)).join(' ');
          await sandbox.commands.run(`node /opt/engelbart/proxy.mjs ${specs}`, { background: true, timeoutMs: HOUR });
          const local = new URL(event.url || `http://localhost:${event.port}`);
          const previewUrl = safePreview(`https://${sandbox.getHost(PROXY_PORT)}${local.pathname}${local.search}`);
          for (let attempt = 0; attempt < 10; attempt++) {
            checkCancelled();
            if (await checkPreview(previewUrl).catch(() => false)) {
              ready = true;
              clearTimeout(deadline);
              emit({ event: 'progress', message: 'Preview verified', kind: 'status', data: { phase: 'check', status: 'ok' } });
              emit({ event: 'ready', preview_url: previewUrl, port: wanted[0].port });
              if (!restarting) auditAfterReady();
              resolveReady();
              return;
            }
            await pause(1000);
          }
          throw new Error('The application started, but its preview is not reachable');
        } else if (event.phase === 'usable' || event.phase === 'error') {
          throw new Error(event.message || event.summary || 'This repository has no running web preview');
        }
      }
      const onStdout = (chunk) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) { rejectReady(new Error('Setup event exceeded its size limit')); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          events = events.then(async () => {
            let event;
            try { event = JSON.parse(line); } catch { progress(line); return; }
            await handleEvent(event);
          }).catch(rejectReady);
        }
      };
      const handle = await sandbox.commands.run(`python3 -u ${ADAPTER}${restarting ? ' --restart' : ''}`, {
        background: true, timeoutMs: HOUR,
        envs: {
          ANTHROPIC_API_KEY: restarting ? '' : env.ANTHROPIC_API_KEY, HC_USE_API_KEY: '1', HC_CHAT_PROVIDER: 'claude',
          HC_EXPERIMENTAL: '1', HC_DISPOSABLE_HOST: '1', PIP_NO_CACHE_DIR: '1', HUMAN_COMPACT_HOME: '/home/user/.human-compact',
          npm_config_audit: 'false',
          ENGELBART_CANVAS_PORT: String(request.port || 0),
          ...Object.fromEntries(Object.entries(env).filter(([key]) => /^HC_.*_(MODEL|BUDGET_USD)$/.test(key))),
        }, onStdout, onStderr: progress,
      });
      const exited = handle.wait().then(async () => {
        await events;
        if (!ready) throw new Error('Repository setup exited before a preview was ready');
      });
      exited.catch(() => {});
      await Promise.race([outcome, exited]);
      await exited; // keep receiving events until the application exits or is stopped
      await stop();
      emit({ event: 'stopped' });
    } catch (error) {
      const wasCancelled = cancelled;
      let cleanupError = '';
      if (restarting && !wasCancelled) {
        // Keep the machine and installed files on a configuration error.
        try { if (sandbox) await sandbox.commands.run(`python3 ${ADAPTER} --stop`, { timeoutMs: 20_000 }); }
        catch { cleanupError = ' Application cleanup could not be confirmed.'; }
        detached = true;
      } else {
        try { await stop(); } catch (failure) { cleanupError = ` Sandbox cleanup failed: ${failure.message}`; }
      }
      emit({ event: wasCancelled && !cleanupError ? 'stopped' : 'failed', error: `${error.message}${cleanupError}` });
    } finally { clearTimeout(deadline); auditController.abort(); }
  }
  return { run, probe, kill, stop, can_restart, detach: () => { detached = true; auditController.abort(); } };
}

if (require.main === module) {
  const { Sandbox } = require('e2b');
  let runtime, request, acknowledge;
  const ack = new Promise((resolve) => { acknowledge = resolve; }); // resolves to the ack itself: a private repository's download link rides on it
  const secrets = [process.env.E2B_API_KEY, process.env.ANTHROPIC_API_KEY].filter(Boolean);
  const emit = (event) => {
    const line = JSON.stringify({ run_id: request.run_id, ...redactEvent(event, secrets) });
    process.stdout.write(line + '\n');
  };
  process.on('message', async (message) => {
    if (message.command === 'ack') { acknowledge(message); return; }
    if (message.command === 'detach') { runtime?.detach(); process.disconnect?.(); process.exit(0); return; }
    if (message.command === 'stop') { acknowledge(); await runtime?.stop().catch(() => {}); return; }
    if (request) return;
    request = message;
    secrets.push(...Object.values(request.environment?.values || {}));
    runtime = createRuntime({ Sandbox, emit, waitForAck: () => Promise.race([ack, pause(30_000).then(() => { throw new Error('Canvas did not acknowledge the sandbox'); })]) });
    try {
      if (['probe', 'kill', 'can_restart'].includes(request.command)) emit({ event: 'result', ...await runtime[request.command](request) });
      else await runtime.run(request);
    } catch (error) { emit({ event: 'failed', error: error.message }); }
    process.disconnect?.();
  });
  process.on('disconnect', () => {
    const timer = setTimeout(() => process.exit(1), 15_000);
    Promise.resolve(runtime?.stop()).then(() => { clearTimeout(timer); process.exit(0); }, () => process.exit(1));
  });
}

module.exports = { createRuntime, safePreview, previewResponds, respondsAt, MISSING_KEY };
