import { runSteps } from './run-steps.js';

// Adapt Canvas's persisted runs to the web timeline's event format. Older
// builds only have message strings; keep those readable after upgrading.
const phases = new Set(['trail', 'recipe', 'discover', 'order', 'plan', 'supabase', 'environment', 'approval', 'run', 'patch', 'visit', 'brief', 'resolve', 'cost', 'setup', 'check', 'start', 'conclusion', 'error', 'exited']);
export function buildEvents(run) {
  const log = run?.build_log || [];
  const restart = log.findLastIndex((entry) => entry.data?.lifecycle === 'restart');
  return log.slice(Math.max(0, restart)).map((entry, index) => {
    let text = entry.message || '';
    let kind = entry.kind || 'status';
    let data = entry.data || {};
    if (!entry.data) {
      const [phase, ...rest] = text.split(' · ');
      if (phases.has(phase)) data = { phase, status: rest.at(-1) };
      else if (phase === 'stage') { kind = 'command'; data = { stage: rest[0] || 'install' }; }
      else if (text === 'Analyzing and setting up repository') data = { phase: 'discover' };
      else if (text === 'Starting repository services') data = { phase: 'supabase', status: 'starting' };
      else if (/^Installing dependencies/.test(text)) data = { phase: 'setup', status: 'starting' };
      else if (text === 'Verifying live preview') data = { phase: 'check', status: 'checking' };
      else if (text === 'Preview ready') data = { phase: 'ready' };
      else if (text === run.error) kind = 'error';
    }
    if (text === 'Cloning repository') text = 'cloning';
    if (text === 'Creating sandbox') text = 'creating';
    if (data.lifecycle === 'cloned') text = 'cloned';
    // Canvas stores complete log entries, whereas the web receives chunks.
    if ((kind === 'stdout' || kind === 'stderr') && !text.endsWith('\n')) text += '\n';
    return { id: index, seq: index, runId: run.id, at: entry.time, text, kind, data };
  });
}

export function canvasBuildSteps(run, repoName) {
  const events = buildEvents(run);
  // Ready is verified and persisted independently of the capped event log.
  if (run?.status === 'ready' && !events.some((event) => event.data.phase === 'ready')) {
    events.push({ id: 'ready', at: events.at(-1)?.at || run.updated_at || run.created_at, kind: 'status', text: 'Preview ready', data: { phase: 'ready' } });
  }
  const adapted = run && {
    id: run.id, status: { starting: 'launching', ready: 'running', stopped: 'killed', failed: 'failed' }[run.status],
    sandboxId: run.sandbox_id, previewUrl: run.preview_url, error: run.error,
  };
  const steps = runSteps(adapted, events, repoName);
  // A capped/legacy log cannot prove that a saved plan or health check ran.
  for (const step of steps) {
    if (['plan', 'health'].includes(step.id) && !step.events.length && step.state === 'done') {
      step.state = 'skipped'; step.summary = 'Not recorded';
    }
    if (step.id === 'health' && step.summary === 'Verifying live preview…' && events.some((event) => event.data.phase === 'ready')) step.summary = 'The check passed';
  }
  if (events.some((event) => event.data.lifecycle === 'restart')) {
    for (const step of steps) {
      if (['sandbox', 'trail', 'plan', 'services'].includes(step.id)) {
        step.state = 'skipped'; step.since = null;
        step.summary = step.id === 'sandbox' ? 'Same sandbox and working files' : 'Reused from the previous build';
      }
      if (step.id === 'start') step.title = 'Restart application';
    }
  }
  return steps;
}
