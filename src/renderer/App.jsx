import React from 'react';
import { api, errorMessage } from './api.js';
import TestToggle from './ui/TestToggle.jsx';
import WindowEdges from './ui/WindowEdges.jsx';
import WindowControls from './ui/WindowControls.jsx';
import SandboxProgress from './ui/SandboxProgress.jsx';
import Home from './screens/Home.jsx';
import Onboarding from './screens/Onboarding.jsx';
import Workspace from './screens/Workspace.jsx';
import ToolSetup from './ui/ToolSetup.jsx';
import UpdateBanner from './ui/UpdateBanner.jsx';
import { useConnectSessions, ConnectChip, ConnectPopup } from './ui/ConnectDock.jsx';
import { GuidedSetupOffer, START_GUIDED_SETUP } from './ui/GuidedSetup.jsx';
import { launchRows, installedSignedOut, TOOL_ORDER } from './model/tools.js';
import ImportFlow from './import/ImportFlow.jsx';
import ImportStatus from './import/ImportStatus.jsx';
import NeedPopup from './import/NeedPopup.jsx';
import { importApi } from './import/import-api.js';
import { engelbartSignIn } from './screens/ConnectLibrary.jsx';
import { welcomePlace } from './model/welcome-place.js';

// Screens: the app opens straight into the workspace you were last in, and the first run (no projects yet) is
// onboarding (screens/Onboarding.jsx, 2026-09-28); + Project runs its last two screens. Onboarding ends in the project
// it made (the welcome tour that followed it was taken out on 2026-10-01). The guided setup (ui/GuidedSetup.jsx, 2026-10-10)
// runs a new user's screens for someone who has projects: offered once over their workspace, and from Settings. Started
// inside a project it has no Create and ends in a Welcome workspace added to that project; from all projects it ends in a
// new project. "Engelbart" in the header (or Escape) shows all projects (in the guided setup, the workspace it was started
// in). A project whose project.json has no code directory yet is held behind a modal until one is chosen (2026-09-18).
// Several windows (2026-10-03, src/main/windows.cjs): each opens where main says (its place before a reload or a
// relaunch, the workspace it was opened from, or the projects screen) and tells main where it goes. What another window
// saves arrives as an announcement: the project's tree or the projects are read again, the library too.

const pickFolder = (current) => window.terminalAPI.pickDirectory(current || undefined);

