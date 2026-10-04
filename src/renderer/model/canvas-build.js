import { runSteps } from './run-steps.js';
import { isAgentEvent, isEnvironmentApplication, localBuildSteps } from './local-build.js';

// Adapt Canvas's persisted runs to the web timeline's event format. Older
// builds only have message strings; keep those readable after upgrading.
const phases = new Set(['trail', 'recipe', 'discover', 'order', 'plan', 'supabase', 'environment', 'approval', 'run', 'patch', 'visit', 'brief', 'resolve', 'cost', 'setup', 'check', 'start', 'conclusion', 'error', 'exited']);
export function buildEvents(run) {
  // The live log is capped; lifecycle evidence is not evicted by app output.
  // IDs deduplicate new records, while the content key handles pre-upgrade logs.
  const saved = Object.values(run?.build_milestones || {}).flatMap((slot) => [slot.first, slot.last, ...(slot.entries || [])]).filter(Boolean);
  const keyOf = (entry) => entry.id || JSON.stringify([entry.time, entry.kind, entry.message, entry.data]);
  const log = [...(run?.build_log || [])];
  const seen = new Set(log.map(keyOf));
  for (const entry of saved) {
    const key = keyOf(entry);
    if (!seen.has(key)) { log.push(entry); seen.add(key); }
  }
  log.sort((a, b) => Number.isFinite(a.seq) && Number.isFinite(b.seq)
    ? a.seq - b.seq : new Date(a.time) - new Date(b.time));
  const restart = log.findLastIndex((entry) => entry.data?.lifecycle === 'restart');
  let localAgent = false;
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
    // Older local-Claude runs used setup for both narration and installation.
    // Reclassify only inside a known local-provider window; API events and
    // deterministic install jobs retain their original meaning.
    if (data.provider === 'api') localAgent = false;
    if (data.phase === 'agent' || data.provider === 'claude-local' && data.phase === 'setup') localAgent = true;
    if (localAgent && data.phase === 'setup' && !data.stage && !data.install_status && data.status !== 'reusing') {
      data = { ...data, phase: 'agent', legacy: true };
    }
    if (text === 'Cloning repository') text = 'cloning';
    if (text === 'Creating sandbox') text = 'creating';
    if (data.lifecycle === 'cloned') text = 'cloned';
    // Structured log events retain stream chunks; legacy records are independent
    // lines. Keep explicit CR progress updates intact in either format.
    if ((kind === 'stdout' || kind === 'stderr') && data.phase !== 'log' && !/[\r\n]$/.test(text)) text += '\n';
    return { id: index, seq: index, runId: run.id, at: entry.time, text, kind, data };
  });
}

// End-to-end wall time, not the sum of stages that can run concurrently. Ready
// events are recorded only after public preview verification. Never substitute
// updated_at (monitoring) or finished_at (sandbox shutdown) for readiness.
export function timeToLive(run) {
  if (!run || run.status === 'starting') return null;
  const events = buildEvents(run);
  const restart = events.find(event => event.data.lifecycle === 'restart');
  const start = restart ? restart.at : run.created_at ?? events.find(event => event.text === 'Starting repository setup')?.at;
  const ready = events.find(event => event.data.phase === 'ready')?.at;
  if (!start || !ready) return null;
  const duration = new Date(ready).getTime() - new Date(start).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function canvasBuildSteps(run, repoName) {
  const events = buildEvents(run);
  // Ready is verified and persisted independently of the capped event log.
  if (run?.status === 'ready' && !events.some((event) => event.data.phase === 'ready')) {
    // A ready row proves readiness, not *when* it happened. updated_at changes
    // with every process snapshot and must never be used as a build timestamp.
    events.push({ id: 'ready', at: null, kind: 'status', text: 'Preview ready', data: { phase: 'ready' } });
  }
  const adapted = run && {
    id: run.id, status: { starting: 'launching', ready: 'running', stopped: 'killed', failed: 'failed' }[run.status],
    sandboxId: run.sandbox_id, previewUrl: run.preview_url, error: run.error,
  };
  // Agent work and environment injection overlap installation. They must not
  // interrupt its clock or appear to complete subsequent sequential stages.
  const steps = runSteps(adapted, events.filter((event) => !isAgentEvent(event) && !isEnvironmentApplication(event)), repoName);
  // A capped/legacy log cannot prove that a saved plan or health check ran.
  for (const step of steps) {
    if (step.id !== 'live' && !step.events.length && ['done', 'skipped'].includes(step.state)) {
      step.state = 'skipped'; step.summary = 'Not recorded';
    }
    if (step.id === 'health' && step.summary === 'Verifying live preview…' && events.some((event) => event.data.phase === 'ready')) step.summary = 'The check passed';
    if (step.id === 'start' && step.state === 'done' && run?.status === 'ready'
      && events.some((event) => event.data.phase === 'check' && event.data.status === 'ok')) step.summary = 'Repository prepared';
  }
  if (events.some((event) => event.data.lifecycle === 'restart')) {
    for (const step of steps) {
      if (['sandbox', 'trail', 'plan', 'services'].includes(step.id)) {
        step.state = 'skipped'; step.since = null;
        step.summary = step.id === 'sandbox' ? 'Same sandbox and working files' : 'Reused from the previous build';
      }
      if (step.id === 'start') {
        step.title = 'Restart application';
        if (step.summary === 'Repository prepared') step.summary = 'Application restarted';
      }
    }
  }
  // Used from a terminal (2026-10-03): installed, then ready in a shell; there is no app to start or preview to check.
  if (run?.kind === 'terminal') {
    for (const step of steps) {
      if (step.id === 'start') step.title = 'Install';
      if (step.id === 'health' && !step.events.length) step.summary = 'No web preview to check';
      if (step.id === 'live' && step.state === 'done') step.summary = 'Terminal ready';
    }
  }
  return localBuildSteps(steps, events, run);
}
