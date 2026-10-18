import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import { TOOL_LOGOS, WORKS, BROWSER_LOGOS, PROVIDER_LOGOS } from './logos.js';
import ObsidianPicker from './ObsidianPicker.jsx';
import { AgentSetupBody } from './AgentSetup.jsx';
import { AGENTS_PATH } from '../ui/SidebarIcons.jsx';
import { keychainStep, afterAllow, profilesOf, runKeychain, cliOfProvider, providerOfCli } from '../model/onboarding.js';
import {
  CATALOG, CATALOG_IDS, ROLES, GROUPS, GROUP_IDS, LOCAL_FOLDERS, SITES, PROVIDER_NAMES, BROWSERS, catalogTool, isLocal, reachOf, isWebApp,
  scopeKind, emptyScope, scopeReady,
} from '../../shared/import-flow.cjs';
import { LOCAL_PDFS, PERIODS, DEFAULT_PERIOD_DAYS, cleanDays, shownName } from '../../shared/connect-sources.cjs';

// Import your context (2026-10-13, the "Onboarding" workspace): the work-first import flow, a port of the mockup
// design/onboarding-mockup/Onboarding.html with its markup and classes (its CSS is import-css.js, scoped under .ix).
//
//   Import context → (the provider: asked when both are subscribed; tools set up when neither can run) → (the browser's
//   sign-ins) → What kind of work do you do? → What are you interested in researching? → What project do you
//   want to work on first? → What should go in your library? (the categories, with the tools the agents found added to
//   them) → Import to Engelbart → How should Engelbart import your sources?
//     in the background with agents → Import context using background agents (I understand) → (Allow Engelbart to
//     organize your research) → the run
//     manually, with fine-grained permissions → (Allow Engelbart to organize your research) → the librarian's chat
//     (Connect your library's, ../screens/ConnectLibrary.jsx)
//
// The project agent starts the moment the provider is known; the tool agent once the browser's sign-ins are answered
// (src/main/onboarding/discover.cjs). In the background, Import to Engelbart starts Connect's pipeline in its direct mode
// (src/main/connect/session.cjs): one import agent a tool, each told only the projects picked; manually, a librarian
// session from the same choices, which asks before anything comes in (From Amitav, 2026-10-15). In a new user's onboarding (`mode` 'new') a project is made for every project picked
// and the first opens; over a workspace (`mode` 'modal', the redo that replaced "guided setup") the imports go to that
// project and the modal closes. Everything it talks to goes through `api` (./import-api.js in the app, the standalone
// page's mock), so the same component is the app's and the HTML's. Where the flow is, is saved (`saveFlow`), so
// onboarding opened again comes back to the same step.

// What "Connect desktop" asks macOS for (2026-10-15, in place of Full Disk Access): one prompt each, at once, rather than
// whenever an agent first reaches into one of them.
const DESKTOP_FOLDERS = ['Desktop', 'Documents', 'Downloads'];
/** The sources whose Specify context has Choose files (Obsidian's opens a picker over its vaults, the others the Mac's). */
const FILE_SOURCES = ['Obsidian', 'Zoom', 'Zotero', LOCAL_PDFS, LOCAL_FOLDERS];
// "Specific things to import from {app} (optional)": the hint is the category's (2026-10-14, Hudson's words).
const GROUP_HINTS = {
  notes: 'Only bring in notes relating to the Memex and my research',
  transcripts: 'Only bring in transcripts relating to meetings with professors on the Memex',
  chats: 'Only include the chats that discussed Memex and the history of computing',
  sites: "Pull in the essays and paper links I've added to some of my research notes",
  papers: 'Include the papers in my local Memex folder',
  code: 'Bring in the digital Memex prototype I was hacking on last week',
  other: 'Only bring in what I made for the Memex project',
};
// Websites holds a "Saved websites from {app}" row for each notes app picked (2026-10-14): the links saved in its notes.
const LINKS = 'links:';
const linksOf = (app) => `${LINKS}${app}`;
const isLinks = (id) => typeof id === 'string' && id.startsWith(LINKS);
const linkedApp = (id) => id.slice(LINKS.length);
/** A source as the Specify context lines name it ("websites saved in Obsidian", not "Saved websites from Obsidian"). */
const spokenName = (id) => (isLinks(id) ? `websites saved in ${toolName(linkedApp(id))}` : toolName(id));
const NOTES_APPS = (GROUPS.find((group) => group.id === 'notes') || { apps: [] }).apps;
const groupOf = (id) => (isLinks(id) || id === SITES ? 'sites' : (GROUPS.find((group) => group.apps.includes(id)) || {}).id || null);
const LINKS_NOTE = 'Also bring in the web links saved in these notes (essays, papers, articles and other pages): add each one to the library with add_to_library.';
const DEFAULT_PICKS = [];
export const COPY = {
  title: 'Import your context',
  subtitle: "Agents will import your notes, chats, and other project context into Engelbart. Everything remains local and isn't uploaded to the cloud.",
  primary: 'Import context (recommended)',
  secondary: 'Skip',
  pickerTitle: 'What should go in your library?',
  bring: 'Bring these in',
};
// 3 (2026-10-14): Import your context is a screen of its own, not a dialog over the picker. 4 (From Amitav, 2026-10-15): one
// tools screen for both ways of importing, the way asked at Import to Engelbart (a flow saved before starts over).
const FLOW_VERSION = 4;
// Dialogs taken out (From Amitav, 2026-10-15): a flow saved on one of them opens on what took its place.
const GONE_DIALOGS = { 'keychain-confirm': 'keychain', privacy: null, apps: null, folders: null, 'disk-wait': null, 'disk-relaunch': null, 'folder-fallback': null, 'folders-asking': null, 'folder-results': null };
// The intro's logos (From Amitav, 2026-10-15: "get rid of the +12, just show everything"): every supported app with a
// logo, the mockup's eight first, each logo once (Claude Code has Claude's).
const SUPPORTED = (() => {
  const seen = new Set();
  return [...WORKS.map(([name, src]) => [shownName(name), src]), ...CATALOG.filter((tool) => TOOL_LOGOS[tool.id]).map((tool) => [tool.name, TOOL_LOGOS[tool.id]])]
    .filter(([name, src]) => (seen.has(name) || seen.has(src) ? false : (seen.add(name).add(src), true)));
})();

/* ------------------------------------------------------------------------------------------------- small pieces */

const Svg = ({ d }) => <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />;
const CHEV = <Svg d={'<path d="m9 5 7 7-7 7"/>'} />;
const DOWN = <Svg d={'<path d="m6 9 6 6 6-6"/>'} />;
const CHECK = <Svg d={'<path d="m5 12 4 4 10-10"/>'} />;
const FOLDER = <Svg d={'<path d="M2 5h7l2 2h11v13H2z"/>'} />;
const FILE = <Svg d={'<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>'} />;
const GLOBE = <Svg d={'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18"/>'} />;
const WEB = <Svg d={'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>'} />;
const PLUS = <Svg d={'<path d="M12 5v14M5 12h14"/>'} />;
// How should Engelbart import your sources? (2026-10-16, S8): the agents' pointer (the sidebar's Agents icon) for the first
// way, a raised hand for the second (Attachment 13 without its rounded square; Lucide's hand, ISC), in the same stroke.
const AGENT_ICON = <Svg d={`<path d="${AGENTS_PATH}"/>`} />;
const HAND_ICON = <Svg d={'<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'} />;
// System Settings ▸ Privacy & Security ▸ Full Disk Access, opened directly when main has no api.openDiskAccess yet (S9).
const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * The window's size, for Welcome's picture (2026-10-16). The screens' zoom that grew with it (S2's fluid scale) is gone:
 * "Zoom back out the onboarding, it looks ugly zoomed in" (the same day, after trying the beta).
 */
