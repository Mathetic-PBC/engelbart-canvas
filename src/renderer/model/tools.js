// What the setup dialog shows for Git, Claude Code and Codex (2026-09-23; design D15). Pure: the main
// process's snapshot (src/main/tools/manager.cjs) in, rows out.

export const TOOL_ORDER = ['git', 'claude', 'codex'];
const AGENTS = ['claude', 'codex'];

/**
 * The tools the dialog opens with after the launch check, or [] for no dialog: Git missing (or unable
 * to run); neither agent installed; no agent able to run a question; an agent installed but not signed
 * in (2026-09-29: often one Engelbart installed in the background, which then still needs its sign-in);
 * an update waiting for the person. A skipped tool is not asked about again until Ask again.
 */
export function launchRows(snapshot) {
  if (!snapshot || !snapshot.checked) return [];
  const tools = snapshot.tools;
  const rows = [];
  if ((tools.git.status === 'missing' || tools.git.status === 'failed') && !tools.git.skip) rows.push('git');
  const installed = AGENTS.filter((name) => tools[name].installed);
  if (!installed.length) {
    if (!AGENTS.every((name) => tools[name].skip)) rows.push(...AGENTS);
  } else if (!AGENTS.some((name) => tools[name].status === 'ready')) {
    rows.push(...installed.filter((name) => !tools[name].skip));
  }
  for (const name of AGENTS) {
    const tool = tools[name];
    if (rows.includes(name) || tool.skip || tool.busy) continue;
    if (tool.status === 'signed-out' || ((tool.status === 'outdated' || tool.status === 'incompatible') && !tool.autoUpdate)) rows.push(name);
  }
  return TOOL_ORDER.filter((name) => rows.includes(name));
}

/**
 * The agents an install has just brought in without a sign-in: installing in `before`, done and signed out in `after`,
 * not skipped. The dialog asks them to sign in once the install is over (App.jsx), whenever it ends.
 */
export function installedSignedOut(before, after) {
  if (!before || !after) return [];
  return AGENTS.filter((name) => {
    const was = before.tools[name], now = after.tools[name];
    return !!(was && now && was.busy && was.busy.action === 'install' && !now.busy && now.status === 'signed-out' && !now.skip);
  });
}

/** A tool needs the person when it is not installed, cannot run, or waits on them (the rows Skip applies to). */
export function needsAction(tool) {
  return !!tool && !tool.busy && !(tool.status === 'ready');
}

/**
 * One row: `state` (what it says), `tone` (ok | muted | busy | warn | error), `action` (the one button:
 * install | update | sign-in | retry | cancel, or null), `detail` (a line under it), `detailTone` (error, in red, or
 * warn: the record's `note`, such as an older copy first on PATH), `page` (an address to open again while signing in),
 * `skipped`.
 */
export function rowOf(tool) {
  const busy = tool.busy || null;
  const row = { id: tool.id, name: tool.name, state: '', tone: 'muted', action: null, detail: null, detailTone: 'error', page: null, skipped: !!tool.skip };
  if (busy && busy.action === 'install') return { ...row, state: busy.phase || 'Installing…', tone: 'busy' };
  if (busy && busy.action === 'update') return { ...row, state: 'Updating…', tone: 'busy' };
  if (busy && busy.action === 'sign-in') return { ...row, state: 'Finish signing in in your browser', tone: 'busy', action: 'cancel', page: busy.url || null };
  if (busy && busy.action === 'sign-out') return { ...row, state: 'Signing out…', tone: 'busy' }; // Connections' Sign out
  const version = tool.version || '';
  switch (tool.status) {
    case 'ready': // `bundled`: the Git that came with Engelbart, standing in for a Mac without one
      return { ...row, state: version ? `${version}${tool.untested ? ' · untested' : ''}${tool.source === 'bundled' ? ' · built in' : ''}` : 'Installed', tone: 'ok', detail: version ? (tool.note || null) : tool.error, detailTone: version ? 'warn' : 'error' };
    case 'signed-out':
      return { ...row, state: 'Not signed in', tone: 'warn', action: 'sign-in', detail: tool.error };
    case 'missing':
      return { ...row, state: tool.skip ? 'Skipped' : 'Not installed', action: 'install', detail: tool.error };
    case 'outdated':
    case 'incompatible': {
      const why = tool.status === 'outdated' ? `needs ${tool.minimum}` : 'does not work with Engelbart';
      const canUpdate = tool.id !== 'git' || tool.source === 'homebrew';
      return { ...row, state: `${version} · ${why}`, tone: 'warn', action: canUpdate ? 'update' : null, detail: tool.error };
    }
    case 'failed':
      return { ...row, state: 'Not working', tone: 'error', action: 'retry', detail: tool.error };
    default:
      return { ...row, state: 'Checking…', tone: 'busy' };
  }
}

/** Which of the rows shown Install all would install: those not installed. */
export function installable(snapshot, ids) {
  return ids.filter((id) => snapshot.tools[id] && snapshot.tools[id].status === 'missing' && !snapshot.tools[id].busy);
}

/** What Skip warns about for these tools, one line each (Hudson: "a warning that Engelbart will be restricted"). */
export function skipWarnings(snapshot, ids) {
  const lines = [];
  const tools = snapshot.tools;
  if (ids.includes('git') && tools.git.status !== 'ready') lines.push('Without Git, Engelbart can’t build or keep your code’s history.');
  // Skipping an agent only restricts anything when no agent can run a question.
  if (AGENTS.some((name) => ids.includes(name)) && !AGENTS.some((name) => tools[name].status === 'ready')) {
    lines.push('Without Claude Code or Codex, @bart and summaries can’t run.');
  }
  return lines;
}

/** Every row shown is ready (installed, recent enough, signed in): the dialog can close. */
export function allDone(snapshot, ids) {
  return ids.length > 0 && ids.every((id) => snapshot.tools[id] && !snapshot.tools[id].busy && snapshot.tools[id].status === 'ready');
}
