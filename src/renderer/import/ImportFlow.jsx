import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { TOOL_LOGOS, WORKS, BROWSER_LOGOS, PROVIDER_LOGOS } from './logos.js';
import {
  CATALOG, CATALOG_IDS, ROLES, GROUPS, LOCAL_FOLDERS, SITES, PROVIDER_NAMES, BROWSERS, catalogTool, isLocal, reachOf, isWebApp,
  scopeKind, emptyScope, scopeReady, scopeOptions,
} from '../../shared/import-flow.cjs';
import { LOCAL_PDFS, PERIODS, DEFAULT_PERIOD_DAYS, cleanDays, shownName } from '../../shared/connect-sources.cjs';

// Import your context (2026-10-13, the "Onboarding" workspace): the work-first import flow, a port of the mockup
// design/onboarding-mockup/Onboarding.html with its markup and classes (its CSS is import-css.js, scoped under .ix).
//
//   Import context → (the provider: asked when both are subscribed; tools set up when neither can run) → How would you
//   like to import context? → (the browser's sign-ins) → What kind of work do you do? → What are you working on?
//   → What project do you want to work on first? → agents: Confirm your tools | myself: the sources, then exactly what
//   to bring in → (Full Disk Access) → (Let agents use your browser?) → Import to Engelbart
//
// The project agent starts the moment the provider is known, before the method is chosen; the tool agent once the
// method is "Let agents choose" and the browser's sign-ins are answered (src/main/onboarding/discover.cjs). Import to
// Engelbart starts Connect's pipeline in its direct mode (src/main/connect/session.cjs): one import agent a tool, each
// told only the projects picked. In a new user's onboarding (`mode` 'new') a project is made for every project picked
// and the first opens; over a workspace (`mode` 'modal', the redo that replaced "guided setup") the imports go to that
// project and the modal closes. Everything it talks to goes through `api` (./import-api.js in the app, the standalone
// page's mock), so the same component is the app's and the HTML's. Where the flow is, is saved (`saveFlow`) so the
// relaunch Full Disk Access needs comes back to the same step.

const FILE_TOOLS = ['Obsidian', 'Zoom', LOCAL_PDFS, LOCAL_FOLDERS];
const DEFAULT_PICKS = [];
const ANSWERS = [
  ['Does my context leave my computer?', 'No. All files, both saved locally and located in the cloud through a 3rd-party are all saved locally and are not uploaded to any of our servers. However, your text will be sent to model providers during the retrieval process and is subject to their own data retention guidelines, just like any other AI chat.'],
  ['Will you sell my data?', 'No. Engelbart does neither retains nor sells any of your data. Importing context simply makes the experience more seamless for you and is not a means to collect your data :)'],
  ["Can I delete things I've imported?", 'Yes. You can remove anything from a project or your library at any time.'],
  ['Where does my context go?', "Engelbart keeps track of the locations of your local files in a local table and creates local copies of files you've created through 3rd-party applications. All context is aggregated in the Engelbart Library, which stays local."],
];
export const COPY = {
  title: 'Import your context',
  subtitle: "Agents will import your notes, chats, and other project context into Engelbart. Everything remains local and isn't uploaded to the cloud.",
  primary: 'Import context (recommended)',
  secondary: 'Start from scratch',
  privacy: 'Remove anything at any time.',
  pickerTitle: 'What should go in your library?',
  bring: 'Bring these in',
};
const FLOW_VERSION = 2;

/* ------------------------------------------------------------------------------------------------- small pieces */

const Svg = ({ d }) => <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />;
const CHEV = <Svg d={'<path d="m9 5 7 7-7 7"/>'} />;
const DOWN = <Svg d={'<path d="m6 9 6 6 6-6"/>'} />;
const CHECK = <Svg d={'<path d="m5 12 4 4 10-10"/>'} />;
const KEY = <Svg d={'<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2"/>'} />;
const FOLDER = <Svg d={'<path d="M2 5h7l2 2h11v13H2z"/>'} />;
const GLOBE = <Svg d={'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18"/>'} />;
const WEB = <Svg d={'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>'} />;
const PLUS = <Svg d={'<path d="M12 5v14M5 12h14"/>'} />;
// A project's symbol is the workspace icon (../ui/SidebarIcons.jsx WorkspaceIcon): workspaces become projects (2026-10-13).
const PROJECT = <Svg d={'<rect x="3.5" y="3" width="6.5" height="18" rx="2.5"/><rect x="14" y="3" width="6.5" height="10.5" rx="2.5"/><rect x="14" y="16.5" width="6.5" height="4.5" rx="2.25"/>'} />;
const CURSOR = <Svg d={'<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/>'} />;

const Check = ({ on }) => <span className={`cb ${on ? 'on' : ''}`}>{on ? CHECK : null}</span>;
const Logo = ({ src, name = '' }) => (src ? <img src={src} alt={name} /> : FOLDER);
const toolName = (id, added = []) => (catalogTool(id) ? catalogTool(id).name : (added.find((tool) => tool.id === id) || {}).name || id);
function ToolLogo({ id }) {
  if (TOOL_LOGOS[id]) return <img src={TOOL_LOGOS[id]} alt="" />;
  if (id === LOCAL_PDFS || id === LOCAL_FOLDERS) return FOLDER;
  return WEB;
}
const browserName = (id) => ((BROWSERS.find((browser) => browser.id === id) || {}).name || 'your browser');

/** Editable copy (the standalone page's Edit): its text, or the override saved for its key. */
const CopyContext = React.createContext({ edit: false, copy: {}, setCopy: () => {} });
function T({ k, tag = 'span', fallback, className, ...rest }) {
  const { edit, copy, setCopy } = React.useContext(CopyContext);
  const Tag = tag;
  const text = copy[k] != null ? copy[k] : fallback != null ? fallback : COPY[k] || '';
  if (!edit) return <Tag className={className} data-copy={k} {...rest}>{text}</Tag>;
  return <Tag className={className} data-copy={k} contentEditable="plaintext-only" suppressContentEditableWarning onBlur={(event) => setCopy(k, event.currentTarget.textContent)} {...rest}>{text}</Tag>;
}

/* ----------------------------------------------------------------------------------------------- the flow's state */

const fresh = () => ({
  v: FLOW_VERSION,
  screen: 'picker', dialog: 'intro', purpose: null,
  mode: null, modeChoice: null, modeFirst: false, scopeOpen: null, notesConsent: false,
  provider: null, providerChoice: null,
  roles: [], work: '', customProjects: [], picked: [],
  confirmed: [], touched: [], added: [], toolOrder: [],
  picks: [...DEFAULT_PICKS], open: ['notes'], period: DEFAULT_PERIOD_DAYS, consent: true, leaves: false, menu: null,
  scopes: {}, browserChoice: null, folderAnswers: null, pendingRun: false,
  scratchName: '', scratchDesc: '',
});

const selectedProjects = (F, discovery) => [...((discovery && discovery.projects && discovery.projects.projects) || []), ...F.customProjects].filter((project) => F.picked.includes(project.id));
const allProjects = (F, discovery) => [...((discovery && discovery.projects && discovery.projects.projects) || []), ...F.customProjects];

/** The apps a run imports from: the tools confirmed (agents), else the sources picked (myself). */
const runApps = (F) => (F.mode === 'auto' ? F.confirmed : F.picks);

const RUN_LABEL = 'Import to Engelbart';

/** Every tool the tools page lists (the catalog's, then those added), its ids. */
const toolIds = (F) => [...CATALOG.map((tool) => tool.id), ...F.added.map((tool) => tool.id).filter((id) => !CATALOG_IDS.includes(id))];

/** The tools page's order settled now: the selected tools first, then the rest, each in the catalog's order. */
function settleTools(F) {
  const all = toolIds(F);
  return [...all.filter((id) => F.confirmed.includes(id)), ...all.filter((id) => !F.confirmed.includes(id))];
}

