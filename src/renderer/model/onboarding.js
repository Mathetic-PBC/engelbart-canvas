// Onboarding's order and gates (2026-09-28; Claude Design "Onboarding.dc.html" and Hudson's tweaks in
// design/onboarding/TWEAKS.md). Pure: screens/Onboarding.jsx asks where Continue and Skip go.

import { hasTag } from './kind.js';
import { launchRows, installable } from './tools.js';

/**
 * A new install walks all six screens; + Project on the all-projects screen only the last two. The tools screen
 * (second, 2026-09-28: it replaces the setup dialog a first launch used to open) is left out when `tools` is false:
 * the launch check found nothing to install. Connect your library (2026-10-07, screens/ConnectLibrary.jsx) is in the
 * flow when `connect` is true (every new user's, test mode's or not, since 2026-10-08; false once the tools screen was
 * skipped with no agent to run it), and then it takes the place of Add to your library and Custom instructions
 * ("replace steps 3 and 4 with this, since it will essentially be the same": its agents bring the papers, sites and code
 * in, and MEMORY.md, made from what the person's AI assistants remember, does what the custom instructions did).
 * A new user's flow has no Project context screen (2026-10-09, "fewer create screens"); + Project keeps create → context.
 * Create comes before Connect (2026-10-10): the librarian is told what the project is, so it recommends the person's own
 * files and papers about it rather than "75 PDFs in your Downloads". The project itself is made at the end of the flow
 * ('open', see endOf), so what Connect brings in still lands in it.
 * The intro screen "All your context in one place" (2026-10-11) was deleted (2026-10-12): the choose screen's consent card says where the data goes.
 */
export const FLOWS = { new: ['welcome', 'tools', 'create', 'connect', 'import', 'instructions'], existing: ['create', 'context'], guided: ['welcome', 'tools', 'connect', 'import', 'instructions'] };

/**
 * The guided setup started inside a project (2026-10-10, "guided setup shouldn't create a new project"): a new user's
 * screens without Create, its last screen adding a Welcome workspace to that project ('open' after it, as after Create).
 * From the all-projects screen it is mode 'new' and ends in a new project.
 */
export const isFresh = (mode) => mode === 'new' || mode === 'guided'; // a new user's screens: Connect, the tools screen's agents

export function flowOf(mode, { tools = true, connect = false } = {}) {
  const flow = FLOWS[mode] || FLOWS.new;
  return flow.filter((step) => (step !== 'tools' || tools) && (connect ? step !== 'import' && step !== 'instructions' : step !== 'intro' && step !== 'connect'));
}

/**
 * Screens that are several screens in effect (2a, 2b …), one box shown at a time. Create has no folder part since
 * 2026-10-09: a folder is made at ~/<name> unless "Use an existing folder…" under the name picks one.
 */
export const SUBS = { import: ['github', 'url', 'pdf'], create: ['name', 'desc'] };

/**
 * Where a forward move from `{ step, sub }` lands: the next part of the same screen, else the next screen, else 'open'
 * (after the context screen, or the last screen of the flow). `detour` is set when the context screen sent the person to add to the library outside
 * the flow (the existing-user flow has no import screen): the end of the import screen returns to context.
 * `options` as flowOf's: from a screen left out of the flow, the next one still in it.
 */
export function forward(mode, { step, sub = 0, detour = false }, options) {
  const parts = SUBS[step];
  if (parts && sub < parts.length - 1) return { step, sub: sub + 1 };
  if (step === 'context') return { step: 'open', sub: 0 };
  if (detour && step === 'import') return { step: 'context', sub: 0 };
  const full = FLOWS[mode] || FLOWS.new;
  const flow = flowOf(mode, options);
  const at = full.indexOf(step);
  const next = at < 0 ? null : full.slice(at + 1).find((name) => flow.includes(name));
  if (next) return { step: next, sub: 0 };
  return flow.includes(step) ? { step: 'open', sub: 0 } : { step, sub };
}

/** The pager under every screen of the flow: `{ count, index }`, or null off the flow (opening, a detour). */
export function pagerOf(mode, step, options) {
  const flow = flowOf(mode, options);
  const index = flow.indexOf(step);
  return index < 0 ? null : { count: flow.length, index };
}

/**
 * Whether a new install's onboarding has the tools screen, from the tool check's snapshot: null until the first check
 * has answered, then whether it found something Install all would install (Git missing, or neither agent installed).
 * What else the check asks about (signing in, an update) waits for the setup dialog after onboarding, except with Connect
 * your library in the flow (`connect`), whose agents run on Claude Code or Codex: then the screen is there
 * until one of them is installed and signed in too ("signing into claude code and/or codex must be done before this step").
 */
