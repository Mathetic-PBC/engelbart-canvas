import React from 'react';
import { createRoot } from 'react-dom/client';
import ImportFlow, { COPY } from './ImportFlow.jsx';
import ImportStatus from './ImportStatus.jsx';
import NeedPopup from './NeedPopup.jsx';
import { IMPORT_CSS } from './import-css.js';
import { CATALOG, BROWSERS } from '../../shared/import-flow.cjs';
import diskHelperPage from '../../main/onboarding/disk-helper.html';
import tracePage from '../../main/onboarding/trace.html';
import { APP_ICON } from './logos.js';

// The standalone page of Import your context as built (2026-10-13, the workspace: "output a similar HTML as this w same
// like edit features and way to see popups and stuff but with the exact UI you implement"): the app's own ImportFlow and
// ImportStatus components, bundled with a mock of main (no account, permission, file or agent is touched) and the
// mockup's controls: Intro popup, Work flow, Sources, Popups, Edit (copy in place, discovery JSON, scenarios), Save HTML,
// Reset. Built by scripts/build-import-mockup.mjs into design/onboarding-implemented/Onboarding.html.

const STORAGE_KEY = `engelbart-import-implemented-v2:${location.pathname}`;
const saved = (() => { try { return JSON.parse(document.getElementById('saved-design').textContent || '{}'); } catch { return {}; } })();
const stored = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; } })();

const SAMPLE_PROJECTS = { projects: [
  { id: 'engelbart', title: 'Engelbart context import', description: 'Designing how agents bring project context into a local library.', recent: 'Today', folder: '~/engelbart-canvas', evidence: '64 Claude Code sessions in ~/engelbart-canvas' },
  { id: 'requirements', title: 'Programming requirements study', description: 'Studying how novice programmers describe and test requirements.', recent: 'Yesterday', evidence: '12 Codex sessions, 9 Obsidian notes' },
  { id: 'reading', title: 'Learning sciences reading guide', description: 'Organizing research on learning, agency and programming.', recent: 'This week', evidence: 'Zotero collection "Learning sciences"' },
  { id: 'launch', title: 'Engelbart launch', description: 'Preparing onboarding, outreach and the first user sessions.', recent: 'This week', evidence: '8 Claude chats' },
] };
const SAMPLE_TOOLS = {
  tools: CATALOG.map((tool) => ({ id: tool.id, used: ['Obsidian', 'Codex', 'Claude Code', 'Cursor', 'PDFs on this Mac', '__sites', 'Notion', 'Google Docs', 'Claude', 'ChatGPT', 'Zotero', 'Overleaf', 'GitHub', 'Granola', 'Gmail'].includes(tool.id), evidence: tool.local ? 'Found on this Mac' : 'Signed in and visited lately', method: tool.local ? 'local' : 'agent' })),
  additional: [{ name: 'Linear', website: 'https://linear.app', used: true, evidence: '41 visits this month' }],
};
const SCENARIOS = {
  both: [{ id: 'anthropic', installed: true, signedIn: true, subscription: 'max' }, { id: 'openai', installed: true, signedIn: true, subscription: 'plus' }],
  claude: [{ id: 'anthropic', installed: true, signedIn: true, subscription: 'max' }, { id: 'openai', installed: true, signedIn: true, subscription: null }],
  codex: [{ id: 'anthropic', installed: true, signedIn: true, subscription: null }, { id: 'openai', installed: true, signedIn: true, subscription: 'plus' }],
  none: [{ id: 'anthropic', installed: false, signedIn: false, subscription: null }, { id: 'openai', installed: false, signedIn: false, subscription: null }],
};
// `agents`: whether the person's Claude Code or Codex already lets its agents use their browser ('allowed'), Engelbart asks
// first ('ask'), or no browser has the extension ('none') (src/main/onboarding/browser-agents.cjs).
const defaults = () => ({ copy: {}, scenario: 'both', disk: false, browsers: ['arc', 'chrome', 'safari', 'firefox'], agents: 'ask', projects: SAMPLE_PROJECTS, tools: SAMPLE_TOOLS });
const initialConfig = { ...defaults(), ...(saved.config || {}), ...(stored || {}) };

// shared/import-flow.cjs chooseProvider's rule: both subscribed is always asked (the one picked before suggested).
function decide(list, remembered) {
  const ready = list.filter((one) => one.installed && one.signedIn);
  if (!ready.length) return { pick: null, ask: false, choices: [], setup: true };
  const paid = ready.filter((one) => one.subscription);
  if (paid.length >= 2) return { pick: null, ask: true, choices: paid.map((one) => one.id), setup: false, suggested: remembered && paid.some((one) => one.id === remembered) ? remembered : null };
  if (paid.length === 1) return { pick: paid[0].id, ask: false, choices: [paid[0].id], setup: false };
  return { pick: ready[0].id, ask: false, choices: [ready[0].id], setup: false };
}

