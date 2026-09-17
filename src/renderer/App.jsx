import React from 'react';
import { api, errorMessage } from './api.js';
import TestToggle from './ui/TestToggle.jsx';
import Home from './screens/Home.jsx';
import CreateProject from './screens/CreateProject.jsx';
import Workspace from './screens/Workspace.jsx';

// Screens (2026-09-17): the app opens straight into the last topic you were in — the
// "Getting started" topic of a fresh project — and the first run shows the create screen.
// The kanban canvas is gone; "Engelbart" in the header (or Escape) shows all projects.

export default function App() {
  const [config, setConfig] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [projects, setProjects] = React.useState([]);
  const [library, setLibrary] = React.useState([]);
  const [tree, setTree] = React.useState(null);
  const [goalId, setGoalId] = React.useState(null);
  const [entry, setEntry] = React.useState(null); // { topicId, tab } for the workspace being opened
  const [phase, setPhase] = React.useState('boot'); // boot | create | home | workspace
  const visited = React.useRef({}); // goalId → last topic id, for this session
  const [, setTick] = React.useState(0);

  const fail = (candidate) => setError(errorMessage(candidate));

  const loadHome = React.useCallback(async () => {
    const [list, rows] = await Promise.all([api.listProjects(), api.library()]);
    setProjects(list);
    setLibrary(rows);
    return list;
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

  // Open a project straight into a topic: the remembered one, else the first goal's first topic.
  const openProject = React.useCallback(async (id, prefer) => {
    let [next, rows] = await Promise.all([api.loadProject(id), api.library()]);
    if (!next.goals.length) {
      const goal = await api.createGoal(id, { name: 'First steps', box: 'current' });
      await api.createTopic(id, goal.id, 'Getting started');
      next = await api.loadProject(id);
    }
    const goal = next.goals.find((candidate) => candidate.id === (prefer && prefer.goalId)) || next.goals[0];
    const topic = goal.topics.find((candidate) => candidate.id === (prefer && prefer.topicId)) || goal.topics[0] || null;
    setTree(next);
    setLibrary(rows);
    setGoalId(goal.id);
    setEntry({ topicId: topic ? topic.id : null, tab: (prefer && prefer.tab) || null });
    setPhase('workspace');
    setError('');
    api.setLastOpen({ projectId: id, goalId: goal.id, topicId: topic ? topic.id : null }).catch(() => {});
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
    setGoalId(null);
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
      await openProject(made.project.id, { goalId: made.goalId, topicId: made.topicId, tab: { id: made.noteId, title: made.noteName } });
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

  const onVisit = React.useCallback((visitedGoalId, topicId) => {
    visited.current[visitedGoalId] = topicId;
    if (tree) api.setLastOpen({ projectId: tree.project.id, goalId: visitedGoalId, topicId }).catch(() => {});
  }, [tree]);

  function selectGoal(id) {
    if (!tree || id === goalId) return;
    setGoalId(id);
    setEntry({ topicId: visited.current[id] || null, tab: null });
  }

  async function createGoal() {
    if (!tree) return;
    try {
      const goal = await api.createGoal(tree.project.id, { name: `Goal ${tree.goals.length + 1}`, box: 'current' });
      const topic = await api.createTopic(tree.project.id, goal.id, 'Topic 1');
      const [next, rows] = await Promise.all([api.loadProject(tree.project.id), api.library()]);
      setTree(next);
      setLibrary(rows);
      setGoalId(goal.id);
      setEntry({ topicId: topic.id, tab: null });
    } catch (candidate) {
      fail(candidate);
    }
  }

  if (!config || phase === 'boot') return <div style={{ position: 'absolute', inset: 0, background: '#fff' }} />;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      {phase === 'home' && (
        <Home projects={projects} error={error} onCreateScreen={() => setPhase('create')} onOpen={(id) => openProject(id, null).catch(fail)} onRename={async (id, name) => { try { await api.renameProject(id, name); await loadHome(); } catch (candidate) { fail(candidate); } }} />
      )}
      {phase === 'create' && (
        <CreateProject onCreate={createProject} onBack={projects.length ? goHome : null} busy={busy} error={error} />
      )}
      {phase === 'workspace' && tree && goalId && (
        <Workspace
          key={goalId}
          tree={tree}
          library={library}
          goalId={goalId}
          initialTopicId={entry ? entry.topicId : null}
          initialTab={entry ? entry.tab : null}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}
          active
          reload={reload}
          onClose={goHome}
          onHome={goHome}
          onSelectGoal={selectGoal}
          onCreateGoal={createGoal}
          onVisit={onVisit}
          onError={fail}
        />
      )}
      {error && phase !== 'home' && phase !== 'create' && (
        <div style={{ position: 'fixed', left: 24, bottom: 18, zIndex: 150, padding: '7px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', font: '12.5px/1.5 var(--font-sans)', color: '#e70022', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', color: '#c9c9c9', font: '14px/1 var(--font-sans)' }}>×</button>
        </div>
      )}
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
