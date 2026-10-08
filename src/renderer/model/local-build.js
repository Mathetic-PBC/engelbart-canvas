// Local-Claude observations extend the legacy pipeline without inventing a
// sequential stage for work that runs in parallel with dependency installation.
export const isAgentEvent = (event) => event.data?.phase === 'agent' || event.data?.actor === 'setup-agent';
export const isEnvironmentApplication = (event) => event.data?.phase === 'environment'
  && event.data.source === 'claude-local' && event.data.status === 'applied';
const terminal = new Set(['done', 'failed', 'stopped', 'summary_unavailable']);
const count = (n, label) => `${n} ${label}${n === 1 ? '' : 's'}`;
const details = (event, text) => ({ ...event, text, kind: 'status' });

function agentStep(events, run) {
  const started = events.find((event) => event.data.phase === 'agent' && event.data.status === 'starting');
  const ended = events.findLast((event) => event.data.phase === 'agent' && terminal.has(event.data.status));
  const legacy = events.every((event) => event.data.legacy);
  let state, summary;
  if (ended) {
    ({ state, summary } = {
      done: { state: 'done', summary: 'Setup agent finished' },
      failed: { state: run?.status === 'failed' ? 'failed' : 'warned', summary: 'Setup agent failed' },
      stopped: { state: 'skipped', summary: 'Setup agent stopped' },
      summary_unavailable: { state: 'warned', summary: 'Preview verified · final summary unavailable' },
    }[ended.data.status]);
  } else if (['failed', 'stopped'].includes(run?.status)) {
    state = 'skipped'; summary = 'Completion not recorded';
  } else if (legacy && run?.status === 'ready') {
    state = 'skipped'; summary = 'Agent activity recorded · completion not recorded';
  } else {
    state = 'active'; summary = run?.status === 'ready' ? 'Finishing setup summary…' : 'Claude preparing the repository…';
  }
  const elapsed = ended?.data.elapsed_ms ?? (started?.at && ended?.at ? Math.max(0, new Date(ended.at) - new Date(started.at)) : 0);
  return { id: 'agent', title: 'Setup agent', state, summary, events,
    error: ended?.data.status === 'failed' ? ended.text : null,
    startedAt: started?.at || null, since: state === 'active' ? started?.at || null : null,
    elapsed, durationUnknown: !started || state !== 'active' && !ended };
}

function observedServices(step, event, run) {
  const app = event.data.app;
  const listeners = app.listeners;
  const owned = listeners.filter((listener) => listener.ownership === 'owned');
  const ports = [...new Set(owned.map((listener) => listener.port))];
  const ended = ['failed', 'stopped'].includes(run?.status);
  const healthy = app.health?.current !== false && app.health?.ok === true;
  let summary = ports.length ? count(ports.length, 'listening port') : app.running ? 'Processes running · no owned listener observed' : 'No application processes running';
  if (healthy && app.running) summary += ' · Preview responding';
  if (ended) summary = 'Last observed: ' + summary;
  else if (app.status === 'stopped' || app.status === 'exited') summary = 'Application processes stopped';
  else if (app.running && app.health?.ok === false && run?.status === 'ready') summary += ' · Preview not responding';
  const lines = [
    event.text,
    ...(app.processes || []).map((process) => `Process ${process.pid}: ${process.name}`),
    ...listeners.map((listener) => `TCP ${String(listener.address).includes(':') ? `[${listener.address}]` : listener.address}:${listener.port} · ${{ owned: 'owned by app', unowned: 'not owned by app' }[listener.ownership] || 'ownership unknown'}`),
    ...(app.health ? [`Preview HTTP check: ${app.health.current === false ? 'previous result' : app.health.ok ? 'passed' : 'not passing'}${app.health.http_status ? ` (${app.health.http_status})` : ''}${app.health.error ? ` · ${app.health.error}` : ''}`] : ['Preview HTTP check: not recorded']),
    'Listening ports are observations, not a complete service inventory. Other endpoints and credential-dependent features are not verified by this check.',
  ];
  Object.assign(step, { summary, state: ended ? 'skipped' : app.running && healthy ? 'done'
    : run?.status === 'starting' ? 'active' : app.running || ['stopped', 'exited'].includes(app.status) ? 'warned' : 'skipped',
    events: [details(event, lines.join('\n'))], startedAt: null, since: null, elapsed: 0, durationUnknown: true, error: null });
}

