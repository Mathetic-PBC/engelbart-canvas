import React from 'react';
import { api, errorMessage } from './api.js';
import TestToggle from './ui/TestToggle.jsx';
import Home from './screens/Home.jsx';
import CreateProject from './screens/CreateProject.jsx';
import Canvas from './screens/Canvas.jsx';
import Workspace from './screens/Workspace.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

// Canvas ↔ workspace transition styles, from the design (Goal Canvas.dc.html lines 615–631).
function wsStyle(phase, r) {
  const W = window.innerWidth || 1200;
  const H = window.innerHeight || 800;
  const base = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff', transformOrigin: '0 0', willChange: 'transform,opacity' };
  const small = r ? { opacity: 0, transform: `translate(${r.x}px,${r.y}px) scale(${r.w / W},${r.h / H})` } : { opacity: 0, transform: 'scale(.6)' };
  if (phase === 'pre-open') return { ...base, ...small, transition: 'none' };
  if (phase === 'closing') return { ...base, ...small, transition: `transform 240ms ${EASE},opacity 180ms ${EASE} 40ms` };
  return { ...base, opacity: 1, transform: 'none', transition: `transform 260ms ${EASE},opacity 200ms ${EASE}` };
}

function canvasStyle(phase, r) {
  const base = { position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' };
  const origin = r ? `${r.x + r.w / 2}px ${r.y + r.h / 2}px` : '50% 50%';
  const away = { opacity: 0, transform: 'scale(1.6)', transformOrigin: origin };
  if (phase === 'pre-close') return { ...base, ...away, transition: 'none' };
  if (phase === 'opening') return { ...base, ...away, transition: `transform 260ms ${EASE},opacity 200ms ${EASE}` };
  if (phase === 'closing') return { ...base, opacity: 1, transform: 'none', transformOrigin: origin, transition: `transform 260ms ${EASE},opacity 220ms ${EASE}` };
  return { ...base, opacity: 1, transform: 'none', transformOrigin: origin };
}

const WS_PHASES = new Set(['pre-open', 'opening', 'workspace', 'pre-close', 'closing']);

export default function App() {
  const [config, setConfig] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [projects, setProjects] = React.useState([]);
  const [library, setLibrary] = React.useState([]);
  const [tree, setTree] = React.useState(null);
  const [goalId, setGoalId] = React.useState(null);
  const [entry, setEntry] = React.useState(null); // { topicId, tab } for a workspace opened straight after creation
  const [phase, setPhase] = React.useState('home'); // home | create | canvas | pre-open | opening | workspace | pre-close | closing
  const [openRect, setOpenRect] = React.useState(null);
  const [, setTick] = React.useState(0);

  const fail = (candidate) => setError(errorMessage(candidate));

  // Home shows the project grid, or the create screen when the data root has no project yet.
  const refreshHome = React.useCallback(async () => {
    const [list, rows] = await Promise.all([api.listProjects(), api.library()]);
    setProjects(list);
    setLibrary(rows);
    setPhase(list.length ? 'home' : 'create');
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

  React.useEffect(() => {
    (async () => {
      try {
        const initial = await api.config();
        setConfig(initial);
        await refreshHome();
      } catch (candidate) {
        fail(candidate);
      }
    })();
  }, [refreshHome]);

  React.useEffect(() => {
    const onResize = () => setTick((value) => value + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function leaveProject() {
    setTree(null);
    setGoalId(null);
    setEntry(null);
    setOpenRect(null);
  }

  async function toggleTest() {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.setTestMode(!config.testMode);
      setConfig(next);
      leaveProject();
      await refreshHome();
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
        await refreshHome();
      }
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
  }

  async function openProject(id) {
    try {
      const [next, rows] = await Promise.all([api.loadProject(id), api.library()]);
      setTree(next);
      setLibrary(rows);
      setEntry(null);
      setPhase('canvas');
      setError('');
    } catch (candidate) {
      fail(candidate);
    }
  }

  // First run and + Project: create, then land in the workspace with the Welcome! note open.
  async function createProject(input) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const made = await api.createProjectWithWelcome(input);
      const [next, rows] = await Promise.all([api.loadProject(made.project.id), api.library()]);
      setTree(next);
      setLibrary(rows);
      setGoalId(made.goalId);
      setEntry({ topicId: made.topicId, tab: { id: made.noteId, title: made.noteName } });
      setOpenRect(null);
      setPhase('workspace');
    } catch (candidate) {
      fail(candidate);
    } finally {
      setBusy(false);
    }
  }

  async function goHome() {
    leaveProject();
    try {
      await refreshHome();
    } catch (candidate) {
      fail(candidate);
    }
  }

  function openGoal(id, rect) {
    if (phase !== 'canvas') return;
    setGoalId(id);
    setEntry(null);
    setOpenRect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    setPhase('pre-open');
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setPhase('opening');
      setTimeout(() => setPhase('workspace'), 280);
    };
    requestAnimationFrame(go);
    setTimeout(go, 120);
  }

  function closeWorkspace() {
    if (phase !== 'workspace') return;
    setPhase('pre-close');
    requestAnimationFrame(() => {
      setPhase('closing');
      setTimeout(() => setPhase('canvas'), 280);
    });
  }

  if (!config) return <div style={{ position: 'absolute', inset: 0, background: '#fff' }} />;

  const showCanvas = tree && (phase === 'canvas' || phase === 'pre-open' || phase === 'opening' || phase === 'pre-close' || phase === 'closing');
  const showWs = tree && goalId && WS_PHASES.has(phase);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      {phase === 'home' && (
        <Home projects={projects} error={error} onCreateScreen={() => setPhase('create')} onOpen={openProject} onRename={async (id, name) => { try { await api.renameProject(id, name); await refreshHome(); } catch (candidate) { fail(candidate); } }} />
      )}
      {phase === 'create' && (
        <CreateProject onCreate={createProject} onBack={projects.length ? () => setPhase('home') : null} busy={busy} error={error} />
      )}
      {showCanvas && (
        <Canvas
          tree={tree}
          library={library}
          style={canvasStyle(phase, openRect)}
          interactive={phase === 'canvas'}
          onHome={goHome}
          onOpenGoal={openGoal}
          onCreateGoal={async (name, box) => { try { await api.createGoal(tree.project.id, { name, box }); await reload(); } catch (candidate) { fail(candidate); } }}
        />
      )}
      {showWs && (
        <Workspace
          key={goalId}
          tree={tree}
          library={library}
          goalId={goalId}
          initialTopicId={entry ? entry.topicId : null}
          initialTab={entry ? entry.tab : null}
          style={wsStyle(phase, openRect)}
          active={phase === 'workspace'}
          reload={reload}
          onClose={closeWorkspace}
          onHome={goHome}
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
