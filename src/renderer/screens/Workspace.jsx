import React from 'react';
import { api, errorMessage } from '../api.js';
import Rail from '../workspace/Rail.jsx';
import DocTabs from '../workspace/DocTabs.jsx';
import NotePicker from '../workspace/NotePicker.jsx';
import { BART_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM } from '../workspace/DocEditor.jsx';
import DocPane from '../workspace/DocPane.jsx';
import RightPane, { RIGHT_MODES } from '../workspace/RightPane.jsx';
import { kindOf, Expand, Collapse } from '../ui/Icons.jsx';
import { hasTag, isNote } from '../model/kind.js';
import { isUntitled, nextUntitled } from '../model/names.js';
import { OPEN_IN_BROWSER } from '../model/address.js';
import { adoptSession, dropSession, SHOW_TERMINAL } from '../terminal/sessions.js';
import { letGoNotes, mentionRows } from '../model/rail.js';
import { useBodies } from '../workspace/useBodies.js';
import { flatWorkspaces, nextPlace, placesToGo } from '../model/nav.js';
import { onStage, savesPageCopy } from '../model/stage.js';
import { paperState, savePaper, repoState, tryRepo } from '../model/guide.js';
import { buildLine, placeAnswer } from '../model/doc.js';
import { openBeside, closePane } from '../model/panes.js';
import { addDropped } from '../model/drop.js';
import { createDocSync } from '../model/doc-sync.js';
import { askEntry, answerOf, continueLines, runningBack } from '../pdf/canvas.js';
import { buildRequestOf } from '../../main/bart/question.cjs';
import ProjectPostIts from '../post-its/ProjectPostIts.jsx';
import BuildPanel from '../workspace/BuildPanel.jsx';
import BuildReject from '../workspace/BuildReject.jsx';
import BuildReview from '../workspace/BuildReview.jsx';
import PostItBuild from '../post-its/PostItBuild.jsx';
import PostItTask from '../post-its/PostItTask.jsx';
import { useSandboxes } from '../ui/SandboxProgress.jsx';
import { repositoryClick, OPEN_SANDBOX_TERMINAL } from '../model/sandbox-notifications.js';

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
// The middle column (MATH-23) can take the whole window: the document's full screen hides the sidebar and the right pane,
// the reverse of the Stage's. A note's or a workspace's mention clicked in a document opens its document in a pane to the
// right, Andy Matuschak's working notes style (model/panes.js, workspace/DocPane.jsx): two panes at most, side by side,
// each half the column; a mention clicked in the right one replaces it. Switching tab or workspace closes it.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IMAGE_REF_RE = /\]\(img:([\w-]+)\)/g;
const MENTION_RE = /@\[([^\]\n]+)\](?!\(ws:)/g; // a note or a library row by its name; `@[Name](ws:<id>)` is a workspace
const SAVE_DELAY = 400;
const EASE = 'cubic-bezier(.25,.1,.25,1)';

const basename = (value) => String(value || '').split('/').pop();
// Why a question from a highlight's note got no answer, as its box says it: the reply's words without "No answer.".
const paperFailure = (lines) => answerOf(lines).answer.replace(/^\*\*No answer\.\*\*\s*/, '');

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
const ARCHIVE_TAB = 'archive:'; // an archived version's tab (2026-09-27: it opens in the middle, read-only, not on the Stage)
const FOOT_BUTTON = { padding: '3px 6px', border: 0, borderRadius: 5, background: '#fff', cursor: 'pointer', font: '400 15px/1.4 var(--font-sans)', color: '#8f8f8f', transition: 'color 120ms' };
const VIEW_SAVE_DELAY = 400;
const PANE_MIN = 240; // px: a column too narrow for two of these side by side scrolls sideways instead (MATH-23)
const NO_PANES = [];
const noView = () => null; // a document beside the one in front keeps no scroll position: it opens at its top
const POST_ITS_HIDDEN = 'engelbart.postIts.hidden';

/**
 * The document a tab stands for in this workspace (`topic`): its key in `docs` and what main reads it by (`ref`), with
 * the workspace whose document it is or the archived version's file. A note beside the document is its note's tab.
 */
const workspaceDoc = (id) => ({ key: `ws:${id}`, ref: { kind: 'workspace', workspaceId: id }, workspaceId: id, archive: null });
function docOf(tabId, topic) {
  if (tabId === 'ws') return topic ? workspaceDoc(topic.id) : { key: null, ref: null, workspaceId: null, archive: null };
  if (tabId.startsWith(ARCHIVE_TAB)) {
    if (!topic) return { key: null, ref: null, workspaceId: null, archive: null };
    const file = tabId.slice(ARCHIVE_TAB.length);
    return { key: `archive:${topic.id}:${file}`, ref: { kind: 'archive', workspaceId: topic.id, file }, workspaceId: null, archive: file };
  }
  return { key: `note:${tabId}`, ref: { kind: 'note', id: tabId }, workspaceId: null, archive: null };
}

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

export default function Workspace({ tree, library, initialWorkspaceId, initialTab, initialViews, initialStage, style, active, reload, onClose, onHome, onVisit, onError }) {
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
  const [notePlus, setNotePlus] = React.useState(null); // the +'s note menu beside the tabs: the +'s rect while it is open
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
  const [stageFull, setStageFull] = React.useState(false); // the right pane (the Stage or the terminal) takes the document's place
  // The document takes the whole window (MATH-23): no sidebar, no right pane. Never with the Stage's full screen: turning
  // either on turns the other off.
  const [docFull, setDocFull] = React.useState(false);
  const toggleStageFull = () => { if (!stageFull) setDocFull(false); setStageFull(!stageFull); };
  // What is in front in the Stage when @bart is asked (MATH-27): only while the Stage shows; main reads a pdf's ink from it.
  const stageShown = React.useRef(false);
  stageShown.current = rightMode === 'stage' && !docFull;
  const stageNow = React.useCallback(() => {
    if (!stageShown.current || !stageRef.current || typeof stageRef.current.front !== 'function') return null;
    try { return stageRef.current.front(); } catch { return null; }
  }, []);
  const toggleDocFull = () => { if (!docFull) setStageFull(false); setDocFull(!docFull); };
  // What opens on the right (the Stage or the terminal) brings the right pane back from the document's full screen.
  const showRight = React.useCallback((mode) => { setRightMode(mode); setDocFull(false); }, []);
  const [stageFront, setStageFront] = React.useState(null); // the library row the Stage shows in front, for the sidebar
  const showStage = React.useCallback(() => showRight('stage'), [showRight]);
  // A link clicked in the terminal opens on the Stage (which adds the tab); the pane turns to show it.
  React.useEffect(() => {
    const show = () => showRight('stage');
    window.addEventListener(OPEN_IN_BROWSER, show);
    return () => window.removeEventListener(OPEN_IN_BROWSER, show);
  }, [showRight]);
  // What a Build's run step got running (main/build/run-step.cjs), opened from Review: a web UI in a Stage tab, a terminal
  // program's session (main's) in the terminal. A desktop app's window comes forward by itself (main).
  React.useEffect(() => api.onBuildRun((event) => {
    if (event && event.kind === 'closed' && event.sessionId) { dropSession(event.sessionId); return; }
    if (!event || event.projectId !== project.id) return;
    if (event.kind === 'ui' && event.url) window.dispatchEvent(new CustomEvent(OPEN_IN_BROWSER, { detail: { url: event.url } }));
    else if (event.kind === 'terminal' && event.session) {
      adoptSession(event.session, project.id).then(() => {
        showRight('terminal');
        window.dispatchEvent(new CustomEvent(SHOW_TERMINAL, { detail: { id: event.session.id } }));
      }).catch(() => {});
    }
  }), [project.id, showRight]);
  // A shell in a repository's sandbox (SandboxProgress.jsx's openTerminal): a tab of this project's terminal pane, the
  // one already there when it was open, shown in front unless the preview is (`show`).
  React.useEffect(() => {
    const onOpen = (event) => {
      const { session, show } = event.detail || {};
      if (!session || !session.id) return;
      adoptSession(session, project.id).then(() => {
        if (show) showRight('terminal');
        window.dispatchEvent(new CustomEvent(SHOW_TERMINAL, { detail: { id: session.id } })); // its tab, in front in the pane
      }).catch(() => {});
    };
    window.addEventListener(OPEN_SANDBOX_TERMINAL, onOpen);
    return () => window.removeEventListener(OPEN_SANDBOX_TERMINAL, onOpen);
  }, [project.id, showRight]);
  const [flashId, setFlashId] = React.useState(null); // a row that just arrived in the sidebar
  const flashTimer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flash = React.useCallback((id) => { clearTimeout(flashTimer.current); setFlashId(id); flashTimer.current = setTimeout(() => setFlashId(null), 1700); }, []);
  const [postItDrag, setPostItDrag] = React.useState({ active: false, over: false });
  const [postItTrash, setPostItTrash] = React.useState(0); // how many post-its are in the trash (main keeps them a week)
  const onPostItDrag = React.useCallback((drag) => { setPostItDrag({ active: !!drag.active, over: !!drag.over }); }, []);
  // The toggle at the sticky note's lower right (2026-09-25): all post-its out of sight or back, remembered across launches.
  const [postItsHidden, setPostItsHidden] = React.useState(() => { try { return window.localStorage.getItem(POST_ITS_HIDDEN) === '1'; } catch { return false; } });
  React.useEffect(() => { try { window.localStorage.setItem(POST_ITS_HIDDEN, postItsHidden ? '1' : '0'); } catch { /* not remembered */ } }, [postItsHidden]);
  const showPostIts = React.useCallback(() => setPostItsHidden(false), []);
  const [openPage, setOpenPage] = React.useState(null); // the page in front in the Browser: { input, title, bytes, tabId, webPage } | null
  const [pageInfo, setPageInfo] = React.useState(null); // what the library holds for it: { input, row, addable, found }
  const [renaming, setRenaming] = React.useState(null);
  const [images, setImages] = React.useState({}); // library image id → object URL
  // Each pane's editor (pane 0: the document in front), for Escape and the title's Enter.
  const editorRefs = React.useRef([]);
  const editorRefAt = (i) => editorRefs.current[i] || (editorRefs.current[i] = React.createRef());
  const wantTitleFocus = React.useRef(false); // a topic or note was just created: the caret belongs in its title
  const pending = React.useRef(new Map());
  const railBox = React.useRef(null);
  const rightBox = React.useRef(null);

  const topic = topics.find((candidate) => candidate.id === topicId) || null;
  // The document open beside the one in front (model/panes.js): closed whenever the workspace or the tab in front changes.
  const [beside, setBeside] = React.useState(NO_PANES);
  const besideFor = `${topicId || ''}\n${activeTab}`;
  const [besideHeldFor, setBesideHeldFor] = React.useState(besideFor);
  if (besideHeldFor !== besideFor) { setBesideHeldFor(besideFor); setBeside(NO_PANES); }
  // Every pane's document. Pane 0 is the one in front: this workspace's (the Workspace tab), an archived version of it
  // (read-only), or a note's. Pane 1, beside it, is a note's, as that note's tab would be, or another workspace's.
  const paneDocs = React.useMemo(() => [docOf(activeTab, topic), ...beside.map((pane) => (pane.kind === 'workspace' ? workspaceDoc(pane.id) : docOf(pane.id, topic)))], [activeTab, topic && topic.id, beside]); // eslint-disable-line react-hooks/exhaustive-deps
  const { key: docKey, ref: docRef, workspaceId: docWorkspaceId, archive: docArchive } = paneDocs[0];

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

  // Every pane's document is read once, when first shown; a read under way is not asked again while another pane is typed in.
  const reading = React.useRef(new Set()); // doc keys being read
  React.useEffect(() => {
    for (const { key, ref } of paneDocs) {
      if (!key || !ref || docs[key] !== undefined || reading.current.has(key)) continue;
      reading.current.add(key);
      const read = ref.kind === 'archive' ? api.readArchive(project.id, ref.workspaceId, ref.file).then((got) => got.text) : api.readDoc(project.id, ref);
      read.then((text) => {
        setDocs((current) => (current[key] === undefined ? { ...current, [key]: text } : current));
      }).catch((error) => onError(error)).finally(() => { reading.current.delete(key); });
    }
  }, [paneDocs, docs, project.id, onError]);

  // The same document open in another window (2026-10-03, model/doc-sync.js): main announces each save that changed it.
  // With no edits of this window's own waiting to be saved, the new text is taken. With some, nothing is lost silently:
  // their save waits until the person picks, in a notice over the document, Keep mine (written over theirs) or Take
  // theirs (these edits are dropped).
  const conflictsRef = React.useRef({}); // doc key → { text, revision }: saved elsewhere over edits here
  const [conflicts, setConflicts] = React.useState({});
  const putConflict = React.useCallback((key, change) => {
    const next = { ...conflictsRef.current };
    if (change) next[key] = change; else delete next[key];
    conflictsRef.current = next;
    setConflicts(next);
  }, []);
  const docSync = React.useRef(null);
  if (!docSync.current) {
    docSync.current = createDocSync({
      hasEdits: (key) => pending.current.has(key),
      take: (key, text) => setDocs((current) => (current[key] === undefined || current[key] === text ? current : { ...current, [key]: text })),
      conflict: (key, change) => putConflict(key, change),
    });
  }
  React.useEffect(() => api.onDocChanged((change) => {
    if (change && change.projectId === project.id && typeof change.key === 'string') docSync.current.announced(change.key, change);
  }), [project.id]);

  const flush = React.useCallback((key) => {
    const entry = pending.current.get(key);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    if (conflictsRef.current[key]) return undefined; // until Keep mine or Take theirs
    pending.current.delete(key);
    docSync.current.saving(key);
    let revision;
    return api.writeDoc(project.id, entry.ref, entry.text)
      .then((out) => { revision = out && out.revision; })
      .catch((error) => onError(error))
      .finally(() => { docSync.current.saved(key, revision); });
  }, [project.id, onError]);

  const keepMine = React.useCallback((key) => {
    const held = conflictsRef.current[key];
    if (!held) return;
    docSync.current.seen(key, held.revision);
    putConflict(key, null);
    flush(key);
  }, [flush, putConflict]);
  const takeTheirs = React.useCallback((key) => {
    const held = conflictsRef.current[key];
    if (!held) return;
    const entry = pending.current.get(key);
    if (entry) { clearTimeout(entry.timer); pending.current.delete(key); }
    putConflict(key, null);
    docSync.current.seen(key, held.revision);
    setDocs((current) => ({ ...current, [key]: held.text }));
  }, [putConflict]);

  // A document's text changes: from an editor (any pane's), or from an @bart answer (any document).
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
  // A pane's editor changed its document (`key`, `ref`): a note typed in beside the document is still this workspace
  // written in; another workspace's document beside it is that workspace.
  const onDocChange = React.useCallback((key, ref, text) => {
    if (ref && ref.kind === 'archive') return; // an archived version is only read
    if (key && ref) changeDoc(key, ref, text);
    const typed = mainRef.current && mainRef.current.contains(document.activeElement);
    const now = Date.now(), last = lastEdit.current;
    const wrote = ref && ref.kind === 'workspace' ? ref.workspaceId : topic && topic.id;
    if (!typed || !wrote || (last.id === wrote && now - last.at < 30000)) return;
    lastEdit.current = { id: wrote, at: now };
    api.recordEdit(project.id, wrote).catch(() => {});
  }, [changeDoc, topic, project.id]);

  React.useEffect(() => () => {
    for (const key of [...pending.current.keys()]) flush(key);
  }, [flush]);
  // Leaving the project with a notice unanswered: the edits made here are what was on screen last, so they are saved.
  const flushRef = React.useRef(flush);
  flushRef.current = flush;
  React.useEffect(() => () => {
    const held = Object.keys(conflictsRef.current);
    conflictsRef.current = {};
    for (const key of held) flushRef.current(key);
  }, []);

  /* ----------------------------------------------------------------- @bart */

  // A question leaves the editor as { askId, text } with a pending line `bart~> <askId>` already under it. The agent reads
  // the documents from disk, so everything is saved first. Its answer replaces the pending line in whatever that document's
  // text is by then, open or not; Stop removes the line; progress (which model, what it is doing, the answer so far) shows on the pending row.
  // A follow-up also carries `turns`, the earlier turns of its exchange as the document holds them, and Regenerate may carry
  // `choice`, a model and effort for that run alone. `agent` is 'brainstorm' for an @brainstorm line (2026-09-30), and for
  // an older document's @orient line (2026-10-05), whose answers are cards the editor draws, and 'discover' for an
  // @discover line (a card or a reading guide); everything else about the run is the same. A question is asked of the pane it
  // was written in (`key`, `ref`): one in a note beside the document is answered in that note (MATH-23).
  const [asks, setAsks] = React.useState({});
  // What the @bart line's chip offers and what its flags are checked against. The files behind it are read again for every
  // question, so this is read again whenever the window comes back to the front, once a question has been sent (one
  // asked with a model picked by hand makes that where the next one starts; main: bart/choices.cjs), and after Settings
  // saves a default or clears a pick (ui/Settings.jsx, in any window).
  const [bartModels, setBartModels] = React.useState(null);
  const liveRef = React.useRef(true);
  const loadBartModels = React.useCallback(() => api.bartModels().then((models) => { if (liveRef.current) setBartModels(models); }).catch(() => {}), []);
  React.useEffect(() => {
    liveRef.current = true;
    loadBartModels();
    window.addEventListener('focus', loadBartModels);
    const off = api.onModelsChanged ? api.onModelsChanged(loadBartModels) : () => {};
    return () => { liveRef.current = false; window.removeEventListener('focus', loadBartModels); off(); };
  }, [loadBartModels]);
  const docsRef = React.useRef(docs);
  docsRef.current = docs;

  // Progress is of three kinds: a step of the ladder begins ({ step, name, effort, movedUp }: whatever the last step showed
  // is dropped), what the agent is doing ({ activity }, kept in `log` when it is a thing done rather than a state), and the
  // answer so far ({ lines }). All of it lives here, never in the document: only the finished answer is written there.
  // A question asked from a highlight's note on a pdf (MATH-27) is kept the same way in `paperAsks`, for the Stage.
  React.useEffect(() => api.onBartProgress(({ askId, log, ...progress }) => {
    const apply = (current) => {
      const ask = current[askId];
      if (!ask) return current;
      const next = { ...ask, ...progress };
      if (progress.step) { next.activity = ''; next.lines = []; }
      if (log && progress.activity) next.log = [...(ask.log || []), progress.activity].slice(-60);
      return { ...current, [askId]: next };
    };
    setAsks(apply);
    setPaperAsks(apply);
  }), []);

  // @bart from a note on a pdf's highlight (MATH-27): asked of this workspace with the mark as its place ({ kind: 'mark',
  // id, rowId | url, page }), the passage, the note and the page's text around the passage with it, and written into no
  // document. The entry here holds which mark and pdf it is for ({ markId, page, rowId | url }) and what it is doing,
  // which the Stage shows on the pdf; the
  // finished answer is returned to the Stage as the mark keeps it (pdf/canvas.js askEntry; main's own, which it has put on
  // the mark already). Stopped, it leaves nothing; a failure stays here, with its error, until it is closed.
  const [paperAsks, setPaperAsks] = React.useState({});
  const dropPaperAsk = React.useCallback((askId) => setPaperAsks((current) => {
    if (!current[askId]) return current;
    const next = { ...current };
    delete next[askId];
    return next;
  }), []);
  const failPaperAsk = React.useCallback((askId, message) => setPaperAsks((current) => (current[askId] ? { ...current, [askId]: { ...current[askId], error: message || 'The run failed.', activity: '', lines: [] } } : current)), []);
  const askHighlight = React.useCallback(async ({ markId, page, quote, note, question, turns, rowId, url, paper, pageText }) => {
    const text = String(question || '').trim();
    if (!topic || !markId || !text || (!rowId && !url)) return null;
    const askId = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setPaperAsks((current) => ({ ...current, [askId]: { askId, markId, page, rowId: rowId || null, url: rowId ? null : url, question: text, agent: 'bart' } }));
    try {
      const ref = rowId ? { kind: 'mark', id: markId, rowId, page } : { kind: 'mark', id: markId, url, page };
      const asked = api.askBart(project.id, { askId, ref, workspaceId: topic.id, text, turns: turns || [], highlight: { quote: quote || '', note: note || '', paper: paper || null, pageText: pageText || '' }, stage: stageNow() });
      loadBartModels(); // main has kept a pick by hand before this is read
      const out = await asked;
      if (out && out.stopped) { dropPaperAsk(askId); return null; }
      if (!out || out.failed || !Array.isArray(out.lines)) { failPaperAsk(askId, paperFailure(out && out.lines)); return null; }
      dropPaperAsk(askId);
      return out.entry || askEntry({ id: askId, question: text, lines: out.lines, meta: out.meta, at: new Date().toISOString() });
    } catch (error) {
      failPaperAsk(askId, errorMessage(error));
      return null;
    }
  }, [topic, project.id, loadBartModels, dropPaperAsk, failPaperAsk, stageNow]);
  // After ⌘R, or back in the project, the questions this window asked from highlights that are still running show their
  // boxes again as main keeps them (running-paper-asks), and their progress goes on into them. How each ended main tells
  // every window (paper-ask-done, second pass 2026-10-06): its box goes, its answer already on the mark (the Stage shows
  // it), or it says "No answer" and why. Ended ones are remembered, so a list read just before one ended brings back no box.
  const paperEnded = React.useRef(new Set());
  React.useEffect(() => {
    let live = true;
    const off = api.onPaperAskDone ? api.onPaperAskDone((done) => {
      if (!done || !done.askId) return;
      paperEnded.current.add(done.askId);
      if (done.failed) failPaperAsk(done.askId, paperFailure(done.lines)); else dropPaperAsk(done.askId);
    }) : () => {};
    if (api.runningPaperAsks) {
      api.runningPaperAsks(project.id).then((list) => {
        if (!live) return;
        setPaperAsks((current) => runningBack(current, list, paperEnded.current));
      }).catch(() => {});
    }
    return () => { live = false; off(); };
  }, [project.id, dropPaperAsk, failPaperAsk]);
  const pendingPaperAsks = React.useMemo(() => Object.values(paperAsks), [paperAsks]);

  const askBart = React.useCallback(async (key, ref, { askId, text, turns, choice, agent }) => {
    if (!key || !ref || !topic) return;
    const place = (lines) => {
      const held = docsRef.current[key];
      if (typeof held !== 'string') return;
      const next = placeAnswer(held, askId, lines);
      if (next !== null) changeDoc(key, ref, next);
    };
    const workspaceId = ref.kind === 'workspace' ? ref.workspaceId : topic.id;
    setAsks((current) => ({ ...current, [askId]: { docKey: key, agent: agent || 'bart' } }));
    // `@bart --build <request>` (2026-10-02): not a question. A full Build of only what follows the flag starts, and its
    // card takes the pending line's place, under the request.
    const build = buildRequestOf({ agent, text }, bartModels || await api.bartModels().catch(() => null));
    if (build) {
      try {
        if (!build.request) { place(['bart> **No Build.** Write what to build after --build.']); return; }
        await new Promise((resolve) => { setTimeout(resolve, 0); }); // as below: the pending line is saved with the rest
        await Promise.all([...pending.current.keys()].map((held) => flush(held)));
        const task = await api.buildStart(project.id, { workspaceId, text: build.request, fromLine: true });
        setBuilds((current) => ({ ...current, [task.id]: task }));
        place([buildLine(task.id)]);
      } catch (error) {
        place([`bart> **No Build.** ${errorMessage(error)}`]);
      } finally {
        setAsks((current) => { const next = { ...current }; delete next[askId]; return next; });
      }
      return;
    }
    try {
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // let the pending line reach `pending` before flushing it
      await Promise.all([...pending.current.keys()].map((held) => flush(held)));
      const asked = api.askBart(project.id, { askId, ref, workspaceId, text, turns: turns || [], choice: choice || null, agent: agent || 'bart', stage: stageNow() });
      loadBartModels(); // main has kept a pick by hand before this is read
      const out = await asked;
      place(out.stopped ? [] : out.lines);
    } catch (error) {
      place([`bart> **No answer.** ${errorMessage(error)}`]);
    } finally {
      setAsks((current) => { const next = { ...current }; delete next[askId]; return next; });
    }
  }, [topic, project.id, flush, changeDoc, loadBartModels, bartModels, stageNow]);

  /* ----------------------------------------------------------------- Build */

  // Build (2026-09-25; docs/superpowers/specs/2026-09-25-build-workflow-design.md): the project's Builds by id, as main
  // announces them, and what each running turn is doing. A workspace document holds a `build> <id>` line per Build, which
  // the editor draws as its card from these; the conversation lives in the Build's record, never in the document.
  const [builds, setBuilds] = React.useState({});
  const buildsRef = React.useRef(builds);
  buildsRef.current = builds;
  const [buildProgress, setBuildProgress] = React.useState({});
  // { anchor } while the workspace's Build panel is open above its Build button
  const [buildDialog, setBuildDialog] = React.useState(null);
  // What each Build has changed, for its card (2026-09-29: it replaced the Review dialog): { files, patch, truncated,
  // running } by id, sent by main after each thing a turn does and when it ends; read once for a card drawn before any.
  const [buildDiffs, setBuildDiffs] = React.useState({});
  const diffAsked = React.useRef(new Set());
  const [rejecting, setRejecting] = React.useState(null); // { id, title } while Reject asks to confirm
  const [review, setReview] = React.useState(null); // { id, title, review, error } while Preview's fallback dialog is open
  // A post-it's Build popup, and its quick task's card (Claude Design "Post-it Quick Task", 2026-09-27), each hanging from
  // the card's button that opened it: { postItId, text, anchor } and { id, postItId, anchor }. A second press on the same
  // button closes what it opened.
  const [postItBuild, setPostItBuild] = React.useState(null);
  const [quickTask, setQuickTask] = React.useState(null);
  const cardAnchor = (rect) => (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) ? { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height, width: rect.width } : null);
  // A post-it that was added to a workspace is a Build there: its state goes to the version it was put in as (2026-09-27).
  const goToVersionRef = React.useRef(null);
  React.useEffect(() => {
    if (!active) return undefined;
    const offAsk = api.onBuildQuick(({ projectId, postItId, text, button }) => {
      if (projectId !== project.id) return;
      setQuickTask(null);
      setPostItBuild((now) => (now && now.postItId === postItId ? null : { postItId, text, anchor: cardAnchor(button) }));
    });
    const offOpen = api.onBuildQuickOpen(({ projectId, id, postItId, button }) => {
      if (projectId !== project.id) return;
      const task = buildsRef.current[id];
      setPostItBuild(null);
      if (task && task.kind === 'build' && task.workspaceId && task.version) { setQuickTask(null); void goToVersionRef.current(task.workspaceId, task.version); }
      else setQuickTask((now) => (now && now.id === id ? null : { id, postItId, anchor: cardAnchor(button) }));
    });
    return () => { offAsk(); offOpen(); };
  }, [active, project.id]);
  React.useEffect(() => {
    let live = true;
    setBuilds({});
    api.buildList(project.id).then((list) => { if (live) setBuilds(Object.fromEntries(list.map((task) => [task.id, task]))); }).catch(() => {});
    const offBuild = api.onBuild((task) => {
      if (!task || task.projectId !== project.id) return;
      setBuilds((current) => ({ ...current, [task.id]: task }));
      // a turn that ended leaves nothing to show as progress
      if (!['running', 'queued', 'setting-up', 'accepting'].includes(task.status)) setBuildProgress((current) => { if (!current[task.id]) return current; const next = { ...current }; delete next[task.id]; return next; });
    });
    const offProgress = api.onBuildProgress(({ projectId, id, log, lines, ...progress }) => { // the card shows what it is doing, not the text so far
      if (projectId !== project.id || !progress.activity) return;
      setBuildProgress((current) => {
        const held = current[id] || {};
        const next = { ...held, ...progress };
        if (log && progress.activity) next.log = [...(held.log || []), progress.activity].slice(-80);
        return { ...current, [id]: next };
      });
    });
    const offDiff = api.onBuildDiff(({ projectId, id, ...diff }) => {
      if (projectId === project.id) setBuildDiffs((current) => ({ ...current, [id]: diff }));
    });
    return () => { live = false; offBuild(); offProgress(); offDiff(); };
  }, [project.id]);
  React.useEffect(() => { setBuildDiffs({}); diffAsked.current = new Set(); }, [project.id]);
  const wantBuildDiff = React.useCallback((id) => {
    if (diffAsked.current.has(id)) return;
    diffAsked.current.add(id);
    api.buildReview(project.id, id).then((diff) => setBuildDiffs((current) => (current[id] ? current : { ...current, [id]: diff }))).catch(() => {});
  }, [project.id]);

  // A post-it added to a workspace (2026-09-27: "it should take me to that workspace"): that workspace, with the archived
  // version the post-it was put in as open in the middle, where its Build's card is. Main has already made it one of ⌘J's
  // recent workspaces.
  const selectRef = React.useRef(null); // selectTopic and openTab, defined further down
  const openTabRef = React.useRef(null);
  const goToVersion = React.useCallback(async (workspaceId, version) => {
    await reload();
    if (!version) return;
    selectRef.current(workspaceId);
    openTabRef.current(`${ARCHIVE_TAB}${version.file}`, version.title);
  }, [reload]);
  goToVersionRef.current = goToVersion;

  // Send in the panel: the Build starts from what is saved, so everything open is saved first; its line goes at the end
  // of the workspace's document, and its card shows there at once. "Automatically clear workspace" then clears it, as
  // Clear does, after the Build froze what it is given: the blank document keeps the new card (2026-09-27).
  const startBuild = React.useCallback(async ({ clear = false, ...input }) => {
    await Promise.all([...pending.current.keys()].map((key) => flush(key)));
    if (!topic) throw new Error('Open a workspace first');
    const task = await api.buildStart(project.id, { workspaceId: topic.id, ...input });
    setBuilds((current) => ({ ...current, [task.id]: task }));
    const key = `ws:${topic.id}`, ref = { kind: 'workspace', workspaceId: topic.id };
    const held = docsRef.current[key] !== undefined ? docsRef.current[key] : await api.readDoc(project.id, ref);
    const body = String(held || '').replace(/\n+$/, '');
    changeDoc(key, ref, `${body ? `${body}\n\n` : ''}${buildLine(task.id)}\n`);
    setBuildDialog(null);
    if (clear && conflictsRef.current[key]) onError(new Error('Not cleared: this document was changed in another window. Keep yours or take theirs, then Clear.'));
    else if (clear) {
      try {
        await flush(key);
        const out = await api.clearWorkspace(project.id, topic.id);
        docSync.current.seen(key, out.revision);
        setDocs((current) => ({ ...current, [key]: out.text }));
        await reload();
      } catch (error) {
        onError(error);
      }
    } else if (input.attach && input.attach.length) await reload(); // what was attached is linked to the workspace: the sidebar shows it
  }, [flush, project.id, topic, changeDoc, reload, onError]);

  // The post-it's popup sends it as a quick task.
  const startQuick = React.useCallback(async (input) => {
    const quick = postItBuild;
    if (!quick) return;
    const task = await api.buildStart(project.id, { kind: 'quick', postItId: quick.postItId, text: quick.text, ...input });
    setBuilds((current) => ({ ...current, [task.id]: task }));
    setPostItBuild(null);
  }, [postItBuild, project.id]);

  // What a card's buttons do. Accept's refusals and a turn's failures are on the card (the record carries them); only a
  // call that could not be made at all is reported. → false when the call failed (the reply field keeps its text)
  const onBuildAction = React.useCallback(async (id, action, payload = {}) => {
    try {
      if (action === 'reply') await api.buildReply(project.id, id, payload.text, { interrupt: !!payload.interrupt, images: payload.images || [] });
      else if (action === 'stop') await api.buildStop(project.id, id);
      else if (action === 'resume') await api.buildResume(project.id, id);
      else if (action === 'fix') await api.buildFix(project.id, id);
      else if (action === 'discard') await api.buildDiscard(project.id, id);
      else if (action === 'accept') await api.buildAccept(project.id, id).catch(() => {}); // refused: the card says why
      else if (action === 'reject') setRejecting({ id, title: (builds[id] && builds[id].title) || '' });
      else if (action === 'runshow') await api.buildRunShow(project.id, id, payload.name); // its Stage tab or its terminal, again
      else if (action === 'runstop') await api.buildRunStop(project.id, id);
      else if (action === 'runstopone') await api.buildRunStopRunnable(project.id, id, payload.name); // an accepted Build's, on what landed
      else if (action === 'runstopall') await api.buildRunStopRunnable(project.id, id, null);
      else if (action === 'review') {
        const task = builds[id];
        const title = (task && task.title) || '';
        // The card's Preview (2026-09-29): what its run step got running opens in the Stage, and that is all it does; the
        // Review dialog (what did not run and why, the diff) opens only when nothing runs, or what runs could not be opened.
        const shown = ((task && task.runStep && task.runStep.runnables) || []).filter((item) => item.status === 'running' && item.type === 'ui');
        if (shown.length) {
          try {
            for (const item of [...shown].reverse()) await api.buildRunShow(project.id, id, item.name); // the first ends in front
            return true;
          } catch { /* stopped meanwhile: the dialog instead */ }
        }
        setReview({ id, title, review: null, error: '' });
        try { const got = await api.buildReview(project.id, id); setReview((now) => (now && now.id === id ? { ...now, review: got } : now)); } catch (error) { setReview((now) => (now && now.id === id ? { ...now, error: errorMessage(error) } : now)); }
      }
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }, [project.id, builds, onError]);

  // A quick task added to a workspace (the "Needs you" card): it becomes a Build of the workspace picked there, on the model
  // picked there, and its session goes on (main/build promote). Its post-it is put in as an archived version of that
  // workspace, and the workspace, with that version open, is where Engelbart goes; the post-it is thrown out (2026-09-29).
  const promoteQuick = React.useCallback(async (id, workspaceId, choice) => {
    const task = await api.buildPromote(project.id, id, workspaceId, choice);
    setBuilds((current) => ({ ...current, [task.id]: task }));
    return task;
  }, [project.id]);
  const goToTask = React.useCallback((task) => { if (task && task.version) goToVersion(task.workspaceId, task.version).catch(onError); }, [goToVersion, onError]);

  const closeBuildDialog = React.useCallback(() => setBuildDialog(null), []);
  const closePostItBuild = React.useCallback(() => setPostItBuild(null), []);
  const closeQuickTask = React.useCallback(() => setQuickTask(null), []);

  /* ----------------------------------------------------------------- Clear */

  // Clear (B21): the document is archived and starts blank (Builds still open keep their lines); everything it mentioned
  // stays on the sidebar. The editor's undo can still bring the text back, and Restore brings back any archived version.
  const clearDoc = React.useCallback(async () => {
    if (!topic || docKey !== `ws:${topic.id}`) return;
    const key = docKey;
    if (conflictsRef.current[key]) { onError(new Error('This document was changed in another window: keep yours or take theirs first.')); return; }
    try {
      await flush(key);
      const out = await api.clearWorkspace(project.id, topic.id);
      docSync.current.seen(key, out.revision);
      setDocs((current) => ({ ...current, [key]: out.text }));
      await reload();
    } catch (error) {
      onError(error);
    }
  }, [topic, docKey, flush, project.id, reload, onError]);

  // Restore (B22): the current document is archived first, then the chosen version is the document again.
  const restoreVersion = React.useCallback(async (file) => {
    if (!topic) return;
    const key = `ws:${topic.id}`;
    if (conflictsRef.current[key]) { onError(new Error('This document was changed in another window: keep yours or take theirs first.')); return; }
    try {
      await flush(key);
      const out = await api.restoreArchive(project.id, topic.id, file);
      docSync.current.seen(key, out.revision);
      setDocs((current) => ({ ...current, [key]: out.text }));
      showWs();
      await reload();
    } catch (error) {
      onError(error);
    }
  }, [topic, flush, project.id, reload, onError]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const openText = paneDocs.map((pane) => (pane.key ? docs[pane.key] || '' : '')).join('\n'); // every pane's
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
    // This workspace's earlier versions, one per Clear, newest first (2026-09-25; the sidebar's Archived section).
    for (const entry of [...(topic.archives || [])].reverse()) out.push({ id: `archive:${entry.file}`, name: entry.title || 'Untitled', type: 'archive', file: entry.file, clearedAt: entry.clearedAt, depth: 0, on: false, editing: false });
    return out;
  }, [topic, here, byId, renaming, activeRowId, tree.notes, mentioned]);

  // What the @ menu and the sidebar's search offer (MATH-58): the library less the notes trashed from their last
  // workspace. `mentionable`, which an @mention already written is opened by, keeps the whole library.
  const findable = React.useMemo(() => {
    const gone = letGoNotes({ workspaces: tree.workspaces, notes: tree.notes });
    return gone.size ? library.filter((row) => !gone.has(row.id)) : library;
  }, [library, tree.workspaces, tree.notes]);

  const mentionable = React.useMemo(() => [BART_ITEM, BRAINSTORM_ITEM, DISCOVER_ITEM, ...library.filter((row) => row.type !== 'image').map(describe)], [library]);

  // On the rail: what the search does not offer again, and what makes the Browser's Save read ✓.
  const railIds = React.useMemo(() => new Set(rows.filter((row) => row.type !== 'child' && row.type !== 'archive').map((row) => row.id)), [rows]);
  const inRail = React.useCallback((id) => railIds.has(id), [railIds]);

  // The page in front in the Browser, and what the library holds for it (asked again whenever the library changes).
  React.useEffect(() => {
    if (!openPage) { setPageInfo(null); return undefined; }
    let live = true;
    const input = openPage.input;
    api.lookupLibraryItem(input)
      .then((answer) => { if (live) setPageInfo({ input, row: answer.row || null, addable: !answer.error, found: answer.found || null }); })
      .catch(() => { if (live) setPageInfo({ input, row: null, addable: false, found: null }); });
    return () => { live = false; };
  }, [openPage && openPage.input, library]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageKnown = openPage && pageInfo && pageInfo.input === openPage.input && pageInfo.addable ? pageInfo : null;
  const pageState = pageKnown ? (pageKnown.row ? (railIds.has(pageKnown.row.id) ? 'here' : 'lib') : 'none') : null;
  // The same three states for each paper of an @discover guide (2026-10-02, model/guide.js), read again whenever the
  // library or the rail changes: a paper saved from the Stage reads ✓ in the guide too.
  const guidePaperState = React.useCallback((address) => paperState(library, address, inRail).state, [library, inRail]);
  // And for the repository a guide's Try line links (2026-10-04): its mark reads "Added" once the repository is here.
  const guideRepoState = React.useCallback((address) => repoState(library, address, inRail).state, [library, inRail]);

  /* --------------------------------------------------------------- opening */

  // A note as a tab; `behind` adds it without bringing it to the front.
  const openTab = React.useCallback((id, title, behind) => {
    setTabs((current) => (current.some((tab) => tab.id === id) ? current : [...current, { id, title }]));
    if (!behind) setActiveTab(id);
  }, []);

  openTabRef.current = openTab;

  // Any note's tab closes; Workspace is always there (2026-09-25; from 2026-09-23 it closed too while another tab was left).
  const closeTab = (id) => {
    if (id === 'ws') return;
    flush(`note:${id}`);
    setTabs((current) => {
      if (current.length < 2 && current.some((tab) => tab.id === id)) return current;
      const next = current.filter((tab) => tab.id !== id);
      if (activeTab === id) setActiveTab(next[next.length - 1].id);
      return next;
    });
  };
  const closeNotePlus = React.useCallback(() => setNotePlus(null), []);
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
  // `{ newTab: true }` (⌘-click in the library, MATH-16): a tab of its own even when one already shows it.
  const openItem = React.useCallback((row, options = {}) => {
    if (!row || row.id === 'chat') return;
    if (row.type === 'workspace') { showWs(); return; }
    if (isNote(row)) { openTab(row.id, row.name); return; }
    if (!onStage(row) || !stageRef.current) return;
    showRight('stage');
    stageRef.current.openRow(row, '', '', { newTab: !!options.newTab });
  }, [openTab, showWs, showRight]);
  // A link in a document goes to the Stage too, never to the default browser; `{ newTab: true }` (⌘-click), in a tab of its own.
  const openLink = React.useCallback((href, options) => {
    if (!stageRef.current) return;
    showRight('stage');
    stageRef.current.openInput(href, options);
  }, [showRight]);
  // What the window itself would open in a new window or tab (a ⌘-click on a link the editor does not handle): main sends
  // it here while this listens, not to the default browser (src/main/index.cjs, 2026-10-02). Not while the project's folder
  // is being asked for: the Stage under that is out of reach.
  React.useEffect(() => {
    if (!active) return undefined;
    return api.onStageOpenLink((link) => { if (link && link.url) openLink(link.url, { newTab: !!link.newTab }); });
  }, [active, openLink]);
  // Opened from the all-projects screen: shown once the Stage is there. `{ links }`: sites Onboarding's sign-in import said
  // to sign in to again, the first in the tab in front and the rest in tabs of their own.
  React.useEffect(() => {
    if (!initialStage || !stageRef.current) return;
    if (Array.isArray(initialStage.links)) initialStage.links.forEach((url, index) => openLink(url, { newTab: index > 0 }));
    else openItem(initialStage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sandboxes = useSandboxes();
  const onRowClick = (row, event) => {
    if (row.type === 'child') { selectTopic(row.id); return; }
    if (row.type === 'archive') { openTab(`${ARCHIVE_TAB}${row.file}`, row.name); return; }
    // A GitHub repository opens its live preview in the Stage, its sandbox's shell in the terminal pane, or both (the
    // preview in front, the terminal a tab behind it); one still building (or failed, or stopped) shows its build, and
    // one ended after a week unopened is built again, its progress in the same build details.
    const sandbox = sandboxes && hasTag(row, 'git') ? sandboxes.items[row.id] : null;
    const click = repositoryClick(sandbox);
    if (click === 'preview') { sandboxes.open(sandbox.run); return; }
    if (click === 'terminal') { sandboxes.openTerminal(sandbox.run); return; }
    if (click === 'both') { sandboxes.openTerminal(sandbox.run, { show: false }); sandboxes.open(sandbox.run); return; }
    if (click === 'start') { sandboxes.openBuild(row); sandboxes.act(sandbox.run, () => api.startSandbox(row.id)); return; }
    if (click === 'details') { sandboxes.openBuild(row); return; }
    openItem(row, { newTab: !!event && (event.metaKey || event.ctrlKey) });
  };

  /* ------------------------------------------------------- the pane beside */

  // A note's or a workspace's mention clicked in either pane opens its document in the pane beside the one in front
  // (model/panes.js), in place of what was there. One already in front is not opened again: the strip shows the pane in
  // front, as it does the pane beside once it is drawn (they move only when the column is too narrow for both). ⌘-click
  // still opens a note's tab and goes to a workspace (DocEditor).
  const besideFront = activeTab === 'ws' ? (topic ? { kind: 'workspace', id: topic.id } : null) : activeTab.startsWith(ARCHIVE_TAB) ? null : { kind: 'note', id: activeTab };
  const reveal = React.useRef(null); // the pane to scroll to after the next draw
  const revealPane = (i) => {
    const main = mainRef.current;
    if (main && main.scrollTo && main.scrollWidth > main.clientWidth) main.scrollTo({ left: i ? main.scrollWidth : 0, behavior: 'smooth' });
  };
  const openDocBeside = (item, link) => {
    if (!item || !item.id) return;
    const workspace = item.kind === 'workspace' ? index.get(item.id) : null;
    if (item.kind === 'workspace' && !workspace) return; // a workspace that is gone
    const { panes: next, at } = openBeside(beside, besideFront, { kind: item.kind, id: item.id, title: workspace ? workspace.node.name : item.name }, link);
    if (at == null) return;
    if (next === beside) { revealPane(at); return; }
    reveal.current = at;
    setBeside(next);
  };
  React.useEffect(() => {
    if (reveal.current == null) return;
    const at = reveal.current;
    reveal.current = null;
    revealPane(at);
  }, [beside]);
  // Its ×: the pane beside closes; what was typed in it is saved now.
  const closeBeside = (at) => {
    for (const doc of paneDocs.slice(at)) if (doc.key) flush(doc.key);
    setBeside((current) => closePane(current, at));
  };
  // A note renamed from its title, in front or beside: its tab, if it has one, and its pane take the new name.
  const renameNoteDoc = async (id, name) => {
    try {
      const renamed = await api.renameNote(project.id, id, name);
      setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, title: renamed.name } : tab)));
      setBeside((current) => current.map((pane) => (pane.kind !== 'workspace' && pane.id === id ? { ...pane, title: renamed.name } : pane)));
      await reload();
    } catch (error) {
      onError(error);
    }
  };
  // Another workspace's document beside, renamed from its title: its pane takes the name the tree has after it.
  const renameWorkspaceBeside = async (id, name) => {
    try {
      await api.renameWorkspace(project.id, id, name);
      setBeside((current) => current.map((pane) => (pane.kind === 'workspace' && pane.id === id ? { ...pane, title: name } : pane)));
      await reload();
    } catch (error) {
      onError(error);
    }
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
  selectRef.current = selectTopic;

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
  // The next row and ⌘J go only to this project's workspaces (2026-10-01); state.json keeps the other projects' places, and
  // their own windows show them. Filtered before nextPlace, which picks one: a pick from another project would empty the row.
  const navHere = React.useMemo(() => ({
    recent: nav.recent.filter((entry) => entry.projectId === project.id),
    agents: nav.agents.filter((agent) => agent.projectId === project.id),
  }), [nav, project.id]);
  const next = React.useMemo(() => {
    const place = nextPlace({ here: topic ? { projectId: project.id, workspaceId: topic.id } : null, recent: navHere.recent, agents: navHere.agents });
    const held = place && index.get(place.workspaceId);
    return held ? { ...place, name: held.node.name } : null; // the names are the tree's, current after a rename
  }, [navHere, topic, project.id, index]);
  // The @ menu: Bart, Task, Note, the open page, the project's other workspaces (written in last first), then the library
  // (model/rail.js).
  const mentionSpaces = React.useMemo(() => {
    const order = new Map();
    nav.recent.forEach((entry, i) => { if (entry.projectId === project.id && !order.has(entry.workspaceId)) order.set(entry.workspaceId, i); });
    const rank = (workspace) => (order.has(workspace.id) ? order.get(workspace.id) : Infinity);
    return allWorkspaces.map((workspace, i) => ({ workspace, i })).sort((a, b) => rank(a.workspace) - rank(b.workspace) || a.i - b.i).map(({ workspace }) => workspace);
  }, [allWorkspaces, nav.recent, project.id]);
  // What the project's things say, asked for while the menu is open (MATH-29): a pdf, a note or a workspace is found by a
  // phrase inside it too.
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const mentionBodies = useBodies(project.id, mentionOpen);
  const mentionItems = React.useCallback(
    (query) => mentionRows({ query, library: findable, page: pageKnown ? openPage : null, pageRow: pageKnown ? pageKnown.row : null, workspaces: mentionSpaces, hereId: topic ? topic.id : null, bodies: mentionBodies }),
    [findable, openPage, pageKnown, mentionSpaces, topic, mentionBodies],
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
  // A ⌘-click on a workspace's mention goes there (the one workspace in the strip changes); a click opens its document
  // beside this one (openDocBeside).
  const openMentionedWorkspace = (id) => { if (index.has(id)) selectTopic(id); };
  // All of them, for the next row's hover list: by the tree's names, gone ones left out.
  const places = React.useMemo(() => placesToGo({ here: topic ? { projectId: project.id, workspaceId: topic.id } : null, recent: navHere.recent, agents: navHere.agents }).flatMap((place) => {
    const held = index.get(place.workspaceId);
    return held ? [{ ...place, name: held.node.name }] : [];
  }), [navHere, topic, project.id, index]);
  const goTo = (place) => { if (place) selectTopic(place.workspaceId); };
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

  // Delete, from the switcher (2026-09-30): the workspace and all nested in it go into the trash, restorable there for a
  // week. When the one open here is among them, the one above it opens instead (else the one below, else its parent).
  const deleteTopic = async (id) => {
    const at = index.get(id);
    if (!at) return;
    try {
      await Promise.all([...pending.current.keys()].map((key) => flush(key)));
      await api.trashWorkspace(project.id, id);
      let inside = false;
      for (let up = here; up && !inside; up = up.parent ? index.get(up.parent.id) : null) inside = up.node.id === id;
      if (inside) {
        const level = at.parent ? at.parent.children : tree.workspaces;
        const i = level.findIndex((candidate) => candidate.id === id);
        const instead = level[i - 1] || level[i + 1] || at.parent;
        if (instead) selectTopic(instead.id);
        else { setTopicId(null); setTabs([WS_TAB]); setActiveTab('ws'); }
      }
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  // Restore, in the trash: the workspace back where it was, and open.
  const restoreTopic = async (id) => {
    await api.restoreWorkspace(project.id, id);
    await reload();
    selectTopic(id);
  };

  /* --------------------------------------------------------------- sidebar */
  // Everything that brings a library item into this workspace links it (context, and off `removed`); adding makes the
  // row first and is refused when the library already holds the thing (library.addItem). The row that arrives flashes.

  // A GitHub repository that comes in starts its sandbox (src/main/sandbox); one that could not start is still added and
  // linked, and says why.
  const linkIds = async (ids) => {
    if (!topic || !ids.length) return;
    const linked = await api.linkToWorkspace(project.id, topic.id, ids);
    await reload();
    flash(ids[ids.length - 1]);
    if (linked && linked.sandbox_error) onError(new Error(linked.sandbox_error));
  };

  const addInput = async (input, name) => {
    if (!topic) throw new Error('Open a workspace first');
    const row = await api.addLibraryItem(input, name ? { name } : undefined);
    await linkIds([row.id]);
    if (row.sandbox_error) onError(new Error(row.sandbox_error));
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

  // Dropped on the sidebar's library rows or into the document (MATH-19): files from Finder, a picture or a link from a
  // browser (model/drop.js), each its own row, in order, then all linked here; what could not be added is said.
  const addDroppedHere = async (items) => {
    const { rows: made, problems } = await addDropped(items, { api, errorMessage });
    try {
      if (topic) await linkIds(made.map((row) => row.id));
      else if (made.length) await reload();
    } catch (error) {
      problems.push(errorMessage(error));
    }
    for (const row of made) if (row.sandbox_error) problems.push(`${row.name}: ${row.sandbox_error}`);
    if (problems.length) onError(new Error(problems.join(' · ')));
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

  // Continue in workspace on a highlight's answer (MATH-27): the passage, the @bart question and the answer at the end of
  // this workspace's document as a thread like any other (pdf/canvas.js continueLines), so it goes on here. The paper is
  // mentioned, and a library paper comes into the workspace as a mention brings it.
  const continueAsk = async ({ quote, question, answer, foot, paper, page }) => {
    if (!topic) return;
    const key = `ws:${topic.id}`, ref = { kind: 'workspace', workspaceId: topic.id };
    try {
      const held = docsRef.current[key] !== undefined ? docsRef.current[key] : await api.readDoc(project.id, ref);
      const body = String(held || '').replace(/\n+$/, '');
      changeDoc(key, ref, `${body ? `${body}\n\n` : ''}${continueLines({ quote, question, answer, foot, paper, page }).join('\n')}\n`);
      showWs();
      if (paper && paper.rowId && !inRail(paper.rowId)) await linkIds([paper.rowId]);
    } catch (error) {
      onError(error);
    }
  };

  // A paper's button in an @discover guide (2026-10-02): + Save adds it as the Stage's Save with Enter does when the tab
  // has no copy (the address, named with its title, linked here; main keeps its pdf straight away), + Workspace links the
  // library's row. Two clicks never make two rows: the second finds it here, or main refuses it as already in the library.
  const saveGuidePaper = ({ address, title }) => savePaper({ address, title, library, inRail }, { addInput, linkIds });
  // A guide's Try link (2026-10-04), after its page opened in the Stage: the repository comes into this workspace, which
  // starts its sandbox in main. A new one is added by its address and named by the library (owner/repo); one the library
  // has is linked, never added twice. A sandbox that could not start is said by addInput and linkIds.
  const tryGuideRepo = ({ address }) => tryRepo({ address, library, inRail }, { addInput, linkIds });

  // The Browser's Save: the page as a new row, named in the card, into the library alone or also into this workspace.
  const savePage = async (name, here) => {
    if (!openPage) return;
    // A pdf read from the web is kept as a copy (<data root>/assets/pdfs), and so is a plain web page, as its tab shows it
    // (assets/pages, MATH-17), each with its address beside it; anything else is linked. A page that cannot be kept says
    // why and adds nothing: it is not linked instead.
    let row;
    if (openPage.bytes) row = await api.addLibraryPdf(openPage.input, openPage.bytes, { name });
    else if (savesPageCopy(openPage, pageKnown && pageKnown.found)) {
      try { row = await api.addLibraryPage(openPage.tabId, openPage.input, { name }); } catch (error) { onError(error); return; }
    } else row = await api.addLibraryItem(openPage.input, { name });
    if (here) await linkIds([row.id]);
    else await reload();
    if (row.sandbox_error) onError(new Error(row.sandbox_error));
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
  // The title of the document in front named anew (its pane, DocPane, holds the draft): the workspace, or the note.
  const renameDoc = async (next) => {
    if (docArchive) return;
    if (activeTab !== 'ws') { await renameNoteDoc(activeTab, next); return; }
    try {
      if (docWorkspaceId) await api.renameWorkspace(project.id, docWorkspaceId, next);
      await reload();
    } catch (error) {
      onError(error);
    }
  };

  /* --------------------------------------------------------------- keyboard */

  // ⌘1–9 switch the tabs of whichever side was clicked last (MATH-12, 2026-10-06): the documents in the middle, or the Stage.
  // A press anywhere else (the library, the header) leaves it as it was.
  const lastSide = React.useRef('doc');
  React.useEffect(() => {
    const onDown = (event) => {
      const at = event.target && event.target.closest ? event.target : null; if (!at) return;
      if (at.closest('[data-stage]')) lastSide.current = 'stage';
      else if (at.closest('[data-terminal]')) lastSide.current = 'terminal';
      else if (at.closest('[data-doc-pane], [data-doc-strip]')) lastSide.current = 'doc';
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  React.useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => {
      const target = event.target;
      const inTerminal = target && target.closest && target.closest('[data-terminal]');
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !inTerminal && /^[1-9]$/.test(event.key)) {
        if (lastSide.current === 'terminal' && rightMode === 'terminal') return; // the Terminal's own tabs (TerminalPane)
        if (lastSide.current === 'stage' && rightMode === 'stage' && stageRef.current) {
          event.preventDefault();
          stageRef.current.tabAt(Number(event.key) - 1);
          return;
        }
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          setActiveTab(tab.id);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      if (renaming) { setRenaming(null); return; }
      // The document's full screen (MATH-23): Escape leaves it only when nothing else used it. What had the key goes first:
      // the caret leaves its line, the @ menu or a card's field shuts (DocEditor marks those as used), a dialog closes
      // (they stop the key). Then a menu open with the key elsewhere shuts, then a focused field is left; the next Escape
      // leaves the full screen. From there it never closes the workspace.
      if (docFull) {
        if (event.defaultPrevented) return;
        if (notePlus) { setNotePlus(null); return; }
        if (editorRefs.current.some((ref) => ref && ref.current && ref.current.shutMenus && ref.current.shutMenus())) return;
        if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) { if (target.blur) target.blur(); return; }
        setDocFull(false);
        return;
      }
      if (event.defaultPrevented) return;
      // The editor of the pane the key was pressed in (the document's, when it was pressed outside them all).
      const pane = target && target.closest ? target.closest('[data-doc-pane]') : null;
      const editor = (editorRefs.current[pane ? Number(pane.dataset.docPane) : 0] || {}).current;
      if (editor && editor.isActive && editor.isActive()) return;
      if (inTerminal) return;
      if (target && target.closest && target.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, tabs, rightMode, renaming, docFull, notePlus, onClose]);

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
  // The right pane's full screen: the Stage or the terminal, whichever is in front, takes the document's place (its header
  // column too); the sidebar stays. Switching between them keeps it.
  const full = stageFull;
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

  const headWide = rail >= 260;
  // In the document's full screen its tab strip reaches the window's top-right corner, where the controls on every screen
  // sit (ui/WindowControls.jsx): the strip stops short of them, so its full-screen button is not under them.
  const [controlsRoom, setControlsRoom] = React.useState(0);
  React.useLayoutEffect(() => {
    const controls = docFull ? document.querySelector('[data-window-controls]') : null;
    if (!controls) return undefined;
    const measure = () => { const r = controls.getBoundingClientRect(); setControlsRoom(r.width ? Math.max(0, Math.ceil((window.innerWidth || 0) - r.left)) : 0); };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(controls);
    window.addEventListener('resize', measure);
    return () => { if (observer) observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [docFull]);

  // The middle column's panes (MATH-23): with a document beside the one in front, the two share the column side by side,
  // half each, neither covering the other, so the mention marked in the left one stays in sight. A column too narrow for
  // two PANE_MIN panes scrolls sideways instead. With the document alone it fills the column.
  const paneCount = paneDocs.length;
  const paneStyle = (i) => (paneCount > 1 ? { flex: '1 1 0', minWidth: PANE_MIN, borderLeft: i ? '1px solid #eaeaea' : 0 } : { flex: '1 1 0' });

  // What every pane's editor is given; each pane adds its own document, its @bart and its notes beside.
  const editorProps = {
    mentionable,
    mentionItems,
    onMentionOpen: setMentionOpen,
    onMentionPicked: mentionPicked,
    workspacePeek,
    onOpenWorkspace: openMentionedWorkspace,
    onNoteVerb: (name) => makeNote(name, false),
    onOpenItem: openItem,
    onOpenLink: openLink,
    images,
    onPasteImage: pasteImage,
    pathForFile: api.pathForFile,
    onDropItems: addDroppedHere,
    asks,
    models: bartModels,
    builds,
    buildProgress,
    buildDiffs,
    onBuildDiffWanted: wantBuildDiff,
    onBuildAction,
    onCopyText: (value) => api.copyText(value),
    onStopAsk: (askId) => api.stopBart(askId).catch((error) => onError(error)),
    paperState: guidePaperState,
    onSavePaper: saveGuidePaper,
    repoState: guideRepoState,
    onTryRepo: tryGuideRepo,
    onError,
  };
  const footer = (
    // Copy, then (on the Workspace tab: a workspace is one Build) Build and Clear (2026-09-25). Build sits beside
    // Copy until it replaces it.
    // An archived version has Restore alone.
    docArchive ? (
      <button type="button" className="hov-ink" data-restore-doc="1" onClick={() => restoreVersion(docArchive)} title="Make this version the workspace's document again" style={{ ...FOOT_BUTTON, marginLeft: -6 }}>Restore</button>
    ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        className="hov-ink"
        data-copy-doc="1"
        onClick={copyDoc}
        title={docWorkspaceId ? 'Copy current workspace' : 'Copy current note'}
        style={{ ...FOOT_BUTTON, marginLeft: -6, color: copied ? '#171717' : '#8f8f8f' }}
      >
        {copied ? copiedLabel(copied) : 'Copy'}
      </button>
      {docWorkspaceId && !copied && <button type="button" className="hov-ink" data-build-doc="1" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setBuildDialog((now) => (now ? null : { anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } })); }} aria-expanded={!!buildDialog} title="Hand this workspace to a coding agent" style={FOOT_BUTTON}>Build</button>}
      {docWorkspaceId && !copied && <button type="button" className="hov-ink" data-clear-doc="1" onClick={clearDoc} title="Archive this document and start it blank" style={FOOT_BUTTON}>Clear</button>}
    </span>
    )
  );
  const noWorkspace = topics.length === 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f', textAlign: 'center' }}>This project has no workspace yet. A workspace holds a document, its context, and any workspaces nested inside it.</span>
      <button type="button" className="hov-bd2" onClick={() => addTopic(false)} style={{ padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>+ Workspace</button>
    </div>
  ) : null;

  return (
    <div data-screen-label="Workspace" style={style}>
      <header className="title-bar" style={{ display: 'flex', alignItems: 'stretch', minHeight: 54, background: '#fafafa', flex: 'none' }}>
        <div className="title-lead" style={{ flex: 'none', width: rail, boxSizing: 'border-box', borderBottom: '1px solid #eaeaea', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', minWidth: 0, overflow: 'hidden' }}>
          <button type="button" className="hov-ink" onClick={onHome} title="All projects" aria-label="All projects" data-crumb-home="1" style={{ flex: 'none', padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 16px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717', whiteSpace: 'nowrap' }}>Engelbart</button>
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
        <div data-doc-strip="1" style={{ flex: '1 1 0', minWidth: 0, boxSizing: 'border-box', display: full ? 'none' : 'flex', alignItems: 'flex-end', padding: `0 ${docFull ? controlsRoom + 8 : 8}px 0 10px`, overflow: 'hidden' }}>
          <div style={{ flex: '0 1 auto', minWidth: 0, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
            <DocTabs tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} onClose={closeTab} onMove={moveTab} wsName={topic ? topic.name : ''} />
          </div>
          {notePlus && topic && (
            <NotePicker
              anchor={notePlus}
              library={library}
              openIds={tabs.map((tab) => tab.id)}
              inRail={inRail}
              onPick={(row) => openTab(row.id, row.name)}
              onNew={(name) => makeNote(name, true)}
              onClose={closeNotePlus}
              onError={onError}
            />
          )}
          {topic && <button type="button" className="hov-tab-plus" data-note-plus="1" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setNotePlus(notePlus ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }); }} aria-label="Open or make a note" aria-expanded={!!notePlus} title="Open a note or make one" style={{ flex: 'none', alignSelf: 'flex-end', width: 28, height: 28, margin: '0 0 3px 6px', padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#4d4d4d', transition: 'background 120ms' }}>+</button>}
          {/* The document's full screen (MATH-23), at the strip's end as the Stage's is at its own. */}
          {topic && <button type="button" className="hov-wash2" onClick={toggleDocFull} aria-label={docFull ? 'Exit full screen' : 'Full screen'} title={docFull ? 'Exit full screen (Esc)' : 'Full screen'} data-doc-full={docFull ? '1' : '0'} style={{ flex: 'none', alignSelf: 'flex-end', width: 28, height: 28, margin: '0 0 3px auto', padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}>{docFull ? <Collapse /> : <Expand />}</button>}
        </div>
        <div style={{ flex: 'none', width: 1, background: '#eaeaea', display: full || docFull ? 'none' : undefined }} />
        <div style={{ flex: 'none', width: paneWidth, minWidth: 0, boxSizing: 'border-box', display: docFull ? 'none' : 'flex', alignItems: 'center', gap: 16, padding: '0 20px', overflow: 'hidden' }}>
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
          onDeleteTopic={deleteTopic}
          rows={rows}
          flashId={flashId}
          onRowClick={onRowClick}
          onRowRenameStart={(row) => setRenaming(row.id)}
          onRowRename={renameRow}
          onRowRenameEnd={() => setRenaming(null)}
          library={findable}
          inRail={inRail}
          onSearchPick={searchPick}
          onAddInput={(input) => addInput(input)}
          onPickDisk={pickFromDisk}
          onNewNote={() => makeNote('', true)}
          onNewChild={makeChild}
          onPickRepo={pickRepo}
          onOpenHeld={(projectId, workspaceId) => { if (projectId === project.id && workspaceId && index.has(workspaceId)) selectTopic(workspaceId); }}
          onDropItems={addDroppedHere}
          onTrashRow={trashRow}
          onRestoreArchive={(row) => restoreVersion(row.file)}
          trashFull={!!(topic && topic.removed && topic.removed.length) || postItTrash > 0 || !!(tree.trash && tree.trash.length)}
          workspaceTrash={{ rows: tree.trash || [], restore: restoreTopic }}
          postItTrash={active ? { count: postItTrash, load: () => api.postItsTrashed(project.id), restore: (id) => api.postItsRestore(project.id, id) } : null}
          postItDrag={postItDrag}
          trashRef={trashRef}
          next={next}
          projectId={project.id}
          onGoNext={goTo}
          places={places}
          onPostIt={active ? () => api.postItsCreate(project.id).catch(onError) : null}
          postItsHidden={postItsHidden}
          onTogglePostIts={active ? () => setPostItsHidden((now) => !now) : null}
          hidden={docFull}
        />

        {!docFull && <Separator onDown={railDown} onMove={railMove} onUp={pointerUp} onReset={() => setRailWidth(300)} />}

        {/* The document, and the one opened beside it (MATH-23): side by side, each pane scrolling down on its own. */}
        <main ref={mainRef} data-doc-column="1" style={{ flex: '1 1 0', minWidth: DOC_MIN, minHeight: 0, display: full ? 'none' : 'flex', overflowX: 'auto', overflowY: 'hidden', position: 'relative', isolation: 'isolate' }}>
          {paneDocs.map((doc, i) => {
            const pane = i ? beside[i - 1] : null, next = beside[i] || null;
            const ws = pane && pane.kind === 'workspace' ? index.get(pane.id) : null;
            const title = !pane ? docTitle : ws ? ws.node.name : pane.kind === 'workspace' ? pane.title : ((notesById.get(pane.id) || {}).name || pane.title);
            return (
              <DocPane
                key={i}
                index={i}
                kind={pane ? pane.kind : null}
                editorRef={editorRefAt(i)}
                docKey={doc.key}
                text={doc.key ? docs[doc.key] : undefined}
                readOnly={!!doc.archive}
                title={title}
                onRename={!pane ? renameDoc : pane.kind === 'workspace' ? (name) => renameWorkspaceBeside(pane.id, name) : (name) => renameNoteDoc(pane.id, name)}
                titleFocus={pane ? null : wantTitleFocus}
                conflict={!!(doc.key && conflicts[doc.key])}
                onKeepMine={() => keepMine(doc.key)}
                onTakeTheirs={() => takeTheirs(doc.key)}
                onClose={pane ? () => closeBeside(i) : null}
                empty={pane ? null : noWorkspace}
                style={paneStyle(i)}
                editor={{
                  ...editorProps,
                  onChange: (value) => onDocChange(doc.key, doc.ref, value),
                  onAsk: (ask) => askBart(doc.key, doc.ref, ask),
                  onOpenBeside: openDocBeside,
                  besideLink: next && next.kind !== 'workspace' ? next.link : null,
                  besideWorkspace: next && next.kind === 'workspace' ? next.id : null,
                  // Where the document was scrolled to is kept for the document in front; one beside opens at its top.
                  viewScope: pane ? null : (topic ? topic.id : null),
                  viewOf: pane ? noView : viewOf,
                  onView: pane ? null : recordPosition,
                  footer: pane ? null : footer,
                }}
              />
            );
          })}
        </main>

        {!full && !docFull && <Separator onDown={rightDown} onMove={rightMove} onUp={pointerUp} onReset={() => setRightWidth(null)} />}

        <RightPane
          ref={stageRef}
          mode={rightMode}
          onError={onError}
          projectDir={project.directory || null}
          projectId={project.id}
          full={full}
          onFull={toggleStageFull}
          onShowStage={showStage}
          onPage={setOpenPage}
          onFront={setStageFront}
          library={library}
          inRail={inRail}
          onOpenItem={openItem}
          mentionItems={mentionItems}
          onMentionOpen={setMentionOpen}
          pendingAsks={pendingPaperAsks}
          onAsk={topic ? askHighlight : undefined}
          onStopAsk={(askId) => api.stopBart(askId).catch((error) => onError(error))}
          onDismissAsk={dropPaperAsk}
          onContinueAsk={topic ? continueAsk : undefined}
          onCopyText={(value) => api.copyText(value).catch((error) => onError(error))}
          save={topic && pageState ? { state: pageState, onSave: savePage, onLink: () => linkIds([pageKnown.row.id]) } : null}
          style={{ flex: 'none', width: paneWidth, minWidth: 0, minHeight: 0, display: docFull ? 'none' : 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
        />
      </div>

      {buildDialog && (
        <BuildPanel
          projectId={project.id}
          workspaceId={topic ? topic.id : null}
          title={topic ? topic.name : ''}
          anchor={buildDialog.anchor}
          library={library}
          inRail={inRail}
          onClose={closeBuildDialog}
          onStart={startBuild}
        />
      )}
      {postItBuild && (
        <PostItBuild
          key={postItBuild.postItId}
          projectId={project.id}
          quick={postItBuild}
          anchor={postItBuild.anchor}
          library={library}
          inRail={inRail}
          onClose={closePostItBuild}
          onStart={startQuick}
          onLibraryChanged={reload}
        />
      )}
      {quickTask && builds[quickTask.id] && (
        <PostItTask
          key={quickTask.id}
          task={builds[quickTask.id]}
          progress={buildProgress[quickTask.id]}
          anchor={quickTask.anchor}
          workspaces={allWorkspaces}
          hereId={topic ? topic.id : null}
          onAction={(action) => onBuildAction(quickTask.id, action)}
          onPromote={(workspaceId, choice) => promoteQuick(quickTask.id, workspaceId, choice)}
          onGo={goToTask}
          onDelete={() => { if (quickTask.postItId) api.postItsThrowOut(project.id, quickTask.postItId).catch(onError); }}
          onClose={closeQuickTask}
        />
      )}
      {rejecting && <BuildReject title={rejecting.title} onConfirm={() => onBuildAction(rejecting.id, 'discard')} onClose={() => setRejecting(null)} />}
      {review && <BuildReview key={review.id} title={review.title} review={review.review} error={review.error} task={builds[review.id] || null} aside={full || docFull ? 0 : paneWidth + 1} onOpen={(name) => { void onBuildAction(review.id, 'runshow', { name }); }} onClose={() => setReview(null)} />}

      <ProjectPostIts
        projectId={project.id}
        active={active}
        hidden={postItsHidden}
        onShown={showPostIts}
        onError={onError}
        onDrag={onPostItDrag}
        onTrashCount={setPostItTrash}
        // +Note on a card: a note in no workspace, opened here as a tab once the library knows it.
        onOpenNote={async ({ id, name }) => { await reload(); openTab(id, name); }}
        onOpenLink={openLink}
      />
    </div>
  );
}