export function toolsWanted(snapshot, { connect = false } = {}) {
  if (!snapshot || !snapshot.checked) return null;
  if (installable(snapshot, launchRows(snapshot)).length > 0) return true;
  return connect ? !agentReady(snapshot) : false;
}

/**
 * Whether Claude Code or Codex is installed and signed in: what Connect your library's agents need. One updating itself in
 * the background (or about to: outdated with automatic updates on) counts (2026-10-13: "Codex was also updated before he
 * could move on. Codex should update automatically in the background"): the update never holds onboarding.
 */
export function agentWorks(tool) {
  return !!tool && (tool.status === 'ready' || (!!tool.installed && (tool.status === 'updating' || (tool.status === 'outdated' && tool.autoUpdate))));
}
export function agentReady(snapshot) {
  return !!(snapshot && snapshot.tools) && ['claude', 'codex'].some((id) => agentWorks(snapshot.tools[id]));
}

/**
 * The tools screen's rows and main button. Without Connect: the rows the launch check asks about, Install all (or
 * Continue) installs in the background and moves on at once. With it: Git when it needs anything, and both agents with
 * their own Install or Sign in; the button installs what is missing and stays, and Continue waits for an agent to be ready.
 * → { ids, install: [tools Install all would install], label, disabled, stay }
 */
export function toolsStep(snapshot, { connect = false } = {}) {
  if (!snapshot || !snapshot.tools) return { ids: [], install: [], label: 'Continue', disabled: true, stay: false };
  if (!connect) {
    const ids = launchRows(snapshot);
    const install = installable(snapshot, ids);
    return { ids, install, label: install.length ? 'Install all' : 'Continue', disabled: false, stay: false };
  }
  const git = snapshot.tools.git;
  const ids = [...(git && git.status !== 'ready' && !git.skip ? ['git'] : []), 'claude', 'codex'].filter((id) => snapshot.tools[id]);
  if (agentReady(snapshot)) return { ids, install: [], label: 'Continue', disabled: false, stay: false };
  // An agent installed and waiting for its sign-in: its row's Sign in is the step, not installing the other one.
  const installedAgent = ['claude', 'codex'].some((id) => snapshot.tools[id] && snapshot.tools[id].installed);
  const install = installable(snapshot, installedAgent ? ids.filter((id) => id === 'git') : ids);
  if (install.length) return { ids, install, label: 'Install all', disabled: false, stay: true };
  return { ids, install: [], label: 'Continue', disabled: true, stay: true };
}

/** What each tool is for, under its name on the tools screen. */
export const TOOL_WHY = {
  git: 'Keeps the history of your code. Build needs it.',
  claude: 'Anthropic’s agent. Runs @bart and Build with your Claude account.',
  codex: 'OpenAI’s agent. Runs @bart and Build with your ChatGPT account.',
};

/**
 * The import screen's buttons, from how many rows its current part has (`n`): Skip while that part is empty; Continue
 * always shown and live once it holds something. It opens the next part, and after the last part the next screen
 * (there is no separate Next: Hudson, 2026-09-28). The GitHub part's Continue is live too once GitHub is connected
 * (`signedIn`), with nothing ticked: connecting is the step, a repository is not required (2026-10-02).
 */
export function importButtons(sub, n, { signedIn = false } = {}) {
  const connected = SUBS.import[sub] === 'github' && signedIn;
  return { showSkip: n === 0, continueDisabled: n === 0 && !connected };
}

/**
 * The create screen's: Skip only on an empty description; Continue (next part, then the next screen) greyed on an empty
 * name, an empty description, and an existing folder not yet named. Neither makes the project (2026-10-10: Create is
 * before Connect, and the project is made when the flow reaches 'open').
 */
export function createButtons(sub, { name, desc, folder = 'new', folderPath = '' }) {
  const part = SUBS.create[sub];
  const empty = (value) => !String(value || '').trim();
  return {
    showSkip: part === 'desc' && empty(desc),
    continueDisabled: (part === 'name' && (empty(name) || (folder === 'existing' && empty(folderPath)))) || (part === 'desc' && empty(desc)),
    label: 'Continue',
  };
}

/**
 * What a forward move that lands on 'open' does: a new user's flow makes its project ('project'), the guided setup adds a
 * Welcome workspace to the project it was started in ('welcome'); + Project opens from its context screen, and any other
 * move does nothing more (null).
 */
export function endOf(mode, next) {
  if (!next || next.step !== 'open') return null;
  if (mode === 'new') return 'project';
  if (mode === 'guided') return 'welcome';
  return null;
}

