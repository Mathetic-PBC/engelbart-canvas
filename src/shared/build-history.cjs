'use strict';

// Durable evidence for the Build overview, separate from the rolling log tail.
// Keep first/latest lifecycle evidence and process observations, plus a bounded
// agent activity tail. General stdout stays in build_log. Input is already redacted.
const PHASES = new Set(['trail', 'recipe', 'discover', 'order', 'plan', 'supabase', 'environment', 'approval', 'run', 'patch', 'visit', 'brief', 'resolve', 'setup', 'agent', 'check', 'start', 'conclusion', 'error', 'exited', 'ready', 'usable']);
const STATUSES = new Set(['starting', 'running', 'working', 'checking', 'reading', 'done', 'ok', 'ready', 'answering', 'succeeded', 'failed', 'error', 'blocked', 'unavailable', 'skipped', 'stopped', 'timeout', 'needs_input', 'unhealthy', 'setup_planning', 'replaying', 'reusing', 'fallback', 'none', 'own', 'shared', 'saved', 'fresh', 'captured', 'ignored', 'applied', 'replayed', 'stale', 'plan', 'gave_up', 'leftover', 'summary_unavailable']);
const STAGES = new Set(['install', 'setup', 'build', 'start', 'run', 'discover', 'order', 'plan', 'environment', 'supabase']);
const MESSAGES = new Set(['Starting repository setup', 'Creating sandbox', 'Sandbox created', 'Cloning repository', 'Repository cloned', 'Preview ready', 'Sandbox stopped', 'Analyzing and setting up repository', 'Starting repository services', 'Verifying live preview']);
const AGENT_LOG_LIMIT = 200;
const isAgentActivity = (entry) => entry.data?.phase === 'agent' || entry.data?.actor === 'setup-agent';

function milestoneKey(entry) {
  let data = entry.data || {};
  if (!entry.data) {
    const [phase, ...parts] = String(entry.message || '').split(' · ');
    if (PHASES.has(phase)) data = { phase, status: parts.at(-1) };
    else if (phase === 'stage') data = { phase, stage: parts[0] || 'install' };
  }
  // Only actual observations qualify; generic monitoring messages prove nothing.
  if (data.phase === 'app_status' && typeof data.app?.running === 'boolean' && Array.isArray(data.app.listeners)) return 'services:observed';
  if (['stdout', 'stderr', 'metrics'].includes(entry.kind) || ['log', 'app_status', 'audit', 'cost'].includes(data.phase)) return null;
  if (data.lifecycle === 'restart' || data.lifecycle === 'cloned') return `lifecycle:${data.lifecycle}`;
  const stage = STAGES.has(data.stage || data.step) ? data.stage || data.step : '';
  if (entry.kind === 'command' || data.phase === 'stage') return `command:${stage}`;
  if (entry.kind === 'error' && !data.phase) return `error:${stage}`;
  if (PHASES.has(data.phase)) {
    const status = STATUSES.has(data.install_status || data.status) ? data.install_status || data.status : 'other';
    return `${data.phase}:${data.source === 'railpack' ? 'railpack' : ''}:${stage}:${status}`;
  }
  if (MESSAGES.has(entry.message)) return `message:${entry.message}`;
  if (!data.phase && /^Installing dependencies/.test(entry.message)) return 'message:install';
  return null;
}

function collectBuildMilestones(entries = []) {
  let milestones = {};
  for (const entry of entries) {
    if (entry.data?.lifecycle === 'restart') milestones = {};
    const key = milestoneKey(entry);
    if (key) milestones[key] = { first: milestones[key]?.first || entry, last: entry };
    if (isAgentActivity(entry)) milestones['agent:activity'] = {
      entries: [...(milestones['agent:activity']?.entries || []), entry].slice(-AGENT_LOG_LIMIT),
    };
  }
  return milestones;
}

module.exports = { milestoneKey, collectBuildMilestones, isAgentActivity, AGENT_LOG_LIMIT };
