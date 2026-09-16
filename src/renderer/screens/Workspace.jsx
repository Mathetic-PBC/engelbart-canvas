import React from 'react';
import { api, errorMessage } from '../api.js';
import Rail from '../workspace/Rail.jsx';
import DocTabs from '../workspace/DocTabs.jsx';
import DocEditor, { CHAT_ITEM } from '../workspace/DocEditor.jsx';
import CtxModal from '../workspace/CtxModal.jsx';
import RightPane from '../workspace/RightPane.jsx';
import InlineField from '../ui/InlineField.jsx';
import { kindOf } from '../ui/Icons.jsx';

// The goal workspace: header crumbs, rail, document, right pane (design lines 101–390).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BOX_LABEL = { current: 'Current', experimental: 'Experimental', past: 'Past' };
const MENTION_RE = /@\[([^\]\n]+)\]/g;
const NEXT_STATUS = { open: 'progress', progress: 'done', done: 'open' };
const SAVE_DELAY = 400;

const basename = (value) => String(value || '').split('/').pop();

function describe(row) {
  const kind = kindOf(row);
  let summary;
  if (row.type === 'paper') summary = row.path ? `Downloaded pdf · ${basename(row.path)}` : 'A paper.';
  else if (row.type === 'website') summary = row.url || 'A linked page.';
  else if (row.type === 'git_repo') summary = row.folder_path ? `Cloned at ${row.folder_path}` : (row.url || 'A repository.');
  else if (row.type === 'dataset') summary = row.path ? basename(row.path) : 'A dataset.';
  else summary = 'A note in this project.';
  return { ...row, title: row.name, summary, facts: `${kind.label}${row.last_edited ? ` · edited ${String(row.last_edited).slice(0, 10)}` : ''}` };
}

function Separator({ onDown, onMove, onUp, onReset }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={onReset}
      style={{ position: 'relative', flex: 'none', width: 1, background: '#eaeaea', cursor: 'col-resize', touchAction: 'none' }}
    >
      <div style={{ position: 'absolute', inset: '0 -6px', zIndex: 4 }} />
    </div>
  );
}