/**
 * What a new user's project is made with (ipc start-project), from Create's state: the rows this onboarding added go into
 * its Getting started workspace, and Connect's session (`connectId`) puts its notes into it.
 */
export function projectInput({ name, desc, folder = 'new', folderPath = '', ids = [], connectId = null, mode = 'new' }) {
  return {
    name: String(name || '').trim(),
    description: String(desc || '').trim(),
    folder,
    directory: folder === 'existing' ? folderPath : '',
    context: ids,
    ...(connectId ? { connect: connectId } : {}),
    ...(mode === 'new' ? { onboarding: true } : {}),
  };
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** What a library row is, in the words of the context screen: "paper · arxiv.org", "git repo · github.com", "website · …". */
export function rowWhy(row) {
  const what = hasTag(row, 'git') ? 'git repo' : hasTag(row, 'paper') ? 'paper' : row.type === 'website' ? 'website' : row.type;
  const where = row.url && !/^file:/i.test(row.url) ? hostOf(row.url) : '';
  return [what, where].filter(Boolean).join(' · ');
}

/** The library rows a project can be given: everything but notes (they belong to their project) and pasted pictures. */
export function contextRows(library) {
  return (library || []).filter((row) => !hasTag(row, 'note') && row.type !== 'image');
}

/** The prompt "Import from an AI provider" copies (Hudson's wording, design chat message 58). */
export const PROFILE_PROMPT = `I want to export a research profile of me that I can give to another AI assistant or collaborator. Using everything you know about me from memory and our past conversations, write a structured profile of me *as a researcher*. Ignore personal, financial, and non-research details unless they directly shape my research.

Cover the following, and skip any section you have no real evidence for:

1. Field(s) and position: my disciplines, subfields, career stage, institutional affiliation (or independence), and how I describe my own work.
2. Core research questions and thesis: the central problem(s) I'm working on, the claims or constructs I've proposed, and what I'm arguing against or distancing myself from.
3. Current and past projects: for each, the question, study design, data, status (idea / running / analyzing / submitted / published), and target venue.
4. Methods and epistemology: my methodological commitments (e.g., qualitative vs. quantitative, specific analytic traditions), theoretical frameworks I build on, and standards of evidence I hold myself to.
5. Intellectual lineage: thinkers, papers, and traditions I draw on, and any I explicitly reject.
6. Collaborators and ecosystem: advisors, co-authors, labs, and communities, with each person's role.
7. Open problems: methodological or conceptual issues I'm currently stuck on or actively iterating on.
8. Trajectory: my research goals, target institutions or venues, and how I'm trying to get there.
9. Working style: how I want AI to engage with my research (tone, level of pushback, formatting, what to avoid).

Rules:
- Be specific. Use the exact terms, names, and framings I've used rather than generic paraphrases.
- Mark each claim with its epistemic status: [stated] if I said it directly, [inferred] if you're reading it from patterns in our conversations, [uncertain] if you're unsure or it may be outdated.
- Do not invent details, papers, or collaborators to fill gaps. An empty section is better than a fabricated one.
- Where something may have changed since I last mentioned it, note roughly when it came up.
- After the profile, list the 3–5 most important things you *don't* know about my research that would substantially improve the profile, so I can fill them in.

Output the final profile inside a single code block so I can copy it cleanly.`;

/* ------------------------------------------------------------------------------------------------------------------ */
// Onboarding beta (2026-10-16, Hudson's Onboarding note; docs/onboarding-beta-10-16.md S1–S13).

/**
 * The pager drawn under a screen (S3: "the pager counts only screens that exist"; it read "1 of 3" on Welcome, then "2 of
 * 4"). Only screens that draw it count: in a new user's flow Create and Connect are Import your context's own page, which
 * has no pager, so Welcome is the only one and none is drawn. A flow of one such screen draws none. → { count, index } | null
 */
export function shownPager(mode, step, options) {
  const own = flowOf(mode, options).filter((name) => !(mode === 'new' && options && options.connect && (name === 'create' || name === 'connect')));
  const index = own.indexOf(step);
  return index < 0 || own.length < 2 ? null : { count: own.length, index };
}

// Claude Code and Codex, as the agent popup names them (S3).
export const CLIS = ['claude', 'codex'];
const PROVIDER_OF_CLI = { claude: 'anthropic', codex: 'openai' };
export const providerOfCli = (id) => PROVIDER_OF_CLI[id] || null;
export const cliOfProvider = (provider) => (provider === 'openai' ? 'codex' : provider === 'anthropic' ? 'claude' : null);
/** "Connect to Claude", "Connect to ChatGPT", "Connect to Claude and ChatGPT": the account each CLI signs in with. */
export const CONNECT_TO = { claude: 'Claude', codex: 'ChatGPT' };
export function connectLabel(ids) {
  const names = CLIS.filter((id) => (ids || []).includes(id)).map((id) => CONNECT_TO[id]);
  return names.length ? `Connect to ${names.join(' and ')}` : '';
}
/** What a choice in the popup covers: 'claude' | 'codex' | 'both'. */
export const choiceIds = (choice) => (choice === 'both' ? [...CLIS] : CLIS.includes(choice) ? [choice] : []);

const providerEntry = (providers, id) => ((providers && providers.providers) || []).find((one) => one.id === PROVIDER_OF_CLI[id]) || null;
const toolOf = (snapshot, id) => (snapshot && snapshot.tools && snapshot.tools[id]) || null;
const OUTDATED = ['outdated', 'incompatible'];

/**
 * Whether a CLI is installed and signed in with a subscription, by its own word, whatever its version
 * (src/main/onboarding/providers.cjs `subscribed`; from a main without it: signed in with a plan named).
 */
export function subscribedCli(snapshot, providers, id) {
  const tool = toolOf(snapshot, id);
  const one = providerEntry(providers, id);
  if (!tool || !tool.installed || !one || tool.status === 'missing' || tool.status === 'failed') return false;
  if (typeof one.subscribed === 'boolean') return one.subscribed;
  return !!(one.signedIn && one.subscription);
}

/**
 * Where one CLI stands for the agent popup: 'ready' (it runs: installed, up to date, signed in with a subscription),
 * 'connecting' (Engelbart installs, updates or checks it), 'signing-in' (its sign-in waits in the browser), 'install' (not
 * on this Mac), 'update' (too old for Engelbart), 'sign-in' (installed and up to date but not signed in, or signed in
 * without a subscription; `refused` too: it said it was signed in, yet turned the agents away), 'failed' (an install or a
 * check that stopped; its `error` says why).
 */
export function cliStage(snapshot, providers, id, { refused = false } = {}) {
  const tool = toolOf(snapshot, id);
  if (!tool) return 'connecting';
  const busy = tool.busy || null;
  if (busy && busy.action === 'sign-in') return 'signing-in';
  if (busy && busy.action !== 'sign-out') return 'connecting';
  if (['installing', 'checking', 'unknown', 'updating'].includes(tool.status)) return 'connecting';
  if (tool.status === 'failed') return 'failed';
  if (!tool.installed || tool.status === 'missing') return tool.error ? 'failed' : 'install';
  if (OUTDATED.includes(tool.status)) return tool.autoUpdate ? 'connecting' : 'update';
  if (!refused && tool.status === 'ready' && subscribedCli(snapshot, providers, id)) return 'ready';
  return 'sign-in';
}

/** Git is never a row (S3): it ships with the app, and when it is missing anyway it is installed in the background. */
export function gitMissing(snapshot) {
  const git = toolOf(snapshot, 'git');
  return !!git && git.status === 'missing' && !git.busy && !git.skip;
}

/**
 * Welcome's Continue (S3, in place of the "Set up your tools" screen) → null while the tool check or the providers have not
 * answered; else { go: true, update } when Claude Code or Codex qualifies (installed, signed in, with a subscription):
 * those that qualify and are too old are updated in the background (`update`; both qualify, both update) and the flow goes
 * straight on. Neither: { go: false }, and the popup asks which to use. `git`: Git to install in the background.
 */
export function agentGate(snapshot, providers) {
  if (!snapshot || !snapshot.checked || !snapshot.tools || !providers || !Array.isArray(providers.providers)) return null;
  const git = gitMissing(snapshot);
  const qualifying = CLIS.filter((id) => subscribedCli(snapshot, providers, id));
  if (!qualifying.length) return { go: false, update: [], git, qualifying };
  const update = qualifying.filter((id) => { const tool = toolOf(snapshot, id); return OUTDATED.includes(tool.status) && !tool.busy && !tool.pin && !tool.autoUpdate; });
  return { go: true, update, git, qualifying };
}

/**
 * The agent popup for a choice (S3: "Claude Code, Codex, or both") → { stages: { id: stage }, install, update, signIn,
 * failed, done, primary: { label, action: null | 'sign-in' | 'open' | 'retry', ids, url?, disabled }, problem }.
 * Choosing installs what is missing (`install`) and updates what is out of date (`update`) at once; one installed and up
 * to date but not signed in waits for one press, "Connect to Claude" (or ChatGPT, or both), which opens that CLI's own
 * sign-in. `done`: one of them runs, and the flow goes on by itself. `problem`: why one stopped, in its own words.
 */
export function agentChoice(snapshot, providers, choice, { refused = null } = {}) {
  const ids = choiceIds(choice);
  const stages = Object.fromEntries(ids.map((id) => [id, cliStage(snapshot, providers, id, { refused: refused === id })]));
  const having = (stage) => ids.filter((id) => stages[id] === stage);
  const install = having('install');
  const update = having('update');
  const signIn = having('sign-in');
  const failed = having('failed');
  const signing = having('signing-in');
  const done = having('ready').length > 0;
  const errorOf = (list) => { for (const id of list) { const tool = toolOf(snapshot, id); if (tool && tool.error) return String(tool.error).split(/(?<=[.!?])\s/)[0].slice(0, 160); } return ''; };
  let primary;
  if (!ids.length) primary = { label: 'Continue', action: null, ids: [], disabled: true };
  else if (done) primary = { label: 'Connected', action: null, ids: [], disabled: true };
  else if (signIn.length) primary = { label: connectLabel(signIn), action: 'sign-in', ids: signIn, disabled: false };
  else if (signing.length) {
    const busy = toolOf(snapshot, signing[0]).busy || {};
    primary = busy.url ? { label: 'Open sign-in page', action: 'open', ids: signing.slice(0, 1), url: busy.url, disabled: false } : { label: 'Finish signing in…', action: null, ids: [], disabled: true };
  } else if (failed.length && failed.length === ids.length - having('ready').length) primary = { label: 'Try again', action: 'retry', ids: failed, disabled: false };
  else primary = { label: 'Connecting…', action: null, ids: [], disabled: true };
  return { stages, install, update, signIn, failed, done, primary, problem: failed.length ? errorOf(failed) : '' };
}

/**
 * The browser's sign-ins, asked once before the work questions (S9–S12) → what comes next, from api.browsers() (`browsers`,
 * null while the browsers are still being looked for):
 *   'wait'            not known yet: "Looking for your browsers…" in place, then asked (S11: never skipped for want of it)
 *   { go: answer }    answered before ('allowed' | 'declined'; macOS's refusal counts as declined), or no browser on this
 *                     Mac to ask about ('declined': nothing is copied, and macOS is never asked)
 *   'safari'          Safari chosen without Full Disk Access: "Engelbart requires additional permissions to access Safari"
 *   'ask'             "Allow Engelbart to use your {browser} sign-ins"
 */
export function keychainStep(browsers, platform) {
  if (!browsers) return 'wait';
  if (browsers.keychain === 'allowed') return { go: 'allowed' };
  if (browsers.keychain === 'declined' || browsers.keychain === 'refused') return { go: 'declined' };
  // Off the Mac (2026-10-18, Linux; `platform` the flow's, model/connect.js copiesSignIns): no browser's sign-ins are ever
  // copied (every sign-in goes through Engelbart's own window), so there is nothing to ask. Allowed, never shown, as main's
  // browsers.list answers there (../../main/onboarding/browsers.cjs): declined, the run would leave out every app that needs
  // a sign-in as turned down (connect/session.cjs), with nobody asked and Engelbart's window able to sign in.
  if (platform && platform !== 'darwin') return { go: 'allowed' };
  if (!Array.isArray(browsers.browsers) || !browsers.browsers.length) return { go: 'declined' };
  if (browsers.chosenId === 'safari' && !(browsers.safari && browsers.safari.diskAccess === true)) return 'safari';
  return 'ask';
}

/** The chosen browser's profiles (COOKIES' api.browsers(): [] for one with a single profile, or none readable). */
export function profilesOf(browsers) {
  const list = (browsers && Array.isArray(browsers.browsers)) ? browsers.browsers : [];
  const chosen = list.find((browser) => browser.id === (browsers && browsers.chosenId));
  return chosen && Array.isArray(chosen.profiles) ? chosen.profiles : [];
}

/**
 * After Allow (or Safari's disk access granted): "Select your {Browser} profile" when the chosen browser has more than one
 * and none of them was chosen (S10), else 'macos': the one prompt macOS shows for the browser's sign-ins, at once (S12).
 */
export function afterAllow(browsers) {
  const profiles = profilesOf(browsers);
  if (profiles.length > 1 && !profiles.some((profile) => profile.id === (browsers && browsers.chosenProfile))) return 'profile';
  return 'macos';
}

/** The run's `keychain` (S11): from the answer alone. Declined, refused or never answered, macOS is never asked. */
export const runKeychain = (browsers) => !!browsers && browsers.keychain === 'allowed';
