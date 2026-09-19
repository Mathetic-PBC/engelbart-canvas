import React from 'react';
import { api, errorMessage } from '../api.js';
import Rail from '../workspace/Rail.jsx';
import DocTabs from '../workspace/DocTabs.jsx';
import DocEditor, { CHAT_ITEM } from '../workspace/DocEditor.jsx';
import CtxModal from '../workspace/CtxModal.jsx';
import RightPane, { RIGHT_MODES } from '../workspace/RightPane.jsx';
import { kindOf } from '../ui/Icons.jsx';
import { isUntitled, nextUntitled } from '../model/names.js';

// The workspace screen (design 2026-09-17): a header in three columns — Engelbart / project /
// parent workspaces over the sidebar, the document tabs over the document, the Browser ·
// Terminal · Paper · Dataset switcher over the right pane — then sidebar, document, right pane.
// A project is a tree of workspaces (2026-09-18): the sidebar shows the current one, its
// siblings on hover, and its child workspaces as rows.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IMAGE_REF_RE = /\]\(img:([\w-]+)\)/g;
const MENTION_RE = /@\[([^\]\n]+)\]/g;
const NEXT_STATUS = { open: 'progress', progress: 'done', done: 'open' };
const SAVE_DELAY = 400;
const EASE = 'cubic-bezier(.25,.1,.25,1)';

const basename = (value) => String(value || '').split('/').pop();

function describe(row) {
  const kind = kindOf(row);
  let summary;
  if (row.type === 'paper') summary = row.path ? `Downloaded pdf · ${basename(row.path)}` : 'A paper.';
  else if (row.type === 'website') summary = row.url || 'A linked page.';
  else if (row.type === 'git_repo') summary = row.folder_path ? `Cloned at ${row.folder_path}` : (row.url || 'A repository.');
  else if (row.type === 'dataset') summary = row.path ? basename(row.path) : 'A dataset.';
  else summary = 'A note in this project.';
  if (row.summary) summary = row.summary; // the catalog blurb, or a paper's abstract, once the sweep has written one
  return { ...row, title: row.name, summary, facts: `${kind.label}${row.last_edited ? ` · edited ${String(row.last_edited).slice(0, 10)}` : ''}` };
}

function Separator({ onDown, onMove, onUp, onReset }) {
  return (
    <div role="separator" aria-orientation="vertical" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onReset} style={{ position: 'relative', flex: 'none', width: 1, background: '#eaeaea', cursor: 'col-resize', touchAction: 'none' }}>
      <div style={{ position: 'absolute', inset: '0 -6px', zIndex: 4 }} />
    </div>
  );
}

/** Every workspace of the tree by id, with its parent. */
function indexWorkspaces(roots) {
  const map = new Map();
  const walk = (list, parent) => { for (const node of list || []) { map.set(node.id, { node, parent }); walk(node.children, node); } };
  walk(roots, null);
  return map;
}

