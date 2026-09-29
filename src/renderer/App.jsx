import React from 'react';
import { api, errorMessage } from './api.js';
import { loadSessionUI, sessionValue, saveSessionValue, flushCanvasView } from './session-ui.js';
import WindowControls from './ui/WindowControls.jsx';
import Home from './screens/Home.jsx';
import CreateProject from './screens/CreateProject.jsx';
import Workspace from './screens/Workspace.jsx';
import SandboxProgress from './ui/SandboxProgress.jsx';
import WindowEdges from './ui/WindowEdges.jsx';
import ToolSetup from './ui/ToolSetup.jsx';
import { launchRows, TOOL_ORDER } from './model/tools.js';

// Screens: the app opens straight into the workspace you were last in — "Getting started" in a
// fresh project — and the first run shows the create screen. "Engelbart" in the header (or
// Escape) shows all projects. Workspaces inherit the project code target unless
// overridden; unavailable connections are explained in the repository selectors.

export default function App() {
  const [config, setConfig] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [projects, setProjects] = React.useState([]);
  const [library, setLibrary] = React.useState([]);
  const [tree, setTree] = React.useState(null);
  const [entry, setEntry] = React.useState(null); // { workspaceId, tab, views } for the project being opened
  const [phase, setPhase] = React.useState('boot'); // boot | create | home | workspace
  React.useEffect(() => { if (phase === 'home' || phase === 'workspace') saveSessionValue('app:screen', phase); }, [phase]);
  const [, setTick] = React.useState(0);
  // Git, Claude Code and Codex (src/main/tools): the last snapshot, and the setup dialog when it is open.
  const [tools, setTools] = React.useState(null);
  const [setup, setSetup] = React.useState(null); // { mode: 'launch' | 'all', ids }
  const askedAtLaunch = React.useRef(false);

  const fail = (candidate) => setError(errorMessage(candidate));

  const loadHome = React.useCallback(async () => {
    const [list, rows] = await Promise.all([api.listProjects(), api.library()]);
    setProjects(list);
    setLibrary(rows);
    return list;
  }, []);

  // Rows the main process changed on its own (a pdf saved as a link became a saved pdf): the library is read again.
  React.useEffect(() => api.onLibraryChanged(() => { api.library().then(setLibrary).catch(() => {}); }), []);

  // The launch check's first answer opens the setup dialog once, and only when something needs you; Engelbart ▸
  // Set Up Tools… opens it with all three tools at any time.
  React.useEffect(() => {
    const take = (snapshot) => {
      if (!snapshot || !snapshot.tools) return;
      setTools(snapshot);
      if (askedAtLaunch.current || !snapshot.checked) return;
      askedAtLaunch.current = true;
      const ids = launchRows(snapshot);
      if (ids.length) setSetup((current) => current || { mode: 'launch', ids });
    };
    const offTools = api.onTools(take);
    const offOpen = api.onToolsOpen(() => setSetup({ mode: 'all', ids: TOOL_ORDER }));
    api.tools().then(take).catch(() => {});
    return () => { offTools(); offOpen(); };
  }, []);

  const reload = React.useCallback(async () => {
    if (!tree) return null;
    try {
      const next = await api.loadProject(tree.project.id);
      const rows = await api.library(); // project migrations may refresh repository labels
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
    const next = await api.loadProject(id);
    const [rows, views] = await Promise.all([api.library(), api.views(id).catch(() => ({}))]);
    setTree(next);
    setLibrary(rows);
    // A note opened from the library lands in the workspace it was made in.
    const made = prefer && prefer.tab && !prefer.workspaceId ? next.notes.find((note) => note.id === prefer.tab.id) : null;
    setEntry({ workspaceId: (prefer && prefer.workspaceId) || (made && made.workspaceId) || next.workspaces[0]?.id || null, tab: (prefer && prefer.tab) || null, stage: (prefer && prefer.stage) || null, views });
    setPhase('workspace');
    setError('');
  }, []);

  // Startup: the last project you were in, or the create screen.
  const start = React.useCallback(async () => {
    const list = await loadHome();
    if (!list.length) { setPhase('create'); return; }
    if (sessionValue('app:screen', 'workspace') === 'home') { setPhase('home'); return; }
    const last = await api.lastOpen().catch(() => null);
    const id = last && list.some((project) => project.id === last.projectId) ? last.projectId : list[0].id;
    await openProject(id, last && last.projectId === id ? last : null);
  }, [loadHome, openProject]);

  React.useEffect(() => {
    const off = api.onPrepareQuit(async ({ id }) => {
      try { await flushCanvasView(); await api.viewFlushed(id); }
      catch (error) { await api.viewFlushed(id, errorMessage(error)); }
    });
    (async () => {
      try {
        await loadSessionUI();
        const initial = await api.config();
        setConfig(initial);
        await start();
        await api.viewReady();
      } catch (candidate) {
        fail(candidate);
        setPhase((current) => (current === 'boot' ? 'home' : current));
      }
    })();
    return off;
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

  // First run and + Project: create, then land in the workspace with the Welcome! note open.
  async function createProject(input) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const made = await api.createProjectWithWelcome(input);
      await openProject(made.project.id, { workspaceId: made.workspaceId, tab: { id: made.noteId, title: made.noteName } });
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
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

  const onVisit = React.useCallback((workspaceId) => {
    if (tree) api.setLastOpen({ projectId: tree.project.id, workspaceId }).catch(() => {});
  }, [tree]);

  if (!config || phase === 'boot') return <div style={{ position: 'absolute', inset: 0, background: '#fff' }} />;

  return (
    <SandboxProgress key={config.dataRoot} dataRoot={config.dataRoot} library={library} inWorkspace={phase === 'workspace' && !!tree}>
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      {phase === 'home' && (
        <Home
          projects={projects}
          library={library}
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
        />
      )}
      {phase === 'create' && (
        <CreateProject onCreate={createProject} onBack={projects.length ? goHome : null} busy={busy} error={error} />
      )}
      {phase === 'workspace' && tree && (
        <Workspace
          key={tree.project.id}
          tree={tree}
          library={library}
          initialWorkspaceId={entry ? entry.workspaceId : null}
          initialTab={entry ? entry.tab : null}
          initialStage={entry ? entry.stage : null}
          initialViews={entry ? entry.views : null}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}
          active
          reload={reload}
          onClose={goHome}
          onHome={goHome}
          onVisit={onVisit}
          onOpenElsewhere={(projectId, workspaceId) => openProject(projectId, { workspaceId }).catch(fail)}
          onError={fail}
        />
      )}
      {error && phase !== 'home' && phase !== 'create' && (
        <div data-overlay="1" style={{ position: 'fixed', left: 24, bottom: 18, zIndex: 150, padding: '7px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', font: '12.5px/1.5 var(--font-sans)', color: '#e70022', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', color: '#c9c9c9', font: '14px/1 var(--font-sans)' }}>×</button>
        </div>
      )}
      <WindowControls />
      {setup && tools && <ToolSetup snapshot={tools} ids={setup.ids} mode={setup.mode} onClose={() => setSetup(null)} />}
      <WindowEdges />
    </div>
    </SandboxProgress>
  );
}