export default function Workspace({ tree, library, goalId, style, active, reload, onClose, onHome, onError }) {
  const project = tree.project;
  const goal = tree.goals.find((candidate) => candidate.id === goalId);
  const topics = goal ? goal.topics : [];
  const [topicId, setTopicId] = React.useState(topics[0] ? topics[0].id : null);
  const [expanded, setExpanded] = React.useState(() => (topics[0] ? { [topics[0].id]: true } : {}));
  const [hoverTopic, setHoverTopic] = React.useState(null);
  const [railWidth, setRailWidth] = React.useState(300);
  const [split, setSplit] = React.useState(0.5);
  const [tabs, setTabs] = React.useState([{ id: 'ws', title: 'Workspace' }]);
  const [activeTab, setActiveTab] = React.useState('ws');
  const [docs, setDocs] = React.useState({});
  const [rightMode, setRightMode] = React.useState('preview');
  const [ctxModal, setCtxModal] = React.useState(null);
  const [paper, setPaper] = React.useState(null);
  const [ideas, setIdeas] = React.useState(() => (goal ? goal.future : []).map((text, index) => ({ id: `f${index}`, text })));
  const [renamingGoal, setRenamingGoal] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const editorRef = React.useRef(null);
  const pending = React.useRef(new Map());
  const ideaTimer = React.useRef(null);
  const railBox = React.useRef(null);
  const splitBox = React.useRef(null);
  const ideaSeq = React.useRef(1000);

  const topic = topics.find((candidate) => candidate.id === topicId) || null;
  const docKey = activeTab === 'ws' ? (topic ? `ws:${topic.id}` : null) : `note:${activeTab}`;
  const docRef = React.useMemo(() => {
    if (!docKey) return null;
    return activeTab === 'ws' ? { kind: 'workspace', goalId, topicId: topic.id } : { kind: 'note', id: activeTab };
  }, [docKey, activeTab, goalId, topic]);

  /* ------------------------------------------------------------ documents */

  React.useEffect(() => {
    if (!docKey || docs[docKey] !== undefined || !docRef) return;
    let cancelled = false;
    api.readDoc(project.id, docRef).then((text) => {
      if (!cancelled) setDocs((current) => (current[docKey] === undefined ? { ...current, [docKey]: text } : current));
    }).catch((error) => onError(error));
    return () => { cancelled = true; };
  }, [docKey, docRef, docs, project.id, onError]);

  const flush = React.useCallback((key) => {
    const entry = pending.current.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.current.delete(key);
    api.writeDoc(project.id, entry.ref, entry.text).catch((error) => onError(error));
  }, [project.id, onError]);

  const onDocChange = React.useCallback((text) => {
    if (!docKey || !docRef) return;
    setDocs((current) => ({ ...current, [docKey]: text }));
    const previous = pending.current.get(docKey);
    if (previous) clearTimeout(previous.timer);
    pending.current.set(docKey, { ref: docRef, text, timer: setTimeout(() => flush(docKey), SAVE_DELAY) });
  }, [docKey, docRef, flush]);

  React.useEffect(() => () => {
    for (const key of [...pending.current.keys()]) flush(key);
    if (ideaTimer.current) clearTimeout(ideaTimer.current);
  }, [flush]);

  /* -------------------------------------------------------------- mentions */

  const mentioned = React.useMemo(() => {
    const text = topic ? docs[`ws:${topic.id}`] || '' : '';
    const names = new Set([...text.matchAll(MENTION_RE)].map((match) => match[1].toLowerCase()));
    return library.filter((row) => names.has(row.name.toLowerCase()));
  }, [docs, topic, library]);

  const rowsFor = React.useCallback((candidate) => {
    const byId = new Map(library.map((row) => [row.id, row]));
    const seen = new Set();
    const rows = [{ id: 'ws', name: 'Workspace', type: 'workspace' }];
    const push = (row) => {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      rows.push(row);
    };
    for (const id of candidate.context) push(byId.get(id));
    if (candidate.id === topicId) for (const row of mentioned) push(row);
    for (const note of goal ? goal.notes : []) if (note.topicId === candidate.id) push({ id: note.id, name: note.name, type: 'note' });
    return rows;
  }, [library, topicId, mentioned, goal]);

  const mentionable = React.useMemo(() => [CHAT_ITEM, ...library.map(describe)], [library]);

  /* --------------------------------------------------------------- opening */

  const openTab = React.useCallback((id, title) => {
    setTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, { id, title }]));
    setActiveTab(id);
  }, []);

  const closeTab = (id) => {
    flush(`note:${id}`);
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTab === id) setActiveTab(next[next.length - 1].id);
      return next;
    });
  };

  const openPaper = React.useCallback(async (row) => {
    setRightMode('paper');
    setPaper({ id: row.id, name: row.name, loading: true });
    try {
      const [file, marks] = await Promise.all([api.readLibraryFile(row.id), api.readAnnotations(row.id)]);
      setPaper({ id: row.id, name: file.name, bytes: file.bytes, marks });
    } catch (error) {
      setPaper({ id: row.id, name: row.name, error: errorMessage(error) });
    }
  }, []);

  const openItem = React.useCallback((row) => {
    if (!row || row.id === 'chat') return;
    if (row.type === 'workspace') {
      setActiveTab('ws');
      return;
    }
    if (row.type === 'note') {
      openTab(row.id, row.name);
      return;
    }
    if (row.type === 'paper') {
      void openPaper(row);
      return;
    }
    if (row.type === 'dataset') {
      setRightMode('dataset');
      return;
    }
    if (row.url) api.openExternal(row.url).catch((error) => onError(error));
  }, [openTab, openPaper, onError]);

  /* ---------------------------------------------------------------- topics */

  const selectTopic = (id) => {
    setTopicId(id);
    setExpanded((current) => ({ ...current, [id]: true }));
    setActiveTab('ws');
  };

  const addTopic = async () => {
    try {
      const created = await api.createTopic(project.id, goalId, `Topic ${topics.length + 1}`);
      await reload();
      selectTopic(created.id);
    } catch (error) {
      onError(error);
    }
  };

  const cycleTopic = async (candidate) => {
    try {
      await api.setTopicStatus(project.id, goalId, candidate.id, NEXT_STATUS[candidate.status] || 'progress');
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  const addNote = async (attachTopic) => {
    try {
      const note = await api.createNote(project.id, { name: 'Untitled note', goalId, topicId: attachTopic ? attachTopic.id : null });
      await reload();
      setCtxModal(null);
      openTab(note.id, note.name);
    } catch (error) {
      onError(error);
    }
  };

  const attachContext = async (candidate, row) => {
    try {
      await api.setTopicContext(project.id, goalId, candidate.id, [...candidate.context, row.id]);
      await reload();
      setCtxModal(null);
      setExpanded((current) => ({ ...current, [candidate.id]: true }));
    } catch (error) {
      onError(error);
    }
  };

  /* ----------------------------------------------------------------- ideas */

  const saveIdeas = (next) => {
    setIdeas(next);
    if (ideaTimer.current) clearTimeout(ideaTimer.current);
    ideaTimer.current = setTimeout(() => {
      api.setFuture(project.id, goalId, next.map((idea) => idea.text)).catch((error) => onError(error));
    }, SAVE_DELAY);
  };

  const addIdea = () => {
    ideaSeq.current += 1;
    saveIdeas([...ideas.map((idea) => ({ ...idea, focus: false })), { id: `f${ideaSeq.current}`, text: '', focus: true }]);
  };

  /* ----------------------------------------------------------------- title */

  const currentTab = tabs.find((tab) => tab.id === activeTab);
  const docTitle = activeTab === 'ws' ? (topic ? topic.name : '') : (currentTab ? currentTab.title : '');
  React.useEffect(() => { setTitleDraft(docTitle); }, [docTitle, docKey]);

  const commitTitle = async () => {
    const next = titleDraft.trim();
    if (!next || next === docTitle) {
      setTitleDraft(docTitle);
      return;
    }
    try {
      if (activeTab === 'ws') {
        if (topic) await api.renameTopic(project.id, goalId, topic.id, next);
      } else {
        const renamed = await api.renameNote(project.id, activeTab, next);
        setTabs((current) => current.map((tab) => (tab.id === activeTab ? { ...tab, title: renamed.name } : tab)));
      }
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  /* --------------------------------------------------------------- keyboard */

  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => {
      const target = event.target;
      const inTerminal = target && target.closest && target.closest('[data-terminal]');
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !inTerminal && /^[1-9]$/.test(event.key)) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          setActiveTab(tab.id);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (ctxModal) {
        setCtxModal(null);
        return;
      }
      if (renamingGoal) return;
      if (editorRef.current && editorRef.current.isActive && editorRef.current.isActive()) return;
      if (inTerminal) return;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tabs, ctxModal, renamingGoal, onClose]);

  /* --------------------------------------------------------------- resizing */

  const railMax = () => Math.max(180, Math.min(520, (window.innerWidth || 1200) - 700));
  const railDown = (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); railBox.current = event.currentTarget.parentElement.getBoundingClientRect(); };
  const railMove = (event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = railBox.current || event.currentTarget.parentElement.getBoundingClientRect(); setRailWidth(clamp(event.clientX - box.left, 180, railMax())); };
  const pointerUp = (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const splitDown = (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const body = event.currentTarget.parentElement.getBoundingClientRect(); const rail = event.currentTarget.parentElement.firstElementChild.getBoundingClientRect(); splitBox.current = { left: rail.right + 1, width: body.right - rail.right - 2 }; };
  const splitMove = (event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !splitBox.current) return; const { left, width } = splitBox.current; const lo = Math.min(0.6, 420 / Math.max(1, width)); const hi = 1 - Math.min(0.4, 300 / Math.max(1, width)); setSplit(clamp((event.clientX - left) / width, lo, hi)); };

  if (!goal) return <div style={style} />;

  const activeRowId = activeTab !== 'ws' ? activeTab : (rightMode === 'paper' && paper ? paper.id : rightMode === 'dataset' ? 'dataset' : 'ws');
  const text = docKey ? docs[docKey] : undefined;

  const header = (
    <input
      value={titleDraft}
      onChange={(event) => setTitleDraft(event.target.value)}
      onBlur={commitTitle}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') event.target.blur(); }}
      aria-label="Title"
      spellCheck={false}
      style={{ display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent', font: '500 22px/1.35 var(--font-sans)', letterSpacing: '-0.3px', color: '#171717' }}
    />
  );

  return (
    <div data-screen-label="Workspace" style={style}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '16px 24px', borderBottom: '1px solid #eaeaea', flex: 'none', paddingRight: 140 }}>
        <button type="button" onClick={onHome} title="All projects" style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>
        <span style={{ font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
        <button type="button" className="hov-ink" onClick={onClose} title="Back to the canvas" style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '400 15px/1.3 var(--font-sans)', color: '#4d4d4d' }}>{project.name}</button>
        <span style={{ font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
        <button type="button" className="hov-ink" onClick={onClose} title="Back to the canvas" style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '400 15px/1.3 var(--font-sans)', color: '#4d4d4d' }}>{BOX_LABEL[goal.box]}</button>
        <span style={{ font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
        {renamingGoal
          ? <InlineField initial={goal.name} placeholder="goal name…" style={{ padding: '2px 8px' }} onCommit={async (name) => { setRenamingGoal(false); try { await api.renameGoal(project.id, goalId, name); await reload(); } catch (error) { onError(error); } }} onCancel={() => setRenamingGoal(false)} />
          : <h1 title="Click to rename" onClick={() => setRenamingGoal(true)} style={{ margin: 0, font: '400 15px/1.3 var(--font-sans)', color: '#4d4d4d', cursor: 'text' }}>{goal.name}</h1>}
        <span style={{ marginLeft: 'auto', font: '11.5px/1 var(--font-sans)', color: '#8f8f8f' }}>esc zooms out</span>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Rail
          width={Math.min(railWidth, railMax())}
          topics={topics}
          activeTopicId={topicId}
          expanded={expanded}
          hoverTopic={hoverTopic}
          rowsFor={rowsFor}
          activeRowId={activeRowId}
          notes={goal.notes}
          activeTab={activeTab}
          ideas={ideas}
          onSelectTopic={selectTopic}
          onCycleTopic={cycleTopic}
          onTogglePin={(id) => { setExpanded((current) => ({ ...current, [id]: !current[id] })); setHoverTopic(null); }}
          onHoverTopic={setHoverTopic}
          onLeaveTopic={() => setHoverTopic(null)}
          onOpenRow={(candidate, row) => { if (candidate.id !== topicId) selectTopic(candidate.id); openItem(row); }}
          onAddContext={(candidate) => setCtxModal(candidate)}
          onAddTopic={addTopic}
          onOpenNote={(note) => openTab(note.id, note.name)}
          onAddNote={() => addNote(null)}
          onIdeasChange={saveIdeas}
          onAddIdea={addIdea}
        />

        <Separator onDown={railDown} onMove={railMove} onUp={pointerUp} onReset={() => setRailWidth(300)} />

        <main style={{ flex: `${split} 1 0`, minWidth: 'min(420px, 55%)', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <DocTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} onClose={closeTab} />
          {docKey && text !== undefined ? (
            <DocEditor
              ref={editorRef}
              docKey={docKey}
              text={text}
              onChange={onDocChange}
              mentionable={mentionable}
              onOpenItem={openItem}
              onOpenLink={(href) => api.openExternal(href).catch((error) => onError(error))}
              buildSpeed="normal"
              header={header}
            />
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
              {topics.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                  <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f', textAlign: 'center' }}>This goal has no topics yet. A topic holds a workspace document and its context.</span>
                  <button type="button" className="hov-bd2" onClick={addTopic} style={{ padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>+ Topic</button>
                </div>
              ) : <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f' }}>Opening…</span>}
            </div>
          )}
        </main>

        <Separator onDown={splitDown} onMove={splitMove} onUp={pointerUp} onReset={() => setSplit(0.5)} />

        <RightPane
          mode={rightMode}
          onMode={setRightMode}
          paper={paper}
          onMarksChange={(id, marks) => api.writeAnnotations(id, marks).catch((error) => onError(error))}
          projectDir={project.dir}
          projectId={project.id}
          style={{ flex: `${1 - split} 1 0`, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 20px 20px' }}
        />
      </div>

      {ctxModal && (
        <CtxModal
          topic={topics.find((candidate) => candidate.id === ctxModal.id) || ctxModal}
          library={library}
          onClose={() => setCtxModal(null)}
          onNewNote={() => addNote(ctxModal)}
          onAttach={(row) => attachContext(topics.find((candidate) => candidate.id === ctxModal.id) || ctxModal, row)}
        />
      )}
    </div>
  );
}
