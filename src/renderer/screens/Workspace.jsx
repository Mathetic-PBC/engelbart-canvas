import React from 'react';
import { api, errorMessage } from '../api.js';
import Rail from '../workspace/Rail.jsx';
import DocTabs from '../workspace/DocTabs.jsx';
import DocEditor, { BART_ITEM, TASK_ITEM } from '../workspace/DocEditor.jsx';
import RightPane, { RIGHT_MODES } from '../workspace/RightPane.jsx';
import { kindOf } from '../ui/Icons.jsx';
import { hasTag, isNote } from '../model/kind.js';
import { isUntitled, nextUntitled } from '../model/names.js';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { mentionRows } from '../model/rail.js';
import { flatWorkspaces, nextPlace, placesToGo } from '../model/nav.js';
import { onStage } from '../model/stage.js';
import ProjectPostIts from '../post-its/ProjectPostIts.jsx';

// The workspace screen (design 2026-09-17): a header in three columns — Engelbart / project /
// parent workspaces over the sidebar, the document tabs over the document, the Stage · Terminal
// switcher over the right pane — then sidebar, document, right pane. The Stage (2026-09-23, Add -
// Mention Stage.dc.html) opens everything that is not a note: a sidebar row, an @mention, a link in
// the document or the terminal; its full screen takes the document's place, never the sidebar's.
// A project is a tree of workspaces (2026-09-18): the sidebar shows the current one, its
// siblings on hover, and its child workspaces as rows.
// Each workspace keeps its own view (2026-09-22): the note tabs it had open, the document in
// front, and where each document was scrolled to. Leaving a workspace and coming back — or
// quitting and reopening — shows it as it was left (state.json `views`, main/store/projects.cjs).
// The sidebar (2026-09-22, Canvas.dc.html and Add - Mention.dc.html) brings library items in through its search, adds
// new ones through its +, and takes them out on its trash (meta.json `removed`); the Browser's Save and the @ menu add
// the page in front. Its next row and ⌘J go to the workspace an agent waits in, else the one written in before
// (state.json `recent` and `agents`, model/nav.js); typing in a document here records this workspace as written in.
// Dragging the sidebar's edge resizes only the document; the right pane keeps its width until its own edge is dragged.
// Post-its (2026-09-22) float over all of it (post-its/ProjectPostIts.jsx).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IMAGE_REF_RE = /\]\(img:([\w-]+)\)/g;
const MENTION_RE = /@\[([^\]\n]+)\](?!\(ws:)/g; // a note or a library row by its name; `@[Name](ws:<id>)` is a workspace
const SAVE_DELAY = 400;
const EASE = 'cubic-bezier(.25,.1,.25,1)';

const basename = (value) => String(value || '').split('/').pop();

function copiedLabel(copied) {
  const parts = ['Copied'];
  if (copied.files) parts.push(`${copied.files} file${copied.files === 1 ? '' : 's'}`);
  if (copied.missing) parts.push(`${copied.missing} missing`);
  return parts.join(' · ');
}

function describe(row) {
  const kind = kindOf(row);
  let summary;
  if (isNote(row)) summary = 'A note in this project.';
  else if (hasTag(row, 'git')) summary = row.folder_path ? `Cloned at ${row.folder_path}` : (row.url || 'A repository.');
  else if (row.type === 'website') summary = row.url || 'A linked page.';
  else summary = row.folder_path || (row.path ? basename(row.path) : '');
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

const WS_TAB = { id: 'ws', title: 'Workspace' };
const VIEW_SAVE_DELAY = 400;

/**
 * A workspace's remembered tabs, less notes that are gone, with their current names; `extra` is a note being opened
 * into it. The Workspace tab is the only workspace document in the strip (2026-09-25: "I should not be able to have two
 * workspace tabs open"); another workspace's tab remembered from the 2026-09-23 build is left behind.
 */
function restoredTabs(view, notesById, extra) {
  const tabs = [WS_TAB];
  for (const tab of (view && view.tabs) || []) {
    if (tabs.some((held) => held.id === tab.id) || tab.kind === 'workspace') continue;
    const row = notesById.get(tab.id);
    if (row) tabs.push({ id: tab.id, title: row.name });
  }
  if (extra && !tabs.some((held) => held.id === extra.id)) tabs.push(extra);
  const active = extra ? extra.id : view && tabs.some((tab) => tab.id === view.active) ? view.active : 'ws';
  return { tabs, active };
}

/** Every workspace of the tree by id, with its parent. */
function indexWorkspaces(roots) {
  const map = new Map();
  const walk = (list, parent) => { for (const node of list || []) { map.set(node.id, { node, parent }); walk(node.children, node); } };
  walk(roots, null);
  return map;
}

export default function Workspace({ tree, library, initialWorkspaceId, initialTab, initialViews, initialStage, style, active, reload, onClose, onHome, onVisit, onOpenElsewhere, onError }) {
  const project = tree.project;
  const index = React.useMemo(() => indexWorkspaces(tree.workspaces), [tree.workspaces]);
  const notesById = React.useMemo(() => new Map(library.filter(isNote).map((row) => [row.id, row])), [library]);
  const views = React.useRef(initialViews || {}); // workspace id → { active, tabs, positions }
  const [wantedId, setTopicId] = React.useState(initialWorkspaceId || null);
  const topicId = wantedId && index.has(wantedId) ? wantedId : (tree.workspaces[0] ? tree.workspaces[0].id : null);
  const here = topicId ? index.get(topicId) : null;
  const topics = here ? (here.parent ? here.parent.children : tree.workspaces) : tree.workspaces; // the current workspace's siblings
  const ancestors = [];
  for (let up = here && here.parent; up; up = index.get(up.id).parent) ancestors.unshift(up);
  const allWorkspaces = React.useMemo(() => flatWorkspaces(tree.workspaces), [tree.workspaces]);
  const [railWidth, setRailWidth] = React.useState(300);
  const [rightWidth, setRightWidth] = React.useState(null); // px, or null: half of what the sidebar leaves
  const [viewWidth, setViewWidth] = React.useState(() => window.innerWidth || 1440);
  React.useEffect(() => {
    const measure = () => setViewWidth(window.innerWidth || 1440);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const [opening] = React.useState(() => restoredTabs(topicId ? views.current[topicId] : null, notesById, initialTab || null));
  const [tabs, setTabs] = React.useState(opening.tabs);
  const [activeTab, setActiveTab] = React.useState(opening.active);
  const [docs, setDocs] = React.useState({});
  const [rightMode, setRightMode] = React.useState('stage');
  const stageRef = React.useRef(null);
  const [stageFull, setStageFull] = React.useState(false); // the Stage takes the document's place
  const [stageFront, setStageFront] = React.useState(null); // the library row the Stage shows in front, for the sidebar
  const showStage = React.useCallback(() => setRightMode('stage'), []);
  // A link clicked in the terminal opens on the Stage (which adds the tab); the pane turns to show it.
  React.useEffect(() => {
    const show = () => setRightMode('stage');
    window.addEventListener(OPEN_IN_BROWSER, show);
    return () => window.removeEventListener(OPEN_IN_BROWSER, show);
  }, []);
  const [flashId, setFlashId] = React.useState(null); // a row that just arrived in the sidebar
  const flashTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = React.useCallback((id) => { clearTimeout(flashTimer.current); setFlashId(id); flashTimer.current = setTimeout(() => setFlashId(null), 1700); }, []);
  const [postItDrag, setPostItDrag] = React.useState({ active: false, over: false });
  const [postItTrash, setPostItTrash] = React.useState(0); // how many post-its are in the trash (main keeps them a week)
  const onPostItDrag = React.useCallback((drag) => { setPostItDrag({ active: !!drag.active, over: !!drag.over }); }, []);
  const [openPage, setOpenPage] = React.useState(null); // the page in front in the Browser: { input, title } | null
  const [pageInfo, setPageInfo] = React.useState(null); // what the library holds for it: { input, row, addable }
  const [renaming, setRenaming] = React.useState(null);
  const [images, setImages] = React.useState({}); // library image id → object URL
  const [titleDraft, setTitleDraft] = React.useState('');
  const editorRef = React.useRef(null);
  const wantTitleFocus = React.useRef(false); // a topic or note was just created: the caret belongs in its title
  const pending = React.useRef(new Map());
  const railBox = React.useRef(null);
  const rightBox = React.useRef(null);

  const topic = topics.find((candidate) => candidate.id === topicId) || null;
  // The document in front: this workspace's (the Workspace tab) or a note's.
  const docWorkspaceId = activeTab === 'ws' ? (topic ? topic.id : null) : null;
  const docKey = docWorkspaceId ? `ws:${docWorkspaceId}` : activeTab === 'ws' ? null : `note:${activeTab}`;
  const docRef = React.useMemo(() => {
    if (!docKey) return null;
    return docWorkspaceId ? { kind: 'workspace', workspaceId: docWorkspaceId } : { kind: 'note', id: activeTab };
  }, [docKey, docWorkspaceId, activeTab]);

  // Remember where we are, so the app reopens here.
  React.useEffect(() => { if (topic && onVisit) onVisit(topic.id); }, [topic && topic.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- views */

  // A workspace's view is saved a moment after it changes, and at once when the editor lets go of a document.
  const viewTimers = React.useRef(new Map());
  const saveView = React.useCallback((workspaceId, now) => {
    clearTimeout(viewTimers.current.get(workspaceId));
    viewTimers.current.delete(workspaceId);
    const send = () => { viewTimers.current.delete(workspaceId); const view = views.current[workspaceId]; if (view) api.setView(project.id, workspaceId, view).catch(() => {}); };
    if (now) send(); else viewTimers.current.set(workspaceId, setTimeout(send, VIEW_SAVE_DELAY));
  }, [project.id]);
  React.useEffect(() => () => {
    for (const [workspaceId, timer] of viewTimers.current) { clearTimeout(timer); const view = views.current[workspaceId]; if (view) api.setView(project.id, workspaceId, view).catch(() => {}); }
    viewTimers.current.clear();
  }, [project.id]);
  // The tabs and the document in front, whenever either changes (switching workspace swaps both at once).
  React.useEffect(() => {
    if (!topicId) return;
    const held = views.current[topicId] || { positions: {} };
    const open = tabs.filter((tab) => tab.id !== 'ws').map((tab) => ({ id: tab.id, title: tab.title }));
    if (held.active === activeTab && JSON.stringify(held.tabs) === JSON.stringify(open)) return;
    views.current[topicId] = { ...held, active: activeTab, tabs: open };
    saveView(topicId);
  }, [topicId, tabs, activeTab, saveView]);
  // Where a document was scrolled to, in the workspace it was read in (the editor says which).
  const recordPosition = React.useCallback(({ scope, key, position, now }) => {
    const held = views.current[scope] || { active: 'ws', tabs: [], positions: {} };
    const positions = { ...held.positions };
    delete positions[key]; // the most recent last: the oldest go first when there are too many
    positions[key] = position;
    views.current[scope] = { ...held, positions };
    saveView(scope, now);
  }, [saveView]);
  const viewOf = React.useCallback((scope, key) => (views.current[scope] && views.current[scope].positions[key]) || null, []);

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
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    pending.current.delete(key);
    return api.writeDoc(project.id, entry.ref, entry.text).catch((error) => onError(error));
  }, [project.id, onError]);

  // A document's text changes: from the editor (the open one), or from an @bart answer (any of them).
  const changeDoc = React.useCallback((key, ref, text) => {
    setDocs((current) => ({ ...current, [key]: text }));
    const previous = pending.current.get(key);
    if (previous) clearTimeout(previous.timer);
    pending.current.set(key, { ref, text, timer: setTimeout(() => flush(key), SAVE_DELAY) });
  }, [flush]);

  // Typing here makes this the workspace written in last (state.json `recent`): told at once when it was another one, then
  // at most every half minute. Only what is typed counts, not an answer landing or the editor tidying its ends.
  const mainRef = React.useRef(null);
  const lastEdit = React.useRef({ id: null, at: 0 });
  const onDocChange = React.useCallback((text) => {
    if (docKey && docRef) changeDoc(docKey, docRef, text);
    const typed = mainRef.current && mainRef.current.contains(document.activeElement);
    const now = Date.now(), last = lastEdit.current;
    const wrote = topic && topic.id;
    if (!typed || !wrote || (last.id === wrote && now - last.at < 30000)) return;
    lastEdit.current = { id: wrote, at: now };
    api.recordEdit(project.id, wrote).catch(() => {});
  }, [docKey, docRef, changeDoc, topic, project.id]);

  React.useEffect(() => () => {
    for (const key of [...pending.current.keys()]) flush(key);
  }, [flush]);

  /* ----------------------------------------------------------------- @bart */

  // A question leaves the editor as { askId, text } with a pending line `bart~> <askId>` already under it. The agent reads
  // the documents from disk, so everything is saved first. Its answer replaces the pending line in whatever that document's
  // text is by then, open or not; Stop removes the line; progress (which model, what it is doing, the answer so far) shows on the pending row.
  // A follow-up also carries `turns`, the earlier turns of its exchange as the document holds them, and Regenerate may carry
  // `choice`, a model and effort for that run alone.
  const [asks, setAsks] = React.useState({});
  // What the @bart line's chip offers and what its flags are checked against. The files behind it are read again for every
  // question, so this is read again whenever the window comes back to the front.
  const [bartModels, setBartModels] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    const load = () => api.bartModels().then((models) => { if (live) setBartModels(models); }).catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, []);
  const docsRef = React.useRef(docs);
  docsRef.current = docs;

  // Progress is of three kinds: a step of the ladder begins ({ step, name, effort, movedUp }: whatever the last step showed
  // is dropped), what the agent is doing ({ activity }, kept in `log` when it is a thing done rather than a state), and the
  // answer so far ({ lines }). All of it lives here, never in the document: only the finished answer is written there.
  React.useEffect(() => api.onBartProgress(({ askId, log, ...progress }) => {
    setAsks((current) => {
      const ask = current[askId];
      if (!ask) return current;
      const next = { ...ask, ...progress };
      if (progress.step) { next.activity = ''; next.lines = []; }
      if (log && progress.activity) next.log = [...(ask.log || []), progress.activity].slice(-60);
      return { ...current, [askId]: next };
    });
  }), []);

  const askBart = React.useCallback(async ({ askId, text, turns, choice }) => {
    if (!docKey || !docRef || !topic) return;
    const key = docKey, ref = docRef;
    const place = (lines) => {
      const held = docsRef.current[key];
      if (typeof held !== 'string') return;
      const all = held.split('\n'), at = all.indexOf(`bart~> ${askId}`);
      if (at < 0) return; // the pending line was undone away: there is nowhere to put the answer
      all.splice(at, 1, ...lines);
      changeDoc(key, ref, all.join('\n'));
    };
    setAsks((current) => ({ ...current, [askId]: { docKey: key } }));
    try {
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // let the pending line reach `pending` before flushing it
      await Promise.all([...pending.current.keys()].map((held) => flush(held)));
      const out = await api.askBart(project.id, { askId, ref, workspaceId: ref.kind === 'workspace' ? ref.workspaceId : topic.id, text, turns: turns || [], choice: choice || null });
      place(out.stopped ? [] : out.lines);
    } catch (error) {
      place([`bart> **No answer.** ${errorMessage(error)}`]);
    } finally {
      setAsks((current) => { const next = { ...current }; delete next[askId]; return next; });
    }
  }, [docKey, docRef, topic, project.id, flush, changeDoc]);

  // Copy (the document's lower left, plain text since 2026-09-23; it was a picture in the sidebar): the open document with
  // every @mentioned file's content placed where it is mentioned. It is read from disk, so every open tab is saved first.
  const [copied, setCopied] = React.useState(null);
  const copiedTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const copyDoc = React.useCallback(async () => {
    if (!docRef) return;
    try {
      await Promise.all([...pending.current.keys()].map((key) => flush(key)));
      setCopied(await api.copyDoc(project.id, docRef));
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1800);
    } catch (error) {
      onError(error);
    }
  }, [docRef, flush, project.id, onError]);

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

  const activeRowId = activeTab !== 'ws' ? activeTab : (rightMode === 'stage' && stageFront ? stageFront : 'ws');

  const rows = React.useMemo(() => {
    const out = [];
    if (!topic) return out;
    const present = new Set(topic.removed || []); // thrown away (the trash): not on this rail, whatever would put it there
    for (const id of topic.context) {
      const row = byId.get(id);
      if (!row || present.has(row.id)) continue;
      present.add(row.id);
      out.push({ ...row, depth: 0, on: activeRowId === row.id, editing: renaming === row.id });
    }
    for (const note of tree.notes || []) {
      if (note.workspaceId === topic.id && !present.has(note.id)) {
        present.add(note.id);
        out.push({ id: note.id, name: note.name, type: 'md', tags: ['note'], depth: 0, on: activeRowId === note.id, editing: renaming === note.id });
      }
    }
    for (const row of mentioned) {
      if (!present.has(row.id)) {
        present.add(row.id);
        out.push({ ...row, depth: 0, on: activeRowId === row.id, editing: renaming === row.id });
      }
    }
    for (const child of here ? here.node.children || [] : []) out.push({ id: child.id, name: child.name, type: 'child', depth: 0, on: activeRowId === child.id, editing: renaming === child.id });
    return out;
  }, [topic, here, byId, renaming, activeRowId, tree.notes, mentioned]);

  const mentionable = React.useMemo(() => [BART_ITEM, TASK_ITEM, ...library.filter((row) => row.type !== 'image').map(describe)], [library]);

  // On the rail: what the search does not offer again, and what makes the Browser's Save read ✓.
  const railIds = React.useMemo(() => new Set(rows.filter((row) => row.type !== 'child').map((row) => row.id)), [rows]);
  const inRail = React.useCallback((id) => railIds.has(id), [railIds]);

  // The page in front in the Browser, and what the library holds for it (asked again whenever the library changes).
  React.useEffect(() => {
    if (!openPage) { setPageInfo(null); return undefined; }
    let live = true;
    const input = openPage.input;
    api.lookupLibraryItem(input)
      .then((answer) => { if (live) setPageInfo({ input, row: answer.row || null, addable: !answer.error }); })
      .catch(() => { if (live) setPageInfo({ input, row: null, addable: false }); });
    return () => { live = false; };
  }, [openPage && openPage.input, library]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageKnown = openPage && pageInfo && pageInfo.input === openPage.input && pageInfo.addable ? pageInfo : null;
  const pageState = pageKnown ? (pageKnown.row ? (railIds.has(pageKnown.row.id) ? 'here' : 'lib') : 'none') : null;

  /* --------------------------------------------------------------- opening */

  // A note as a tab; `behind` adds it without bringing it to the front.
  const openTab = React.useCallback((id, title, behind) => {
    setTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, { id, title }]));
    if (!behind) setActiveTab(id);
  }, []);

  // Any tab closes, Workspace too, while another is left (Stage design, 2026-09-23); the workspace's name in the sidebar
  // brings it back, first again (showWs).
  const closeTab = (id) => {
    flush(id === 'ws' ? (topic ? `ws:${topic.id}` : '') : `note:${id}`);
    setTabs((current) => {
      if (current.length < 2 && current.some((tab) => tab.id === id)) return current;
      const next = current.filter((tab) => tab.id !== id);
      if (activeTab === id) setActiveTab(next[next.length - 1].id);
      return next;
    });
  };
  const showWs = React.useCallback(() => {
    setTabs((current) => (current.some((tab) => tab.id === 'ws') ? current : [WS_TAB, ...current]));
    setActiveTab('ws');
  }, []);

  // Dragging a note tab onto another takes its place; Workspace is not part of the shuffle.
  const moveTab = React.useCallback((id, overId) => {
    setTabs((current) => {
      const from = current.findIndex((tab) => tab.id === id);
      const to = current.findIndex((tab) => tab.id === overId);
      if (from < 0 || to < 0 || id === 'ws' || overId === 'ws' || from === to) return current;
      const next = [...current];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }, []);

  // Anything that is not a note opens on the Stage: a pdf, a page, a repository's address, a file of any kind.
  const openItem = React.useCallback((row) => {
    if (!row || row.id === 'chat') return;
    if (row.type === 'workspace') { showWs(); return; }
    if (isNote(row)) { openTab(row.id, row.name); return; }
    if (!onStage(row) || !stageRef.current) return;
    setRightMode('stage');
    stageRef.current.openRow(row);
  }, [openTab, showWs]);
  // A link in a document goes to the Stage too, never to the default browser.
  const openLink = React.useCallback((href) => {
    if (!stageRef.current) return;
    setRightMode('stage');
    stageRef.current.openInput(href);
  }, []);
  // Opened from the all-projects screen: shown once the Stage is there.
  React.useEffect(() => { if (initialStage && stageRef.current) openItem(initialStage); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onRowClick = (row) => {
    if (row.type === 'child') { selectTopic(row.id); return; }
    openItem(row);
  };

  /* ---------------------------------------------------------------- topics */

  // Going to another workspace opens what it had open when it was left; its own name again opens its document.
  const selectTopic = (id) => {
    if (id === topicId) { showWs(); return; }
    const restored = restoredTabs(views.current[id], notesById, null);
    setTopicId(id);
    setTabs(restored.tabs);
    setActiveTab(restored.active);
  };

  /* ------------------------------------------------------------ next place */

  // The recent workspaces and the agents (state.json, read again whenever the main process says they changed).
  const [nav, setNav] = React.useState({ recent: [], agents: [] });
  React.useEffect(() => {
    let live = true;
    const load = () => api.nav().then((value) => { if (live && value) setNav(value); }).catch(() => {});
    load();
    const off = api.onNav(load);
    return () => { live = false; off(); };
  }, []);
  // Being in a workspace is looking at whatever an agent left there.
  React.useEffect(() => {
    if (!active || !topic) return;
    if (nav.agents.some((agent) => agent.status === 'waiting' && agent.projectId === project.id && agent.workspaceId === topic.id)) api.seenAgents(project.id, topic.id).catch(() => {});
  }, [active, nav, topic && topic.id, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = React.useMemo(() => {
    const place = nextPlace({ here: topic ? { projectId: project.id, workspaceId: topic.id } : null, recent: nav.recent, agents: nav.agents });
    if (!place || place.projectId !== project.id) return place;
    const held = index.get(place.workspaceId);
    return held ? { ...place, name: held.node.name } : null; // this project's names are the tree's, current after a rename
  }, [nav, topic, project.id, index]);
  // The @ menu: Bart, Task, Note, the open page, the project's other workspaces (written in last first), then the library
  // (model/rail.js).
  const mentionSpaces = React.useMemo(() => {
    const order = new Map();
    nav.recent.forEach((entry, i) => { if (entry.projectId === project.id && !order.has(entry.workspaceId)) order.set(entry.workspaceId, i); });
    const rank = (workspace) => (order.has(workspace.id) ? order.get(workspace.id) : Infinity);
    return allWorkspaces.map((workspace, i) => ({ workspace, i })).sort((a, b) => rank(a.workspace) - rank(b.workspace) || a.i - b.i).map(({ workspace }) => workspace);
  }, [allWorkspaces, nav.recent, project.id]);
  const mentionItems = React.useCallback(
    (query) => mentionRows({ query, library, page: pageKnown ? openPage : null, pageRow: pageKnown ? pageKnown.row : null, workspaces: mentionSpaces, hereId: topic ? topic.id : null }),
    [library, openPage, pageKnown, mentionSpaces, topic],
  );
  // A mentioned workspace's peek (workspace/WorkspacePeek.jsx): the tree, state.json's agents and recent edits, and its
  // document as open here (unsaved words included) or as saved.
  const peekRef = React.useRef(null);
  peekRef.current = { nav, docs, index };
  const workspacePeek = React.useMemo(() => ({
    info: (id) => {
      const { nav: held, index: tree } = peekRef.current;
      const at = tree.get(id);
      if (!at) return null;
      const above = [];
      for (let up = at.parent; up; up = tree.get(up.id).parent) above.unshift(up.name);
      const theirs = held.agents.filter((agent) => agent.projectId === project.id && agent.workspaceId === id);
      const bart = theirs.some((agent) => agent.status === 'waiting') ? 'waiting' : theirs.some((agent) => agent.status === 'running') ? 'running' : null;
      const edit = held.recent.find((entry) => entry.projectId === project.id && entry.workspaceId === id);
      return { name: at.node.name, above, bart, editedAt: edit ? edit.at : null };
    },
    read: (id) => {
      const open = peekRef.current.docs[`ws:${id}`];
      return open !== undefined ? Promise.resolve(open) : api.readDoc(project.id, { kind: 'workspace', workspaceId: id });
    },
  }), [project.id]);
  // A click on a workspace's mention goes there (the one workspace in the strip changes; nothing opens beside it).
  const openMentionedWorkspace = (id) => { if (index.has(id)) selectTopic(id); };
  // All of them, for the next row's hover list; this project's by the tree's names, gone ones left out.
  const places = React.useMemo(() => placesToGo({ here: topic ? { projectId: project.id, workspaceId: topic.id } : null, recent: nav.recent, agents: nav.agents }).flatMap((place) => {
    if (place.projectId !== project.id) return [place];
    const held = index.get(place.workspaceId);
    return held ? [{ ...place, name: held.node.name }] : [];
  }), [nav, topic, project.id, index]);
  const goTo = (place) => {
    if (!place) return;
    if (place.projectId === project.id) selectTopic(place.workspaceId);
    else if (onOpenElsewhere) onOpenElsewhere(place.projectId, place.workspaceId);
  };
  // ⌘J, wherever the keyboard is: the app's pages see it in the capture phase, before the editor or a terminal can; a
  // Browser page has the main process send it (src/main/browser/views.cjs).
  const goNext = React.useRef(null);
  goNext.current = () => goTo(next);
  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== 'j') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) goNext.current();
    };
    window.addEventListener('keydown', onKey, true);
    const off = api.onNextWorkspace(() => goNext.current());
    return () => { window.removeEventListener('keydown', onKey, true); off(); };
  }, [active]);

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

  const renameTopic = async (name) => {
    if (!topic) return;
    try {
      await api.renameWorkspace(project.id, topic.id, name);
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  /* --------------------------------------------------------------- sidebar */
  // Everything that brings a library item into this workspace links it (context, and off `removed`); adding makes the
  // row first and is refused when the library already holds the thing (library.addItem). The row that arrives flashes.

  const linkIds = async (ids) => {
    if (!topic || !ids.length) return;
    await api.linkToWorkspace(project.id, topic.id, ids);
    await reload();
    flash(ids[ids.length - 1]);
  };

  const addInput = async (input, name) => {
    if (!topic) throw new Error('Open a workspace first');
    const row = await api.addLibraryItem(input, name ? { name } : undefined);
    await linkIds([row.id]);
    return row;
  };

  // "Choose from disk…": every file and folder picked, each its own row; what could not be added is said, the rest is linked.
  const pickFromDisk = async () => {
    const paths = await api.pickLibraryPaths();
    const problems = [];
    const ids = [];
    for (const file of paths || []) {
      try { ids.push((await api.addLibraryItem(file)).id); } catch (error) { problems.push(errorMessage(error)); }
    }
    await linkIds(ids);
    return problems;
  };

  // A note made from the sidebar's + or the @ menu's Note: named after what was typed, else untitled; made here. Every new
  // note opens as a tab (2026-09-23): in front with the caret in its title from the +, behind the document from the @
  // menu, whose line is still being typed.
  const makeNote = async (name, openIt) => {
    const given = String(name || '').trim();
    const note = await api.createNote(project.id, { name: given || nextUntitled('Note', (tree.notes || []).map((candidate) => candidate.name)), workspaceId: topic.id });
    await linkIds([note.id]);
    if (openIt && !given) wantTitleFocus.current = true;
    openTab(note.id, note.name, !openIt);
    return note;
  };

  // A workspace nested in this one, from the +'s Sub-Workspace: made, then gone into, the caret in its title. It opened
  // as a tab here from 2026-09-23 until 2026-09-25, when one workspace in the strip became the rule.
  const makeChild = async () => {
    const created = await api.createWorkspace(project.id, { name: nextUntitled('Workspace', (here && here.node.children ? here.node.children : []).map((candidate) => candidate.name)), parentId: topic.id });
    await reload();
    wantTitleFocus.current = true;
    selectTopic(created.id);
  };

  // A repository picked from the +'s GitHub view: the library's row for it comes in, else it is added by its address
  // (signed in, so a private one gets its GitHub id too).
  const pickRepo = async ({ repo, row }) => {
    if (row) await linkIds([row.id]);
    else await addInput(repo.url);
  };

  // The search: something already here opens; anything else in the library comes in; an address or a path is added first.
  const searchPick = async (result, typed) => {
    if (!topic) return;
    if (result.kind === 'item' && railIds.has(result.row.id)) openItem(result.row);
    else if (result.kind === 'item') await linkIds([result.row.id]);
    else if (result.kind === 'fresh') await addInput(typed);
  };

  // The trash: off this workspace, not out of the library. A note's tab closes and a paper leaves the right pane.
  const trashRow = async (row) => {
    if (!topic) return;
    try {
      await api.unlinkFromWorkspace(project.id, topic.id, row.id);
      if (tabs.some((tab) => tab.id === row.id)) closeTab(row.id);
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  // An item picked from the @ menu comes into this workspace; the open page is added to the library first, under the name the mention carries.
  const mentionPicked = (item) => {
    if (!topic) return;
    const done = item.kind === 'fresh' ? addInput(item.input, item.name) : item.row ? linkIds([item.row.id]) : null;
    if (done) done.catch((error) => onError(error));
  };

  // The Browser's Save: the page as a new row, named in the card, into the library alone or also into this workspace.
  const savePage = async (name, here) => {
    if (!openPage) return;
    // a pdf read from the web is kept as a copy (<data root>/assets/pdfs), its address beside it; anything else is linked
    const row = openPage.bytes ? await api.addLibraryPdf(openPage.input, openPage.bytes, { name }) : await api.addLibraryItem(openPage.input, { name });
    if (here) await linkIds([row.id]);
    else await reload();
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
        if (docWorkspaceId) await api.renameWorkspace(project.id, docWorkspaceId, next);
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
      if (renaming) { setRenaming(null); return; }
      if (editorRef.current && editorRef.current.isActive && editorRef.current.isActive()) return;
      if (inTerminal) return;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tabs, renaming, onClose]);

  /* --------------------------------------------------------------- resizing */

  // (Add - Mention.dc.html, 2026-09-22) The sidebar is 220–520px; dragging its edge resizes the document only, the right
  // pane keeping its width. The right pane's own edge moves between the document and it (the right pane at least 320px,
  // the document at least 280px). The header's columns follow both. Double-click an edge for its default.
  const RAIL_MIN = 220, RAIL_MAX = 520, DOC_MIN = 280, RIGHT_MIN = 320;
  const railRoom = Math.max(RAIL_MIN, viewWidth - 2 - DOC_MIN - RIGHT_MIN);
  const rail = clamp(railWidth, RAIL_MIN, Math.min(RAIL_MAX, railRoom));
  const rightRoom = Math.max(RIGHT_MIN, viewWidth - rail - 2 - DOC_MIN);
  const right = clamp(rightWidth == null ? Math.round((viewWidth - rail - 2) / 2) : rightWidth, RIGHT_MIN, rightRoom);
  const pointerUp = (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const railDown = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    railBox.current = event.currentTarget.parentElement.getBoundingClientRect();
    if (rightWidth == null) setRightWidth(right); // from here the right pane keeps the width it has
  };
  const railMove = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = railBox.current || event.currentTarget.parentElement.getBoundingClientRect();
    setRailWidth(clamp(event.clientX - box.left, RAIL_MIN, Math.min(RAIL_MAX, Math.max(RAIL_MIN, viewWidth - 2 - DOC_MIN - right))));
  };
  const rightDown = (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); rightBox.current = event.currentTarget.parentElement.getBoundingClientRect(); };
  const rightMove = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = rightBox.current || event.currentTarget.parentElement.getBoundingClientRect();
    setRightWidth(clamp(Math.round(box.right - event.clientX - 1), RIGHT_MIN, rightRoom));
  };
  // The Stage's full screen: it takes the document's place (its header column too); the sidebar stays. Only while it is in front.
  const full = stageFull && rightMode === 'stage';
  const paneWidth = full ? Math.max(RIGHT_MIN, viewWidth - rail - 1) : right;

  // Where the trash can is, for the post-its (main/post-its/views.cjs throws away a card let go over it): sent whenever it
  // may have moved, and none while this screen is not showing.
  const trashEl = React.useRef(null);
  const trashRef = React.useCallback((element) => { trashEl.current = element; }, []);
  React.useEffect(() => {
    const send = () => {
      const r = active && trashEl.current ? trashEl.current.getBoundingClientRect() : null;
      api.postItsTrashRect(r && r.width && r.height ? { x: r.left, y: r.top, width: r.width, height: r.height } : null).catch(() => {});
    };
    send();
    if (!active) return undefined;
    const observer = new ResizeObserver(send);
    if (trashEl.current) observer.observe(trashEl.current);
    window.addEventListener('resize', send);
    return () => { observer.disconnect(); window.removeEventListener('resize', send); };
  }, [active, rail, viewWidth]);

  const text = docKey ? docs[docKey] : undefined;
  const headWide = rail >= 260;

  const header = (
    <input
      ref={(element) => { if (element && wantTitleFocus.current) { wantTitleFocus.current = false; element.focus(); } }}
      value={titleDraft}
      onChange={(event) => setTitleDraft(event.target.value.replace(/[/\\]/g, '-'))} // a title is a file name: slashes become hyphens as you type
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
      <header className="title-bar" style={{ display: 'flex', alignItems: 'stretch', minHeight: 54, background: '#fafafa', flex: 'none' }}>
        <div className="title-lead" style={{ flex: 'none', width: rail, boxSizing: 'border-box', borderBottom: '1px solid #eaeaea', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', minWidth: 0, overflow: 'hidden' }}>
          <button type="button" onClick={onHome} title="All projects" style={{ flex: 'none', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>
          <span style={{ flex: 'none', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
          <span title={project.directory || project.dir} style={{ flex: '0 4 auto', minWidth: 20, font: '400 14px/1.3 var(--font-sans)', color: '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
          {headWide && ancestors.map((ancestor, i) => (
            <React.Fragment key={ancestor.id}>
              <span style={{ flex: 'none', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
              <button type="button" className="hov-ink" onClick={() => selectTopic(ancestor.id)} title={ancestor.name} data-ancestor={ancestor.id} style={{ flex: i === ancestors.length - 1 ? '0 1 auto' : '0 5 auto', minWidth: i === ancestors.length - 1 ? 44 : 16, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '400 14px/1.3 var(--font-sans)', color: isUntitled(ancestor.name) ? '#8f8f8f' : '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'color 120ms' }}>{ancestor.name}</button>
            </React.Fragment>
          ))}
          {/* Where you are ends the trail, as in any breadcrumb, and goes nowhere; the names before it go up (2026-09-22). */}
          {headWide && topic && (
            <>
              <span style={{ flex: 'none', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
              <span title={topic.name} data-crumb-here={topic.id} style={{ flex: '0 2 auto', minWidth: 32, font: '500 14px/1.3 var(--font-sans)', color: isUntitled(topic.name) ? '#8f8f8f' : '#171717', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'default' }}>{topic.name}</span>
            </>
          )}
        </div>
        <div style={{ flex: 'none', width: 1, background: '#eaeaea' }} />
        {/* The document's tabs, drawn as the Stage's (2026-09-25): no rule under them; the tab in front runs into the page. */}
        <div data-doc-strip="1" style={{ flex: '1 1 0', minWidth: 0, boxSizing: 'border-box', display: full ? 'none' : 'flex', alignItems: 'flex-end', padding: '0 8px 0 10px', overflow: 'hidden' }}>
          <div style={{ flex: '0 1 auto', minWidth: 0, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
            <DocTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} onClose={closeTab} onMove={moveTab} />
          </div>
          {topic && <button type="button" className="hov-tab-plus" onClick={() => { makeNote('', true).catch(onError); }} aria-label="New note tab" title="new note" style={{ flex: 'none', alignSelf: 'flex-end', width: 28, height: 28, margin: '0 0 3px 6px', padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#4d4d4d', transition: 'background 120ms' }}>+</button>}
        </div>
        <div style={{ flex: 'none', width: 1, background: '#eaeaea', display: full ? 'none' : undefined }} />
        <div style={{ flex: 'none', width: paneWidth, minWidth: 0, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', overflow: 'hidden' }}>
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
          allWorkspaces={allWorkspaces}
          onOpenDoc={showWs}
          onSelectTopic={selectTopic}
          onRenameTopic={renameTopic}
          onAddTopic={() => addTopic(false)}
          rows={rows}
          flashId={flashId}
          onRowClick={onRowClick}
          onRowRenameStart={(row) => setRenaming(row.id)}
          onRowRename={renameRow}
          onRowRenameEnd={() => setRenaming(null)}
          library={library}
          inRail={inRail}
          onSearchPick={searchPick}
          onAddInput={(input) => addInput(input)}
          onPickDisk={pickFromDisk}
          onNewNote={() => makeNote('', true)}
          onNewChild={makeChild}
          onPickRepo={pickRepo}
          onOpenHeld={(projectId, workspaceId) => { if (projectId === project.id && workspaceId && index.has(workspaceId)) selectTopic(workspaceId); }}
          onTrashRow={trashRow}
          trashFull={!!(topic && topic.removed && topic.removed.length) || postItTrash > 0}
          postItTrash={active ? { count: postItTrash, load: () => api.postItsTrashed(project.id), restore: (id) => api.postItsRestore(project.id, id) } : null}
          postItDrag={postItDrag}
          trashRef={trashRef}
          next={next}
          projectId={project.id}
          onGoNext={goTo}
          places={places}
          onPostIt={active ? () => api.postItsCreate(project.id).catch(onError) : null}
        />

        <Separator onDown={railDown} onMove={railMove} onUp={pointerUp} onReset={() => setRailWidth(300)} />

        <main ref={mainRef} style={{ flex: '1 1 0', minWidth: DOC_MIN, minHeight: 0, display: full ? 'none' : 'flex', flexDirection: 'column', position: 'relative' }}>
          {docKey && text !== undefined ? (
            <DocEditor
              ref={editorRef}
              docKey={docKey}
              text={text}
              onChange={onDocChange}
              mentionable={mentionable}
              mentionItems={mentionItems}
              onMentionPicked={mentionPicked}
              workspacePeek={workspacePeek}
              onOpenWorkspace={openMentionedWorkspace}
              onNoteVerb={(name) => makeNote(name, false)}
              onOpenItem={openItem}
              onOpenLink={openLink}
              buildSpeed="normal"
              images={images}
              onPasteImage={pasteImage}
              asks={asks}
              models={bartModels}
              onCopyText={(value) => api.copyText(value)}
              onAsk={askBart}
              onStopAsk={(askId) => api.stopBart(askId).catch((error) => onError(error))}
              viewScope={topic ? topic.id : null}
              viewOf={viewOf}
              onView={recordPosition}
              header={header}
              footer={(
                <button
                  type="button"
                  className="hov-ink"
                  data-copy-doc="1"
                  onClick={copyDoc}
                  title={docWorkspaceId ? 'Copy current workspace' : 'Copy current note'}
                  style={{ marginLeft: -6, padding: '3px 6px', border: 0, borderRadius: 5, background: '#fff', cursor: 'pointer', font: '400 15px/1.4 var(--font-sans)', color: copied ? '#171717' : '#8f8f8f', transition: 'color 120ms' }}
                >
                  {copied ? copiedLabel(copied) : 'Copy'}
                </button>
              )}
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

        {!full && <Separator onDown={rightDown} onMove={rightMove} onUp={pointerUp} onReset={() => setRightWidth(null)} />}

        <RightPane
          ref={stageRef}
          mode={rightMode}
          onError={onError}
          projectDir={project.directory || null}
          projectId={project.id}
          full={full}
          onFull={() => setStageFull((on) => !on)}
          onShowStage={showStage}
          onPage={setOpenPage}
          onFront={setStageFront}
          library={library}
          inRail={inRail}
          save={topic && pageState ? { state: pageState, onSave: savePage, onLink: () => linkIds([pageKnown.row.id]) } : null}
          style={{ flex: 'none', width: paneWidth, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
        />
      </div>

      <ProjectPostIts
        projectId={project.id}
        active={active}
        onError={onError}
        onDrag={onPostItDrag}
        onTrashCount={setPostItTrash}
        // +Note on a card: a note in no workspace, opened here as a tab once the library knows it.
        onOpenNote={async ({ id, name }) => { await reload(); openTab(id, name); }}
      />
    </div>
  );
}