/** main, in this page: timers in place of agents, nothing read or sent. */
function createMockApi(getConfig) {
  const listeners = { discovery: new Set(), disk: new Set(), tools: new Set() };
  const emit = (kind, value) => listeners[kind].forEach((fn) => fn(value));
  let remembered = null;
  let flow = null;
  let disc = { projects: { status: 'idle' }, tools: { status: 'idle' } };
  let keychain = null;
  let browserChosen = null;
  let diskGranted = getConfig().disk;
  let installed = { claude: SCENARIOS[getConfig().scenario][0].installed, codex: SCENARIOS[getConfig().scenario][1].installed };
  // Set up and signed in from the tools dialog: each with its subscription, so both done asks which (the workspace: "if
  // not authenticated, show the login then choose").
  const providerList = () => SCENARIOS[getConfig().scenario].map((one) => {
    const done = one.id === 'anthropic' ? installed.claude : installed.codex;
    return { ...one, installed: done || one.installed, signedIn: done || one.signedIn, subscription: one.subscription || (done && getConfig().scenario === 'none' ? (one.id === 'anthropic' ? 'max' : 'plus') : null) };
  });
  let agentsAnswer = null;
  const agentsStatus = () => {
    const kind = getConfig().agents || 'ask';
    const available = kind !== 'none';
    const byCli = kind === 'allowed';
    return { available, browser: available ? { id: 'chrome', name: 'Chrome' } : null, others: [], allowedByCli: byCli, consent: agentsAnswer, ask: available && !byCli && !agentsAnswer, use: available && agentsAnswer !== 'declined' && (byCli || agentsAnswer === 'allowed'), why: available ? '' : 'The extension is not in a browser on this Mac' };
  };
  const snapTools = () => ({ checked: true, tools: { git: { status: 'ready', installed: true }, claude: { status: providerList()[0].signedIn ? 'ready' : 'missing', installed: providerList()[0].installed }, codex: { status: providerList()[1].signedIn ? 'ready' : 'missing', installed: providerList()[1].installed } } });
  const browsersOut = () => {
    const ids = getConfig().browsers.filter((id) => BROWSERS.some((browser) => browser.id === id));
    const chosen = browserChosen && ids.includes(browserChosen) ? browserChosen : ids[0] || null;
    return { browsers: ids.map((id) => ({ ...BROWSERS.find((browser) => browser.id === id), isDefault: id === ids[0] })), defaultId: ids[0] || null, chosenId: chosen, keychain };
  };
  return {
    flow: async () => flow,
    saveFlow: async (value) => { flow = value; return true; },
    providers: async () => ({ providers: providerList(), decision: decide(providerList(), remembered), remembered }),
    rememberProvider: async (id) => { remembered = id; return { providers: providerList(), decision: decide(providerList(), remembered), remembered }; },
    browsers: async () => browsersOut(),
    chooseBrowser: async (id) => { browserChosen = id; return browsersOut(); },
    keychain: async (answer) => { keychain = answer; return answer; },
    browserAgents: async () => agentsStatus(),
    browserAgentsAnswer: async (answer) => { agentsAnswer = answer; return answer; },
    discovery: async () => disc,
    discoverProjects: async ({ provider, again } = {}) => {
      if (!again && ['running', 'done'].includes(disc.projects.status)) return disc;
      disc = { ...disc, projects: { status: 'running', provider, projects: [] } };
      setTimeout(() => { disc = { ...disc, projects: { status: 'done', provider, projects: getConfig().projects.projects.slice(0, 5) } }; emit('discovery', disc); }, 1300);
      return disc;
    },
    discoverTools: async ({ provider, browserId, again } = {}) => {
      if (!again && ['checking', 'done'].includes(disc.tools.status)) return disc;
      const evidence = Object.fromEntries(getConfig().tools.tools.filter((tool) => tool.method === 'local').map((tool) => [tool.id, { used: tool.used, method: 'local', evidence: tool.evidence }]));
      disc = { ...disc, tools: { status: 'checking', provider, browser: browserId, results: { tools: getConfig().tools.tools.map((tool) => ({ ...tool, used: tool.method === 'local' ? tool.used : false, method: tool.method === 'local' ? 'local' : 'none' })), additional: [] }, evidence } };
      setTimeout(() => { disc = { ...disc, tools: { ...disc.tools, status: 'done', results: getConfig().tools } }; emit('discovery', disc); }, 1600);
      return disc;
    },
    onDiscovery: (fn) => { listeners.discovery.add(fn); return () => listeners.discovery.delete(fn); },
    diskAccess: async () => ({ platform: 'darwin', granted: diskGranted, grantedFresh: diskGranted, app: 'Engelbart', needsRelaunch: false }),
    diskAccessOpen: async () => {
      setTimeout(() => { diskGranted = true; emit('disk', { platform: 'darwin', granted: false, grantedFresh: true, app: 'Engelbart', needsRelaunch: true, done: true }); }, 2600);
      return { platform: 'darwin', granted: false, grantedFresh: false, app: 'Engelbart', needsRelaunch: false };
    },
    diskAccessRelaunch: async () => { emit('disk', { platform: 'darwin', granted: true, grantedFresh: true, app: 'Engelbart', needsRelaunch: false, relaunched: true }); toast('Engelbart would quit and reopen here, on this step.'); return true; },
    diskAccessStop: async () => true,
    onDiskAccess: (fn) => { listeners.disk.add(fn); return () => listeners.disk.delete(fn); },
    foldersAsk: async (ids) => Object.fromEntries(ids.map((id) => [id, id === 'Downloads' ? 'denied' : 'allowed'])),
    notesPermission: async () => ({ allowed: true }),
    tools: async () => snapTools(),
    onTools: (fn) => { listeners.tools.add(fn); return () => listeners.tools.delete(fn); },
    toolsInstall: async (ids) => { setTimeout(() => { for (const id of ids) installed[id] = true; emit('tools', snapTools()); }, 900); return true; },
    toolsSignIn: async (id) => { setTimeout(() => { installed[id] = true; emit('tools', snapTools()); }, 900); return true; },
    detect: async () => ({ apps: { Obsidian: { found: true }, 'Claude Code': { found: true }, Codex: { found: true }, Cursor: { found: true }, [CATALOG.find((tool) => tool.id === 'PDFs on this Mac').id]: { found: true } }, sites: { found: true }, github: { found: false }, localRepos: [] }),
    pickFiles: async () => [{ path: '/Users/you/Documents/Engelbart notes.md', name: 'Engelbart notes.md' }],
    pickDirectory: async () => `/Users/you/Documents/${['Papers', 'Research vault', 'Recordings'][Math.floor(Math.random() * 3)]}`,
    connectStart: async (choices) => { lastChoices = choices; return { id: 'sample-session', ...sampleSession(choices) }; },
    startProject: async (input) => ({ project: { id: `project-${input.name}`, name: input.name }, workspaceId: 'welcome' }),
    openTrace: async () => true,
  };
}