export function useWindowSize() {
  const read = () => ({ width: typeof window === 'undefined' ? 1000 : window.innerWidth, height: typeof window === 'undefined' ? 700 : window.innerHeight });
  const [size, setSize] = React.useState(read);
  React.useEffect(() => {
    const onResize = () => setSize(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}
// A project's symbol is the workspace icon (../ui/SidebarIcons.jsx WorkspaceIcon): workspaces become projects (2026-10-13).

const Check = ({ on }) => <span className={`cb ${on ? 'on' : ''}`}>{on ? CHECK : null}</span>;
const Logo = ({ src, name = '' }) => (src ? <img src={src} alt={name} /> : FOLDER);
const toolName = (id, added = []) => (isLinks(id) ? `Saved websites from ${toolName(linkedApp(id))}` : catalogTool(id) ? catalogTool(id).name : (added.find((tool) => tool.id === id) || {}).name || id);
function ToolLogo({ id }) {
  // A notes app's saved websites: its logo with a globe in the corner.
  if (isLinks(id)) return <span className="links-logo">{TOOL_LOGOS[linkedApp(id)] ? <img src={TOOL_LOGOS[linkedApp(id)]} alt="" /> : FOLDER}<span className="links-globe">{GLOBE}</span></span>;
  if (TOOL_LOGOS[id]) return <img src={TOOL_LOGOS[id]} alt="" />;
  if (id === LOCAL_PDFS || id === LOCAL_FOLDERS) return FOLDER;
  if (id === SITES) return WEB;
  // A tool the agents found or the person added: no icon (From Amitav, 2026-10-15: "they should just have no icon"), and
  // no room kept for one either (2026-10-16, S7: "shift the text to the left to get rid of the whitespace").
  return null;
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
  screen: 'intro', dialog: null, purpose: null,
  mode: null, scopeOpen: null, notesConsent: false, agentsConsent: false, librarian: null,
  provider: null, providerChoice: null,
  roles: [], work: '', customProjects: [], picked: [],
  touched: [], added: [],
  picks: [...DEFAULT_PICKS], open: ['notes'], period: DEFAULT_PERIOD_DAYS, consent: true, leaves: false, menu: null,
  scopes: {}, groupScopes: {}, groupScopeClosed: [], browserChoice: null, folderAnswers: null, organized: false, firstProject: null,
  scratchName: '', scratchDesc: '',
});

const selectedProjects = (F, discovery) => [...((discovery && discovery.projects && discovery.projects.projects) || []), ...F.customProjects].filter((project) => F.picked.includes(project.id));
const allProjects = (F, discovery) => [...((discovery && discovery.projects && discovery.projects.projects) || []), ...F.customProjects];

/** The catalog's apps a run imports from: those ticked on the tools screen. */
const runApps = (F) => F.picks.filter((id) => CATALOG_IDS.includes(id));
/** The tools the agents found (or the person added) that are ticked: what the run's "Other tools" import reads. */
const runAdded = (F) => F.added.filter((tool) => F.picks.includes(tool.id));

const RUN_LABEL = 'Import to Engelbart';
// Dialogs a click beside them does not close: questions that need an answer (2026-10-16: the browser's sign-ins "wasn't
// skippable, so you shouldn't even be able to skip this"), and steps that are under way.
const UNSKIPPABLE = ['starting', 'organize', 'browser-agents', 'browser-agents-confirm', 'keychain', 'keychain-browser', 'safari', 'browser-profile'];

// "Allow Engelbart to read Apple Notes?" answered Allow once is not asked again (2026-10-14: skip permission prompts that
// were already accepted). macOS keeps its own answer; this is Engelbart's question in front of it.
const NOTES_KEY = 'engelbart.import.notesConsent';
function notesConsented() { try { return window.localStorage.getItem(NOTES_KEY) === '1'; } catch { return false; } }
function rememberNotesConsent() { try { window.localStorage.setItem(NOTES_KEY, '1'); } catch { /* asked again next time */ } }

/* ======================================================================================================== the flow */

/**
 * `api` the flow's calls (./import-api.js); `mode` 'new' (a new user's onboarding, full window) or 'modal' (over a
 * workspace, into project `into`); `onDone(made)` a project was made (new); `onClose()` the modal closed; `edit` and
 * `copy`/`setCopy` the standalone page's editing; `preview` a dialog or screen to show at once (the standalone page's
 * Popups); `platform` 'darwin' or another. `renderLibrarian({ sessionId, project, onDone, onBack })`: the librarian's chat
 * (Import manually, in a new user's onboarding), drawn by the host (Onboarding.jsx: Connect your library's page).
 */
export default function ImportFlow({ api, mode = 'new', into = null, workspaceId = null, intoProject = null, onDone = () => {}, onClose = () => {}, edit = false, copy = {}, setCopy = () => {}, preview = null, platform = 'darwin', renderLibrarian = null }) {
  // Import context from inside a project (2026-10-14: "it should just basically start from if they picked manual import"):
  // for this project, no intro, work questions or project list again; its first question is how to import (2026-10-16:
  // "clicking import context should bypass the role and project selection screens and should start from the popup asking
  // if they want manual or agent importing"), then the sources (`methodFirst`). The permissions already answered are not
  // asked again (the browser's sign-ins, the folders, agents in the browser are kept by main; Apple Notes' consent below).
  const [F, setF] = React.useState(() => (mode === 'modal' && into ? {
    ...fresh(), screen: 'picker', dialog: 'import-method', methodFirst: true,
    customProjects: [{ id: `project:${into}`, title: (intoProject && intoProject.name) || 'This project', description: (intoProject && intoProject.description) || '', recent: '' }],
    picked: [`project:${into}`], notesConsent: notesConsented(),
  } : fresh()));
  const set = React.useCallback((patch) => setF((now) => ({ ...now, ...(typeof patch === 'function' ? patch(now) : patch) })), []);
  const latest = React.useRef(F);
  latest.current = F;
  const [restored, setRestored] = React.useState(false);
  const [providers, setProviders] = React.useState(null);
  const [browsers, setBrowsers] = React.useState(null);
  const [discovery, setDiscovery] = React.useState(null);
  const [disk, setDisk] = React.useState(null); // { granted }: the folders macOS guards may already be read
  const [asked, setAsked] = React.useState(null); // { [folder]: 'allowed' | 'denied' } asked before (folders.json)
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
      // In a project the picker comes fresh every time; a new user's onboarding opens where it was.
      if (saved && saved.v === FLOW_VERSION && mode === 'new') { setF({ ...fresh(), ...saved, menu: null, groupScopes: {}, ...(Object.hasOwn(GONE_DIALOGS, saved.dialog) ? { dialog: GONE_DIALOGS[saved.dialog] } : {}) }); }
      setRestored(true);
    }).catch(() => setRestored(true));
    api.providers(false).then((out) => { if (live) setProviders(out); }).catch(() => {});
    // A detection that failed is a Mac with no browser to ask about, not an answer left missing (S11).
    api.browsers().then((out) => { if (live) { setBrowsers(out); set((now) => (now.browserChoice ? {} : { browserChoice: out.chosenId })); } }).catch(() => { if (live) setBrowsers((now) => now || { browsers: [], keychain: null, failed: true }); });
    api.discovery().then((out) => { if (live) setDiscovery(out); }).catch(() => {});
    api.diskAccess().then((out) => { if (live) setDisk(out); }).catch(() => {});
    if (api.foldersAsked) api.foldersAsked().then((out) => { if (live) setAsked(out || {}); }).catch(() => {});
    api.tools().then((out) => { if (live) setToolsSnap(out); }).catch(() => {});
    api.detect().then((out) => { if (live) setFound(out); }).catch(() => {});
    const offs = [
      api.onDiscovery((out) => setDiscovery(out)),
      api.onTools((out) => { if (out && out.tools) { setToolsSnap(out); api.providers(true).then(setProviders).catch(() => {}); } }),
    ];
    return () => { live = false; offs.forEach((off) => off && off()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the flow is, kept so onboarding opened again comes back to it (and nothing else: closing the flow forgets it).
  React.useEffect(() => {
    if (!restored || preview) return undefined;
    const timer = setTimeout(() => { api.saveFlow({ ...F, into, menu: null }).catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [F, restored]); // eslint-disable-line react-hooks/exhaustive-deps

  // One tools screen (From Amitav, 2026-10-15: "when they get to the screen of selecting tools they see the different
  // categories, but if the agents have found any additional tools they are added"): the tool agent's answer adds each
  // tool it found to its category (Other when none fits) and, in a new user's onboarding, ticks what it found in use,
  // unless the person touched it. Importing into a project from Settings ticks nothing (2026-10-14: "it should not
  // preselect anything on manual import").
  React.useEffect(() => {
    const results = discovery && discovery.tools && discovery.tools.results;
    if (!results) return;
    set((now) => {
      const tick = mode === 'new';
      const picks = new Set(now.picks);
      for (const tool of results.tools || []) {
        if (!tick || !CATALOG_IDS.includes(tool.id) || now.touched.includes(tool.id)) continue;
        if (tool.used && tool.evidence) picks.add(tool.id); else picks.delete(tool.id);
      }
      const added = [...now.added];
      for (const extra of results.additional || []) {
        const id = `custom:${extra.name.toLowerCase()}`;
        if (!added.some((tool) => tool.id === id)) added.push({ id, name: extra.name, website: extra.website || '', source: 'agent', group: GROUP_IDS.includes(extra.category) ? extra.category : 'other' });
        if (tick && extra.used && extra.evidence && !now.touched.includes(id)) picks.add(id);
      }
      return { picks: [...picks], added };
    });
  }, [discovery && discovery.tools && discovery.tools.results]); // eslint-disable-line react-hooks/exhaustive-deps

  // The standalone page's Popups: a dialog or a screen at once.
  React.useEffect(() => {
    if (!preview) return;
    if (preview.screen) set({ screen: preview.screen, dialog: preview.dialog || null, ...(preview.state || {}) });
    else if (preview.dialog === 'intro') set({ screen: 'intro', dialog: null, ...(preview.state || {}) });
    else set({ dialog: preview.dialog, ...(preview.state || {}) });
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------- the provider */
  const decision = providers && providers.decision;
  const toolsNow = React.useRef(null);
  toolsNow.current = toolsSnap;
  const cliOf = (provider) => (provider === 'openai' ? 'codex' : 'claude');
  const checkedAt = (provider) => { const tool = toolsNow.current && toolsNow.current.tools && toolsNow.current.tools[cliOf(provider)]; return (tool && tool.checkedAt) || null; };
  // A provider whose CLI says it is signed in yet turned the agent away (an account without a subscription, say): not
  // ready for this until it is signed in again (its check changes), so Try again never re-runs it as it is.
  const refusedNow = () => { const refused = latest.current.refused; return refused && checkedAt(refused.provider) === refused.since ? refused.provider : null; };
  const readyIn = (status) => ((status && status.providers) || []).filter((one) => one.installed && one.signedIn && one.id !== refusedNow()).map((one) => one.id);
  const readyProviders = () => readyIn(providers);

  /**
   * The provider for `purpose`: 'start' | 'run' | 'projects' (the recent projects again: their line's Try again or Connect,
   * 2026-10-14) | 'tools' (the tool agent again). Asked when both are subscribed; Connect Claude Code or Codex when none can
   * run, or `connectFor` can't (`refused`: it turned the agent away while signed in). The one picked before is kept only
   * while its CLI can run (read fresh: a stale "ready" re-ran a signed-out Claude Code on every Try again).
   */
  const needProvider = async (purpose, connectFor = null, refused = false) => {
    if (refused && connectFor) { const mark = { provider: connectFor, since: checkedAt(connectFor) }; latest.current = { ...latest.current, refused: mark }; set({ refused: mark }); }
    let status = providers;
    try { status = await api.providers(true); setProviders(status); } catch { /* the last answer */ }
    const out = status && status.decision;
    const ready = readyIn(status);
    if (!out || !ready.length || (connectFor && !ready.includes(connectFor))) { set({ purpose, connectFor, dialog: 'tools-setup' }); return; }
    if (connectFor) { providerReady(connectFor, purpose); return; }
    if (latest.current.provider && ready.includes(latest.current.provider)) { providerReady(latest.current.provider, purpose); return; }
    if (out.ask && out.choices.every((id) => ready.includes(id))) { set({ purpose, providerChoice: out.suggested || null, dialog: 'provider-choice' }); return; }
    providerReady(out.pick && ready.includes(out.pick) ? out.pick : ready[0], purpose);
  };
  // Connected while Connect Claude Code or Codex is open (its Connect, or Settings): on with what it was opened for, with
  // no Continue to press (2026-10-14: "maybe if they dont hit connect it doesnt work but fails silently").
  const connectOpen = F.dialog === 'tools-setup';
  const readyNow = readyProviders().join(',');
  const wantedAt = F.connectFor ? checkedAt(F.connectFor) : null;
  React.useEffect(() => {
    if (!connectOpen || !readyNow) return;
    const want = latest.current.connectFor;
    if (want && !readyNow.split(',').includes(want)) return;
    void needProvider(latest.current.purpose || 'start', want || null);
  }, [connectOpen, readyNow, wantedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another CLI chosen in the popup than the one it was opened for (Claude Code turned the agents away, and Codex was
  // picked), running: the flow goes on with that one, not waiting for the first (2026-10-16: it showed Connected and
  // waited, with Skip the only way on). 'Both': whichever of them runs. Only then: the effect above goes on for the one
  // asked for, or for any when none was, and returns early in exactly this case, so the flow goes on once.
  const choseInPopup = (choice) => {
    const want = latest.current.connectFor || null;
    if (!want || latest.current.dialog !== 'tools-setup') return;
    const provider = choice === 'both' ? null : providerOfCli(choice);
    if (provider === want || readyProviders().includes(want)) return;
    void needProvider(latest.current.purpose || 'start', provider);
  };
  const providerReady = (provider, purpose) => {
    set({ provider, connectFor: null, refused: null });
    if (purpose === 'projects') {
      // Try again (or Connect) on the recent projects: they are looked for again, now on a provider that can run.
      set({ dialog: null });
      api.discoverProjects({ provider, again: true }).then(setDiscovery).catch(() => {});
      return;
    }
    if (purpose === 'tools') {
      set({ dialog: null });
      api.discoverTools({ provider, browserId: (browsers && browsers.chosenId) || null, keychain: (browsers && browsers.keychain) || null, again: true }).then(setDiscovery).catch(() => {});
      return;
    }
    if (purpose === 'start') {
      // Recent projects, found in the background from now on: not waiting for the method (the workspace's ask).
      api.discoverProjects({ provider }).then(setDiscovery).catch(() => {});
      // The work questions come next; the tool agent starts once the browser question is answered, so the tools screen
      // has what it found by the time the person gets there. 2026-10-14: the popups the intro's buttons bring up stay over
      // the intro ("the background should never change when a new popup comes").
      keychainGate('roles');
    } else if (purpose === 'run') void run(provider);
    else if (purpose === 'librarian') void startLibrarian(provider);
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

  /**
   * The browser's sign-ins, asked once before the work questions (2026-10-16, S9–S12; model/onboarding.js keychainStep).
   * It can't be skipped, and is never skipped for want of an answer: while the browsers are still being looked for the
   * dialog says so and asks once they are known (S11; it used to go on as 'declined', and the run then sent keychain: true).
   * What comes after (`keychainNext`: the work questions) is kept in the saved flow, so a relaunch macOS asks for after Full
   * Disk Access comes back to the question and goes on from it.
   */
  const keychainGate = (next) => {
    latest.current = { ...latest.current, keychainNext: next };
    set({ keychainNext: next });
    routeKeychain(browsers);
  };
  const routeKeychain = (now, { fresh = false } = {}) => {
    const step = keychainStep(fresh && now ? { ...now, keychain: null } : now, platform);
    if (step === 'wait') { set({ dialog: 'keychain' }); return; }
    // No browser whose sign-ins can be read: declined without a question, and saved as declined, so nothing waits for an
    // answer (2026-10-16: the recent projects waited ten minutes for one, discover.cjs keychainAnswer).
    if (step.go === 'declined' && !now.keychain) Promise.resolve(api.keychain('declined')).catch(() => {});
    if (step.go) { keychainDone(step.go); return; }
    set({ dialog: step === 'safari' ? 'safari' : 'keychain' });
  };
  // The browsers found while the dialog waited for them: asked now (or on at once, with none to ask about).
  const haveBrowsers = !!browsers;
  React.useEffect(() => {
    const now = latest.current;
    if (haveBrowsers && now.dialog === 'keychain' && now.keychainNext) routeKeychain(browsers);
  }, [haveBrowsers]); // eslint-disable-line react-hooks/exhaustive-deps
  const keychainDone = (answer) => {
    const now = latest.current;
    // A flow saved on the question before `keychainNext` was kept: it was asked from the intro, on the way to the questions.
    const next = now.keychainNext || (now.screen === 'intro' ? 'roles' : null);
    latest.current = { ...now, dialog: null, keychainNext: null, diskWaiting: false };
    set({ dialog: null, keychainNext: null, diskWaiting: false, ...(next ? { screen: next } : {}) });
    startTools(answer === 'allowed' ? 'allowed' : 'declined');
  };
  /** Allow (or Safari's disk access granted): the profile first when the browser has several (S10), then macOS (S12). */
  const keychainAllow = () => {
    if (afterAllow(browsers) === 'profile') { set({ dialog: 'browser-profile', profileChoice: null }); return; }
    void askMacos();
  };
  // macOS's one prompt for the chosen browser's sign-ins, at once, with either way of importing (S12: it waited until
  // Import to Engelbart with "Choose sources myself"). It resolves once macOS answered (COOKIES' api.keychain: { keychain:
  // 'allowed' | 'refused' }); a refusal is kept as such, so nothing asks macOS again this run.
  const askMacos = async () => {
    setBusy('keychain');
    let out = null;
    try { out = await api.keychain('allowed'); } catch (failure) { say(failure); }
    setBusy('');
    const answer = out && typeof out === 'object' && (out.keychain === 'allowed' || out.keychain === 'refused') ? out.keychain : 'allowed';
    setBrowsers((now) => ({ ...(now || { browsers: [] }), keychain: answer }));
    keychainDone(answer);
  };
  const keychainDecline = async () => {
    try { await api.keychain('declined'); } catch (failure) { say(failure); }
    setBrowsers((now) => ({ ...(now || { browsers: [] }), keychain: 'declined' }));
    keychainDone('declined');
  };
  const chooseProfile = async () => {
    const id = latest.current.profileChoice;
    if (!id || !browsers) return;
    if (typeof api.chooseBrowserProfile === 'function') {
      try { setBrowsers(await api.chooseBrowserProfile(browsers.chosenId, id)); } catch (failure) { say(failure); return; }
    } else setBrowsers((now) => ({ ...now, chosenProfile: id }));
    void askMacos();
  };
  // Safari (S9): Grant disk access opens System Settings ▸ Privacy & Security ▸ Full Disk Access (no guide window) and waits
  // for the switch; granted, Safari's sign-ins are used like any other browser's.
  const grantDisk = async () => {
    set({ diskWaiting: true });
    try {
      if (typeof api.openDiskAccess === 'function') await api.openDiskAccess();
      else await api.openExternal(FULL_DISK_ACCESS_URL);
    } catch (failure) { say(failure); }
  };
  const safariOpen = F.dialog === 'safari';
  React.useEffect(() => {
    if (!safariOpen) return undefined;
    let live = true;
    let timer = null;
    const tick = async () => {
      let granted = false;
      try { const out = await api.diskAccess(); granted = !!(out && out.granted); } catch { granted = false; }
      if (!live) return;
      if (!granted) { timer = setTimeout(tick, 1500); return; }
      setDisk({ granted: true });
      let now = browsers;
      try { now = await api.browsers(); setBrowsers(now); } catch { /* the last answer */ }
      if (!live || latest.current.dialog !== 'safari') return;
      const ready = { ...(now || {}), safari: { ...((now && now.safari) || {}), diskAccess: true } };
      if (afterAllow(ready) === 'profile') { set({ dialog: 'browser-profile', profileChoice: null }); return; }
      void askMacos();
    };
    timer = setTimeout(tick, 0);
    return () => { live = false; clearTimeout(timer); };
  }, [safariOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const useBrowser = async () => {
    const id = F.browserChoice;
    let out = null;
    try { out = await api.chooseBrowser(id); setBrowsers(out); } catch (failure) { say(failure); return; }
    // Another browser is asked about afresh: Safari's popup, or Allow for any other (Firefox keeps no Keychain key, so
    // macOS asks nothing for it).
    routeKeychain(out, { fresh: true });
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
    const web = runApps(now).filter((id) => isWebApp(id));
    const others = runAdded(now);
    if (!web.length && !others.length) { then(); return; }
    let status = null;
    try { status = await api.browserAgents({ provider, browserId: (browsers && browsers.chosenId) || null }); } catch { status = null; }
    if (!status || !status.ask) { then(); return; }
    // "Import context using background agents" said they use the signed-in browser, and the person said I understand.
    if (now.agentsConsent) { try { await api.browserAgentsAnswer('allowed'); } catch (failure) { say(failure); } then(); return; }
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
  // How should Engelbart import your sources? (From Amitav, 2026-10-15), asked at Import to Engelbart: in the background
  // with agents (after what that means is said and understood), or manually, the librarian asking before anything comes in.
  // Opened from a project (`methodFirst`), the question comes first: answered there, the sources follow, and Import to
  // Engelbart goes on with that answer (what agents do is still said after the sources are chosen).
  const atFirstQuestion = () => { const now = latest.current; return !!now.methodFirst && !now.mode && now.dialog === 'import-method'; };
  const chooseMethod = () => {
    const now = latest.current;
    if (!((runApps(now).length || runAdded(now).length) && now.picked.length)) return;
    if (now.methodFirst && now.mode === 'auto') { set({ dialog: 'agents-consent' }); return; }
    if (now.methodFirst && now.mode === 'manual') { manually(); return; }
    set({ dialog: 'import-method' });
  };
  const inBackground = () => { if (atFirstQuestion()) { set({ mode: 'auto', dialog: null }); return; } set({ mode: 'auto', dialog: 'agents-consent' }); };
  const understood = () => { latest.current = { ...latest.current, mode: 'auto', agentsConsent: true, dialog: null }; set({ mode: 'auto', agentsConsent: true, dialog: null }); runGate(); };
  const manually = () => {
    if (atFirstQuestion()) { set({ mode: 'manual', dialog: null }); return; }
    latest.current = { ...latest.current, mode: 'manual', dialog: null }; set({ mode: 'manual', dialog: null }); runGate();
  };

  /** What comes before an import starts, either way: which project opens first, Apple Notes' permission, Allow Engelbart
   *  to organize your research (the folders macOS guards, asked once); then the run, or the librarian. */
  const runGate = () => {
    const now = latest.current;
    const apps = runApps(now);
    if ((!apps.length && !runAdded(now).length) || !now.picked.length) return;
    // Which project opens (2026-10-14, "Right now I think it opens a random project"): asked when more than one was picked.
    // It gets the Welcome project holding every source the run brings in, for all the projects.
    if (mode === 'new' && now.picked.length > 1 && !now.picked.includes(now.firstProject)) { set({ dialog: 'first-project', firstChoice: now.picked[0] }); return; }
    if (apps.includes('Apple Notes') && !now.notesConsent && !notesConsented()) { set({ dialog: 'notes-permission' }); return; }
    if (platform === 'darwin' && !foldersReady(now)) { set({ dialog: 'organize' }); return; }
    if (now.mode === 'manual') { if (!now.provider) { void needProvider('librarian'); return; } void startLibrarian(); return; }
    if (!now.provider) { void needProvider('run'); return; }
    void run();
  };

  /** The run, once the person said whether agents may use their browser (when that is theirs to say). */
  function run(providerNow = null) {
    const provider = providerNow || latest.current.provider;
    if (!provider) { void needProvider('run'); return Promise.resolve(); }
    return browserAgentsGate(provider, () => { void startRun(provider); });
  }

  /**
   * What an import is told, either way (From Amitav, 2026-10-15: one tools screen): the projects (the one to start with
   * first), the catalog's apps ticked, what was specified for each (its own Specify context and its category's: the note,
   * the people, the projects it is kept to, none meaning every one picked), and the extra tools ticked with theirs.
   */
  const runChoices = (now) => {
    const projects = selectedProjects(now, discovery).map((project) => ({ id: project.id, title: project.title, description: project.description || '', folder: project.folder || '' }))
      .sort((a, b) => (b.id === now.firstProject) - (a.id === now.firstProject));
    const titlesOf = (ids) => projects.filter((project) => ids.includes(project.id)).map((project) => project.title);
    const sentence = (lines) => lines.map((line) => String(line || '').trim()).filter(Boolean).map((line) => (/[.!?]$/.test(line) ? line : `${line}.`)).join(' ');
    const said = (id, group) => {
      const scope = now.scopes[id] || emptyScope(isLinks(id) ? SITES : id);
      const category = { note: '', people: [], ...(now.groupScopes[group] || {}) };
      const only = Array.isArray(scope.only) ? titlesOf(scope.only) : [];
      return { scope, category, only: only.length === projects.length ? [] : only };
    };
    const apps = runApps(now);
    const scopes = {};
    for (const id of apps) {
      const { scope, category, only } = said(id, groupOf(id));
      // A notes app's saved websites (2026-10-14), ticked under Websites: its import also brings in the links in its notes.
      const links = now.picks.includes(linksOf(id));
      const linkScope = now.scopes[linksOf(id)] || null;
      const sites = links ? { note: '', ...(now.groupScopes.sites || {}) } : null;
      const note = sentence([category.note, scope.note, links ? LINKS_NOTE : '', sites && sites.note ? `For those links: ${sites.note}` : '', linkScope && linkScope.note ? `For those links: ${linkScope.note}` : '']);
      scopes[id] = { kind: scope.kind, folders: scope.folders, note, people: [...new Set([...(category.people || []), ...scope.people])], items: [], labels: [], projects: only };
    }
    const additional = runAdded(now).map((tool) => {
      const { scope, category, only } = said(tool.id, tool.group || 'other');
      return { name: tool.name, website: tool.website || '', note: sentence([category.note, scope.note]), projects: only };
    });
    return { projects, apps, scopes, additional };
  };
  const startInput = (now, provider, { projects, apps, scopes, additional }, extra = {}) => ({
    provider,
    permissions: { files: true, browser: true, recall: true, notes: apps.includes('Apple Notes') },
    keychain: runKeychain(browsers), // S11: from the answer alone; declined or never answered, macOS is never asked
    browser: (browsers && browsers.chosenId) || null,
    days: cleanDays(now.period),
    ...(mode === 'modal' && into ? { projectId: into, ...(workspaceId ? { workspaceId } : {}) } : {}),
    direct: { mode: now.mode || 'auto', projects, roles: now.roles, work: now.work, apps, scopes, additional },
    ...extra,
  });

  /** A project for every project picked; the first (the one to start with) holds session `sessionId` and opens. */
  const openProjects = async (sessionId, projects) => {
    let first = null;
    for (const [index, project] of projects.entries()) {
      const input = { name: project.title, description: project.description, folder: 'new', directory: '', context: [], onboarding: index === 0, ...(index === 0 ? { connect: sessionId } : {}) };
      let made = null;
      if (project.folder) made = await api.startProject({ ...input, folder: 'existing', directory: project.folder }).catch(() => null);
      if (!made) made = await api.startProject(input);
      if (!first) first = made;
    }
    if (!first) first = await api.startProject({ name: 'My research', description: '', folder: 'new', directory: '', context: [], onboarding: true, connect: sessionId });
    await onDone(first, { session: { id: sessionId } });
  };

  async function startRun(providerNow = null) {
    const now = latest.current;
    const provider = providerNow || now.provider;
    if (!provider) { void needProvider('run'); return; }
    const choices = runChoices(now);
    // No "Starting your imports" popup (2026-10-14: one popup at most between here and the project): the button says it.
    set({ dialog: null });
    setBusy('run');
    setError('');
    try {
      if (choices.apps.includes('Apple Notes')) await api.notesPermission().catch(() => null);
      const session = await api.connectStart(startInput(now, provider, choices));
      await api.saveFlow(null).catch(() => {});
      if (mode === 'modal') { onClose({ session }); return; }
      await openProjects(session.id, choices.projects);
      set({ dialog: null });
    } catch (failure) {
      say(failure);
      set({ dialog: null });
    } finally {
      setBusy('');
    }
  }

  // Import manually with fine-grained permissions (From Amitav, 2026-10-15: "Clicking pill two should do the library
  // brainstorm import process, and right now just reuse the exact code"): the same choices start a librarian session
  // (connect/session.cjs `librarian`), whose chat (Connect your library's) asks before anything comes in. In a new user's
  // onboarding the chat is this flow's last screen and the projects are made when it is put away; over a project, the
  // chat opens over the workspace (App.jsx).
  async function startLibrarian(providerNow = null) {
    const now = latest.current;
    const provider = providerNow || now.provider;
    if (!provider) { void needProvider('librarian'); return; }
    const choices = runChoices(now);
    set({ dialog: null });
    setBusy('run');
    setError('');
    try {
      if (choices.apps.includes('Apple Notes')) await api.notesPermission().catch(() => null);
      const session = await api.connectStart(startInput(now, provider, choices, { librarian: true }));
      if (mode === 'modal') { await api.saveFlow(null).catch(() => {}); onClose({ session }); return; }
      latest.current = { ...latest.current, screen: 'librarian', librarian: session.id, dialog: null };
      set({ screen: 'librarian', librarian: session.id, dialog: null });
    } catch (failure) {
      say(failure);
      set({ dialog: null });
    } finally {
      setBusy('');
    }
  }
  /** The librarian's chat put away (it goes on in the background): the projects are made and the first opens. */
  const librarianDone = async () => {
    const now = latest.current;
    if (!now.librarian || busy === 'project') return;
    setBusy('project');
    try {
      await api.saveFlow(null).catch(() => {});
      await openProjects(now.librarian, runChoices(now).projects);
    } catch (failure) { say(failure); } finally { setBusy(''); }
  };

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

  /* -------- the folders macOS guards */
  // Allow Engelbart to organize your research (2026-10-15, Hudson: no Full Disk Access, "by bypassing the FDA gate we will
  // just have the popups, and that is ok. however, instead of them showing up randomly have a popup"): asked once, unless
  // they were asked before (folders.json) or may be read already.
  const foldersReady = (now) => now.organized || !!now.folderAnswers || !!(disk && disk.granted) || DESKTOP_FOLDERS.every((id) => asked && asked[id]);
  const connectDesktop = async () => {
    setBusy('folders');
    let answers = {};
    try { answers = (await api.foldersAsk(DESKTOP_FOLDERS)) || {}; } catch (failure) { say(failure); }
    setBusy('');
    setAsked((now) => ({ ...(now || {}), ...answers }));
    latest.current = { ...latest.current, folderAnswers: answers };
    set({ folderAnswers: answers });
  };
  // Skip (2026-10-16, S13: "they should be able to deny"): on without asking macOS for the folders; what needs them is left
  // out quietly (the folder guard reads only folders allowed, ../../main/connect/folder-access.cjs).
  const organizeSkip = () => { latest.current = { ...latest.current, organized: true, dialog: null }; set({ organized: true, dialog: null }); setTimeout(runGate, 0); };

  // S8: "(recommended)" in the first way's title only while the whole title fits on one line at the dialog's width.
  const [recommendedFits, setRecommendedFits] = React.useState(true);
  const recommendedWatch = React.useRef(null);
  const recommendedRef = React.useCallback((title) => {
    if (recommendedWatch.current) { recommendedWatch.current.disconnect(); recommendedWatch.current = null; }
    if (!title) return;
    const measure = () => {
      const probe = title.parentElement && title.parentElement.querySelector('.recommended-measure');
      if (probe) setRecommendedFits(probe.getBoundingClientRect().width <= title.getBoundingClientRect().width + 0.5);
    };
    measure();
    if (typeof ResizeObserver === 'function') { recommendedWatch.current = new ResizeObserver(measure); recommendedWatch.current.observe(title); }
  }, []);

  /* -------- picks */
  /** A tool from "+ Add a tool": ticked, as the person's own choice. */
  const pickTool = (id) => set((now) => ({ picks: [...new Set([...now.picks, id])], touched: [...new Set([...now.touched, id])], open: [groupOfId(id, now)], dialog: null }));
  /** The category a source is shown in: the catalog's, else (a tool the agents found or the person added) its own. */
  const groupOfId = (id, now = F) => groupOf(id) || ((now.added.find((tool) => tool.id === id) || {}).group) || 'other';
  /** A category's rows: its apps (Websites: the browser's saved URLs, then each notes app's saved websites), then the tools
   *  the agents found in it. Other: its own apps (Linear, 2026-10-16) and those, shown when it has either. */
  const keysOf = (group, now = F) => {
    const own = (group.apps.length ? group.apps : group.id === 'other' ? [] : [`__${group.id}`]).map((key) => (key === '__sites' ? SITES : key));
    const links = group.id === 'sites' ? NOTES_APPS.filter((app) => now.picks.includes(app)).map(linksOf) : [];
    const found = now.added.filter((tool) => groupOfId(tool.id, now) === group.id).map((tool) => tool.id);
    return [...own, ...links, ...found];
  };
  const toggle = (list, id) => (list.includes(id) ? list.filter((one) => one !== id) : [...list, id]);
  const scopeOf = (id) => F.scopes[id] || emptyScope(isLinks(id) ? SITES : id);
  /** A source ticked or unticked (the person's own, so the tool agent's answer leaves it). Ticking closes any one source's
   *  Specify context; unticking opens nothing. A notes app unticked takes its saved websites with it. */
  const pickSource = (id) => set((now) => {
    const adding = !now.picks.includes(id);
    let picks = toggle(now.picks, id);
    if (!adding && NOTES_APPS.includes(id)) picks = picks.filter((one) => one !== linksOf(id));
    const touched = [...new Set([...now.touched, id])];
    return adding ? { picks, touched, scopeOpen: null } : { picks, touched, scopeOpen: now.scopeOpen === id ? null : now.scopeOpen };
  });
  const setScope = (id, patch) => set((now) => ({ scopes: { ...now.scopes, [id]: { ...(now.scopes[id] || emptyScope(id)), ...patch } } }));
  // Choose files (2026-10-14: "choose folder and choose files should just be the same thing"): files and folders in one
  // picker; Obsidian's is a picker of its own over the vaults, drawn like Obsidian's file explorer (./ObsidianPicker.jsx).
  const addFolders = (id, chosenFiles) => set((now) => {
    const scope = now.scopes[id] || emptyScope(id);
    const folders = [...scope.folders, ...chosenFiles.filter((file) => !scope.folders.some((folder) => folder.path === file.path))];
    return { scopes: { ...now.scopes, [id]: { ...scope, folders } } };
  });
  const chooseFiles = async (id) => {
    if (id === 'Obsidian' && api.obsidianTree) { set({ dialog: 'obsidian-picker', pickerFor: id }); return; }
    const files = await api.pickFiles().catch(() => []);
    if (files.length) addFolders(id, files);
  };

  const projects = allProjects(F, discovery);
  const chosen = selectedProjects(F, discovery);
  const projectStatus = discovery && discovery.projects ? discovery.projects.status : 'idle';
  const toolStatus = discovery && discovery.tools ? discovery.tools.status : 'idle';
  const results = discovery && discovery.tools && discovery.tools.results;

  /* ================================================================================================== the screens */

  const flowHeader = (title, key, onBack, sub = '') => (
    <header className="work-head">
      
      <T k={key} tag="h1" fallback={title} />
      {sub ? <p>{sub}</p> : null}
    </header>
  );

  const lowerBack = () => <button type="button" className="link work-back" onClick={() => {
    if (F.screen === 'roles') set({ screen: 'intro', dialog: null });
    else if (F.screen === 'work') set({ screen: 'roles' });
    else if (F.screen === 'projects') set({ screen: 'work' });
    else set({ screen: 'projects' });
  }}>{CHEV} Back</button>;

  // 2026-10-14 (a beta tester: "it said try again but it didn't work ever"): a failure its provider's CLI caused (not
  // installed, not signed in: the discovery's `connect`) asks to connect that one, and Try again checks the provider before
  // it looks again, so it never re-runs a CLI that cannot run. A search that never started (idle, or stopped by a quit)
  // says so instead of "Finding…".
  const discoveryLine = () => {
    if (projectStatus === 'idle' && !F.provider) return null;
    const found = (discovery && discovery.projects) || {};
    const connect = found.connect === 'anthropic' || found.connect === 'openai' ? found.connect : null;
    const named = connect === 'openai' ? 'Codex' : connect === 'anthropic' ? 'Claude Code' : '';
    // Its CLI says it is signed in, yet it turned the agent away (no subscription, say): connecting is signing in again.
    const refused = projectStatus === 'failed' && !!connect && ((providers && providers.providers) || []).some((one) => one.id === connect && one.installed && one.signedIn);
    // Nothing on this Mac to name projects from (2026-10-15: a new account): said plainly, not as a failure to try again.
    const text = projectStatus === 'done' && found.empty ? 'No recent projects found. Add your own below.'
      : projectStatus === 'done' ? 'Recent projects found'
      // DISCOVERY's route (2026-10-16): the person's Claude or ChatGPT on the web is asked when the CLIs knew nothing.
      : projectStatus === 'running' && Array.isArray(found.asking) && found.asking.length ? `Asking ${found.asking.join(' and ')} about your projects…`
      : projectStatus === 'running' ? 'Finding recent projects in the background…'
        : projectStatus === 'failed' ? (connect ? `Couldn’t reach ${named}.` : 'Couldn’t find recent projects. Add your own below.')
          : projectStatus === 'waiting-provider' ? `Waiting for ${named || 'your AI provider'}…`
            : projectStatus === 'stale' || projectStatus === 'idle' ? 'Recent projects weren’t looked for.' : 'Finding recent projects in the background…';
    return (
      <div className="discovery-line" role="status" data-discovery-status={projectStatus}>
        <span className="activity-dot" />
        <span>{text}</span>
        {(projectStatus === 'waiting-provider' || (projectStatus === 'failed' && connect)) && <button type="button" className="link under" data-discovery-connect={connect || ''} onClick={() => needProvider('projects', connect, refused)}>{named ? `Connect ${named}` : 'Connect Claude Code or Codex'}</button>}
        {((projectStatus === 'failed' && !connect) || projectStatus === 'stale' || projectStatus === 'idle') && <button type="button" className="link under" data-discovery-again="1" onClick={() => needProvider('projects')}>Try again</button>}
      </div>
    );
  };

  // Import your context (2026-10-14: "Instead of a popup, this should actually be its own screen"): the first screen, not a
  // dialog over the picker the person had not seen yet. Its buttons' popups (provider, tools, the browser's sign-ins, Start
  // from scratch) open over it and it stays behind them; the work questions follow once they are answered.
  const introPage = () => (
    <main className="page intro-page" data-import-screen="intro">
      {mode === 'modal' && <button type="button" className="close intro-close" aria-label="Close" onClick={() => { api.saveFlow(null).catch(() => {}); onClose({}); }}>×</button>}
      <div className="welcome">
        <T k="title" tag="h1" />
        <T k="subtitle" tag="p" className="lead" />
        <div className="icons">
          {SUPPORTED.map(([name, src]) => <span key={name} className="ic" title={name}><img src={src} alt={name} /></span>)}
        </div>
        <div className="actions">
          <a className="link scratch-link" href="#skip" onClick={(event) => { event.preventDefault(); set({ dialog: 'scratch-confirm' }); }}><T k="secondary" /></a>
          <button type="button" className="btn" data-import-start="1" onClick={importContext}><T k="primary" /></button>
        </div>
      </div>
    </main>
  );

  const rolesPage = () => (
    <main className="work-page" data-import-screen="roles">
      <div className="work-column">
        {flowHeader('What kind of work do you do?', 'role-title', () => set({ screen: 'intro', dialog: null }), 'Choose all that apply.')}
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
  // written here goes to the import agents with the projects picked. 2026-10-14: "What are you interested in?", Enter
  // continues and Shift+Enter starts a new paragraph, with no line saying so ("we wanna keep it clean").
  const workNext = () => { if (latest.current.work.trim()) set({ screen: 'projects' }); };
  const workPage = () => (
    <main className="work-page review-work" data-import-screen="work"><div className="work-column">
      {flowHeader('What are you interested in researching?', 'work-description-title', () => set({ screen: 'roles' }))}
      <textarea id="work-description" className="field" rows={1} ref={growReviewInput} autoFocus aria-label="What are you interested in researching?" placeholder="Understanding the Memex..." value={F.work}
        onChange={event => { growReviewInput(event.currentTarget); set({ work: event.target.value.slice(0, 2000) }); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); workNext(); } }} />
      <footer className="work-foot">{lowerBack()}<button type="button" className="btn" disabled={!F.work.trim()} onClick={workNext}>Continue{CHEV}</button></footer>
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
                <span className="project-text"><b>{project.title}</b><small>{project.description || 'Added by you'}</small></span>
                {project.recent ? <span className="project-recency">{project.recent}</span> : null}
                <Check on={F.picked.includes(project.id)} />
              </button>
            ))}
            {!ready && <div className="project-loading">{discoveryLine()}<div className="project-skeleton" /><div className="project-skeleton" /></div>}
            {ready && projectStatus === 'failed' && discoveryLine()}
            {/* Nothing anywhere knew of a project (DISCOVERY's reason 'no-context', 2026-10-16): the person adds one, and
                nothing says it failed ("it is more an issue of not enough context"). */}
            {projectStatus === 'done' && discovery.projects.empty && !projects.length && <p className="projects-empty" data-projects-empty={discovery.projects.reason || 'empty'}>Add the project you want to start with.</p>}
          </div>
          <button type="button" className="add-project" onClick={() => { setDraft({ title: '', description: '', tool: '', website: '' }); set({ dialog: 'work-add-project' }); }}>{PLUS} Add a project</button>
          <footer className="work-foot">{lowerBack()}
            <span className="muted">{F.picked.length} selected</span>
            <button type="button" className="btn" disabled={!F.picked.length} onClick={() => {
              set({ screen: 'picker', dialog: null });
              window.scrollTo(0, 0);
            }}>Continue{CHEV}</button>
          </footer>
        </div>
      </main>
    );
  };

  /**
   * A Specify context panel (round 3, reworked 2026-10-14). A source's own: the projects first, every one picked ticked
   * until the person narrows it (From Amitav, 2026-10-15: "default should be all selected projects, unless overridden on a
   * tool level"), under one line saying what they are for; then "Specific things to import from {source} (optional)" with
   * its category's hint, Choose files for a file source, and the people for email (Enter adds one). A category's: no
   * projects, and "these apps" (or "these sources") rather than every name ticked in it.
   */
  const contextPanel = ({ id, name, label, hint, note, onNote, projectOn = null, onProject = null, chooser = null, people = null, onPeople = null, folders = [], onRemoveFolder = null }) => (
    <div className="review-context" data-context-panel={id}>
      {projectOn && chosen.length > 0 && <p className="review-projects-note">Select all projects you want Engelbart to import from {name}.</p>}
      {projectOn && chosen.length > 0 && <div className="review-projects" role="group" aria-label={`Projects to import from ${name}`}>
        {chosen.map((project) => {
          const on = projectOn(project);
          return <button key={project.id} type="button" className="review-project" data-source-project={project.id} role="checkbox" aria-checked={on} onClick={() => onProject(project, on)}>{on && <span className="review-project-check" aria-hidden="true">✓</span>}{project.title}</button>;
        })}
      </div>}
      <label className="review-context-label" htmlFor={`review-context-${id}`}>{label}</label>
      <textarea id={`review-context-${id}`} className="field" rows={1} ref={growReviewInput} data-scope-note={id} placeholder={hint} value={note} onChange={(event) => { growReviewInput(event.currentTarget); onNote(event.target.value.slice(0, 2000)); }} />
      {people && <>
        <div className="sender-input">
          <input className="field" aria-label="Name or email address" placeholder="Name or email address" value={sender[id] || ''} data-sender-input={id}
            onChange={(event) => setSender((now) => ({ ...now, [id]: event.target.value }))}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); const person = (sender[id] || '').trim(); if (person) onPeople([...new Set([...people, person])]); setSender((now) => ({ ...now, [id]: '' })); } }} />
          <button type="button" className="link" onClick={() => { const person = (sender[id] || '').trim(); if (person) onPeople([...new Set([...people, person])]); setSender((now) => ({ ...now, [id]: '' })); }}>Add person</button>
        </div>
        {people.length > 0 && <div className="sender-chips">{people.map((person) => <button type="button" key={person} onClick={() => onPeople(people.filter((one) => one !== person))}>{person} ×</button>)}</div>}
      </>}
      {chooser && <div className="folder-upload"><button type="button" className="link under" data-choose-files={id} onClick={chooser}>Choose files</button></div>}
      {folders.length > 0 && <div className="selected-folder-list">{folders.map((folder) => <div key={folder.path} title={folder.path}>{folder.file ? FILE : FOLDER}<span>{folder.name}</span><button type="button" className="link" aria-label={`Remove ${folder.name}`} onClick={() => onRemoveFolder(folder)}>×</button></div>)}</div>}
    </div>
  );

  /** A source's name as its row says it (a tool the agents found by its own name). */
  const nameOf = (id) => toolName(id, F.added);
  const spokenOf = (id) => (isLinks(id) ? spokenName(id) : nameOf(id));

  /** A source's own Specify context (opened from its row). `only`: the projects it is kept to, null for every one picked. */
  const sourcePanel = (id) => {
    const scope = scopeOf(id);
    const name = spokenOf(id);
    const every = chosen.map((project) => project.id);
    const only = Array.isArray(scope.only) ? scope.only.filter((one) => every.includes(one)) : null;
    return contextPanel({
      id, name, label: `Specific things to import from ${name} (optional)`, hint: GROUP_HINTS[groupOfId(id)] || '', note: scope.note, onNote: (note) => setScope(id, { note }),
      projectOn: (project) => !only || !only.length || only.includes(project.id),
      onProject: (project, on) => {
        const now = only && only.length ? only : every;
        const next = on ? now.filter((one) => one !== project.id) : [...new Set([...now, project.id])];
        if (!next.length) return; // a source is for one project at least
        setScope(id, { only: next.length === every.length ? null : next });
      },
      chooser: FILE_SOURCES.includes(id) ? () => chooseFiles(id) : null,
      people: scope.kind === 'email' ? scope.people : null, onPeople: (people) => setScope(id, { people }),
      folders: scope.folders, onRemoveFolder: (folder) => setScope(id, { folders: scope.folders.filter((one) => one.path !== folder.path) }),
    });
  };


  const picker = () => (
    <>
      <main className="page picker-page review-picker" data-import-screen="picker">
        <div className="col">
          <T k="pickerTitle" tag="h2" />
          {mode === 'new' && toolStatus === 'checking' && <div className="discovery-line picker-discovery" role="status" data-tools-status="checking"><span className="activity-dot" /><span>Finding the tools you use…</span></div>}
          {/* 2026-10-16 (S6, "get rid of this dropdown, it should not be collapsable on a topic level"): every category is
              open, with no chevron, and has no "Specify context for all {category}" of its own; each source keeps its own
              Specify context, a category of one source too. */}
          {GROUPS.filter((group) => keysOf(group).length > 0).map((group) => {
            const keys = keysOf(group);
            const nOn = keys.filter((id) => F.picks.includes(id)).length;
            return <section key={group.id} data-group-section={group.id}>
              <div className="group-head">
                <span className="group-title" data-group={group.id}>{group.label}</span>
                <span className="muted review-count">{nOn ? `${nOn} selected` : ''}</span>
              </div>
              <div className="apps">
                {keys.map((id) => {
                  const selected = F.picks.includes(id);
                  return <section key={id} className={`review-source ${selected ? 'selected' : ''}`}>
                    <div className="review-source-row">
                      <button type="button" className="app-row" data-app={id} role="checkbox" aria-checked={selected} onClick={() => pickSource(id)}>
                        <ToolLogo id={id} /><span className="app-text">{nameOf(id)}</span><Check on={selected} />
                      </button>
                      {selected && <button type="button" className={`review-specify ${F.scopeOpen === id ? 'is-open' : ''}`} data-specify-context={id} aria-expanded={F.scopeOpen === id} onClick={() => set({ scopeOpen: F.scopeOpen === id ? null : id })}>Specify context{DOWN}</button>}
                    </div>
                    {selected && F.scopeOpen === id && sourcePanel(id)}
                  </section>;
                })}
              </div>
            </section>;
          })}
          <div className="picker-add"><button type="button" className="link under" data-add-tool="1" onClick={() => { setCatalogQuery(''); setDraft({ title: '', description: '', tool: '', website: '' }); set({ dialog: 'work-add-tool' }); }}>+ Add a tool</button></div>
        </div>
      </main>
      <footer className="foot"><div className="foot-inner"><div className="back-skip"><button type="button" className="link" onClick={() => { if (mode === 'modal') { api.saveFlow(null).catch(() => {}); onClose({}); } else set({ screen: 'projects', dialog: null }); }}>{mode === 'modal' ? 'Cancel' : 'Back'}</button></div><span className="muted review-count">{F.picks.length} selected</span><div className="foot-right"><button type="button" className="btn" data-import-run="1" disabled={!F.picks.length || !F.picked.length || busy === 'run'} onClick={chooseMethod}>{busy === 'run' ? 'Starting…' : RUN_LABEL}{busy === 'run' ? null : CHEV}</button></div></div></footer>
    </>
  );

  /* ================================================================================================== the dialogs */

  const buttons = (secondary, primary, onSecondary, onPrimary, disabled = false) => (
    <div className="mf">
      {secondary ? <button type="button" className="link" onClick={onSecondary}>{secondary}</button> : null}
      <button type="button" className="btn small" disabled={disabled} onClick={onPrimary}>{primary}</button>
    </div>
  );
  const close = () => set({ dialog: null });
  const browserNow = browsers ? browserName(browsers.chosenId) : 'your browser';

  // The browser named as the profile popup says it: "Select your Chrome profile" (not "Google Chrome").
  const shortBrowser = (id) => browserName(id).replace(/^(Google|Microsoft)\s+/, '');

  const dialogBody = () => {
    const d = F.dialog;
    if (d === 'scratch-confirm') return (<><h3>Are you sure?</h3><p>{mode === 'modal' ? 'Nothing will be imported. You can import your context later.' : 'Your project will start with an empty library. You can import your context later.'}</p><div className="mf"><button type="button" className="link" onClick={() => (mode === 'modal' ? startFromScratch() : set({ dialog: 'project' }))}>{mode === 'modal' ? 'Close' : 'Skip'}</button><button type="button" className="btn small" onClick={importContext}>Keep importing</button></div></>);
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
          <div className="mf mf-start"><button type="button" className="link" onClick={() => set({ dialog: null })}>Back</button></div>
        </>
      );
    }
    // The agent popup (2026-10-16, S3): the same one Welcome shows (./AgentSetup.jsx), in place of "Connect Claude Code or
    // Codex". The CLI the flow asked for (a provider that could not run, or one that turned the agents away) is chosen
    // already; once one can run, the effect above goes on with what it was opened for.
    if (d === 'tools-setup') {
      const asked = F.connectFor ? cliOfProvider(F.connectFor) : null;
      const turnedAway = refusedNow() ? cliOfProvider(refusedNow()) : null;
      return <AgentSetupBody key={asked || 'any'} api={api} tools={toolsSnap} providers={providers} initial={asked} refused={turnedAway} onDone={choseInPopup} onSkip={() => set({ dialog: null })} />;
    }
    // How should Engelbart import your sources? (From Amitav, 2026-10-15): choosing is continuing, as the legacy question's
    // was. In the background: what that means first (agents-consent). Manually: the librarian. 2026-10-16 (S8): the agents'
    // icon and a hand, "(recommended)" in the first title when it still fits on one line (dropped when it does not), no
    // trailing periods.
    if (d === 'import-method') {
      return (
        <>
          <h3>How should Engelbart import your sources?</h3>
          <div className="profiles import-modes" role="group" aria-label="How to import">
            <button type="button" className="prof import-mode" data-import-method="agents" onClick={inBackground}>
              <span className="import-mode-icon">{AGENT_ICON}</span>
              <span className="import-mode-copy"><b ref={recommendedRef} data-recommended={recommendedFits ? '1' : '0'}>Import in the background with agents{recommendedFits ? <span className="recommended"> (recommended)</span> : null}</b><span className="recommended-measure" aria-hidden="true">Import in the background with agents (recommended)</span><small>Engelbart will dispatch local background agents to bring in your approved sources with minimal intervention.</small></span>
            </button>
            <button type="button" className="prof import-mode" data-import-method="manual" onClick={manually}>
              <span className="import-mode-icon">{HAND_ICON}</span>
              <span className="import-mode-copy"><b>Import manually with fine-grained permissions</b><small>Engelbart will ask for your input before importing anything and will use permission prompts to ask for explicit permission before accessing anything.</small></span>
            </button>
          </div>
          {/* the first question from a project: nothing behind it, so Back closes Import context */}
          <div className="mf mf-start"><button type="button" className="link" data-import-method-back="1" onClick={atFirstQuestion() ? () => { api.saveFlow(null).catch(() => {}); onClose({}); } : close}>Back</button></div>
        </>
      );
    }
    // What the agents do, said before they start (From Amitav, 2026-10-15). Import manually is the second option's, not a
    // way back to the question.
    if (d === 'agents-consent') {
      // The provider that will run it: the one chosen, else the one Engelbart would pick (opened from a project, nothing
      // was chosen in this flow: it named neither, 2026-10-15).
      const runs = F.provider || (decision && decision.pick) || null;
      const cli = runs === 'openai' ? 'Codex' : runs === 'anthropic' ? 'Claude Code' : 'Claude Code or Codex';
      const company = runs === 'openai' ? 'OpenAI' : runs === 'anthropic' ? 'Anthropic' : 'Anthropic or OpenAI';
      const browser = browsers && browsers.chosenId && runKeychain(browsers) ? browserName(browsers.chosenId) : 'browser';
      return (
        <>
          <h3>Import context using background agents</h3>
          <p>{`Engelbart will use ${cli} and your signed-in ${browser} to find and import context from the sources you selected. Agents run in the background, and imported files are saved locally on your device. Content the agents read may be sent to ${company} for processing.`}</p>
          <div className="mf agents-consent-actions">
            <button type="button" className="link mf-left" onClick={() => set({ dialog: 'import-method' })}>Back</button>
            <button type="button" className="btn secondary small" data-import-manually="1" onClick={manually}>Import manually</button>
            <button type="button" className="btn small" data-import-understood="1" onClick={understood}>I understand</button>
          </div>
        </>
      );
    }
    // The browser's sign-ins (S9–S12, keychainGate): no way past it but an answer. While the browsers are being looked for
    // it says so in its place (S11); Allow goes to the profile (S10) or straight to macOS's own prompt (S12).
    if (d === 'keychain') {
      if (!browsers) return (<><h3>Allow Engelbart to use your browser sign-ins</h3><div className="discovery-line keychain-looking" role="status" data-keychain-looking="1"><span>Looking for your browsers…</span></div></>);
      const asking = busy === 'keychain';
      return (<><h3>{`Allow Engelbart to use your ${browserNow} sign-ins`}</h3><p>Everything is stored locally on your own device.</p><div className="mf keychain-actions"><button type="button" className="link under" disabled={asking} onClick={() => set({ dialog: 'keychain-browser', browserFrom: 'keychain', browserChoice: (browsers && browsers.chosenId) || null })}>Use another browser</button><button type="button" className="btn small" data-import-keychain-allow="1" disabled={asking} onClick={keychainAllow}>{asking ? 'Waiting for macOS…' : 'Allow'}</button></div></>);
    }
    // Safari (S9, Hudson's words): Full Disk Access, for Safari's own cookie file. Grant disk access opens System Settings at
    // Full Disk Access and waits for the switch (the effect above); Skip uses no Safari sign-ins (as declined).
    if (d === 'safari') {
      const waiting = !!F.diskWaiting || busy === 'keychain';
      return (
        <>
          <h3>Engelbart requires additional permissions to access Safari</h3>
          <p>Click on the toggle next to ‘Engelbart’ to grant access</p>
          <div className="mf safari-actions">
            <button type="button" className="link mf-left" data-safari-skip="1" onClick={keychainDecline}>Skip</button>
            <button type="button" className="btn secondary small" data-safari-other="1" onClick={() => set({ dialog: 'keychain-browser', browserFrom: 'safari', browserChoice: (browsers && browsers.chosenId) || null })}>Select different browser</button>
            <button type="button" className="btn small" data-safari-grant="1" disabled={busy === 'keychain'} onClick={grantDisk}>{waiting ? 'Waiting for access…' : 'Grant disk access'}</button>
          </div>
        </>
      );
    }
    // Several profiles in the chosen browser (S10): one is chosen, and only it is ever read from.
    if (d === 'browser-profile') {
      const list = profilesOf(browsers);
      const asking = busy === 'keychain';
      return (
        <>
          <h3>{`Select your ${shortBrowser(browsers && browsers.chosenId)} profile`}</h3>
          <div className="profiles browser-profiles" role="radiogroup" aria-label="Profile">
            {list.map((profile) => (
              <button key={profile.id} type="button" className="prof browser-choice profile-choice" role="radio" aria-checked={F.profileChoice === profile.id} data-browser-profile={profile.id} onClick={() => set({ profileChoice: profile.id })}>
                <span className="profile-name">{profile.name || profile.id}</span>{profile.email ? <span className="profile-email">{profile.email}</span> : null}
              </button>
            ))}
          </div>
          <div className="mf"><button type="button" className="btn small" data-browser-profile-continue="1" disabled={!F.profileChoice || asking} onClick={chooseProfile}>{asking ? 'Waiting for macOS…' : 'Continue'}</button></div>
        </>
      );
    }
    if (d === 'notes-permission') return (<><h3>Allow Engelbart to read Apple Notes?</h3><div className="mf"><button type="button" className="link" onClick={() => { const now = latest.current; const next = { ...now, picks: now.picks.filter(id => id !== 'Apple Notes'), dialog: null }; latest.current = next; set(next); setTimeout(runGate, 0); }}>Don’t allow</button><button type="button" className="btn" onClick={() => { rememberNotesConsent(); latest.current = { ...latest.current, notesConsent: true, dialog: null }; set({ notesConsent: true, dialog: null }); setTimeout(runGate, 0); }}>Allow</button></div></>);

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
          <div className="mf"><button type="button" className="link" onClick={() => set({ dialog: F.browserFrom === 'safari' ? 'safari' : 'keychain' })}>Back</button><button type="button" className="btn" disabled={!F.browserChoice} onClick={useBrowser}>{`Use ${browserName(F.browserChoice)}`}</button></div>
        </>
      );
    }
    // Allow Engelbart to organize your research (2026-10-15, drawn after Granola's "Allow Granola to transcribe your
    // meetings", in Engelbart's own look): Connect desktop asks macOS for Desktop, Documents and Downloads, one prompt
    // each; the agents' part is on already. Continue once the folders were asked about, whatever macOS was told.
    if (d === 'organize') {
      const done = !!F.folderAnswers;
      return (
        <>
          <h3>Allow Engelbart to organize your research</h3>
          <div className="organize-rows">
            <div className="organize-row" data-organize-row="files">
              <span>View my files locally</span>
              {done ? <span className="organize-enabled" data-organize-enabled="files">{CHECK}Enabled</span>
                : <button type="button" className="btn secondary small organize-connect" data-organize-connect="1" disabled={busy === 'folders'} onClick={connectDesktop}>{FOLDER}{busy === 'folders' ? 'Connecting…' : 'Connect desktop'}</button>}
            </div>
            <div className="organize-row" data-organize-row="agents">
              <span>Analyze using agents</span>
              <span className="organize-enabled" data-organize-enabled="agents">{CHECK}Enabled</span>
            </div>
          </div>
          <div className="mf"><button type="button" className="link mf-left" data-organize-skip="1" onClick={organizeSkip}>Skip</button><button type="button" className="btn small" data-organize-continue="1" disabled={!done} onClick={() => { latest.current = { ...latest.current, organized: true, dialog: null }; set({ organized: true, dialog: null }); setTimeout(runGate, 0); }}>Continue</button></div>
        </>
      );
    }
    if (d === 'browser-agents') return (<><h3>{`Let agents use ${browserNow}?`}</h3><p>They’ll read your selected sources in the background.</p><div className="mf"><button type="button" className="link" onClick={() => browserAgentsAnswer('declined')}>Don’t allow</button><button type="button" className="btn small" data-import-browser-agents-allow="1" onClick={() => browserAgentsAnswer('allowed')}>Allow</button></div></>);

    if (d === 'browser-agents-confirm') return (<><h3>Are you sure?</h3><p>{`Without ${F.agentsBrowser || 'your browser'}, agents bring in your web apps through Engelbart’s own browser instead, with the sign-ins it copied or those you make inside Engelbart.`}</p><div className="mf"><button type="button" className="link" onClick={() => browserAgentsAnswer('declined')}>Continue without it</button><button type="button" className="btn small" onClick={() => browserAgentsAnswer('allowed')}>{`Allow ${F.agentsBrowser || 'your browser'}`}</button></div></>);
    if (d === 'starting') return (<><h3>Starting your imports</h3><p>{`Each agent will bring in only what pertains to ${chosen.map((project) => project.title).join(' and ') || 'your projects'}.`}</p><div className="discovery-line" role="status"><span className="activity-dot" /><span>{mode === 'modal' ? 'Starting…' : 'Setting up your projects…'}</span></div></>);
    if (d === 'first-project') {
      const pick = F.firstChoice || F.picked[0];
      return (
        <>
          <h3>Which project do you want to start with?</h3>
          <div className="profiles first-projects" role="radiogroup" aria-label="Project to start with">
            {chosen.map((project) => (
              <button key={project.id} type="button" className="prof first-project" role="radio" aria-checked={pick === project.id} data-first-project={project.id} onClick={() => set({ firstChoice: project.id })}>
                <span>{project.title}</span>{pick === project.id ? CHECK : null}
              </button>
            ))}
          </div>
          <div className="mf"><button type="button" className="link" onClick={close}>Back</button><button type="button" className="btn small" data-first-project-open="1" disabled={!pick} onClick={() => { latest.current = { ...latest.current, firstProject: pick, dialog: null }; set({ firstProject: pick, dialog: null }); setTimeout(runGate, 0); }}>Continue</button></div>
        </>
      );
    }
    if (d === 'obsidian-picker') {
      return <ObsidianPicker api={api} chosen={(scopeOf(F.pickerFor || 'Obsidian').folders || []).map((folder) => folder.path)} onCancel={close}
        onChoose={(picks) => { addFolders(F.pickerFor || 'Obsidian', picks); close(); }} />;
    }
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
          <label className="field-label">Project title<input id="custom-project-title" className="field" placeholder="Memex" value={draft.title} onChange={(event) => setDraft((now) => ({ ...now, title: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') save(); }} /></label>
          <label className="field-label">Description <span className="muted">(optional)</span><textarea id="custom-project-description" className="field" rows={2} placeholder="Understanding the history of the Memex" value={draft.description} onChange={(event) => setDraft((now) => ({ ...now, description: event.target.value }))} /></label>
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
        // A tool the person adds goes in Other, ticked, and that category opens on it.
        set((now) => {
          const added = now.added.some((tool) => tool.id === id) ? now.added : [...now.added, { id, name, website, source: 'user', group: 'other' }];
          return { added, picks: [...new Set([...now.picks, id])], touched: [...new Set([...now.touched, id])], open: [groupOfId(id, { ...now, added })], dialog: null };
        });
      };
      return (
        <>
          <h3>Add a tool</h3>
          <input id="catalog-search" className="field" placeholder="Search supported tools…" aria-label="Search supported tools" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
          <div className="catalog-tool-list">
            {CATALOG.filter((tool) => !F.picks.includes(tool.id) && tool.name.toLowerCase().includes(catalogQuery.toLowerCase())).map((tool) => (
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
  const modalClass = d === 'obsidian-picker' ? 'obsidian-modal' : d === 'organize' ? 'organize-modal' : d === 'tools-setup' ? 'agent-modal' : d === 'safari' ? 'safari-modal' : d === 'import-method' ? 'method-modal' : '';
  const screen = F.screen === 'intro' ? introPage() : F.screen === 'roles' ? rolesPage() : F.screen === 'work' ? workPage() : F.screen === 'projects' ? projectsPage() : picker();

  // Import manually: the librarian's chat, Connect your library's own page, outside this flow's styles; put away, the
  // projects are made and the first opens.
  if (F.screen === 'librarian' && F.librarian && renderLibrarian) {
    const titles = chosen.map((project) => project.title);
    return (
      <div data-import-flow={mode} data-screen="librarian" data-dialog="" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '54px 24px 24px', boxSizing: 'border-box' }}>
        {renderLibrarian({ sessionId: F.librarian, project: { name: titles.join(', '), description: chosen.map((one) => `${one.title}${one.description ? `: ${one.description}` : ''}`).join('\n') }, onDone: librarianDone, onBack: () => set({ screen: 'picker', librarian: null, mode: null, dialog: null }) })}
        {error && <div role="alert" style={{ marginTop: 10, font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
      </div>
    );
  }

  return (
    <CopyContext.Provider value={{ edit, copy, setCopy }}>
      {/* ix-fluid: a new user's onboarding, the whole window (over a workspace the flow is a modal) */}
      <div className={`ix ${edit ? 'editing' : ''} ${mode === 'modal' ? 'ix-in-modal' : 'ix-fluid'}`} data-import-flow={mode} data-screen={F.screen} data-dialog={d || ''}>
        <style>{IMPORT_CSS}{EXTRA_CSS}{ROUND3_CSS}{ROUND4_CSS}</style>
        <div className="ix-app" inert={d ? true : undefined}>{screen}</div>
        {error && <div className="ix-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {body && (
          <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !UNSKIPPABLE.includes(d)) set({ dialog: null }); }}>
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