export function localBuildSteps(steps, events, run) {
  const agentEvents = events.filter(isAgentEvent);
  const applied = events.findLast(isEnvironmentApplication);
  const snapshot = events.findLast((event) => event.data?.phase === 'app_status'
    && typeof event.data.app?.running === 'boolean' && Array.isArray(event.data.app.listeners));
  const provider = events.findLast((event) => ['api', 'claude-local'].includes(event.data?.provider))?.data.provider;
  const local = provider !== 'api' && !!(agentEvents.length || applied || snapshot);
  if (agentEvents.length) {
    const agent = agentStep(agentEvents, run);
    const index = steps.findIndex((step) => step.id === 'plan');
    // Keep a real API Run Plan on fallback; replace only the empty placeholder.
    steps.splice(index, steps[index].events.length ? 0 : 1, agent);
    for (const step of steps) {
      if (step.id === 'sandbox' && step.state === 'active' && step.events.some((event) => event.data.lifecycle === 'cloned')) {
        step.state = 'done'; step.since = null;
        if (step.startedAt && agent.startedAt) step.elapsed = Math.max(0, new Date(agent.startedAt) - new Date(step.startedAt));
      }
      if (['sandbox', 'trail', 'plan'].includes(step.id) && step.state === 'active' && !step.events.length) step.state = 'waiting';
      // A run-level agent failure must not falsely fail the independent install.
      if (step.id === 'start' && step.state === 'failed' && agent.state === 'failed'
        && !step.events.some(event => ['failed', 'error', 'blocked'].includes(event.data?.install_status || event.data?.status)
          || event.data?.phase === 'error')) {
        step.state = 'skipped'; step.summary = 'Interrupted by setup agent failure'; step.error = null;
        step.durationUnknown = true; // No terminal install outcome was recorded.
      }
    }
  }
  const services = steps.find((step) => step.id === 'services');
  if (local && !services.events.some((event) => event.data?.phase === 'supabase')) {
    if (snapshot) {
      observedServices(services, snapshot, run);
      const live = steps.find(step => step.id === 'live');
      live.events = live.events.filter(event => event.data?.phase !== 'app_status' || !event.data.app);
    }
    else Object.assign(services, { state: 'skipped', summary: 'Not observed yet', since: null });
  }
  const environment = steps.find((step) => step.id === 'environment');
  const scanned = environment.events.some((event) => event.data?.phase === 'environment' && Array.isArray(event.data.variables));
  if (applied) {
    const names = Array.isArray(applied.data.provided_names) ? applied.data.provided_names : [];
    const removed = Array.isArray(applied.data.removed_names) ? applied.data.removed_names : [];
    const output = [applied.text, names.length ? `Applied names: ${names.join(', ')}` : 'No saved variables supplied.',
      ...(removed.length ? [`Removed overrides: ${removed.join(', ')}`] : []),
      'Applying saved values does not check which variables the repository requires or whether credentials work.'];
    if (!scanned && local) Object.assign(environment, { state: 'skipped',
      summary: `${names.length ? `${names.length} saved applied` : 'No saved variables'} · Requirements not scanned`,
      startedAt: null, since: null, elapsed: 0, durationUnknown: true, error: null });
    environment.events.push(details(applied, output.join('\n')));
  } else if (local && !scanned) {
    Object.assign(environment, { state: 'skipped', summary: 'Requirements not scanned', since: null });
  }
  return steps;
}