export default function Workspace({ tree, library, initialWorkspaceId, initialTab, style, active, reload, onClose, onHome, onVisit, onError }) {
  const project = tree.project;
  const index = React.useMemo(() => indexWorkspaces(tree.workspaces), [tree.workspaces]);
  const [wantedId, setTopicId] = React.useState(initialWorkspaceId || null);
  const topicId = wantedId && index.has(wantedId) ? wantedId : (tree.workspaces[0] ? tree.workspaces[0].id : null);
  const here = topicId ? index.get(topicId) : null;
  const topics = here ? (here.parent ? here.parent.children : tree.workspaces) : tree.workspaces; // the current workspace's siblings
  const ancestors = [];
  for (let up = here && here.parent; up; up = index.get(up.id).parent) ancestors.unshift(up);
  const [railWidth, setRailWidth] = React.useState(300);
  const [split, setSplit] = React.useState(0.5);
  const [tabs, setTabs] = React.useState(() => (initialTab ? [{ id: 'ws', title: 'Workspace' }, initialTab] : [{ id: 'ws', title: 'Workspace' }]));
  const [activeTab, setActiveTab] = React.useState(initialTab ? initialTab.id : 'ws');
  const [docs, setDocs] = React.useState({});
  const [rightMode, setRightMode] = React.useState('preview');
  const [ctxModal, setCtxModal] = React.useState(null);
  const [paper, setPaper] = React.useState(null);
  const [renaming, setRenaming] = React.useState(null);
  const [images, setImages] = React.useState({}); // library image id → object URL
  const [titleDraft, setTitleDraft] = React.useState('');
  const editorRef = React.useRef(null);
  const wantTitleFocus = React.useRef(false); // a topic or note was just created: the caret belongs in its title
  const pending = React.useRef(new Map());
  const railBox = React.useRef(null);
  const splitBox = React.useRef(null);

  const topic = topics.find((candidate) => candidate.id === topicId) || null;
  const docKey = activeTab === 'ws' ? (topic ? `ws:${topic.id}` : null) : `note:${activeTab}`;
  const docRef = React.useMemo(() => {
    if (!docKey) return null;
    return activeTab === 'ws' ? { kind: 'workspace', workspaceId: topic.id } : { kind: 'note', id: activeTab };
  }, [docKey, activeTab, topic]);

  // Remember where we are, so the app reopens here.
  React.useEffect(() => { if (topic && onVisit) onVisit(topic.id); }, [topic && topic.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [flush]);

  /* ---------------------------------------------------------------- images */

  const openText = docKey ? docs[docKey] : undefined;
  React.useEffect(() => {
    const ids = [...String(openText || '').matchAll(IMAGE_REF_RE)].map((match) => match[1]).filter((id) => !(id in images));
    if (!ids.length) return;
    setImages((current) => ({ ...Object.fromEntries(ids.map((id) => [id, ''])), ...current }));
    for (const id of ids) {
      api.readImage(id).then((file) => {
        const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
        setImages((current) => ({ ...current, [id]: url }));
      }).catch(() => {});
    }
  }, [openText]); // eslint-disable-line react-hooks/exhaustive-deps
  const imagesRef = React.useRef(images);
  imagesRef.current = images;
  React.useEffect(() => () => { for (const url of Object.values(imagesRef.current)) if (url) URL.revokeObjectURL(url); }, []);

  const pasteImage = React.useCallback(async (file, name) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const row = await api.saveImage(project.id, { bytes, mime: file.type, name });
      setImages((current) => ({ ...current, [row.id]: URL.createObjectURL(file) }));
      await reload();
      return row;
    } catch (error) {
      onError(error);
      return null;
    }
  }, [project.id, reload, onError]);

  /* ---------------------------------------------------------- context rows */

  const byId = React.useMemo(() => new Map(library.map((row) => [row.id, row])), [library]);

  const mentioned = React.useMemo(() => {
    const text = topic ? docs[`ws:${topic.id}`] || '' : '';
    const names = new Set([...text.matchAll(MENTION_RE)].map((match) => match[1].toLowerCase()));
    const shown = new Set([...text.matchAll(IMAGE_REF_RE)].map((match) => match[1])); // pasted images are context without an @mention
    return library.filter((row) => (row.type === 'image' ? shown.has(row.id) : names.has(row.name.toLowerCase())));
  }, [docs, topic, library]);

  const activeRowId = activeTab !== 'ws' ? activeTab : (rightMode === 'paper' && paper ? paper.id : rightMode === 'dataset' ? 'dataset' : 'ws');

  const rows = React.useMemo(() => {
    const out = [{ id: 'ws', name: 'Workspace', type: 'workspace', depth: 0, on: activeRowId === 'ws', editing: false }];
    if (!topic) return out;
    const present = new Set();
    for (const id of topic.context) {
      const row = byId.get(id);
      if (!row || present.has(row.id)) continue;
      present.add(row.id);
      out.push({ ...row, depth: 0, on: activeRowId === row.id || (row.type === 'dataset' && activeRowId === 'dataset'), editing: renaming === row.id });
    }
    for (const note of tree.notes || []) {
      if (note.workspaceId === topic.id && !present.has(note.id)) {
        present.add(note.id);
        out.push({ id: note.id, name: note.name, type: 'note', depth: 0, on: activeRowId === note.id, editing: renaming === note.id });
      }
    }
    for (const row of mentioned) {
      if (!present.has(row.id)) {
        present.add(row.id);
        out.push({ ...row, depth: 0, on: activeRowId === row.id, editing: renaming === row.id });
      }
    }
    for (const child of here ? here.node.children || [] : []) out.push({ id: child.id, name: child.name, type: 'child', depth: 0, on: false, editing: renaming === child.id });
    return out;
  }, [topic, here, byId, renaming, activeRowId, tree.notes, mentioned]);

  const mentionable = React.useMemo(() => [CHAT_ITEM, ...library.filter((row) => row.type !== 'image').map(describe)], [library]);

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
    if (row.type === 'workspace') { setActiveTab('ws'); return; }
    if (row.type === 'note') { openTab(row.id, row.name); return; }
    if (row.type === 'paper') { void openPaper(row); return; }
    if (row.type === 'dataset') { setRightMode('dataset'); return; }
    if (row.type === 'image') return;
    if (row.url) api.openExternal(row.url).catch((error) => onError(error));
  }, [openTab, openPaper, onError]);

  const onRowClick = (row) => {
    if (row.type === 'child') { selectTopic(row.id); return; }
    openItem(row);
  };

  /* ---------------------------------------------------------------- topics */

  const saveContext = async (entries) => {
    if (!topic) return;
    try {
      await api.setWorkspaceContext(project.id, topic.id, entries);
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  const selectTopic = (id) => {
    setTopicId(id);
    setActiveTab('ws');
  };

  // A sibling of the current workspace (the switcher's + New), or a child of it (+ Workspace).
  const addTopic = async (asChild) => {
    try {
      const child = asChild === true && here;
      const level = child ? here.node.children || [] : topics;
      const parentId = child ? here.node.id : (here && here.parent ? here.parent.id : null);
      const created = await api.createWorkspace(project.id, { name: nextUntitled('Workspace', level.map((candidate) => candidate.name)), parentId });
      await reload();
      wantTitleFocus.current = true;
      selectTopic(created.id);
    } catch (error) {
      onError(error);
    }
  };

  const cycleTopic = async (candidate) => {
    try {
      await api.setWorkspaceStatus(project.id, candidate.id, NEXT_STATUS[candidate.status] || 'progress');
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  const renameTopic = async (name) => {
    if (!topic) return;
    try {
      await api.renameWorkspace(project.id, topic.id, name);
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  const addNote = async () => {
    if (!topic) return;
    try {
      const note = await api.createNote(project.id, { name: nextUntitled('Note', (tree.notes || []).map((candidate) => candidate.name)), workspaceId: topic.id });
      await api.setWorkspaceContext(project.id, topic.id, [...topic.context, note.id]);
      await reload();
      setCtxModal(null);
      wantTitleFocus.current = true;
      openTab(note.id, note.name);
    } catch (error) {
      onError(error);
    }
  };

  const attachContext = async (row) => {
    if (!topic) return;
    await saveContext([...topic.context, row.id]);
    setCtxModal(null);
  };

  const renameRow = async (row, name) => {
    try {
      if (row.type === 'child') {
        await api.renameWorkspace(project.id, row.id, name);
        await reload();
        return;
      }
      const updated = await api.renameLibraryItem(row.id, name);
      setTabs((current) => current.map((tab) => (tab.id === row.id ? { ...tab, title: updated.name } : tab)));
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  /* ----------------------------------------------------------------- title */

  const currentTab = tabs.find((tab) => tab.id === activeTab);
  const docTitle = activeTab === 'ws' ? (topic ? topic.name : '') : (currentTab ? currentTab.title : '');
  const shownTitle = isUntitled(docTitle) ? '' : docTitle; // an untitled name is the field's hint, not its value
  React.useEffect(() => { setTitleDraft(shownTitle); }, [shownTitle, docKey]);

  const commitTitle = async () => {
    const next = titleDraft.trim();
    if (!next || next === docTitle) {
      setTitleDraft(shownTitle);
      return;
    }
    try {
      if (activeTab === 'ws') {
        if (topic) await api.renameWorkspace(project.id, topic.id, next);
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
      if (ctxModal) { setCtxModal(null); return; }
      if (renaming) { setRenaming(null); return; }
      if (editorRef.current && editorRef.current.isActive && editorRef.current.isActive()) return;
      if (inTerminal) return;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tabs, ctxModal, renaming, onClose]);

  /* --------------------------------------------------------------- resizing */

  const railMax = () => Math.max(180, Math.min(520, (window.innerWidth || 1200) - 700));
  const railDown = (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); railBox.current = event.currentTarget.parentElement.getBoundingClientRect(); };
  const railMove = (event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = railBox.current || event.currentTarget.parentElement.getBoundingClientRect(); setRailWidth(clamp(event.clientX - box.left, 180, railMax())); };
  const pointerUp = (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const splitDown = (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const body = event.currentTarget.parentElement.getBoundingClientRect(); const rail = event.currentTarget.parentElement.firstElementChild.getBoundingClientRect(); splitBox.current = { left: rail.right + 1, width: body.right - rail.right - 2 }; };
  const splitMove = (event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !splitBox.current) return; const { left, width } = splitBox.current; const lo = Math.min(0.6, 420 / Math.max(1, width)); const hi = 1 - Math.min(0.4, 300 / Math.max(1, width)); setSplit(clamp((event.clientX - left) / width, lo, hi)); };

  const text = docKey ? docs[docKey] : undefined;
  const rail = Math.min(railWidth, railMax());
  const headWide = rail >= 260;

  const header = (
    <input
      ref={(element) => { if (element && wantTitleFocus.current) { wantTitleFocus.current = false; element.focus(); } }}
      value={titleDraft}
      onChange={(event) => setTitleDraft(event.target.value)}
      onBlur={commitTitle}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.target.blur(); return; }
        if (event.key !== 'Enter') return;
        // Enter names the document and drops the caret into it.
        event.preventDefault();
        event.target.blur();
        if (editorRef.current && editorRef.current.focusStart) editorRef.current.focusStart();
      }}
      placeholder={isUntitled(docTitle) ? docTitle : 'Untitled'}
      data-doc-title="1"
      aria-label="Title"
      spellCheck={false}
      style={{ display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent', font: '500 22px/1.35 var(--font-sans)', letterSpacing: '-0.3px', color: '#171717' }}
    />
  );

  return (
    <div data-screen-label="Workspace" style={style}>
      <header style={{ display: 'flex', alignItems: 'stretch', minHeight: 46, borderBottom: '1px solid #eaeaea', background: '#fafafa', flex: 'none' }}>
        <div style={{ flex: 'none', width: rail, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', minWidth: 0, overflow: 'hidden' }}>
          <button type="button" onClick={onHome} title="All projects" style={{ flex: 'none', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>
          <span style={{ flex: 'none', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
          <span title={project.directory || project.dir} style={{ flex: '0 1 auto', minWidth: 0, font: '400 14px/1.3 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
          {headWide && ancestors.map((ancestor) => (
            <React.Fragment key={ancestor.id}>
              <span style={{ flex: 'none', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
              <button type="button" className="hov-ink" onClick={() => selectTopic(ancestor.id)} title="Go up to this workspace" data-ancestor={ancestor.id} style={{ flex: '0 1 auto', minWidth: 0, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '400 14px/1.3 var(--font-sans)', color: isUntitled(ancestor.name) ? '#8f8f8f' : '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'color 120ms' }}>{ancestor.name}</button>
            </React.Fragment>
          ))}
        </div>
        <div style={{ flex: 'none', width: 1, background: '#eaeaea' }} />
        <div style={{ flex: `${split} 1 0`, minWidth: 'min(420px, 55%)', display: 'flex', alignItems: 'flex-end', gap: 2, padding: '8px 8px 0', overflow: 'hidden' }}>
          <DocTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} onClose={closeTab} />
        </div>
        <div style={{ flex: 'none', width: 1, background: '#eaeaea' }} />
        <div style={{ flex: `${1 - split} 1 0`, minWidth: 0, display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px' }}>
          {RIGHT_MODES.map((mode) => {
            const on = rightMode === mode.id;
            return (
              <button key={mode.id} type="button" className="hov-ink" onClick={() => setRightMode(mode.id)} data-right-mode={mode.id} style={{ flex: 'none', padding: '0 0 2px', border: 0, borderBottom: `2px solid ${on ? '#171717' : 'transparent'}`, background: 'transparent', font: `${on ? 600 : 400} 13px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 120ms' }}>{mode.label}</button>
            );
          })}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Rail
          width={rail}
          topics={topics}
          topic={topic}
          onSelectTopic={selectTopic}
          onCycleTopic={cycleTopic}
          onRenameTopic={renameTopic}
          onAddTopic={() => addTopic(false)}
          rows={rows}
          onRowClick={onRowClick}
          onRowRenameStart={(row) => setRenaming(row.id)}
          onRowRename={renameRow}
          onRowRenameEnd={() => setRenaming(null)}
          onAddContext={() => { if (topic) setCtxModal(topic); }}
          onAddChild={() => addTopic(true)}
        />

        <Separator onDown={railDown} onMove={railMove} onUp={pointerUp} onReset={() => setRailWidth(300)} />

        <main style={{ flex: `${split} 1 0`, minWidth: 'min(420px, 55%)', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
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
              images={images}
              onPasteImage={pasteImage}
              header={header}
            />
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
              {topics.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                  <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f', textAlign: 'center' }}>This project has no workspace yet. A workspace holds a document, its context, and any workspaces nested inside it.</span>
                  <button type="button" className="hov-bd2" onClick={() => addTopic(false)} style={{ padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>+ Workspace</button>
                </div>
              ) : <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f' }}>Opening…</span>}
            </div>
          )}
        </main>

        <Separator onDown={splitDown} onMove={splitMove} onUp={pointerUp} onReset={() => setSplit(0.5)} />

        <RightPane
          mode={rightMode}
          paper={paper}
          onMarksChange={(id, marks) => api.writeAnnotations(id, marks).catch((error) => onError(error))}
          projectDir={project.directory || null}
          projectId={project.id}
          onExpand={() => setSplit((current) => (current <= 0.36 ? 0.5 : 0.35))}
          style={{ flex: `${1 - split} 1 0`, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
        />
      </div>

      {ctxModal && topic && (
        <CtxModal
          topic={topic}
          library={library}
          onClose={() => setCtxModal(null)}
          onNewNote={addNote}
          onAttach={attachContext}
        />
      )}
    </div>
  );
}