/** The tools page's order: what was settled (settleTools), then any tool it does not hold yet, the selected ones first. */
function orderedTools(F) {
  const all = toolIds(F);
  const settled = (F.toolOrder || []).filter((id) => all.includes(id));
  const rest = all.filter((id) => !settled.includes(id));
  return [...settled, ...rest.filter((id) => F.confirmed.includes(id)), ...rest.filter((id) => !F.confirmed.includes(id))];
}

/** `order` with `id` placed after the last selected tool (a tool added by name, selected as it is added). */
function placeSelected(order, id, confirmed) {
  const without = order.filter((one) => one !== id);
  let at = 0;
  without.forEach((one, index) => { if (confirmed.includes(one)) at = index + 1; });
  return [...without.slice(0, at), id, ...without.slice(at)];
}

/** A source's hint under its name in the picker (the mockup's third column). */
function sourceHint(app, diskGranted) {
  const reach = reachOf(app);
  if (reach === 'web' || reach === 'connector' || reach === 'signin') return 'Needs sign-in';
  if (reach === 'automation') return 'macOS will ask';
  if ((app === LOCAL_PDFS || app === LOCAL_FOLDERS) && !diskGranted) return 'macOS will ask';
  return '';
}

/* ======================================================================================================== the flow */

/**
 * `api` the flow's calls (./import-api.js); `mode` 'new' (a new user's onboarding, full window) or 'modal' (over a
 * workspace, into project `into`); `onDone(made)` a project was made (new); `onClose()` the modal closed; `edit` and
 * `copy`/`setCopy` the standalone page's editing; `preview` a dialog or screen to show at once (the standalone page's
 * Popups); `platform` 'darwin' or another.
 */
