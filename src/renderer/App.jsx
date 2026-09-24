import React from 'react';
import { api, errorMessage } from './api.js';
import TestToggle from './ui/TestToggle.jsx';
import WindowEdges from './ui/WindowEdges.jsx';
import Home from './screens/Home.jsx';
import CreateProject from './screens/CreateProject.jsx';
import Workspace from './screens/Workspace.jsx';

// Screens: the app opens straight into the workspace you were last in — "Getting started" in a
// fresh project — and the first run shows the create screen. "Engelbart" in the header (or
// Escape) shows all projects. A project whose project.json has no code directory yet is held
// behind a modal until one is chosen (2026-09-18).

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
  const [library, setLibrary] = React.useState([]);
  const [tree, setTree] = React.useState(null);
  const [entry, setEntry] = React.useState(null); // { workspaceId, tab, views } for the project being opened
  const [phase, setPhase] = React.useState('boot'); // boot | create | home | workspace
  const [, setTick] = React.useState(0);

  const fail = (candidate) => setError(errorMessage(candidate));

  const loadHome = React.useCallback(async () => {
    const [list, rows] = await Promise.all([api.listProjects(), api.library()]);
    setProjects(list);
    setLibrary(rows);
    return list;
  }, []);

  // Rows the main process changed on its own (a pdf saved as a link became a saved pdf): the library is read again.
  React.useEffect(() => api.onLibraryChanged(() => { api.library().then(setLibrary).catch(() => {}); }), []);

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

  // Startup (and after the data root changes): the last project you were in, or the create screen.
  const start = React.useCallback(async () => {
    const list = await loadHome();
    if (!list.length) { setPhase('create'); return; }
    const last = await api.lastOpen().catch(() => null);
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

  async function resetTest() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.resetTestData();
      if (result.reset) {
        setConfig(result);
        leaveProject();
        await start();
      }
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
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

  return (
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
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff', ...(tree.project.directory ? {} : { filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' }) }}
          active={!!tree.project.directory}
          reload={reload}
          onClose={goHome}
          onHome={goHome}
          onVisit={onVisit}
          onOpenElsewhere={(projectId, workspaceId) => openProject(projectId, { workspaceId }).catch(fail)}
          onError={fail}
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
      <WindowEdges />
      <TestToggle
        testMode={config.testMode}
        busy={busy}
        onToggle={toggleTest}
        onReset={resetTest}
        onReveal={() => api.reveal(config.testRoot).catch(fail)}
      />
    </div>
  );
}