let lastChoices = null;
// Round 3 (2026-10-13): every web app in Engelbart's own browser with the copied sign-ins; one signed out (ChatGPT here,
// when picked) waits on its sign-in popup, which opens the person's browser.
const SIGNED_OUT = ['ChatGPT'];

/** A run's status as the workspace shows it, from what was chosen; `browser` the browser the person chose. */
function sampleSession(choices, browser = 'Chrome') {
  const direct = (choices && choices.direct) || { projects: [{ title: 'Engelbart context import' }], apps: ['Obsidian', 'Google Docs', 'Granola', 'ChatGPT', 'PDFs on this Mac'] };
  const apps = direct.apps.length ? direct.apps : ['Obsidian', 'Google Docs', 'Granola', 'ChatGPT'];
  const name = (app) => (CATALOG.find((tool) => tool.id === app) || { name: app }).name;
  const jobs = apps.filter((app) => !SIGNED_OUT.includes(app)).slice(0, 8).map((app, index) => ({ id: `job-${index}`, kind: 'import', label: name(app), apps: [app], status: 'running', notes: 0, items: 0, progress: 0 }));
  const needs = apps.filter((app) => SIGNED_OUT.includes(app)).map((app) => ({ id: `need-${app}`, app, kind: 'signin', reason: `Sign in to ${name(app)}`, browser, opened: false, busy: false }));
  return { id: 'sample-session', direct: { mode: direct.mode || 'auto', projects: direct.projects.map((project) => project.title || project) }, jobs, needs, memory: { status: 'waiting' } };
}