/** The project exists but does not know where its code lives: nothing else works until it does. */
function DirectoryGate({ project, onChosen, onHome, error }) {
  const [busy, setBusy] = React.useState(false);
  const choose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const chosen = await pickFolder(null);
      if (chosen) await onChosen(chosen);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="Choose the project's code directory" data-directory-gate="1" data-overlay="1" style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(255,255,255,.35)' }}>
      <div style={{ width: 'min(480px, 100%)', display: 'flex', flexDirection: 'column', gap: 18, padding: 28, background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: 'rise 200ms cubic-bezier(.25,.1,.25,1)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ margin: 0, font: '500 20px/1.3 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Where does this project's code live?</h2>
          {project.directoryMissing && <p style={{ margin: 0, font: '13px/1.6 var(--font-mono)', color: '#e70022', overflowWrap: 'anywhere' }}>{project.directoryMissing} is no longer there.</p>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button type="button" onClick={choose} disabled={busy} autoFocus style={{ minHeight: 40, padding: '10px 18px', border: 0, borderRadius: 8, background: '#0070f3', color: '#fff', cursor: busy ? 'default' : 'pointer', font: '500 13px/1 var(--font-sans)', opacity: busy ? 0.6 : 1 }}>{busy ? 'Choosing…' : 'Choose folder…'}</button>
          <button type="button" className="hov-ink" onClick={onHome} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#8f8f8f' }}>All projects</button>
        </div>
        {error && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
      </div>
    </div>
  );
}


export default function App() {
  const [config, setConfig] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [projects, setProjects] = React.useState([]);
  const [trashed, setTrashed] = React.useState([]); // projects in the trash (Home's Recently deleted), newest first
  const [library, setLibrary] = React.useState([]);
  const [tree, setTree] = React.useState(null);
  const [entry, setEntry] = React.useState(null); // { workspaceId, tab, views } for the project being opened
  const [phase, setPhase] = React.useState('boot'); // boot | create | home | workspace
  const [run, setRun] = React.useState(0); // a reset starts onboarding over from its first screen
  const [, setTick] = React.useState(0);
  // Git, Claude Code and Codex (src/main/tools): the last snapshot, and the setup dialog when it is open.
  const [tools, setTools] = React.useState(null);
  const [setup, setSetup] = React.useState(null); // { mode: 'launch' | 'all', ids }
  const [launchAsk, setLaunchAsk] = React.useState(null); // what the launch check asks about, until the dialog can open
  const askedAtLaunch = React.useRef(false);
  const lastTools = React.useRef(null);
  // Connect your library (2026-10-07): its popup ({ sessionId } from the chip, { projectId } the one-time offer).
  const [connectPopup, setConnectPopup] = React.useState(null);
  // Import your context over the workspace (2026-10-13: the redo of onboarding, "a popup modal in front of the workspace"):
  // { projectId, workspaceId } the imports go to. And its run's status, open for a session id (ImportStatus).
  const [importModal, setImportModal] = React.useState(null);
  const [importStatus, setImportStatus] = React.useState(null);
  // The import's "Open library": { n, workspaceId, tab } for the workspace to show and its sidebar tour to start.
  const [tourRequest, setTourRequest] = React.useState(null);
  // The guided setup (ui/GuidedSetup.jsx): a new user's onboarding run for someone with projects, while `guided` (false;
  // true, started from all projects; or { projectId, workspaceId }, the workspace it was started in); its one-time offer
  // over the workspace while `guidedOffer`.
  const [guided, setGuided] = React.useState(false);
  const visited = React.useRef(null); // { projectId, workspaceId }: the workspace on screen now (onVisit)
  const [guidedOffer, setGuidedOffer] = React.useState(false);

  const fail = (candidate) => setError(errorMessage(candidate));

  // The trash is read first: reading it purges the projects in it a week, and their library rows with them.
  const trashedNow = React.useRef([]);
  const loadHome = React.useCallback(async () => {
    const gone = await api.trashedProjects().catch(() => []);
    const [list, rows] = await Promise.all([api.listProjects(), api.library()]);
    trashedNow.current = gone;
    setTrashed(gone);
    setProjects(list);
    setLibrary(rows);
    return list;
  }, []);

  // The notes and images of a project in the trash are in the trash with it: no screen lists them until it is restored.
  const shownLibrary = React.useMemo(() => {
    const gone = new Set(trashed.map((project) => project.id));
    return gone.size ? library.filter((row) => !gone.has(row.project_id)) : library;
  }, [library, trashed]);

  // Rows the main process changed on its own (a pdf saved as a link became a saved pdf): the library is read again.
  React.useEffect(() => api.onLibraryChanged(() => { api.library().then(setLibrary).catch(() => {}); }), []);

  // The launch check's first answer opens the setup dialog once, and only when something needs you; Engelbart ▸
  // Set Up Tools… opens it with all three tools at any time. An agent installed while the app is open (Claude Code, in
  // the background, on a Mac that had neither) asks for its sign-in once the install is over, whatever was answered before.
  React.useEffect(() => {
    const take = (snapshot) => {
      if (!snapshot || !snapshot.tools) return;
      setTools(snapshot);
      const before = lastTools.current;
      lastTools.current = snapshot;
      if (askedAtLaunch.current && installedSignedOut(before, snapshot).length) setLaunchAsk((current) => current || 'after');
      if (askedAtLaunch.current || !snapshot.checked) return;
      askedAtLaunch.current = true;
      const ids = launchRows(snapshot);
      if (ids.length) setLaunchAsk(ids);
    };
    const offTools = api.onTools(take);
    const offOpen = api.onToolsOpen(() => setSetup({ mode: 'all', ids: TOOL_ORDER }));
    api.tools().then(take).catch(() => {});
    return () => { offTools(); offOpen(); };
  }, []);

  // A new install's onboarding asks on a screen of its own (2026-09-28), so the dialog waits until it is over. Its
  // Install all leaves 'after': once the installs end, the dialog asks only what is left (signing in, a failure). Its
  // Skip for now asks nothing more until the next launch.
  const onboardingNew = phase === 'boot' || (phase === 'create' && (!projects.length || guided));
  React.useEffect(() => {
    if (!launchAsk || onboardingNew || !tools) return;
    if (launchAsk === 'after') {
      if (TOOL_ORDER.some((id) => tools.tools[id] && tools.tools[id].busy)) return;
      const ids = launchRows(tools);
      if (ids.length) setSetup((current) => current || { mode: 'launch', ids });
    } else {
      setSetup((current) => current || { mode: 'launch', ids: launchAsk });
    }
    setLaunchAsk(null);
  }, [launchAsk, onboardingNew, tools]);
  const onboardingTools = React.useCallback((choice) => {
    askedAtLaunch.current = true;
    setLaunchAsk(choice === 'install' ? 'after' : null);
  }, []);

  const reload = React.useCallback(async () => {
    if (!tree) return null;
    try {
      const [next, rows] = await Promise.all([api.loadProject(tree.project.id), api.library()]);
      setTree(next);
      setLibrary(rows);
      return next;
    } catch (candidate) {
      fail(candidate);
      return null;
    }
  }, [tree]);

  // Open a project straight into a workspace: the remembered one, else the first. Each of its workspaces reopens with
  // the tabs, the document and the scroll position it was left with (state.json `views`).
  const openProject = React.useCallback(async (id, prefer) => {
    let [next, rows, views] = await Promise.all([api.loadProject(id), api.library(), api.views(id).catch(() => ({}))]);
    if (!next.workspaces.length) {
      await api.createWorkspace(id, { name: 'Getting started' });
      next = await api.loadProject(id);
    }
    setTree(next);
    setLibrary(rows);
    // A note opened from the library lands in the workspace it was made in.
    const made = prefer && prefer.tab && !prefer.workspaceId ? next.notes.find((note) => note.id === prefer.tab.id) : null;
    setEntry({ workspaceId: (prefer && prefer.workspaceId) || (made && made.workspaceId) || next.workspaces[0].id, tab: (prefer && prefer.tab) || null, stage: (prefer && prefer.stage) || null, views });
    setPhase('workspace');
    setError('');
  }, []);

  // Startup (and after the data root changes): the last project you were in, or the create screen. A window's first start
  // goes where main says this window belongs, when it says (the projects screen, or a workspace).
  const firstStart = React.useRef(true);
  const start = React.useCallback(async () => {
    setGuided(false);
    const list = await loadHome();
    const first = firstStart.current;
    firstStart.current = false;
    // Every project deleted: all projects, where Recently deleted can bring one back, not a new install's onboarding.
    if (!list.length) { setPhase(trashedNow.current.length ? 'home' : 'create'); return; }
    const target = first ? await api.windowTarget().catch(() => null) : null;
    if (target && target.home) { setPhase('home'); return; }
    const last = target && target.projectId ? target : await api.lastOpen().catch(() => null);
    const id = last && list.some((project) => project.id === last.projectId) ? last.projectId : list[0].id;
    await openProject(id, last && last.projectId === id ? last : null);
  }, [loadHome, openProject]);

  React.useEffect(() => {
    (async () => {
      try {
        const initial = await api.config();
        setConfig(initial);
        await start();
      } catch (candidate) {
        fail(candidate);
        setPhase((current) => (current === 'boot' ? 'home' : current));
      }
    })();
  }, [start]);

  React.useEffect(() => {
    const onResize = () => setTick((value) => value + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function leaveProject() {
    setTree(null);
    setEntry(null);
  }

  // Where this window is, for main to reopen it there (a workspace reports itself through onVisit; onboarding, which ends
  // in a project, is not a place) and for its title, which names it in the Window menu.
  const projectName = tree ? tree.project.name : '';
  React.useEffect(() => {
    if (phase === 'home') api.reportPlace({ projectId: null, workspaceId: null });
    document.title = phase === 'workspace' && projectName ? `${projectName} — Engelbart` : 'Engelbart';
  }, [phase, projectName]);

  // Connect your library's sessions in this data root (each library its own, 2026-10-08), for the chip and the Inbox.
  const connectSessions = useConnectSessions(!!config, config ? config.dataRoot : '');
  // An Import your context run's step for the person (a sign-in, a permission) is a popup of its own, over whatever is
  // showing (round 3, 2026-10-13: "the permission prompts … should be popups instead of like little pills in the popup"),
  // one at a time, the oldest first. Later puts one away (`laterNeeds`); the status modal's "Needs you" brings it back.
  const [needShown, setNeedShown] = React.useState(null); // { sessionId, needId } opened from the status modal
  const laterNeeds = React.useRef(new Set());
  const [, setNeedTick] = React.useState(0);
  const pendingNeed = (() => {
    if (importModal || phase !== 'workspace') return null;
    for (const session of connectSessions) {
      if (!session.direct) continue;
      for (const need of session.needs || []) {
        const asked = needShown && needShown.sessionId === session.id && needShown.needId === need.id;
        if (asked || !laterNeeds.current.has(need.id)) return { session, need };
      }
    }
    return null;
  })();
  const needLater = (need) => { laterNeeds.current.add(need.id); setNeedShown(null); setNeedTick((n) => n + 1); };
  // Everything ended: the run's completion ("Your imports are complete!") opens by itself, once, in place of the header
  // pill (round 3: "instead of having the pill in the header once it is done a popup should just come").
  const completedShown = React.useRef(new Set());
  React.useEffect(() => {
    if (phase !== 'workspace' || importModal) return;
    for (const session of connectSessions) {
      if (!session.direct || completedShown.current.has(session.id)) continue;
      const work = (session.jobs || []).filter((job) => job.kind === 'import' || job.kind === 'recall' || job.kind === 'survey');
      const ended = work.length > 0 && work.every((job) => job.status === 'done' || job.status === 'failed' || job.status === 'stopped') && !(session.needs || []).length;
      if (!ended || session.dismissed) continue;
      completedShown.current.add(session.id);
      setImportStatus(session.id);
    }
  }, [connectSessions, importModal, phase]);
  const openSession = (id) => {
    const session = connectSessions.find((entry) => entry.id === id);
    if (session && session.direct) setImportStatus(id); else setConnectPopup({ sessionId: id });
  };
  const statusSession = importStatus ? connectSessions.find((entry) => entry.id === importStatus) : null;
  // One popup at a time (2026-10-14, Hudson: "There were two popups, there should only be one … Simplify this."). A step
  // that needs the person comes first; the status waits behind it (it shows again once that popup is answered or put
  // away); the guided setup's offer and the tools' setup wait behind both. The sidebar tour pauses under any of them.
  const needUp = !!pendingNeed;
  const statusUp = !!(statusSession && !importModal && phase === 'workspace' && !needUp);
  const closeStatus = () => setImportStatus(null);
  const needOpen = async (session, need) => {
    try {
      if (need.app === 'Zotero' || need.app === 'GitHub') { if (await engelbartSignIn(need.app)) await api.connectNeed(session.id, need.id, 'done'); return; }
      await api.connectNeed(session.id, need.id, 'open');
    } catch (failure) { fail(failure); }
  };
  // The status modal's "Needs you": that step's popup again, over the modal.
  const needAgain = (session, need) => { laterNeeds.current.delete(need.id); setNeedShown({ sessionId: session.id, needId: need.id }); };

  // The guided setup offered once to someone who has projects, over the workspace they are in (2026-10-10: it took the
  // place of Connect your library's one-time popup; Connect is the setup's second screen). Seen once it has been shown.
  const openProjectId = phase === 'workspace' && tree ? tree.project.id : null;
  React.useEffect(() => {
    if (!openProjectId) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      api.guidedOffer().then((offer) => {
        if (!alive || !offer || !offer.show) return;
        setGuidedOffer(true);
        api.guidedOfferSeen('shown').catch(() => {});
      }).catch(() => {});
    }, 1200); // after the workspace has drawn itself
    return () => { alive = false; clearTimeout(timer); };
  }, [openProjectId]);
  // Start (the offer's, or Settings ▸ Guided setup's): onboarding from its first screen, as a new user has it. Inside a
  // project (2026-10-10, "guided setup shouldn't create a new project") it remembers the workspace it left: its screens
  // have no Create, and it ends in a Welcome workspace added there. Started again during the setup, it keeps where it was from.
  const startGuided = React.useCallback(() => {
    const now = latest.current;
    const here = now.phase === 'workspace' && now.tree ? now.tree.project.id : null;
    const from = here
      ? { projectId: here, workspaceId: visited.current && visited.current.projectId === here ? visited.current.workspaceId : (now.entry && now.entry.workspaceId) || null }
      : (now.phase === 'create' && now.guided && now.guided.projectId ? now.guided : null);
    setGuidedOffer(false);
    setConnectPopup(null);
    // In a workspace: Import your context opens over it, the imports going to its project; nothing is left.
    if (here) { setImportModal({ projectId: here, workspaceId: from.workspaceId || null }); return; }
    setTree(null);
    setEntry(null);
    setGuided(from || true);
    setRun((n) => n + 1);
    setPhase('create');
  }, []);
  React.useEffect(() => {
    window.addEventListener(START_GUIDED_SETUP, startGuided);
    return () => window.removeEventListener(START_GUIDED_SETUP, startGuided);
  }, [startGuided]);
  // Back from the relaunch Full Disk Access needs (round 3): Import your context had been opened over this project, with
  // its run pending, so it opens again on its step and starts the imports (ImportFlow's restore).
  const resumedImport = React.useRef(false);
  React.useEffect(() => {
    if (!openProjectId || resumedImport.current || importModal) return;
    resumedImport.current = true;
    api.importFlow().then((flow) => {
      if (flow && flow.pendingRun && flow.into === openProjectId) setImportModal({ projectId: openProjectId, workspaceId: null });
    }).catch(() => {});
  }, [openProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another window saved something here: this project's tree (a workspace or note made, renamed, linked; a document
  // cleared) is read again, or, on the projects screen, the projects. A project another window deleted is left for the
  // projects screen. Another window switched the data root (test mode): this one starts over on it, as the window that
  // switched it does.
  const latest = React.useRef({});
  latest.current = { phase, tree, entry, guided, reload, loadHome, start };
  React.useEffect(() => {
    let timer = null;
    const offProject = api.onProjectChanged(({ projectId, trashed: gone } = {}) => {
      const now = latest.current;
      if (gone && now.phase === 'workspace' && now.tree && now.tree.project.id === projectId) {
        setTree(null);
        setEntry(null);
        setPhase('home');
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const held = latest.current;
        if (held.phase === 'home') held.loadHome().catch(() => {});
        else if (held.phase === 'workspace' && held.tree && held.tree.project.id === projectId) held.reload();
      }, 150);
    });
    const offRoot = api.onDataRootChanged(({ config: next, fresh } = {}) => {
      if (!next) return;
      setConfig(next);
      setTree(null);
      setEntry(null);
      if (fresh) setRun((n) => n + 1);
      latest.current.start().catch((candidate) => setError(errorMessage(candidate)));
    });
    return () => { clearTimeout(timer); offProject(); offRoot(); };
  }, []);

  async function toggleTest() {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.setTestMode(!config.testMode);
      setConfig(next);
      leaveProject();
      await start();
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
  }

  // fresh: "Start as a new user…" — no sample library, no remembered sidebar folds or hidden post-its, onboarding from
  // its first screen.
  async function resetTest(fresh = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.resetTestData({ fresh });
      if (result.reset) {
        if (fresh) {
          try { Object.keys(localStorage).filter((key) => key.startsWith('engelbart.')).forEach((key) => localStorage.removeItem(key)); } catch { /* storage unavailable */ }
        }
        setConfig(result);
        leaveProject();
        setRun((n) => n + 1);
        await start();
      }
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
  }

  // Onboarding made the project (api.startProject): land in its Getting started workspace with the Welcome! note open, and
  // the sites its sign-in import said to sign in to again on the Stage. A new user's (made.gettingStarted, 2026-10-09)
  // lands on its Welcome workspace's own document instead, under the walkthrough; the note is in its sidebar. The guided
  // setup started inside a project (api.welcomeWorkspace) lands the same way on the Welcome workspace it added there.
  async function onboarded(made, { stageLinks = [], session = null } = {}) {
    setError('');
    setGuided(false);
    await loadHome();
    await openProject(made.project.id, { workspaceId: made.workspaceId, tab: made.gettingStarted ? null : { id: made.noteId, title: made.noteName }, stage: stageLinks.length ? { links: stageLinks } : null });
    // Import your context's run: its status is not opened over the project on landing (2026-10-14, Hudson: "There were
    // two popups, there should only be one"). A step that needs the person comes up as its own popup; the progress is
    // the "Importing i/n" words in the title bar, which open the status.
    void session;
  }

  async function goHome() {
    leaveProject();
    setPhase('home');
    try {
      await loadHome();
    } catch (candidate) {
      fail(candidate);
    }
  }

  // "Open library" on the import's completion (2026-10-14, Hudson: "the button that says open library should just take
  // them to the welcome note on their page and should basically highlight the sources part of the sidebar"): the project
  // the run went to (its snapshot's projectId; else the one open), on its Welcome workspace's page (the session's
  // workspace when main says which, else the newest workspace called Welcome, else the one open), then the three-card
  // sidebar tour, once (SidebarTour.jsx).
  async function openLibrary(session) {
    const id = session.id;
    setImportStatus(null);
    api.connectDismiss(id).catch(() => {});
    const now = latest.current;
    const projectId = session.projectId || (now.tree && now.tree.project.id) || null;
    if (!projectId) { void goHome(); return; }
    try {
      const here = now.phase === 'workspace' && now.tree && now.tree.project.id === projectId;
      const target = here ? now.tree : await api.loadProject(projectId);
      const place = welcomePlace(target, { given: session.workspaceId || null, current: here && visited.current && visited.current.projectId === projectId ? visited.current.workspaceId : null });
      if (!here) await openProject(projectId, place.workspaceId ? { workspaceId: place.workspaceId, tab: place.tab } : null);
      setTourRequest({ n: Date.now(), workspaceId: place.workspaceId, tab: place.tab });
    } catch (candidate) {
      fail(candidate);
    }
  }

  // Delete on a project card (Home asks first): into the trash for a week. Restore brings it back. The project open
  // here is left first, so nothing of it writes while it moves.
  async function deleteProject(id) {
    setError('');
    try {
      if (tree && tree.project.id === id) { leaveProject(); setPhase('home'); }
      await api.trashProject(id);
    } catch (candidate) {
      fail(candidate);
    }
    try { await loadHome(); } catch (candidate) { fail(candidate); }
  }

  async function restoreProject(id) {
    setError('');
    try {
      await api.restoreProject(id);
    } catch (candidate) {
      fail(candidate);
    }
    try { await loadHome(); } catch (candidate) { fail(candidate); }
  }

  const onVisit = React.useCallback((workspaceId) => {
    if (!tree) return;
    visited.current = { projectId: tree.project.id, workspaceId };
    api.setLastOpen({ projectId: tree.project.id, workspaceId }).catch(() => {});
    api.reportPlace({ projectId: tree.project.id, workspaceId });
  }, [tree]);

  async function chooseDirectory(directory) {
    if (!tree) return;
    setError('');
    try {
      await api.setProjectDirectory(tree.project.id, directory);
      await reload();
    } catch (candidate) {
      fail(candidate);
    }
  }

  if (!config || phase === 'boot') return <div style={{ position: 'absolute', inset: 0, background: '#fff' }} />;
  const returning = projects.length > 0 || trashed.length > 0; // someone whose projects are all in the trash is not new
  // The guided setup is a new user's onboarding; started inside a project, without Create ('guided', model/onboarding.js).
  const guidedFrom = guided && guided.projectId ? guided : null;
  const onboardMode = guidedFrom ? 'guided' : guided || !returning ? 'new' : 'existing';
  // "Engelbart" in onboarding's top left: back to the workspace the guided setup was started in, else all projects.
  const leaveOnboarding = () => {
    setGuided(false);
    if (guidedFrom) openProject(guidedFrom.projectId, guidedFrom.workspaceId ? { workspaceId: guidedFrom.workspaceId } : null).catch(() => goHome());
    else goHome();
  };

  const offerUp = guidedOffer && phase === 'workspace' && !needUp && !statusUp && !importModal && !connectPopup;
  const setupUp = !!(setup && tools && !needUp && !statusUp);
  const popupUp = needUp || statusUp || offerUp || setupUp || !!importModal || !!connectPopup;

  return (
    <SandboxProgress key={config.dataRoot} dataRoot={config.dataRoot} library={library} inWorkspace={phase === 'workspace' && !!tree}>
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      {phase === 'home' && (
        <Home
          projects={projects}
          trashed={trashed}
          library={shownLibrary}
          error={error}
          onCreateScreen={() => { setGuided(false); setPhase('create'); }}
          onOpenWorkspace={(id, workspaceId, stage) => openProject(id, workspaceId || stage ? { workspaceId, stage } : null).catch(fail)}
          // a library row no project holds opens on the Stage of the project last open (else the first)
          onOpenOnStage={async (row) => {
            try {
              const last = await api.lastOpen().catch(() => null);
              const known = last && projects.some((project) => project.id === last.projectId);
              const id = known ? last.projectId : projects[0] && projects[0].id;
              if (id) await openProject(id, { workspaceId: known ? last.workspaceId : null, stage: row });
            } catch (candidate) { fail(candidate); }
          }}
          onOpenNote={(row) => openProject(row.project_id, { tab: { id: row.id, title: row.name } }).catch(fail)}
          onLibraryChanged={() => loadHome().catch(fail)}
          onRename={async (id, name) => { try { await api.renameProject(id, name); await loadHome(); } catch (candidate) { fail(candidate); } }}
          onDelete={deleteProject}
          onRestore={restoreProject}
        />
      )}
      {phase === 'create' && (
        <Onboarding key={run} mode={onboardMode} into={guidedFrom ? guidedFrom.projectId : null} tools={tools} onTools={onboardingTools} onDone={onboarded} onBack={returning ? leaveOnboarding : null} backTitle={guidedFrom ? 'Back to your project' : 'All projects'} />
      )}
      {phase === 'workspace' && tree && (
        <Workspace
          key={tree.project.id}
          tree={tree}
          library={shownLibrary}
          initialWorkspaceId={entry ? entry.workspaceId : null}
          initialTab={entry ? entry.tab : null}
          initialStage={entry ? entry.stage : null}
          initialViews={entry ? entry.views : null}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff', ...(tree.project.directory ? {} : { filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' }) }}
          active={!!tree.project.directory}
          reload={reload}
          onClose={goHome}
          onHome={goHome}
          // the sidebar's project menu (2026-10-07): another project, opened where it was left; or a new one, made as
          // + Project makes it
          onOpenProject={(id, workspaceId) => openProject(id, workspaceId ? { workspaceId } : null).catch(fail)}
          onNewProject={() => { leaveProject(); setGuided(false); setPhase('create'); }}
          onVisit={onVisit}
          onError={fail}
          // Connect your library's sessions, for the sidebar's Inbox: one that needs you or has finished, opened in its popup
          connectSessions={connectSessions}
          onOpenConnect={openSession}
          // the import's "Open library": its Welcome page, then the sidebar tour (workspace/SidebarTour.jsx), paused
          // under any popup
          tourRequest={tourRequest}
          tourPaused={popupUp}
        />
      )}
      {phase === 'workspace' && tree && !tree.project.directory && (
        <DirectoryGate project={tree.project} onChosen={chooseDirectory} onHome={goHome} error={error} />
      )}
      {error && phase !== 'home' && phase !== 'create' && !(tree && !tree.project.directory) && (
        <div data-overlay="1" style={{ position: 'fixed', left: 24, bottom: 18, zIndex: 150, padding: '7px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', font: '12.5px/1.5 var(--font-sans)', color: '#e70022', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', color: '#c9c9c9', font: '14px/1 var(--font-sans)' }}>×</button>
        </div>
      )}
      {/* a new version downloading, or ready to restart into (src/main/updates.cjs), on every screen */}
      <UpdateBanner />
      {setupUp && <ToolSetup snapshot={tools} ids={setup.ids} mode={setup.mode} onClose={() => setSetup(null)} />}
      <WindowEdges />
      {/* test mode, its pill and Settings' Test data section, only in a developer's copy (src/main/developer.cjs): the app
          people download has no test mode */}
      <WindowControls test={config.testModeAvailable ? {
        testMode: config.testMode,
        onReset: () => resetTest(false),
        onStartNew: () => resetTest(true),
        onReveal: () => api.reveal(config.testRoot).catch(fail),
      } : null}>
        <ConnectChip sessions={connectSessions} onOpen={openSession} />
        {config.testModeAvailable && <TestToggle testMode={config.testMode} busy={busy} onToggle={toggleTest} />}
      </WindowControls>
      {offerUp && (
        <GuidedSetupOffer onStart={() => { api.guidedOfferSeen('started').catch(() => {}); startGuided(); }} onDismiss={() => { setGuidedOffer(false); api.guidedOfferSeen('dismissed').catch(() => {}); }} />
      )}
      {importModal && phase === 'workspace' && (
        <div data-overlay="1" data-cover="1" data-import-modal="1" style={{ position: 'fixed', inset: 0, zIndex: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
          {/* transform: the flow's fixed parts (its foot, its dialogs) are held inside this panel, not the window */}
          <div role="dialog" aria-modal="true" aria-label="Import your context" style={{ position: 'relative', width: 'min(1000px, 100%)', height: 'min(800px, 100%)', overflow: 'auto', background: '#fff', borderRadius: 14, boxShadow: '0 20px 60px #00000026', transform: 'translateZ(0)' }}>
            <ImportFlow api={importApi} mode="modal" into={importModal.projectId} workspaceId={importModal.workspaceId} platform={/Mac/i.test(navigator.platform || '') ? 'darwin' : 'other'}
              // the flow over the workspace ended: as on landing, the status is not opened by itself (the title bar's words open it)
              onClose={() => setImportModal(null)} />
          </div>
        </div>
      )}
      {/* in the workspace only: during onboarding the run starts before its project opens, and the modal would cover the flow */}
      {statusUp && (
        <ImportStatus session={statusSession} onClose={closeStatus}
          onNeed={(need) => needAgain(statusSession, need)}
          onNeedDone={(need) => api.connectNeed(statusSession.id, need.id, 'done').catch(fail)}
          onSkip={(need) => api.connectNeed(statusSession.id, need.id, 'skip').catch(fail)}
          onStop={() => api.connectStop(statusSession.id).catch(fail)}
          onDone={() => { void openLibrary(statusSession); }} />
      )}
      {pendingNeed && (
        <NeedPopup key={pendingNeed.need.id} need={pendingNeed.need}
          onOpen={() => needOpen(pendingNeed.session, pendingNeed.need)}
          onDone={() => api.connectNeed(pendingNeed.session.id, pendingNeed.need.id, 'done').catch(fail)}
          onSkip={() => { api.connectNeed(pendingNeed.session.id, pendingNeed.need.id, 'skip').catch(fail); setNeedShown(null); }}
          // Later puts the step away for good (2026-10-14: "clicking later should dismiss the needs you, too"): skipped for
          // this run, so no "Needs you" is left in the title bar or the status.
          onLater={() => { const { session, need } = pendingNeed; needLater(need); api.connectNeed(session.id, need.id, 'skip').catch(fail); }} />
      )}
      {connectPopup && <ConnectPopup key={connectPopup.sessionId || connectPopup.projectId} request={connectPopup} onClose={() => setConnectPopup(null)} />}
    </div>
    </SandboxProgress>
  );
}
