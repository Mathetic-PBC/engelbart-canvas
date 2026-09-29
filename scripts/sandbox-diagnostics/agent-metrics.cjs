'use strict';

// Deliberately allowlist numeric/structural fields, never raw CLI events,
// prompts, tool arguments/results, account information, MCP tokens or stderr.
function numericUsage(value) {
  return Object.fromEntries(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .filter((key) => Number.isFinite(value?.[key])).map((key) => [key, value[key]]));
}
function createAgentMetrics(now) {
  const result = { models: [], assistant_messages: 0, tool_calls: [], cli_result: null };
  const messages = new Set(), tools = new Map();
  let buffer = '';
  function consume(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') result.models.push(event.model);
    if (event.type === 'assistant') {
      const id = event.message?.id;
      if (id && !messages.has(id)) { messages.add(id); result.assistant_messages++; }
      for (const block of event.message?.content || []) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string' || tools.has(block.id)) continue;
        const tool = { name: block.name, started_ms: now() };
        // Selected categorical execution choices, never arbitrary arguments.
        if (block.name === 'mcp__canvas__start_app') tool.wait_for_install = block.input?.wait_for_install === true;
        if (block.name === 'mcp__canvas__dependency_install' && ['start', 'status', 'stop', 'skip'].includes(block.input?.action)) {
          tool.install_action = block.input.action;
          if (Array.isArray(block.input.parallel)) tool.parallel_install_managers = block.input.parallel.map(x => x?.manager).filter(x => ['npm', 'pip'].includes(x));
        }
        tools.set(block.id, tool); result.tool_calls.push(tool);
      }
    }
    if (event.type === 'user') for (const block of event.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      const tool = tools.get(block.tool_use_id);
      if (tool && tool.finished_ms === undefined) {
        tool.finished_ms = now(); tool.elapsed_ms = tool.finished_ms - tool.started_ms;
        tool.is_error = !!block.is_error;
      }
    }
    if (event.type === 'result') {
      result.cli_result = { subtype: event.subtype, is_error: !!event.is_error, usage: numericUsage(event.usage),
        ...Object.fromEntries(['duration_ms', 'duration_api_ms', 'num_turns'].filter((k) => Number.isFinite(event[k])).map((k) => [k, event[k]])) };
      result.models.push(...Object.keys(event.modelUsage || {}));
    }
    result.models = [...new Set(result.models)];
  }
  return { result,
    push(chunk) {
      buffer += chunk.toString();
      if (buffer.length > 2_000_000) { buffer = ''; result.truncated = true; return; }
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    },
    finish() { if (buffer.trim()) consume(buffer); buffer = ''; },
  };
}

function phaseSummary(events, agent) {
  const first = (predicate) => events.find(predicate)?.elapsed_ms ?? null;
  const difference = (end, start) => end === null || start === null ? null : end - start;
  const authStart = first((e) => e.message === 'Checking local Claude subscription sign-in');
  const createStart = first((e) => e.message === 'Creating sandbox');
  const created = first((e) => e.event === 'sandbox_created');
  const cloneStart = first((e) => e.message === 'Cloning repository');
  const cloned = first((e) => e.data?.lifecycle === 'cloned');
  const firstStart = first((e) => e.data?.phase === 'stage' && e.data?.stage === 'start');
  const ready = first((e) => e.event === 'ready');
  const jobs = new Map();
  for (const e of events) {
    const d = e.data;
    if (!d?.job_id) continue;
    const job = jobs.get(d.job_id) || { id: d.job_id };
    if (d.phase === 'stage' && d.stage === 'install') { job.command = d.command; job.started_ms = e.elapsed_ms; }
    if (d.install_status) {
      job.status = d.install_status;
      if (['succeeded', 'failed', 'stopped'].includes(d.install_status)) {
        job.finished_ms = e.elapsed_ms; job.elapsed_ms = d.duration_ms; job.exit_code = d.exit_code;
      }
    }
    jobs.set(d.job_id, job);
  }
  return { worker_ready_ms: ready, auth_ms: difference(createStart, authStart),
    detection_and_creation_ms: difference(created, createStart), clone_ms: difference(cloned, cloneStart),
    agent_started_ms: agent?.started_ms ?? null, agent_wall_ms: agent?.wall_ms ?? null,
    first_app_start_ms: firstStart, first_start_to_ready_ms: difference(ready, firstStart),
    installs: [...jobs.values()],
    note: 'Agent wall time contains tool waits and overlaps installation/startup. CLI duration_api_ms is reported as-is, not pure thinking time. Tool round trips may overlap/queue. Do not sum these phases.' };
}
module.exports = { createAgentMetrics, numericUsage, phaseSummary };
