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
import { launchRows, installedSignedOut, TOOL_ORDER } from './model/tools.js';

// Screens: the app opens straight into the workspace you were last in, and the first run (no projects yet) is
// onboarding (screens/Onboarding.jsx, 2026-09-28); + Project runs its last two screens. Onboarding ends in the project
// it made (the welcome tour that followed it was taken out on 2026-10-01). "Engelbart" in the header (or Escape) shows
// all projects. A project whose project.json has no code directory yet is held
// behind a modal until one is chosen (2026-09-18).
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
  // Connect your library (test mode, 2026-10-07): its popup ({ sessionId } from the chip, { projectId } the one-time offer).
  const [connectPopup, setConnectPopup] = React.useState(null);

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
  const onboardingNew = phase === 'boot' || (phase === 'create' && !projects.length);
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

  // Connect your library for someone who has projects: offered once, as a popup over the workspace they are in (test mode).
  const connectOn = !!(config && config.testMode);
  const connectSessions = useConnectSessions(connectOn, config ? config.dataRoot : '');
  const openProjectId = phase === 'workspace' && tree ? tree.project.id : null;
  React.useEffect(() => {
    if (!connectOn || !openProjectId) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      api.connectOffer().then((offer) => {
        if (!alive || !offer || !offer.show) return;
        setConnectPopup((now) => now || { projectId: openProjectId });
        api.connectOfferSeen('shown').catch(() => {});
      }).catch(() => {});
    }, 1200); // after the workspace has drawn itself
    return () => { alive = false; clearTimeout(timer); };
  }, [connectOn, openProjectId]);

  // Another window saved something here: this project's tree (a workspace or note made, renamed, linked; a document
  // cleared) is read again, or, on the projects screen, the projects. A project another window deleted is left for the
  // projects screen. Another window switched the data root (test mode): this one starts over on it, as the window that
  // switched it does.
  const latest = React.useRef({});
  latest.current = { phase, tree, reload, loadHome, start };
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
  // the sites its sign-in import said to sign in to again on the Stage.
  async function onboarded(made, { stageLinks = [] } = {}) {
    setError('');
    await loadHome();
    await openProject(made.project.id, { workspaceId: made.workspaceId, tab: { id: made.noteId, title: made.noteName }, stage: stageLinks.length ? { links: stageLinks } : null });
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
  const onboardMode = returning ? 'existing' : 'new';

  return (
    <SandboxProgress key={config.dataRoot} dataRoot={config.dataRoot} library={library} inWorkspace={phase === 'workspace' && !!tree}>
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      {phase === 'home' && (
        <Home
          projects={projects}
          trashed={trashed}
          library={shownLibrary}
          error={error}
          onCreateScreen={() => setPhase('create')}
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
        <Onboarding key={run} mode={onboardMode} tools={tools} onTools={onboardingTools} onDone={onboarded} onBack={returning ? goHome : null} connect={!!config.testMode} />
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
          onNewProject={() => { leaveProject(); setPhase('create'); }}
          onVisit={onVisit}
          onError={fail}
          // Connect your library's sessions, for the sidebar's Inbox: one that needs you or has finished, opened in its popup
          connectSessions={connectOn ? connectSessions : []}
          onOpenConnect={(id) => setConnectPopup({ sessionId: id })}
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
      {setup && tools && <ToolSetup snapshot={tools} ids={setup.ids} mode={setup.mode} onClose={() => setSetup(null)} />}
      <WindowEdges />
      {/* test mode, its pill and Settings' Test data section, only in a developer's copy (src/main/developer.cjs): the app
          people download has no test mode */}
      <WindowControls test={config.testModeAvailable ? {
        testMode: config.testMode,
        onReset: () => resetTest(false),
        onStartNew: () => resetTest(true),
        onReveal: () => api.reveal(config.testRoot).catch(fail),
      } : null}>
        {connectOn && <ConnectChip sessions={connectSessions} onOpen={(id) => setConnectPopup({ sessionId: id })} />}
        {config.testModeAvailable && <TestToggle testMode={config.testMode} busy={busy} onToggle={toggleTest} />}
      </WindowControls>
      {connectOn && connectPopup && <ConnectPopup key={connectPopup.sessionId || connectPopup.projectId} request={connectPopup} onClose={() => setConnectPopup(null)} />}
    </div>
    </SandboxProgress>
  );
}