export default function ImportFlow({ api, mode = 'new', into = null, workspaceId = null, onDone = () => {}, onClose = () => {}, edit = false, copy = {}, setCopy = () => {}, preview = null, platform = 'darwin' }) {
  const [F, setF] = React.useState(fresh);
  const set = React.useCallback((patch) => setF((now) => ({ ...now, ...(typeof patch === 'function' ? patch(now) : patch) })), []);
  const latest = React.useRef(F);
  latest.current = F;
  const [restored, setRestored] = React.useState(false);
  const restoredPending = React.useRef(false);
  const [providers, setProviders] = React.useState(null);
  const [browsers, setBrowsers] = React.useState(null);
  const [discovery, setDiscovery] = React.useState(null);
  const [disk, setDisk] = React.useState(null);
  const [toolsSnap, setToolsSnap] = React.useState(null);
  const [found, setFound] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [catalogQuery, setCatalogQuery] = React.useState('');
  const [sender, setSender] = React.useState({});
  const [draft, setDraft] = React.useState({ title: '', description: '', tool: '', website: '' });
  const say = (failure) => setError(failure ? String(failure.message || failure).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : '');

  /* -------- what main knows, and its news */
  React.useEffect(() => {
    let live = true;
    api.flow().then((saved) => {
      if (!live) return;
      if (saved && saved.v === FLOW_VERSION && (mode === 'new' || saved.into === into)) { restoredPending.current = !!saved.pendingRun; setF({ ...fresh(), ...saved, menu: null }); }
      setRestored(true);
    }).catch(() => setRestored(true));
    api.providers(false).then((out) => { if (live) setProviders(out); }).catch(() => {});
    api.browsers().then((out) => { if (live) { setBrowsers(out); set((now) => (now.browserChoice ? {} : { browserChoice: out.chosenId })); } }).catch(() => {});
    api.discovery().then((out) => { if (live) setDiscovery(out); }).catch(() => {});
    api.diskAccess().then((out) => { if (live) setDisk(out); }).catch(() => {});
    api.tools().then((out) => { if (live) setToolsSnap(out); }).catch(() => {});
    api.detect().then((out) => { if (live) setFound(out); }).catch(() => {});
    const offs = [
      api.onDiscovery((out) => setDiscovery(out)),
      api.onDiskAccess((out) => setDisk((now) => ({ ...(now || {}), ...out }))),
      api.onTools((out) => { if (out && out.tools) { setToolsSnap(out); api.providers(true).then(setProviders).catch(() => {}); } }),
    ];
    return () => { live = false; offs.forEach((off) => off && off()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the flow is, kept for the relaunch Full Disk Access needs (and nothing else: closing the flow forgets it).
  React.useEffect(() => {
    if (!restored || preview) return undefined;
    const timer = setTimeout(() => { api.saveFlow({ ...F, into, menu: null }).catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [F, restored]); // eslint-disable-line react-hooks/exhaustive-deps

  // The picker starts with what was found on this Mac ticked (the old choose screen's), once.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !found || !restored) return;
    seeded.current = true;
    // As connect-detect answers (model/connect.js foundRow): what is on this Mac, the browser, GitHub, local repositories.
    const local = Object.entries(found.apps || {}).filter(([app, value]) => value && value.found && CATALOG_IDS.includes(app) && isLocal(app)).map(([app]) => app);
    const more = [...(found.sites && found.sites.found ? [SITES] : []), ...(found.github && found.github.found ? ['GitHub'] : []), ...((found.localRepos || []).length ? [LOCAL_FOLDERS] : [])];
    if ((local.length || more.length) && latest.current.picks.join() === DEFAULT_PICKS.join()) set({ picks: [...new Set([...local, ...more])] });
  }, [found, restored]); // eslint-disable-line react-hooks/exhaustive-deps

  // The tool agent's answer ticks what it found, unless the person touched it.
  React.useEffect(() => {
    const results = discovery && discovery.tools && discovery.tools.results;
    if (!results) return;
    set((now) => {
      const confirmed = new Set(now.confirmed.filter(id => now.touched.includes(id) || (results.tools || []).some(tool => tool.id === id && tool.used && tool.evidence)));
      for (const tool of results.tools) if (!now.touched.includes(tool.id)) { if (tool.used && tool.evidence) confirmed.add(tool.id); else confirmed.delete(tool.id); }
      const added = [...now.added];
      for (const extra of results.additional || []) {
        const id = `custom:${extra.name.toLowerCase()}`;
        if (!added.some((tool) => tool.id === id)) added.push({ id, name: extra.name, website: extra.website || '', source: 'agent' });
        if (extra.used && extra.evidence && !now.touched.includes(id)) confirmed.add(id);
      }
      return { confirmed: [...confirmed], added, toolOrder: settleTools({ ...now, confirmed: [...confirmed], added }) };
    });
  }, [discovery && discovery.tools && discovery.tools.results]); // eslint-disable-line react-hooks/exhaustive-deps

  // The standalone page's Popups: a dialog or a screen at once.
  React.useEffect(() => {
    if (!preview) return;
    if (preview.screen) set({ screen: preview.screen, dialog: preview.dialog || null, ...(preview.state || {}) });
    else set({ dialog: preview.dialog, ...(preview.state || {}) });
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from Full Disk Access's relaunch with a run pending (as the flow was saved, not this launch's): it starts.
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (!restored || resumed.current || !restoredPending.current || !disk) return;
    resumed.current = true;
    if (disk.granted || disk.grantedFresh || F.folderAnswers) void run();
    else set({ pendingRun: false, dialog: 'folders' });
  }, [restored, disk]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full Disk Access granted while the flow waits: a relaunch when this process can't read yet, else the run.
  React.useEffect(() => {
    if (!disk || !disk.done || latest.current.dialog !== 'disk-wait') return;
    // Restarting is not a decision (the bart chat: "The window blinks and reopens on the same step … The user never sees a
    // decision"): said, then done, the run pending so it starts when Engelbart is back.
    if (disk.needsRelaunch) { set({ pendingRun: true, dialog: 'disk-relaunch' }); setTimeout(() => { void relaunch(); }, 120); return; }
    void run();
  }, [disk]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!disk) return;
    // A stand-in Mac (ENGELBART_DISK_ACCESS, the standalone page) "relaunched" without quitting: the run goes on here.
    if (disk.relaunched && latest.current.dialog === 'disk-relaunch') { void run(); return; }
    if (disk.fallback && latest.current.dialog === 'disk-wait') set({ dialog: 'folder-fallback' });
    if (disk.cancelled && latest.current.dialog === 'disk-wait') set({ dialog: 'folders' });
    // Fifteen minutes without the switch: asked again rather than waiting forever.
    if (disk.gaveUp && latest.current.dialog === 'disk-wait') set({ dialog: 'folders' });
  }, [disk]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------- the provider */
  const decision = providers && providers.decision;
  const readyProviders = () => ((providers && providers.providers) || []).filter((one) => one.installed && one.signedIn).map((one) => one.id);

  /** The provider for `purpose` ('start' | 'run'): asked when both are subscribed, the tools set up when none can run. */
  const needProvider = async (purpose) => {
    let status = providers;
    try { status = await api.providers(true); setProviders(status); } catch { /* the last answer */ }
    const out = status && status.decision;
    if (!out || out.setup) { set({ purpose, dialog: 'tools-setup' }); return; }
    if (latest.current.provider && readyProviders().concat(out.choices || []).includes(latest.current.provider)) { providerReady(latest.current.provider, purpose); return; }
    if (out.ask) { set({ purpose, providerChoice: out.suggested || null, dialog: 'provider-choice' }); return; }
    providerReady(out.pick, purpose);
  };
  const providerReady = (provider, purpose) => {
    set({ provider });
    if (purpose === 'start') {
      // Recent projects, found in the background from now on: not waiting for the method (the workspace's ask).
      api.discoverProjects({ provider }).then(setDiscovery).catch(() => {});
      // Round 3: the method is asked after the projects, so the work questions come next. The next screen is drawn behind the
      // browser question ("advance to next screen before immediately showing [the popup]"), and the tool agent starts once
      // it is answered, so Confirm your tools is ready by the time the person gets there.
      set({ screen: 'roles', modeFirst: false });
      keychainGate(() => set({ dialog: null }), 'auto');
    } else if (purpose === 'run') void run(provider);
    else set({ dialog: null });
  };
  // Choosing is continuing, as the import method is (one click).
  const chooseProvider = async (pick) => {
    if (!pick) return;
    set({ providerChoice: pick });
    try { await api.rememberProvider(pick); } catch { /* asked again next time */ }
    providerReady(pick, latest.current.purpose);
  };

  /* -------- the start */
  const importContext = () => { setError(''); void needProvider('start'); };
  // Choosing a method is continuing (2026-10-13, second round: "clicking either let agents choose or choose sources myself
  // should act as continuing, no need for two clicks").
  const chooseMode = (choice) => {
    if (!choice) return;
    const first = latest.current.modeFirst;
    set({ mode: choice, modeChoice: choice, modeFirst: false });
    if (first) { keychainGate(() => set({ dialog: null, screen: 'roles' }), choice); return; }
    if (choice === 'auto') keychainGate(() => { set((now) => ({ dialog: null, screen: 'tools', toolOrder: settleTools(now) })); }, choice);
    else set({ dialog: null, screen: 'picker' });
  };

  /** The browser's sign-ins asked about once (Keychain), then `then`; the tool agent starts once it is answered. */
  const afterKeychain = React.useRef(null);
  const keychainGate = (then, method = latest.current.mode) => {
    const answered = (browsers && browsers.keychain) || null;
    const go = (answer) => { then(); if (method === 'auto') startTools(answer); };
    if (answered || !browsers || !browsers.browsers.length) { go(answered || 'declined'); return; }
    afterKeychain.current = go;
    set({ dialog: 'keychain' });
  };
  const keychainAnswer = async (answer) => {
    try { await api.keychain(answer); } catch (failure) { say(failure); }
    setBrowsers((now) => ({ ...(now || { browsers: [] }), keychain: answer }));
    const go = afterKeychain.current;
    afterKeychain.current = null;
    set({ dialog: null });
    if (go) go(answer);
  };
  const useBrowser = async () => {
    const id = F.browserChoice;
    try { setBrowsers(await api.chooseBrowser(id)); } catch (failure) { say(failure); return; }
    // Firefox keeps no Keychain key to ask for: its sign-ins are read as they are. Safari's can't be read at all: the
    // sign-ins are made inside Engelbart (src/main/connect/web-signin.cjs).
    if (id === 'safari') { set({ dialog: 'keychain' }); return; }
    if (!(BROWSERS.find((browser) => browser.id === id) || {}).keychain) { set({ dialog: 'keychain' }); return; }
    set({ dialog: 'keychain' });
  };
  const startTools = (answer) => {
    const now = latest.current;
    api.discoverTools({ provider: now.provider, browserId: (browsers && browsers.chosenId) || null, keychain: answer || (browsers && browsers.keychain) || null }).then(setDiscovery).catch(() => {});
  };

  /* -------- browser agents */
  // The web apps' imports in the person's own browser (2026-10-13, second round: "We will use computer use in my real
  // browser"). Asked before the run only when their Claude Code or Codex does not already let its agents use the browser
  // (src/main/onboarding/browser-agents.cjs); "Don't allow" asks again, the safe choice the button and leaving them out a link.
  const afterBrowserAgents = React.useRef(null);
  const browserAgentsGate = async (provider, then) => {
    const now = latest.current;
    const web = runApps(now).filter((id) => isWebApp(id) && id !== 'Gmail');
    const others = now.mode === 'auto' ? now.added.filter((tool) => now.confirmed.includes(tool.id)) : [];
    if (!web.length && !others.length) { then(); return; }
    let status = null;
    try { status = await api.browserAgents({ provider, browserId: (browsers && browsers.chosenId) || null }); } catch { status = null; }
    if (!status || !status.ask) { then(); return; }
    afterBrowserAgents.current = then;
    set({ dialog: 'browser-agents', agentsBrowser: status.browser ? status.browser.name : 'your browser', agentsApps: [...web.map((id) => shownName(id)), ...others.map((tool) => tool.name)].slice(0, 6) });
  };
  const browserAgentsAnswer = async (answer) => {
    if (answer === 'declined' && latest.current.dialog === 'browser-agents') { set({ dialog: 'browser-agents-confirm' }); return; }
    try { await api.browserAgentsAnswer(answer); } catch (failure) { say(failure); }
    const go = afterBrowserAgents.current;
    afterBrowserAgents.current = null;
    set({ dialog: null });
    if (go) go();
  };

  /* -------- the run */
  const runGate = () => {
    const now = latest.current;
    const apps = runApps(now);
    if (!apps.length || !now.picked.length) return;
    if (apps.includes('Apple Notes') && !now.notesConsent) { set({ dialog: 'notes-permission' }); return; }
    const files = apps.some((id) => FILE_TOOLS.includes(id));
    if (platform === 'darwin' && files && !(disk && (disk.granted || disk.grantedFresh)) && !now.folderAnswers) { set({ dialog: 'folders' }); return; }
    if (!now.provider) { void needProvider('run'); return; }
    void run();
  };

  /** The run, once the person said whether agents may use their browser (when that is theirs to say). */
  function run(providerNow = null) {
    const provider = providerNow || latest.current.provider;
    if (!provider) { void needProvider('run'); return Promise.resolve(); }
    return browserAgentsGate(provider, () => { void startRun(provider); });
  }

  async function startRun(providerNow = null) {
    const now = latest.current;
    const provider = providerNow || now.provider;
    if (!provider) { void needProvider('run'); return; }
    const projects = selectedProjects(now, discovery).map((project) => ({ id: project.id, title: project.title, description: project.description || '', folder: project.folder || '' }));
    const apps = runApps(now).filter((id) => CATALOG_IDS.includes(id));
    const scopes = {};
    if (now.mode === 'manual') {
      for (const id of apps) {
        const scope = now.scopes[id] || emptyScope(id);
        // The project pills (round 3): a project is ticked when its options are; none ticked means every project picked.
        const only = projects.filter((project) => { const mine = scopeOptions(id, [project]); return mine.length > 0 && mine.every((option) => scope.items.includes(option.id)); }).map((project) => project.title);
        scopes[id] = { ...scope, items: [], labels: [], projects: only.length === projects.length ? [] : only };
      }
    }
    const additional = now.mode === 'auto' ? now.added.filter((tool) => now.confirmed.includes(tool.id)).map((tool) => ({ name: tool.name, website: tool.website || '' })) : [];
    set({ dialog: 'starting', pendingRun: false });
    setError('');
    try {
      if (apps.includes('Apple Notes')) await api.notesPermission().catch(() => null);
      const session = await api.connectStart({
        provider,
        permissions: { files: true, browser: true, recall: true, notes: apps.includes('Apple Notes') },
        keychain: !browsers || browsers.keychain !== 'declined',
        browser: (browsers && browsers.chosenId) || null,
        days: cleanDays(now.period),
        ...(mode === 'modal' && into ? { projectId: into, ...(workspaceId ? { workspaceId } : {}) } : {}),
        direct: { mode: now.mode || 'auto', projects, roles: now.roles, work: now.work, apps, scopes, additional },
      });
      await api.saveFlow(null).catch(() => {});
      if (mode === 'modal') { onClose({ session }); return; }
      // A project for every project picked; the first opens with the run attached to it (its rows on its list).
      let first = null;
      for (const [index, project] of projects.entries()) {
        const input = { name: project.title, description: project.description, folder: 'new', directory: '', context: [], onboarding: index === 0, ...(index === 0 ? { connect: session.id } : {}) };
        let made = null;
        if (project.folder) made = await api.startProject({ ...input, folder: 'existing', directory: project.folder }).catch(() => null);
        if (!made) made = await api.startProject(input);
        if (!first) first = made;
      }
      if (!first) first = await api.startProject({ name: 'My research', description: '', folder: 'new', directory: '', context: [], onboarding: true, connect: session.id });
      await onDone(first, { session });
      // Off the screen once the project has opened: the flow is never left on Starting your imports over the workspace.
      set({ dialog: null });
    } catch (failure) {
      say(failure);
      set({ dialog: null });
    }
  }

  const startFromScratch = async () => {
    if (mode === 'modal') { await api.saveFlow(null).catch(() => {}); onClose({}); return; }
    const name = F.scratchName.trim();
    if (!name) return;
    setBusy('project');
    try {
      const made = await api.startProject({ name, description: F.scratchDesc.trim(), folder: 'new', directory: '', context: [], onboarding: true });
      await api.saveFlow(null).catch(() => {});
      await onDone(made, {});
    } catch (failure) { say(failure); } finally { setBusy(''); }
  };

  /* -------- Full Disk Access */
  const openDisk = async () => {
    set({ dialog: 'disk-wait' });
    try { setDisk(await api.diskAccessOpen()); } catch (failure) { say(failure); }
  };
  const relaunch = async () => {
    set({ pendingRun: true });
    await api.saveFlow({ ...latest.current, pendingRun: true, dialog: null, into }).catch(() => {});
    try { await api.diskAccessRelaunch(mode === 'modal'); } catch (failure) { say(failure); }
  };
  const askFolders = async () => {
    set({ dialog: 'folders-asking' });
    api.diskAccessStop().catch(() => {});
    const ids = ['Desktop', 'Documents', 'Downloads', 'iCloud Drive'];
    let answers = {};
    try { answers = await api.foldersAsk(ids); } catch (failure) { say(failure); }
    set({ folderAnswers: answers || {}, dialog: 'folder-results' });
  };

  /* -------- picks */
  /** A supported tool added from "+ Add a tool": selected, and placed with the selected ones. */
  const pickTool = (id) => set((now) => ({ confirmed: [...new Set([...now.confirmed, id])], touched: [...new Set([...now.touched, id])], toolOrder: placeSelected(orderedTools(now), id, now.confirmed), dialog: null }));
  const keysOf = (group) => (group.apps.length ? group.apps : [`__${group.id}`]).map((key) => (key === '__sites' ? SITES : key));
  const allKeys = GROUPS.flatMap(keysOf);
  const toggle = (list, id) => (list.includes(id) ? list.filter((one) => one !== id) : [...list, id]);
  const toggleGroup = (group) => set((now) => { const keys = keysOf(group); const on = keys.every((key) => now.picks.includes(key)); return { picks: on ? now.picks.filter((key) => !keys.includes(key)) : [...new Set([...now.picks, ...keys])] }; });
  const scopeOf = (id) => F.scopes[id] || emptyScope(id);
  const setScope = (id, patch) => set((now) => ({ scopes: { ...now.scopes, [id]: { ...(now.scopes[id] || emptyScope(id)), ...patch } } }));
  const chooseFolder = async (id) => {
    const dir = await api.pickDirectory().catch(() => null);
    if (!dir) return;
    const scope = scopeOf(id);
    if (!scope.folders.some((folder) => folder.path === dir)) setScope(id, { folders: [...scope.folders, { path: dir, name: dir.split('/').filter(Boolean).pop() || dir }] });
  };

  const projects = allProjects(F, discovery);
  const chosen = selectedProjects(F, discovery);
  const projectStatus = discovery && discovery.projects ? discovery.projects.status : 'idle';
  const toolStatus = discovery && discovery.tools ? discovery.tools.status : 'idle';
  const results = discovery && discovery.tools && discovery.tools.results;
  const diskGranted = !!(disk && (disk.granted || disk.grantedFresh));
  const diskApp = (disk && disk.app) || 'Engelbart';

  /* ================================================================================================== the screens */

  const flowHeader = (title, key, onBack, sub = '') => (
    <header className="work-head">
      
      <T k={key} tag="h1" fallback={title} />
      {sub ? <p>{sub}</p> : null}
    </header>
  );

  const lowerBack = () => <button type="button" className="link work-back" onClick={() => {
    if (F.screen === 'roles') set({ screen: 'picker', dialog: 'intro' });
    else if (F.screen === 'work') set({ screen: 'roles' });
    else if (F.screen === 'projects') set({ screen: 'work' });
    else if (F.screen === 'tools') set({ dialog: 'import-mode', modeChoice: 'auto', modeFirst: false });
    else set({ screen: 'picker' });
  }}>{CHEV} Back</button>;

  const discoveryLine = () => {
    if (projectStatus === 'idle' && !F.provider) return null;
    const text = projectStatus === 'done' ? 'Recent projects found'
      : projectStatus === 'running' ? 'Finding recent projects in the background…'
        : projectStatus === 'failed' ? 'Couldn’t find recent projects. Add your own below.'
          : projectStatus === 'waiting-provider' ? 'Waiting for your AI provider…' : 'Finding recent projects in the background…';
    return (
      <div className="discovery-line" role="status">
        <span className="activity-dot" />
        <span>{text}</span>
        {projectStatus === 'waiting-provider' && <button type="button" className="link under" onClick={() => needProvider('start')}>Connect provider</button>}
        {(projectStatus === 'failed' || projectStatus === 'stale') && <button type="button" className="link under" onClick={() => api.discoverProjects({ provider: F.provider, again: true }).then(setDiscovery).catch(() => {})}>Try again</button>}
      </div>
    );
  };

  const projectScopeStrip = () => (chosen.length ? (
    <div className="project-scope-strip">
      <span>For</span>
      {chosen.map((project) => <span key={project.id} className="scope-project">{project.title}</span>)}
      <button type="button" className="link under" onClick={() => set({ screen: 'projects' })}>Edit</button>
    </div>
  ) : null);

  const rolesPage = () => (
    <main className="work-page" data-import-screen="roles">
      <div className="work-column">
        {flowHeader('What kind of work do you do?', 'role-title', () => set({ screen: 'picker', dialog: 'intro' }), 'Choose all that apply.')}
        <div className="role-grid">
          {ROLES.map((role) => (
            <button key={role.name} type="button" className="role-card" role="checkbox" aria-checked={F.roles.includes(role.name)} data-work-role={role.name} onClick={() => set((now) => ({ roles: toggle(now.roles, role.name) }))}>
              <span className="role-icon"><Svg d={role.paths} /></span><span>{role.name}</span><Check on={F.roles.includes(role.name)} />
            </button>
          ))}
        </div>
        <footer className="work-foot">{lowerBack()}<span /><button type="button" className="btn" disabled={!F.roles.length} onClick={() => { set({ screen: 'work' }); window.scrollTo(0, 0); }}>Continue{CHEV}</button></footer>
      </div>
    </main>
  );

  // Not optional (2026-10-13, second round: "Dont make this optional"); the project agent is already running, so what is
  // written here goes to the import agents with the projects picked.
  const workPage = () => (
    <main className="work-page review-work" data-import-screen="work"><div className="work-column">
      {flowHeader('What are you working on?', 'work-description-title', () => set({ screen: 'roles' }))}
      <textarea id="work-description" className="field" rows={1} ref={growReviewInput} aria-label="What are you working on?" placeholder="Understanding the Memex..." value={F.work} onChange={event => { growReviewInput(event.currentTarget); set({ work: event.target.value.slice(0, 2000) }); }} />
      <footer className="work-foot">{lowerBack()}<button type="button" className="btn" disabled={!F.work.trim()} onClick={() => set({ screen: 'projects' })}>Continue{CHEV}</button></footer>
    </div></main>
  );

  const projectsPage = () => {
    const ready = projectStatus === 'done' || projectStatus === 'failed';
    return (
      <main className="work-page" data-import-screen="projects">
        <div className="work-column">
          {flowHeader('What project do you want to work on first?', 'projects-title', () => set({ screen: 'work' }), 'Select one or more projects, or add your own.')}
          <div className="project-list">
            {projects.map((project) => (
              <button key={project.id} type="button" className="project-choice" role="checkbox" aria-checked={F.picked.includes(project.id)} data-work-project={project.id} onClick={() => set((now) => ({ picked: toggle(now.picked, project.id) }))}>
                <span className="project-symbol">{PROJECT}</span>
                <span><b>{project.title}</b><small>{project.description || 'Added by you'}</small></span>
                {project.recent ? <span className="project-recency">{project.recent}</span> : null}
                <Check on={F.picked.includes(project.id)} />
              </button>
            ))}
            {!ready && <div className="project-loading">{discoveryLine()}<div className="project-skeleton" /><div className="project-skeleton" /></div>}
            {ready && projectStatus === 'failed' && discoveryLine()}
          </div>
          <button type="button" className="add-project" onClick={() => { setDraft({ title: '', description: '', tool: '', website: '' }); set({ dialog: 'work-add-project' }); }}>{PLUS} Add a project</button>
          <footer className="work-foot">{lowerBack()}
            <span className="muted">{F.picked.length} selected</span>
            <button type="button" className="btn" disabled={!F.picked.length} onClick={() => {
              set({ screen: 'picker', dialog: 'import-mode', modeFirst: false });
              window.scrollTo(0, 0);
            }}>Continue{CHEV}</button>
          </footer>
        </div>
      </main>
    );
  };

  const toolsPage = () => {
    const scanned = toolStatus === 'done';
    const detected = (id) => results && (results.tools.find((tool) => tool.id === id) || {});
    // Every supported tool, the selected ones first (2026-10-13, second round: "dont have the toggle … show all
    // automatically but all the selected ones should be shown on top"). The order is settled when the page opens and when
    // the agent answers (toolOrder), not on every click, so a tool never jumps away from the pointer that ticked it.
    const byId = new Map([...CATALOG, ...F.added].map((tool) => [tool.id, tool]));
    const shown = orderedTools(F).map((id) => byId.get(id)).filter(Boolean);
    return (
      <main className="work-page tools-page" data-import-screen="tools">
        <div className="work-column">
          {flowHeader('Confirm your tools', 'tools-title', () => set({ dialog: 'import-mode', modeChoice: 'auto', modeFirst: false }))}
          <div className="flow-step-label">Automatic import</div>
          {projectScopeStrip()}
          {!scanned && <div className="discovery-line" role="status"><span className="activity-dot" />Checking the tools you use in your browser…{results ? <button type="button" className="link under" onClick={() => set({ skipWait: true })}>Don’t wait</button> : null}</div>}
          {discovery && discovery.tools && discovery.tools.error && <div className="discovery-line" role="status"><span>{`The agent didn’t finish (${discovery.tools.error}). What was found on this Mac is ticked.`}</span></div>}
          <div className="tool-scroll" role="region" aria-label="Available tools" tabIndex={0}>
            <div className="tool-grid">
              {shown.map((tool) => (
                <button key={tool.id} type="button" className="tool-choice" data-work-tool={tool.id} role="checkbox" aria-checked={F.confirmed.includes(tool.id)} title={(detected(tool.id) || {}).evidence || ''} onClick={() => set((now) => ({ touched: [...new Set([...now.touched, tool.id])], confirmed: toggle(now.confirmed, tool.id) }))}>
                  <ToolLogo id={tool.id} />
                  <span><b>{tool.name}</b></span>
                  <Check on={F.confirmed.includes(tool.id)} />
                </button>
              ))}
            </div>
          </div>
          <div className="tool-list-actions">
            <span />
            <button type="button" className="link under" onClick={() => { setCatalogQuery(''); setDraft({ title: '', description: '', tool: '', website: '' }); set({ dialog: 'work-add-tool' }); }}>+ Add a tool</button>
          </div>
          <footer className="work-foot">{lowerBack()}
            <span className="muted">{F.confirmed.length} tools selected</span>
            <button type="button" className="btn" data-import-run="1" disabled={!(scanned || F.skipWait) || !F.confirmed.length} onClick={runGate}>{RUN_LABEL}{CHEV}</button>
          </footer>
        </div>
      </main>
    );
  };

  const picker = () => (
    <>
      <main className="page picker-page review-picker" data-import-screen="picker">
        <div className="col">
          <T k="pickerTitle" tag="h2" />
          {GROUPS.map((group) => {
            const keys = keysOf(group), open = F.open.includes(group.id);
            return <section key={group.id}>
              <div className="group-head">
                <button type="button" className="expand" data-group={group.id} aria-expanded={open} onClick={() => set({ open: open ? [] : [group.id], scopeOpen: null })}>{CHEV}<span>{group.label}</span></button>
                <span className="muted review-count">{keys.filter(id => F.picks.includes(id)).length ? `${keys.filter(id => F.picks.includes(id)).length} selected` : ''}</span>
              </div>
              {open && <div className="apps">
                {keys.map(id => {
                  const selected = F.picks.includes(id), scope = scopeOf(id);
                  const files = ['Obsidian', 'Zoom', 'Zotero', LOCAL_PDFS, LOCAL_FOLDERS].includes(id);
                  return <section key={id} className={`review-source ${selected ? 'selected' : ''}`}>
                    <div className="review-source-row">
                      <button type="button" className="app-row" data-app={id} role="checkbox" aria-checked={selected} onClick={() => set(now => ({ picks: toggle(now.picks, id), scopeOpen: now.scopeOpen === id ? id : null }))}>
                        <ToolLogo id={id} /><span className="app-text">{toolName(id)}</span><Check on={selected} />
                      </button>
                      {selected && <button type="button" className={`review-specify ${F.scopeOpen === id ? 'is-open' : ''}`} data-specify-context={id} aria-expanded={F.scopeOpen === id} onClick={() => set({ scopeOpen: F.scopeOpen === id ? null : id })}>Specify context{DOWN}</button>}
                    </div>
                    {selected && F.scopeOpen === id && <div className="review-context">
                      <div className="review-projects" role="group" aria-label={`Projects to import from ${toolName(id)}`}>
                        {chosen.map(project => {
                          const options = scopeOptions(id, [project]);
                          const selected = options.every(option => scope.items.includes(option.id));
                          return <button key={project.id} type="button" className="review-project" data-source-project={project.id} role="checkbox" aria-checked={selected} onClick={() => setScope(id, { items: selected ? scope.items.filter(item => !options.some(option => option.id === item)) : [...new Set([...scope.items, ...options.map(option => option.id)])] })}>{selected && <span className="review-project-check" aria-hidden="true">✓</span>}{project.title}</button>;
                        })}
                      </div>
                      {chosen.length > 0 && <p className="review-projects-note">Select all projects you want Engelbart to import from {toolName(id)}.</p>}
                      <label className="review-context-label" htmlFor={`review-context-${id}`}>Further specify</label>
                      <textarea id={`review-context-${id}`} className="field" rows={1} ref={growReviewInput} data-scope-note={id} aria-label={`Optional context for ${toolName(id)}`} placeholder={id === LOCAL_FOLDERS ? 'e.g. Research notes and PDFs about the Memex in Documents' : id === 'Obsidian' ? 'e.g. My notes about Engelbart and context engineering' : 'e.g. Only context related to my current projects'} value={scope.note} onChange={event => { growReviewInput(event.currentTarget); setScope(id, { note: event.target.value.slice(0, 2000) }); }} />
                      {files && <div className="folder-upload"><button type="button" className="link under" onClick={() => chooseFolder(id)}>Choose a folder</button><button type="button" className="link under" onClick={async () => { const files = await api.pickFiles(); setScope(id, { folders: [...scope.folders, ...files.filter(file => !scope.folders.some(folder => folder.path === file.path))] }); }}>Choose files</button></div>}
                      {scope.kind === 'email' && <><div className="sender-input"><input className="field" aria-label="Name or email address" placeholder="Name or email address" value={sender[id] || ''} onChange={event => setSender(now => ({ ...now, [id]: event.target.value }))} /><button type="button" className="link" onClick={() => { const person = (sender[id] || '').trim(); if (person) setScope(id, { people: [...new Set([...scope.people, person])] }); setSender(now => ({ ...now, [id]: '' })); }}>Add person</button></div><div className="sender-chips">{scope.people.map(person => <button type="button" key={person} onClick={() => setScope(id, { people: scope.people.filter(one => one !== person) })}>{person} ×</button>)}</div></>}
                      <div className="selected-folder-list">{scope.folders.map(folder => <div key={folder.path}>{FOLDER}<span>{folder.name}</span><button type="button" className="link" aria-label={`Remove ${folder.name}`} onClick={() => setScope(id, { folders: scope.folders.filter(one => one.path !== folder.path) })}>×</button></div>)}</div>
                    </div>}
                  </section>;
                })}
              </div>}
            </section>;
          })}
        </div>
      </main>
      <footer className="foot"><div className="foot-inner"><div className="back-skip"><button type="button" className="link" onClick={() => set({ dialog: 'import-mode', modeFirst: false })}>Back</button></div><span className="muted review-count">{F.picks.length} selected</span><div className="foot-right"><button type="button" className="btn" data-import-run="1" disabled={!F.picks.length || !F.picked.length} onClick={runGate}>{RUN_LABEL}{CHEV}</button></div></div></footer>
    </>
  );

  const scopesPage = () => picker();



  /* ================================================================================================== the dialogs */

  const buttons = (secondary, primary, onSecondary, onPrimary, disabled = false) => (
    <div className="mf">
      {secondary ? <button type="button" className="link" onClick={onSecondary}>{secondary}</button> : null}
      <button type="button" className="btn small" disabled={disabled} onClick={onPrimary}>{primary}</button>
    </div>
  );
  const close = () => set({ dialog: null });
  const browserNow = browsers ? browserName(browsers.chosenId) : 'your browser';

  const toolRow = (id, name) => {
    const tool = toolsSnap && toolsSnap.tools && toolsSnap.tools[id];
    const provider = id === 'claude' ? 'anthropic' : 'openai';
    const status = providers && (providers.providers || []).find((one) => one.id === provider);
    const ready = tool && tool.status === 'ready';
    const label = !tool || !tool.installed ? 'Not installed' : ready ? (status && status.subscription ? 'Signed in' : 'Signed in · no subscription found') : tool.status === 'signing-in' ? 'Signing in…' : 'Not signed in';
    const act = () => {
      if (!tool || !tool.installed) api.toolsInstall([id]).catch(say);
      else api.toolsSignIn(id).catch(say);
    };
    return (
      <div key={id}>
        <Logo src={PROVIDER_LOGOS[provider]} />
        <span>{name}</span>
        <small>{label}</small>
        {ready ? CHECK : <button type="button" className="btn secondary small" onClick={act}>{!tool || !tool.installed ? 'Install' : 'Sign in'}</button>}
      </div>
    );
  };

  const dialogBody = () => {
    const d = F.dialog;
    if (d === 'intro') {
      return (
        <>
          {mode === 'modal' && <button type="button" className="close intro-close" aria-label="Close" onClick={() => { api.saveFlow(null).catch(() => {}); onClose({}); }}>×</button>}
          <div className="welcome">
            <T k="title" tag="h1" />
            <T k="subtitle" tag="p" className="lead" />
            <div className="icons">
              {WORKS.map(([name, src]) => <span key={name} className="ic" title={shownName(name)}><img src={src} alt={shownName(name)} /></span>)}
              <button type="button" className="ic" aria-label="Show all supported apps" onClick={() => set({ dialog: 'apps' })}>+12</button>
            </div>
            <div className="trust"><T k="privacy" /><button type="button" className="link under" onClick={() => set({ dialog: 'privacy' })}>Learn more</button></div>
            <div className="actions">
              <a className="link scratch-link" href="#start-from-scratch" onClick={(event) => { event.preventDefault(); set({ dialog: 'scratch-confirm' }); }}><T k="secondary" /></a>
              <button type="button" className="btn" data-import-start="1" onClick={importContext}><T k="primary" /></button>
            </div>
          </div>
        </>
      );
    }
    if (d === 'privacy') return (<><div className="modal-head"><h3>About your context</h3><button type="button" className="close" aria-label="Close" onClick={() => set({ dialog: 'intro' })}>×</button></div>{ANSWERS.map(([q, a]) => <div key={q} className="faq-item"><b>{q}</b><p>{a}</p></div>)}{buttons('', 'Got it', null, () => set({ dialog: 'intro' }))}</>);
    if (d === 'apps') {
      const seen = new Set();
      const list = [...WORKS.map(([name, src]) => [shownName(name), src]), ...CATALOG.filter((tool) => TOOL_LOGOS[tool.id]).map((tool) => [tool.name, TOOL_LOGOS[tool.id]])].filter(([name]) => (seen.has(name) ? false : seen.add(name)));
      return (<><div className="modal-head"><h3>Works with your tools</h3><button type="button" className="close" aria-label="Close" onClick={() => set({ dialog: 'intro' })}>×</button></div><div className="all-apps">{list.map(([name, src]) => <span key={name} className="supported-app"><img src={src} alt="" />{name}</span>)}</div>{buttons('', 'Done', null, () => set({ dialog: 'intro' }))}</>);
    }
    if (d === 'scratch-confirm') return (<><h3>Are you sure?</h3><p>{mode === 'modal' ? 'Nothing will be imported. You can import your context later.' : 'Your project will start with an empty library. You can import your context later.'}</p><div className="mf"><button type="button" className="link" onClick={() => (mode === 'modal' ? startFromScratch() : set({ dialog: 'project' }))}>{mode === 'modal' ? 'Close' : 'Start from scratch'}</button><button type="button" className="btn small" onClick={importContext}>Keep importing</button></div></>);
    if (d === 'project') {
      return (
        <>
          <h3>Create a new project</h3>
          <p>Start with an empty library. You can import context later.</p>
          <label className="field-label" htmlFor="project-name">Project name<input id="project-name" className="field" placeholder="My research project" autoComplete="off" value={F.scratchName} onChange={(event) => set({ scratchName: event.target.value.slice(0, 200) })} onKeyDown={(event) => { if (event.key === 'Enter') startFromScratch(); }} /></label>
          <label className="field-label" htmlFor="project-desc">Description <span className="muted">(optional)</span><textarea className="field" id="project-desc" placeholder="What are you working on?" value={F.scratchDesc} onChange={(event) => set({ scratchDesc: event.target.value.slice(0, 4000) })} /></label>
          {buttons('Back', busy === 'project' ? 'Creating…' : 'Create project', () => set({ dialog: 'scratch-confirm' }), startFromScratch, !F.scratchName.trim() || busy === 'project')}
        </>
      );
    }
    if (d === 'provider-choice') {
      const choices = decision && decision.ask ? decision.choices : readyProviders();
      return (
        <>
          <h3>Which provider should Engelbart use for onboarding?</h3>
          <div className="profiles provider-choices" role="group" aria-label="Onboarding provider">
            {choices.map((id) => (
              <button key={id} type="button" className="prof browser-choice" data-onboarding-provider={id} onClick={() => chooseProvider(id)}>
                <Logo src={PROVIDER_LOGOS[id]} /><span>{id === 'anthropic' ? 'Claude' : 'Codex'}</span>
              </button>
            ))}
          </div>
          <div className="mf mf-start"><button type="button" className="link" onClick={() => set({ dialog: F.purpose === 'start' ? 'intro' : null })}>Back</button></div>
        </>
      );
    }
    if (d === 'tools-setup') {
      const ready = readyProviders().length > 0;
      return (
        <>
          <div className="modal-head"><h3>Set up your tools</h3><button type="button" className="close" aria-label="Close tool setup" onClick={() => set({ dialog: F.purpose === 'start' ? 'intro' : null })}>×</button></div>
          <p>Engelbart’s agents run on Claude Code or Codex with the subscription you already have. One is enough.</p>
          <div className="tool-list">
            {toolsSnap && toolsSnap.tools && toolsSnap.tools.git ? <div><span>Git</span><small>{toolsSnap.tools.git.status === 'ready' ? 'Installed' : 'Not installed'}</small>{toolsSnap.tools.git.status === 'ready' ? CHECK : <button type="button" className="btn secondary small" onClick={() => api.toolsInstall(['git']).catch(say)}>Install</button>}</div> : null}
            {toolRow('claude', 'Claude Code')}
            {toolRow('codex', 'Codex')}
          </div>
          <div className="mf"><button type="button" className="link" onClick={() => set({ dialog: F.purpose === 'start' ? 'intro' : null })}>Back</button><button type="button" className="btn" disabled={!ready} onClick={() => needProvider(F.purpose || 'start')}>Continue</button></div>
        </>
      );
    }
    if (d === 'import-mode') {
      return (
        <>
          <h3>How would you like to import context?</h3>
          <div className="profiles import-modes" role="group" aria-label="Import method">
            {[['auto', 'Let agents choose'], ['manual', 'Choose sources myself']].map(([value, label]) => (
              <button key={value} type="button" className="prof import-mode" data-import-mode={value} onClick={() => chooseMode(value)}>
                <span className="mode-icon">{value === 'auto' ? CURSOR : FOLDER}</span><span className="import-mode-copy"><b>{label}</b></span>
              </button>
            ))}
          </div>
          <div className="mf mf-start"><button type="button" className="link" onClick={() => set({ dialog: null, screen: 'projects' })}>Back</button></div>
        </>
      );
    }
    if (d === 'keychain') return (<><div className="key">{KEY}</div><h3>{`Allow Engelbart to use your ${browserNow} sign-ins?`}</h3><div className="mf keychain-actions"><button type="button" className="link under" onClick={() => set({ dialog: 'keychain-browser', browserChoice: (browsers && browsers.chosenId) || null })}>Use another browser</button><button type="button" className="link" onClick={() => set({ dialog: 'keychain-confirm' })}>Don’t allow</button><button type="button" className="btn small" data-import-keychain-allow="1" onClick={() => keychainAnswer('allowed')}>Allow</button></div></>);
    if (d === 'keychain-confirm') return (<><h3>Continue without browser access?</h3><p>You can still import from sources on your Mac.</p><div className="mf"><button type="button" className="link" onClick={() => keychainAnswer('declined')}>Continue without access</button><button type="button" className="btn small" onClick={() => keychainAnswer('allowed')}>Allow access</button></div></>);
    if (d === 'notes-permission') return (<><h3>Allow Engelbart to read Apple Notes?</h3><div className="mf"><button type="button" className="link" onClick={() => { const now = latest.current; const next = { ...now, picks: now.picks.filter(id => id !== 'Apple Notes'), confirmed: now.confirmed.filter(id => id !== 'Apple Notes'), dialog: null }; latest.current = next; set(next); setTimeout(runGate, 0); }}>Don’t allow</button><button type="button" className="btn" onClick={() => { latest.current = { ...latest.current, notesConsent: true, dialog: null }; set({ notesConsent: true, dialog: null }); setTimeout(runGate, 0); }}>Allow</button></div></>);

    if (d === 'keychain-browser') {
      const list = (browsers && browsers.browsers) || [];
      return (
        <>
          <h3>Which browser should Engelbart use?</h3>
          <div className="profiles browser-profiles" role="radiogroup" aria-label="Browser">
            {list.map((browser) => (
              <button key={browser.id} type="button" className="prof browser-choice" role="radio" aria-checked={F.browserChoice === browser.id} data-keychain-browser={browser.id} onClick={() => set({ browserChoice: browser.id })}>
                <img src={BROWSER_LOGOS[browser.id]} alt="" /><span>{browser.name}{browser.isDefault ? <small>Default</small> : null}</span>{F.browserChoice === browser.id ? CHECK : null}
              </button>
            ))}
          </div>
          <div className="mf"><button type="button" className="link" onClick={() => set({ dialog: 'keychain' })}>Back</button><button type="button" className="btn" disabled={!F.browserChoice} onClick={useBrowser}>{`Use ${browserName(F.browserChoice)}`}</button></div>
        </>
      );
    }
    // Full Disk Access (round 3): one line each; System Settings and the small "Toggle Setting" panel beside it do the
    // rest (../../main/onboarding/disk-helper.html). The simulated Settings guide of the review mockup was left out.
    if (d === 'folders') return (<><div className="key">{FOLDER}</div><h3>Allow Full Disk Access</h3><p>{`Turn on ${diskApp} in System Settings so agents can find your files.`}</p><div className="mf"><button type="button" className="link" onClick={() => set({ dialog: 'folder-fallback' })}>Don’t allow</button><button type="button" className="btn small" data-import-disk-open="1" onClick={openDisk}>Open System Settings</button></div></>);
    if (d === 'disk-wait') return (<><div className="key">{FOLDER}</div><h3>{`Turn on ${diskApp}`}</h3><div className="discovery-line" role="status"><span className="activity-dot" /><span>Waiting for System Settings…</span></div><div className="mf"><button type="button" className="link" onClick={() => { api.diskAccessStop().catch(() => {}); set({ dialog: 'folder-fallback' }); }}>Don’t allow</button><button type="button" className="btn small" onClick={openDisk}>Open System Settings</button></div></>);

    if (d === 'disk-relaunch') return (<><h3>Reopening Engelbart…</h3><p>Your imports resume automatically.</p></>);
    if (d === 'folder-fallback') return (<><h3>Are you sure?</h3><p>macOS will ask about each folder instead.</p><div className="mf"><button type="button" className="link" onClick={askFolders}>Use individual permissions</button><button type="button" className="btn" onClick={openDisk}>Grant Full Disk Access</button></div></>);
    if (d === 'folders-asking') return (<><div className="key">{FOLDER}</div><h3>macOS is asking about your folders</h3><p>Choose Allow for each folder you want included.</p></>);
    if (d === 'folder-results') {
      const answers = F.folderAnswers || {};
      const list = Object.keys(answers).length ? Object.keys(answers) : ['Desktop', 'Documents', 'Downloads', 'iCloud Drive'];
      return (<><h3>Folder permissions</h3><p>Only folders you allowed will be included.</p><div className="folder-results">{list.map((folder) => <div key={folder}><span>{folder}</span><span className={answers[folder] === 'allowed' ? 'allowed' : 'failed'}>{answers[folder] === 'allowed' ? 'Allowed' : 'Left out'}</span></div>)}</div><div className="mf">{list.some((folder) => answers[folder] !== 'allowed') && <button type="button" className="link" onClick={askFolders}>Review left-out folders</button>}<button type="button" className="btn" onClick={() => { set({ dialog: null }); runGate(); }}>Continue</button></div></>);
    }
    if (d === 'browser-agents') return (<><h3>{`Let agents use ${browserNow}?`}</h3><p>They’ll read your selected sources in the background.</p><div className="mf"><button type="button" className="link" onClick={() => browserAgentsAnswer('declined')}>Don’t allow</button><button type="button" className="btn small" data-import-browser-agents-allow="1" onClick={() => browserAgentsAnswer('allowed')}>Allow</button></div></>);

    if (d === 'browser-agents-confirm') return (<><h3>Are you sure?</h3><p>{`Without ${F.agentsBrowser || 'your browser'}, agents bring in your web apps through Engelbart’s own browser instead, with the sign-ins it copied or those you make inside Engelbart.`}</p><div className="mf"><button type="button" className="link" onClick={() => browserAgentsAnswer('declined')}>Continue without it</button><button type="button" className="btn small" onClick={() => browserAgentsAnswer('allowed')}>{`Allow ${F.agentsBrowser || 'your browser'}`}</button></div></>);
    if (d === 'starting') return (<><h3>Starting your imports</h3><p>{`Each agent will bring in only what pertains to ${chosen.map((project) => project.title).join(' and ') || 'your projects'}.`}</p><div className="discovery-line" role="status"><span className="activity-dot" /><span>{mode === 'modal' ? 'Starting…' : 'Setting up your projects…'}</span></div></>);
    if (d === 'work-add-project') {
      const save = () => {
        const title = draft.title.trim();
        if (!title) return;
        const id = `user-project:${Date.now()}`;
        set((now) => ({ customProjects: [...now.customProjects, { id, title: title.slice(0, 80), description: draft.description.trim().slice(0, 500), recent: '' }], picked: [...now.picked, id], dialog: null }));
      };
      return (
        <>
          <h3>Add a project</h3>
          <label className="field-label">Project title<input id="custom-project-title" className="field" placeholder="A concise name for your project" value={draft.title} onChange={(event) => setDraft((now) => ({ ...now, title: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} /></label>
          <label className="field-label">Description <span className="muted">(optional)</span><textarea id="custom-project-description" className="field" rows={2} placeholder="What are you trying to do?" value={draft.description} onChange={(event) => setDraft((now) => ({ ...now, description: event.target.value }))} /></label>
          <div className="mf"><button type="button" className="link" onClick={close}>Cancel</button><button type="button" className="btn" disabled={!draft.title.trim()} onClick={save}>Add project</button></div>
        </>
      );
    }
    if (d === 'work-add-tool') {
      const save = () => {
        const name = draft.tool.trim().slice(0, 60);
        const website = draft.website.trim();
        if (!name) return;
        if (website && !/^https?:\/\//i.test(website)) { setError('Use a website beginning with https://'); return; }
        setError('');
        const known = CATALOG.find((tool) => tool.name.toLowerCase() === name.toLowerCase());
        if (known) { pickTool(known.id); return; }
        const id = `custom:${name.toLowerCase()}`;
        set((now) => {
          const added = now.added.some((tool) => tool.id === id) ? now.added : [...now.added, { id, name, website, source: 'user' }];
          const confirmed = [...new Set([...now.confirmed, id])];
          return { added, confirmed, touched: [...new Set([...now.touched, id])], toolOrder: placeSelected(orderedTools({ ...now, added }), id, now.confirmed), dialog: null };
        });
      };
      return (
        <>
          <h3>Add a tool</h3>
          <input id="catalog-search" className="field" placeholder="Search supported tools…" aria-label="Search supported tools" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
          <div className="catalog-tool-list">
            {CATALOG.filter((tool) => !F.confirmed.includes(tool.id) && tool.name.toLowerCase().includes(catalogQuery.toLowerCase())).map((tool) => (
              <button key={tool.id} type="button" onClick={() => pickTool(tool.id)}><ToolLogo id={tool.id} />{tool.name}</button>
            ))}
          </div>
          <label className="field-label">Or add another tool<input id="custom-tool-name" className="field" placeholder="Tool name" value={draft.tool} onChange={(event) => setDraft((now) => ({ ...now, tool: event.target.value }))} /></label>
          <input id="custom-tool-website" className="field" placeholder="Website (optional)" value={draft.website} onChange={(event) => setDraft((now) => ({ ...now, website: event.target.value }))} />
          <div className="mf"><button type="button" className="link" onClick={close}>Cancel</button><button type="button" className="btn" disabled={!draft.tool.trim()} onClick={save}>Add tool</button></div>
        </>
      );
    }
    return null;
  };

  const d = F.dialog;
  const body = d ? dialogBody() : null;
  const modalClass = d === 'folder-fallback' ? 'disk-deny-modal' : (d === 'folders' || d === 'disk-wait') ? 'disk-modal' : d === 'intro' ? 'intro-modal' : d === 'privacy' ? 'context-modal' : '';
  const screen = F.screen === 'roles' ? rolesPage() : F.screen === 'work' ? workPage() : F.screen === 'projects' ? projectsPage() : F.screen === 'tools' ? toolsPage() : F.screen === 'scopes' ? scopesPage() : picker();

  return (
    <CopyContext.Provider value={{ edit, copy, setCopy }}>
      <div className={`ix ${edit ? 'editing' : ''} ${mode === 'modal' ? 'ix-in-modal' : ''}`} data-import-flow={mode} data-screen={F.screen} data-dialog={d || ''}>
        <style>{IMPORT_CSS}{EXTRA_CSS}{ROUND3_CSS}</style>
        <div className="ix-app" inert={d ? true : undefined}>{screen}</div>
        {error && <div className="ix-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {body && (
          <div className={`scrim ${d === 'intro' ? 'intro-scrim' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !['intro', 'starting', 'disk-wait', 'folders-asking', 'browser-agents', 'browser-agents-confirm'].includes(d)) set({ dialog: d === 'privacy' || d === 'apps' ? 'intro' : null }); }}>
            <section className={`modal ${modalClass}`} role="dialog" aria-modal="true" aria-label={d}>{body}</section>
          </div>
        )}
      </div>
    </CopyContext.Provider>
  );
}

// What the app adds to the mockup's CSS: the error line, and the flow inside a modal over the workspace (fixed parts are
// held inside it by its transform; the pages fill it rather than the window).
const EXTRA_CSS = `
.ix .ix-error{position:fixed;left:24px;bottom:96px;z-index:90;display:flex;gap:10px;align-items:center;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:12.5px;line-height:1.5;color:#e70022;max-width:min(560px,calc(100% - 48px))}
.ix .ix-error button{border:0;background:none;color:#c9c9c9;cursor:pointer;font-size:14px}
.ix.ix-in-modal{min-height:100%}
.ix.ix-in-modal .page,.ix.ix-in-modal .work-page{min-height:100%}
.ix .prof small{display:block;font-size:11.5px;color:var(--mute);font-weight:400}
.ix .mf.mf-start{justify-content:flex-start}
.ix .mf .mf-left{margin-right:auto}
.ix textarea.field{resize:none}
.ix .import-mode.prof:hover,.ix .provider-choices .prof:hover{border-color:var(--ink)}
.ix ul.guardrails{margin:4px 0 12px;padding:0;list-style:none;font-size:13px;line-height:1.5;text-align:left}
.ix ul.guardrails li{padding:6px 0;border-top:1px solid var(--line)}
.ix ul.guardrails li:first-child{border-top:0}
.ix p.fine{font-size:12px;color:var(--mute);margin-top:0}
`;

function growReviewInput(element) { if (!element) return; element.style.height = 'auto'; element.style.height = Math.min(140, Math.max(46, element.scrollHeight)) + 'px'; }