const POPUPS = [
  ['intro', 'Import intro'], ['privacy', 'Privacy'], ['apps', 'All apps'], ['scratch-confirm', 'Start confirmation'], ['project', 'New project'],
  ['provider-choice', 'Choose provider (both subscribed)'], ['tools-setup', 'Tools setup'], ['import-mode', 'Import method'],
  ['keychain', 'Browser sign-ins'], ['keychain-browser', 'Browser picker'], ['keychain-confirm', 'Decline browser sign-ins'],
  ['folders', 'Full Disk Access'], ['disk-wait', 'Waiting for Settings'], ['disk-helper', 'Toggle Setting (beside System Settings)'], ['disk-relaunch', 'Restarting'], ['folder-fallback', 'Deny Full Disk Access'], ['folder-results', 'Folder permissions'],
  ['screen:roles', 'Roles'], ['screen:work', 'What are you working on'], ['screen:projects', 'Recent projects'], ['work-add-project', 'Add a project'],
  ['screen:tools', 'Confirm tools'], ['work-add-tool', 'Add a tool'], ['screen:picker', 'Sources & context (manual)'],
  ['browser-agents', 'Let agents use your browser'], ['browser-agents-confirm', 'Decline browser agents'],
  ['starting', 'Starting imports'], ['workspace', 'The project after Import to Engelbart'], ['status', 'Imports in progress (workspace)'], ['signin', 'Sign-in popup'], ['complete', 'Your imports are complete'], ['status-stop', 'Stop all confirmation'], ['trace', 'Agent trace window'],
];
const PREVIEW_STATE = { provider: 'anthropic', picked: ['engelbart', 'requirements'], roles: ['Researcher'], folderAnswers: { Desktop: 'allowed', Documents: 'allowed', Downloads: 'denied', 'iCloud Drive': 'allowed' }, agentsBrowser: 'Chrome', agentsApps: ['Google Docs', 'ChatGPT', 'Overleaf'] };

let toast = () => {};

