'use strict';

// An import agent's turn turned away by the model's service for a moment (2026-10-14, Hudson's Import your context run:
// "Meeting transcripts: Granola" failed after 17 s on Codex's `{"type":"turn.failed","error":{"message":"Selected model is
// at capacity. Please try a different model."}}`, was shown as "Left out", and was never tried again) runs again on the same
// model after a wait; a lasting failure (a usage limit, a sign-in) does not. And a Codex browser agent's Chrome plugin's
// per-site question goes to Codex's auto-review instead of being declined by `approval_policy="never"` (the same run's
// Gmail and Google Drive: "Browser Use rejected this action … The user declined permission for this action").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConnectAgents, transientFailure, ConnectError, RETRY_WAITS_MS, CODEX_BROWSE_APPROVALS } = require('../src/main/connect/agents.cjs');

const CAPACITY = '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}';

/** A home with a Codex sign-in and a fake shell: each turn's answer is the next of `answers` (a Codex message, or a failure line). */
function harness(answers, { provider = 'openai' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-retry-'));
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const runs = [];
  const waits = [];
  const run = (shell, args, options, done) => {
    const answer = answers[Math.min(runs.length, answers.length - 1)];
    runs.push({ env: options.env, command: args.join(' ') });
    let stdout = '';
    if (provider === 'openai') {
      if (answer.ok) fs.writeFileSync(options.env.ENGELBART_CONNECT_OUTPUT, answer.ok);
      else stdout = `{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000000"}\n${answer.fail}\n`;
    } else {
      stdout = `${JSON.stringify({ type: 'result', subtype: answer.ok ? 'success' : 'error', is_error: !answer.ok, result: answer.ok || answer.fail })}\n`;
    }
    setImmediate(() => done(null, stdout));
    return { stdout: null };
  };
  const sleep = (ms, signal) => { waits.push(ms); return signal && signal.onWait ? signal.onWait() : Promise.resolve(); };
  const agents = createConnectAgents({ environment: { HOME: home, PATH: '/usr/bin' }, runDirectory: path.join(home, 'runs'), interviewHome: path.join(home, 'codex-home'), codexAuthFile: auth, run, sleep });
  return { agents, runs, waits, home };
}

const choiceOf = (provider) => ({ provider, modelId: provider === 'openai' ? 'gpt-x' : 'sonnet', effort: 'high' });

test('a turn the model\'s service turned away for a moment runs again on the same model, the person told why', async () => {
  const { agents, runs, waits } = harness([{ fail: CAPACITY }, { ok: 'Imported 3 Granola meetings.' }]);
  const updates = [];
  const out = await agents.turn({ choice: choiceOf('openai'), kind: 'memory', system: 'rules', message: 'go', onUpdate: (update) => updates.push(update) });
  assert.equal(out.text, 'Imported 3 Granola meetings.');
  assert.equal(runs.length, 2, 'once refused, once again');
  assert.deepEqual(waits, [RETRY_WAITS_MS[0]], 'after the first wait');
  const retry = updates.find((update) => update.retry);
  assert.ok(retry, JSON.stringify(updates));
  assert.equal(retry.activity, 'The model is busy: trying again in 15 s');
  assert.deepEqual({ attempt: retry.retry.attempt, of: retry.retry.of }, { attempt: 2, of: RETRY_WAITS_MS.length + 1 });
  assert.match(retry.retry.reason, /at capacity/);
  assert.equal(runs[0].env.ENGELBART_CONNECT_MODEL, runs[1].env.ENGELBART_CONNECT_MODEL, 'the pinned model, not another');
});

test('a service that stays busy: every wait tried, then the failure as it came', async () => {
  const { agents, runs, waits } = harness([{ fail: CAPACITY }]);
  await assert.rejects(agents.turn({ choice: choiceOf('openai'), kind: 'memory', system: 'rules', message: 'go' }), (error) => error instanceof ConnectError && error.kind === 'failed' && /at capacity/.test(error.message));
  assert.equal(runs.length, RETRY_WAITS_MS.length + 1);
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
});

test('a lasting failure (a usage limit) is not tried again', async () => {
  const { agents, runs, waits } = harness([{ fail: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again in 3 hours."}}' }]);
  await assert.rejects(agents.turn({ choice: choiceOf('openai'), kind: 'memory', system: 'rules', message: 'go' }), /usage limit/);
  assert.equal(runs.length, 1);
  assert.deepEqual(waits, []);
});

test('Stop during the wait ends the turn as stopped, with no other run', async () => {
  const { agents, runs } = harness([{ fail: CAPACITY }, { ok: 'never' }]);
  const controller = new AbortController();
  controller.signal.onWait = () => { controller.abort(); return Promise.resolve(); };
  await assert.rejects(agents.turn({ choice: choiceOf('openai'), kind: 'memory', system: 'rules', message: 'go', signal: controller.signal }), (error) => error.kind === 'stopped');
  assert.equal(runs.length, 1);
});

test('Claude Code\'s overloaded answer is tried again too', async () => {
  const { agents, runs } = harness([{ fail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, { ok: 'Done.' }], { provider: 'anthropic' });
  const out = await agents.turn({ choice: choiceOf('anthropic'), kind: 'memory', system: 'rules', message: 'go' });
  assert.equal(out.text, 'Done.');
  assert.equal(runs.length, 2);
});

test('which failures pass by waiting', () => {
  const failed = (message) => transientFailure(new ConnectError('failed', message));
  for (const message of [CAPACITY, 'API Error: 529 Overloaded', 'Repeated 529 Overloaded errors', '{"type":"error","message":"stream disconnected before completion: error sending request for url"}', 'API Error: 503 Service Unavailable', 'rate limit exceeded, please try again shortly', 'request failed: ECONNRESET']) assert.equal(failed(message), true, message);
  for (const message of ['You\'ve hit your usage limit. Upgrade to Pro', 'Claude AI usage limit reached|1760000000', 'API Error: 401 Invalid API key', 'Not logged in · Please run /login', 'The model returned no text.', 'prompt is too long: 250000 tokens > 200000 maximum']) assert.equal(failed(message), false, message);
  assert.equal(transientFailure(new ConnectError('unavailable', 'at capacity')), false, 'a CLI not found is not the service');
  assert.equal(transientFailure(new ConnectError('stopped', 'Stopped.')), false);
});

test('a Codex browser agent: the Chrome plugin\'s per-site questions go to auto-review, every other approval stays refused', () => {
  assert.match(CODEX_BROWSE_APPROVALS, /approvals_reviewer="auto_review"/);
  const policy = CODEX_BROWSE_APPROVALS.match(/approval_policy=(\{[^']*\})'/)[1];
  assert.match(policy, /mcp_elicitations = true/, 'the plugin asks as an MCP elicitation: answered by auto-review, not declined');
  for (const kind of ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions']) assert.match(policy, new RegExp(`${kind} = false`), `${kind} refused as under "never"`);
  assert.doesNotMatch(CODEX_BROWSE_APPROVALS, /approval_policy="never"/);
});

// 2026-10-14 ("please ensure our agent also deletes the claude/codex chats that get run with the prompt asking about them
// … it is alarming and no need for user to see this"): Engelbart's own agent runs are not kept in the person's Claude Code
// history; the librarian's interview, whose turns resume one session, still is.
test('an agent turn on Claude Code is not saved to the person\'s history; the interview, which resumes, is', async () => {
  const { agents, runs } = harness([{ ok: 'done' }], { provider: 'anthropic' });
  await agents.turn({ choice: choiceOf('anthropic'), kind: 'projects', system: 'rules', message: 'go', onUpdate: () => {} });
  assert.match(runs[0].command, /--no-session-persistence/);
  await agents.turn({ choice: choiceOf('anthropic'), kind: 'interview', system: 'rules', message: 'go', onUpdate: () => {} });
  assert.doesNotMatch(runs[1].command, /--no-session-persistence/);
});

// 2026-10-15 (Hudson's local run: "Nothing new came into your Engelbart Library"): every import given its job's tools
// failed at once with "tools.ensure is not a function". The job's tool names were passed to turn() as `tools`, the name of
// the tools manager it ensures the CLI with, so the manager was never reached. A real turn, with a tools manager and a
// job's tool list, for each CLI.
test('a job\'s own tool list reaches the agent, and the CLI is still ensured by the tools manager', async () => {
  for (const provider of ['anthropic', 'openai']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-toolnames-'));
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
    const calls = [];
    const manager = { ensure: async (cli) => { calls.push(`ensure ${cli}`); }, use: async (cli, fn) => { calls.push(`use ${cli}`); return fn(); }, check: async () => {}, binaryFor: () => null, environment: () => ({}) };
    const connections = [];
    const run = (shell, args, options, done) => {
      const file = options.env.ENGELBART_CONNECT_MCP ? JSON.parse(fs.readFileSync(options.env.ENGELBART_CONNECT_MCP, 'utf8')).mcpServers.engelbart.args[1] : null;
      if (file) connections.push(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (provider === 'openai') {
        const config = fs.readFileSync(path.join(options.env.CODEX_HOME, 'config.toml'), 'utf8');
        const match = /args = \[".*?", "(.*?)"\]/.exec(config);
        if (match) connections.push(JSON.parse(fs.readFileSync(match[1], 'utf8')));
        fs.writeFileSync(options.env.ENGELBART_CONNECT_OUTPUT, 'Brought in 2 chats.');
      }
      setImmediate(() => done(null, provider === 'openai' ? '' : `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Brought in 2 chats.' })}\n`));
      return { stdout: null };
    };
    const agents = createConnectAgents({ environment: { HOME: home, PATH: '/usr/bin' }, runDirectory: path.join(home, 'runs'), interviewHome: path.join(home, 'codex-home'), codexAuthFile: auth, run, tools: manager });
    const out = await agents.turn({ choice: choiceOf(provider), kind: 'import', system: 'rules', message: 'go', bridge: { url: 'http://127.0.0.1:1/x', token: 't' }, toolNames: ['web_chats', 'import_web_chats'] });
    assert.equal(out.text, 'Brought in 2 chats.', provider);
    assert.deepEqual(calls, [`ensure ${provider === 'openai' ? 'codex' : 'claude'}`, `use ${provider === 'openai' ? 'codex' : 'claude'}`], `${provider}: the manager ensured and ran the CLI`);
    assert.deepEqual(connections.map((one) => one.tools), [['web_chats', 'import_web_chats']], `${provider}: the job's tools reached its MCP server`);
  }
});