function Standalone() {
  const [config, setConfig] = React.useState(initialConfig);
  const configRef = React.useRef(config);
  configRef.current = config;
  const api = React.useMemo(() => createMockApi(() => configRef.current), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [run, setRun] = React.useState(0);
  const [edit, setEdit] = React.useState(false);
  const [chrome, setChrome] = React.useState(true);
  const [preview, setPreview] = React.useState(null);
  const [overlay, setOverlay] = React.useState(null); // 'status' | 'disk-helper' | 'trace'
  // After Import to Engelbart: the project opens (a stand-in workspace here) with the run's status over it, which the
  // person can put away and work under (2026-10-13, second round: the flow had stayed on "Starting your imports").
  const [workspace, setWorkspace] = React.useState(null); // { name } | null
  const [status, setStatus] = React.useState(null); // the run's snapshot, changed by its buttons here
  const [stopAsk, setStopAsk] = React.useState(false);
  const [later, setLater] = React.useState([]); // the sign-in popups put away (Later)
  // The sample run goes on by itself: each import a quarter further every half second, until done.
  React.useEffect(() => {
    if (!status || !status.jobs.some((job) => job.status === 'running')) return undefined;
    const timer = setInterval(() => setStatus((now) => (now ? { ...now, jobs: now.jobs.map((job) => (job.status === 'running' ? (job.progress >= 75 ? { ...job, status: 'done', notes: 3 + (job.id.length % 5), progress: 100 } : { ...job, progress: (job.progress || 0) + 25 }) : job)) } : now)), 500);
    return () => clearInterval(timer);
  }, [status && status.id, status && status.jobs.some((job) => job.status === 'running')]); // eslint-disable-line react-hooks/exhaustive-deps
  // Everything ended: the completion opens by itself, as in the app.
  const ended = !!status && status.jobs.length > 0 && status.jobs.every((job) => ['done', 'failed', 'stopped'].includes(job.status)) && !status.needs.length;
  React.useEffect(() => { if (ended && workspace) setOverlay('status'); }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps
  const [message, setMessage] = React.useState('');
  const [json, setJson] = React.useState({ projects: JSON.stringify(config.projects, null, 2), tools: JSON.stringify(config.tools, null, 2) });
  toast = (text) => { setMessage(text); setTimeout(() => setMessage(''), 2600); };
  const keep = (next) => { setConfig(next); try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private window */ } };
  const setCopy = (key, value) => keep({ ...configRef.current, copy: { ...configRef.current.copy, [key]: value } });

  const agentsBrowser = () => 'Chrome';
  const openWorkspace = (name) => { setWorkspace({ name: name || 'Engelbart context import' }); setStatus(sampleSession(lastChoices, agentsBrowser())); setOverlay('status'); };
  const pick = (value) => {
    if (!value) return;
    setOverlay(null);
    setStopAsk(false);
    if (value === 'workspace') { openWorkspace(); setOverlay(null); return; }
    if (value === 'status' || value === 'status-stop') { if (!status) setStatus(sampleSession(lastChoices, agentsBrowser())); setStopAsk(value === 'status-stop'); setOverlay('status'); return; }
    if (value === 'signin') { if (!workspace) setWorkspace({ name: 'Engelbart context import' }); setLater([]); setStatus(sampleSession({ direct: { projects: [{ title: 'Engelbart context import' }], apps: ['Obsidian', 'ChatGPT'] } }, agentsBrowser())); return; }
    if (value === 'complete') { if (!workspace) setWorkspace({ name: 'Engelbart context import' }); const done = sampleSession(lastChoices, agentsBrowser()); setStatus({ ...done, needs: [], jobs: done.jobs.map((job) => ({ ...job, status: 'done', notes: 4 })) }); setOverlay('status'); return; }
    if (value === 'disk-helper' || value === 'trace') { setOverlay(value); return; }
    setWorkspace(null);
    if (value.startsWith('screen:')) { setPreview({ screen: value.slice(7), dialog: null, state: { ...PREVIEW_STATE, mode: value === 'screen:picker' || value === 'screen:scopes' ? 'manual' : 'auto' }, at: Date.now() }); return; }
    setPreview({ dialog: value, state: PREVIEW_STATE, at: Date.now() });
  };
  const exportHtml = () => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelector('#root').innerHTML = '';
    clone.querySelector('#saved-design').textContent = JSON.stringify({ config: configRef.current }).replace(/</g, '\\u003c');
    const blob = new Blob([`<!doctype html>\n${clone.outerHTML}`], { type: 'text/html' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'Engelbart · Import your context (implemented).html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const applyJson = () => {
    try {
      const projects = JSON.parse(json.projects);
      const tools = JSON.parse(json.tools);
      if (!Array.isArray(projects.projects) || projects.projects.length < 1 || projects.projects.length > 5 || !Array.isArray(tools.tools)) throw new Error('shape');
      keep({ ...configRef.current, projects, tools });
      toast('Discovery data saved. Reset to run the flow with it.');
    } catch { toast('Use 1–5 projects with ids and titles, and a tools list.'); }
  };
  const reset = () => { setPreview(null); setOverlay(null); setWorkspace(null); setStatus(null); setLater([]); setRun((n) => n + 1); };
  // The status modal's buttons, played out on the sample run.
  const changeStatus = (fn) => setStatus((now) => (now ? fn(now) : now));
  const needOpen = (need) => { changeStatus((now) => ({ ...now, needs: now.needs.map((one) => (one.id === need.id ? { ...one, opened: true } : one)) })); toast(`${need.app}'s sign-in would open in ${need.browser}.`); };
  // "I'm signed in": its sign-in copied over, and its import starts.
  const needDone = (need) => changeStatus((now) => ({ ...now, needs: now.needs.filter((one) => one.id !== need.id), jobs: [...now.jobs, { id: `job-${need.app}`, kind: 'import', label: need.app, apps: [need.app], status: 'running', notes: 0, items: 0, progress: 0 }] }));
  const needSkip = (need) => changeStatus((now) => ({ ...now, needs: now.needs.filter((one) => one.id !== need.id) }));
  const pendingNeed = workspace && status ? status.needs.find((need) => !later.includes(need.id)) : null;
  const stopAll = () => { changeStatus((now) => ({ ...now, needs: [], jobs: now.jobs.map((job) => (job.status === 'done' ? job : { ...job, status: 'stopped', activity: '' })) })); toast('Every import stopped. What came in stays.'); };

  const helperDoc = diskHelperPage.replace('<script>', `<script>window.diskHelper={onState:(cb)=>setTimeout(()=>cb({app:'Engelbart',icon:${JSON.stringify(APP_ICON)}}),0),action:(name)=>parent.postMessage({helper:name},'*')};</script><script>`);
  const traceDoc = tracePage.replace('<script id="trace-render">', `<script>window.TRACE_SAVED=${JSON.stringify(sampleTrace()).replace(/</g, '\\u003c')};</script><script id="trace-render">`);

  return (
    <>
      <style>{`${IMPORT_CSS}
body{margin:0}
.dev{position:fixed;top:14px;left:14px;z-index:200;display:flex;align-items:center;gap:3px;padding:5px;border:1px solid #eaeaea;border-radius:10px;background:#f7f7f7;box-shadow:0 1px 4px #00000004;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif;max-width:calc(100vw - 28px);flex-wrap:wrap}
.dev button,.dev select{font-size:12px;border:0;background:transparent;border-radius:6px;padding:6px 9px;color:#666;cursor:pointer}
.dev button.on{background:#171717;color:#fff}
.dev .divider{width:1px;height:17px;background:#ddd;margin:0 3px}
.dev select{max-width:150px}
.restore{position:fixed;top:14px;left:14px;z-index:200;border:1px solid #eaeaea;border-radius:9px;background:#fff;padding:9px 12px;font-size:12px;color:#888;cursor:pointer}
.editor{position:fixed;right:16px;top:72px;bottom:100px;width:300px;background:#fff;border:1px solid #eaeaea;border-radius:12px;box-shadow:0 12px 40px #0000001a;z-index:190;padding:20px;overflow:auto;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif}
.editor h3{margin:0;font-size:16px;font-weight:600}
.editor p{font-size:12px;line-height:1.5;color:#8f8f8f}
.editor label{font-size:12px;display:block;margin:16px 0 5px}
.editor input,.editor textarea,.editor select{width:100%;box-sizing:border-box;font-size:12px;padding:8px;border:1px solid #eaeaea;border-radius:6px;font-family:ui-monospace,Menlo,monospace}
.editor textarea{min-height:120px}
.editor button{width:100%;margin-top:10px;font-size:13px;min-height:34px;border-radius:8px;border:1px solid #171717;background:#171717;color:#fff;cursor:pointer}
.editor button.secondary{background:#fff;color:#171717;border-color:#c9c9c9}
.toast{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:#171717;color:#fff;z-index:300;padding:12px 18px;border-radius:10px;font-size:13px;font-family:-apple-system,Inter,sans-serif}
.overlay-frame{position:fixed;inset:0;z-index:150;background:#00000040;display:flex;align-items:center;justify-content:center}
.overlay-frame iframe{border:0;background:transparent}
.overlay-frame .close-preview{position:absolute;top:18px;right:22px;font-size:22px;border:0;background:#fff;border-radius:50%;width:34px;height:34px;cursor:pointer}
.ix.editing [data-copy]{outline:1px dashed #0070f3;outline-offset:3px}`}</style>
      {workspace ? <MockWorkspace name={workspace.name} status={status} onStatus={() => setOverlay('status')} /> : (
        <ImportFlow key={run} api={api} mode="new" edit={edit} copy={config.copy} setCopy={setCopy} preview={preview} platform="darwin"
          onDone={async (made) => { openWorkspace(made && made.project ? made.project.name : ''); toast('Projects made: the first opens, and the imports run in the background.'); }} />
      )}
      {overlay === 'status' && status && <ImportStatus key={stopAsk ? 'stop' : 'status'} session={status} previewStop={stopAsk} onClose={() => { setOverlay(null); setStopAsk(false); if (!workspace) openWorkspace(); setOverlay(null); }} onNeed={(need) => setLater((now) => now.filter((id) => id !== need.id))} onNeedDone={needDone} onSkip={needSkip} onStop={stopAll} onDone={() => { setOverlay(null); setStatus(null); toast('The library would open.'); }} />}
      {pendingNeed && <NeedPopup key={pendingNeed.id} need={pendingNeed} onOpen={() => needOpen(pendingNeed)} onDone={() => needDone(pendingNeed)} onSkip={() => needSkip(pendingNeed)} onLater={() => setLater((now) => [...now, pendingNeed.id])} />}
      {overlay === 'disk-helper' && (
        <div className="overlay-frame" onClick={() => setOverlay(null)}>
          <iframe title="Full Disk Access helper" srcDoc={helperDoc} style={{ width: 330, height: 150 }} onClick={(event) => event.stopPropagation()} />
          <button type="button" className="close-preview" onClick={() => setOverlay(null)}>×</button>
        </div>
      )}
      {overlay === 'trace' && (
        <div className="overlay-frame" style={{ background: '#00000059' }}>
          <iframe title="Agent trace" srcDoc={traceDoc} style={{ width: 'min(980px, 92vw)', height: '88vh', background: '#fff', borderRadius: 10 }} />
          <button type="button" className="close-preview" onClick={() => setOverlay(null)}>×</button>
        </div>
      )}
      {chrome ? (
        <nav className="dev" aria-label="Mockup controls">
          <button type="button" onClick={() => pick('intro')}>Intro popup</button>
          <button type="button" onClick={() => pick('screen:roles')}>Work flow</button>
          <button type="button" onClick={() => pick('screen:picker')}>Sources</button>
          <button type="button" onClick={() => pick('screen:tools')}>Tools</button>
          <span className="divider" />
          <select aria-label="Preview a popup" value="" onChange={(event) => pick(event.target.value)}>
            <option value="">Popups</option>
            {POPUPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="button" className={edit ? 'on' : ''} onClick={() => setEdit((now) => !now)}>Edit</button>
          <button type="button" onClick={exportHtml}>Save HTML</button>
          <button type="button" onClick={reset}>Reset</button>
          <button type="button" aria-label="Hide mockup controls" onClick={() => setChrome(false)}>×</button>
        </nav>
      ) : <button type="button" className="restore" onClick={() => setChrome(true)}>Mockup</button>}
      {edit && (
        <aside className="editor" aria-label="Design editor">
          <h3>Edit this page</h3>
          <p>Click outlined copy to edit it in place. Changes save in this browser; Save HTML downloads a standalone copy with them. The rest is the app’s own code, run against sample data.</p>
          {Object.keys(COPY).map((key) => (
            <React.Fragment key={key}>
              <label htmlFor={`edit-${key}`}>{key}</label>
              <input id={`edit-${key}`} value={config.copy[key] != null ? config.copy[key] : COPY[key]} onChange={(event) => setCopy(key, event.target.value)} />
            </React.Fragment>
          ))}
          <label htmlFor="scenario">Claude Code and Codex</label>
          <select id="scenario" value={config.scenario} onChange={(event) => keep({ ...config, scenario: event.target.value })}>
            <option value="both">Both subscribed: asked which</option>
            <option value="claude">Only Claude subscribed</option>
            <option value="codex">Only Codex subscribed</option>
            <option value="none">Neither set up</option>
          </select>
          <label htmlFor="browsers">Installed browsers (ids, the default first)</label>
          <input id="browsers" value={config.browsers.join(', ')} onChange={(event) => keep({ ...config, browsers: event.target.value.split(',').map((id) => id.trim()).filter(Boolean) })} />
          <label htmlFor="agents">Agents in the person’s browser</label>
          <select id="agents" value={config.agents || 'ask'} onChange={(event) => keep({ ...config, agents: event.target.value })}>
            <option value="ask">Not allowed in their CLI: Engelbart asks</option>
            <option value="allowed">Already allowed in their CLI: not asked</option>
            <option value="none">No browser has the extension</option>
          </select>
          <label><input type="checkbox" checked={config.disk} onChange={(event) => keep({ ...config, disk: event.target.checked })} style={{ width: 'auto', marginRight: 6 }} />Full Disk Access already on</label>
          <label htmlFor="projects-json">Project discovery JSON (the agent’s answer)</label>
          <textarea id="projects-json" spellCheck={false} value={json.projects} onChange={(event) => setJson((now) => ({ ...now, projects: event.target.value }))} />
          <label htmlFor="tools-json">Tool discovery JSON (the agent’s answer)</label>
          <textarea id="tools-json" spellCheck={false} value={json.tools} onChange={(event) => setJson((now) => ({ ...now, tools: event.target.value }))} />
          <button type="button" className="secondary" onClick={applyJson}>Apply discovery data</button>
          <button type="button" onClick={exportHtml}>Save edited HTML</button>
          <button type="button" className="secondary" onClick={() => { keep(defaults()); setJson({ projects: JSON.stringify(SAMPLE_PROJECTS, null, 2), tools: JSON.stringify(SAMPLE_TOOLS, null, 2) }); reset(); }}>Restore original design</button>
        </aside>
      )}
      {message && <div className="toast" role="status">{message}</div>}
    </>
  );
}

/** The project the run opens into, standing in for Engelbart's workspace: a page to write in, and the imports' chip. */
function MockWorkspace({ name, status, onStatus }) {
  const [text, setText] = React.useState('');
  const jobs = status ? status.jobs : [];
  const running = jobs.filter((job) => ['running', 'waiting', 'queued'].includes(job.status)).length;
  const needs = status ? status.needs.length : 0;
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', gridTemplateColumns: '240px 1fr', fontFamily: '-apple-system, Inter, sans-serif', color: '#171717', background: '#fff' }} data-mock-workspace="1">
      <aside style={{ borderRight: '1px solid #eaeaea', padding: '64px 16px 16px', background: '#fafafa' }}>
        <div style={{ fontSize: 12, color: '#8f8f8f', marginBottom: 8 }}>Project</div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{name}</div>
        <div style={{ marginTop: 18, fontSize: 13, color: '#666' }}>Welcome</div>
      </aside>
      <main style={{ padding: '64px 48px', position: 'relative' }}>
        {status && (
          <button type="button" onClick={onStatus} style={{ position: 'absolute', top: 18, right: 24, border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
            {needs ? `Imports · ${needs} need${needs === 1 ? 's' : ''} you` : running ? `Imports · ${running} running` : 'Imports · done'}
          </button>
        )}
        <h1 style={{ fontSize: 24, margin: '0 0 16px' }}>Welcome</h1>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Write here while the imports run…" style={{ width: '100%', minHeight: 260, border: 0, outline: 0, resize: 'none', font: '15px/1.6 -apple-system, Inter, sans-serif' }} />
      </main>
    </div>
  );
}

function sampleTrace() {
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  return [
    { id: '1', type: 'event', at: at(300), kind: 'discovery', text: 'Looking for recent projects with Claude Code', detail: '{ "folders": 6, "vaults": 1, "zotero": 4 }' },
    { id: '2', type: 'turn', at: at(299), ended: at(281), status: 'done', kind: 'projects', provider: 'anthropic', model: 'Sonnet', effort: 'high', label: 'Recent projects', dirs: [], system: 'You find the projects a person has been working on lately…', message: '<recent_work note="Read on this Mac without a model, the last 120 days.">\n{ "folders": [ … ] }\n</recent_work>', output: JSON.stringify(SAMPLE_PROJECTS, null, 1), error: '', activity: [] },
    { id: '3', type: 'event', at: at(200), kind: 'start', text: 'Connect session started (Import your context, tools found by agents) on Claude Code (Sonnet · high)', detail: '{ "direct": { "projects": [ … ] } }' },
    { id: '4', type: 'event', at: at(199), kind: 'dispatch', text: 'Queued import: Notes: Obsidian', detail: 'Bring in from Obsidian only what pertains to these projects the person picked:\n- Engelbart context import: …' },
    { id: '5', type: 'turn', at: at(198), ended: null, status: 'running', kind: 'import', provider: 'anthropic', model: 'Sonnet', effort: 'high', label: 'Notes: Obsidian', dirs: ['/Users/you/Documents/Research vault'], system: 'You are one of Engelbart’s import agents…', message: '<plan>\nBring in from Obsidian only what pertains to these projects…\n</plan>', output: '', error: '', activity: [{ at: at(190), text: 'Listing the vault’s notes changed this year' }, { at: at(150), text: 'Saving 4 notes about the context import' }] },
    { id: '6', type: 'event', at: at(120), kind: 'need', text: 'Needs the person (signin, Claude): Sign in to Claude so its agent can bring in what pertains to your projects', detail: null },
    { id: '7', type: 'event', at: at(110), kind: 'dispatch', text: 'Queued import (in Chrome): Notes: Google Docs', detail: 'Bring in from Google Docs only what pertains to these projects… Find what belongs with these projects yourself, in the person\'s own Chrome (their sign-ins are there)…' },
    { id: '8', type: 'turn', at: at(108), ended: null, status: 'running', kind: 'browse', provider: 'anthropic', model: 'Sonnet', effort: 'high', label: 'Notes: Google Docs', dirs: [], system: 'You are an import agent inside Engelbart… # Guardrails\n\nYou are in the person\'s own browser, signed in as them…\n- You may: open pages, in tabs of your own; read them; scroll; search; download files; and export…\n- You must never: send, post, delete, archive, change settings, type a password or close tabs…\n- At a login page … call needs_you…', message: '<plan>\nBring in from Google Docs only what pertains to …\n</plan>\n\n<browser note="The person\'s own browser, where they are signed in. You work in it through Claude in Chrome.">\n{"browser":"Chrome","sites":["docs.google.com","drive.google.com"]}\n</browser>', command: 'claude -p --chrome --setting-sources "" --strict-mcp-config --tools "Read,Grep,Glob,WebSearch,WebFetch" --disallowedTools "mcp__claude-in-chrome__javascript_tool,…,mcp__claude-in-chrome__tabs_close_mcp" --permission-mode auto --permission-prompts none --model sonnet --effort high', output: '', error: '', activity: [{ at: at(107), text: 'Looking at its tabs' }, { at: at(105), text: 'Opening docs.google.com in a new tab' }, { at: at(98), text: 'Reading the page' }, { at: at(90), text: 'Downloading “Study protocol v3” as Markdown' }, { at: at(84), text: 'Adding “Study protocol v3” to the library' }], transcript: '{"type":"system","subtype":"init","model":"claude-sonnet-5-5","tools":["mcp__claude-in-chrome__tabs_context_mcp", …]}\n…' },
  ];
}

createRoot(document.getElementById('root')).render(<Standalone />);
