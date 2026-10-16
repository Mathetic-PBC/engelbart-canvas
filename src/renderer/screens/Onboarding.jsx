import React from 'react';
import { api, errorMessage } from '../api.js';
import Button from '../ui/Button.jsx';
import Option from '../ui/Option.jsx';
import Pager from '../ui/Pager.jsx';
import ThinkingDots from '../ui/ThinkingDots.jsx';
import { GH, GLOBE, PDF } from '../ui/Icons.jsx';
import { heldRow } from '../model/github.js';
import { SUBS, isFresh, forward, shownPager, endOf, projectInput, importButtons, createButtons, rowWhy, contextRows, agentGate, PROFILE_PROMPT } from '../model/onboarding.js';
import { useGithubStatus } from '../workspace/useGithubStatus.js';
import ImportSignins from '../workspace/ImportSignins.jsx';
import GithubRepos from '../workspace/GithubRepos.jsx';
import ConnectLibrary from './ConnectLibrary.jsx';
import ImportFlow, { useWindowSize } from '../import/ImportFlow.jsx';
import AgentSetupPopup, { providerOfChoice } from '../import/AgentSetup.jsx';
import { importApi } from '../import/import-api.js';

// What the agent popup and Import your context call (2026-10-16): Import your context's calls, with the tool manager's own
// update (the popup updates a CLI too old for Engelbart without signing it in, which toolsConnect would).
const flowApi = { ...importApi, toolsUpdate: (id) => api.toolsUpdate(id) };
import welcomePng from '../../../design/assets/welcome-field.png';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

// Onboarding (2026-09-28): port of Claude Design "Onboarding.dc.html", Hudson's tweaks in design/onboarding/TWEAKS.md.
// mode 'new' (first launch: welcome → tools → create → connect your library, or add to library → custom instructions)
// or 'existing' (+ Project: create → context), or 'guided' (the guided setup started inside a project, 2026-10-10: a new
// user's screens without Create; after the last one `into`, that project, gets a Welcome workspace and opens on it).
// Everything is real: library rows are added as they are picked, the instructions are saved on Continue, and a new
// user's project is made past the last screen (src/main/store/onboarding.cjs) and opens on its Getting started workspace.
// Create comes before Connect (2026-10-10) so the librarian is told what the project is (`project` below).
// The window is white and the content sits on it, centred, with no card or grey boxes; one Continue per screen walks
// its parts (Hudson, 2026-09-28). The tools screen installs Git, Claude Code and Codex in the background (App.jsx
// holds the setup dialog back until onboarding is over).

const rise = 'rise 260ms cubic-bezier(.25,.1,.25,1)';
const riseSub = 'rise 220ms cubic-bezier(.25,.1,.25,1)';
const h1 = { margin: 0, font: '500 28px/1.2 var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' };
const lead = { margin: 0, maxWidth: 440, font: '15.5px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' };
const column = { width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column' };
const plain = { padding: 0, border: 0, background: 'none', cursor: 'pointer' };
const skipStyle = { ...plain, padding: '10px 12px', marginLeft: -12, font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' };
// Welcome (2026-10-16, S1/S2): bigger type, the picture as large as the window lets it be, Continue on the right.
const welcomeH1 = { margin: 0, font: '600 36px/1.15 var(--font-sans)', letterSpacing: '-0.9px', color: '#171717', textAlign: 'center' };
const welcomeLead = { margin: 0, font: '18px/1.5 var(--font-sans)', color: '#4d4d4d', textAlign: 'center', textWrap: 'pretty' };
const faint = { font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' };
const LABEL = { github: 'GitHub', url: 'Websites', pdf: 'Papers' };

function Glyph({ children, size = 16, color = '#4d4d4d' }) {
  return <span className="glyph-fit" aria-hidden="true" style={{ flex: 'none', width: size, height: size, display: 'flex', color }}>{children}</span>;
}
const ICON = { github: <GH />, url: <GLOBE />, pdf: <PDF /> };

function Head({ title, children }) {
  return (
    <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
      <h1 style={h1}>{title}</h1>
      {children && <p style={lead}>{children}</p>}
    </div>
  );
}

function Mark({ done }) {
  return done
    ? <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: '#1f9d55', color: '#fff', font: '600 11px/1 var(--font-sans)' }}>✓</span>
    : <span style={{ flex: 'none', width: 18, height: 18, boxSizing: 'border-box', borderRadius: '50%', border: '1.5px solid #c9c9c9' }} />;
}

function Footer({ showSkip, onSkip, continueDisabled, onContinue, label = 'Continue' }) {
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ display: 'flex' }}>
        {showSkip && <button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={skipStyle}>Skip</button>}
      </div>
      <span data-onboarding-continue="1"><Button variant="filled" go disabled={continueDisabled} onClick={onContinue}>{label}</Button></span>
    </div>
  );
}

/**
 * `tools`: the tool check's snapshot (App.jsx). `onTools('install' | 'skip')`: what the tools screen was answered with.
 * A new user's flow has Connect your library (2026-10-07; in every library, not test mode's only, since 2026-10-08), and
 * so does the guided setup's. `into`: the project mode 'guided' adds its Welcome workspace to. `backTitle`: where
 * "Engelbart" in the top left goes (all projects, or the project the guided setup was started in).
 */
export default function Onboarding({ mode = 'new', into = null, tools = null, onTools = () => {}, onDone, onBack, backTitle = 'All projects' }) {
  const flowMode = mode === 'existing' ? 'existing' : mode === 'guided' && into ? 'guided' : 'new';
  const fresh = isFresh(flowMode);
  const [place, setPlace] = React.useState({ step: flowMode === 'existing' ? 'create' : 'welcome', sub: 0, detour: false });
  const { step, sub } = place;
  const [library, setLibrary] = React.useState([]);
  const [added, setAdded] = React.useState([]); // { id, src, fresh } rows this onboarding put in the library (fresh: it made them)
  const [busy, setBusy] = React.useState(''); // a row being added or removed
  const [entry, setEntry] = React.useState('');
  const [entryErr, setEntryErr] = React.useState('');
  const [instrSrc, setInstrSrc] = React.useState(null); // 'claude' | 'own'
  const [instr, setInstr] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [name, setName] = React.useState('');
  const [desc, setDesc] = React.useState('');
  const [folder, setFolder] = React.useState('new');
  const [folderPath, setFolderPath] = React.useState('');
  const [newPath, setNewPath] = React.useState('~/my-project');
  const [sel, setSel] = React.useState({});
  const [error, setError] = React.useState('');
  const [importing, setImporting] = React.useState(false); // the "Import sign-ins…" picker is open (MATH-18, macOS only)
  const [connectId, setConnectId] = React.useState(null); // Connect your library's session: its staged notes go into the project
  // Connect your library needs Claude Code or Codex: skipping the tools screen without one takes it out of the flow, and
  // Add to your library and Custom instructions come back in its place.
  const [connectDropped, setConnectDropped] = React.useState(false);
  const connectMode = fresh && !connectDropped;
  // What Connect's librarian is told the project is (2026-10-10): Create's name and description in a new user's flow, the
  // project's own in the guided setup. Never its id: an onboarding session with one would not be picked up again.
  const [intoProject, setIntoProject] = React.useState(null);
  React.useEffect(() => {
    if (flowMode !== 'guided') return undefined;
    let live = true;
    api.loadProject(into).then((tree) => { if (live && tree && tree.project) setIntoProject({ name: tree.project.name || '', description: tree.project.description || '' }); }).catch(() => {});
    return () => { live = false; };
  }, [flowMode, into]);
  // Its "Sign in again" sites (2026-10-06): there is no Stage until the project opens, so they open on it then (App.jsx).
  const stageLinks = React.useRef([]);
  const [ghStatus] = useGithubStatus();
  const entryRef = React.useRef(null);

  const readLibrary = React.useCallback(() => api.library().then((rows) => { setLibrary(rows); return rows; }).catch(() => []), []);
  React.useEffect(() => { readLibrary(); }, [readLibrary]);
  React.useEffect(() => api.onLibraryChanged(() => { readLibrary(); }), [readLibrary]);
  React.useEffect(() => { api.instructions().then((text) => { if (text) { setInstr(text); setInstrSrc('own'); } }).catch(() => {}); }, []);

  // The folder "Create a folder for me" would make, as the name is typed.
  React.useEffect(() => {
    const timer = setTimeout(() => { api.freeFolder(name.trim() || 'my-project').then((free) => setNewPath(free.shown)).catch(() => {}); }, 120);
    return () => clearTimeout(timer);
  }, [name]);

  const byId = React.useMemo(() => new Map(library.map((row) => [row.id, row])), [library]);
  const cur = SUBS[step] ? SUBS[step][sub] : null;
  const addedHere = (src) => added.filter((item) => item.src === src && byId.has(item.id)).map((item) => byId.get(item.id));
  const heldRepo = (repo) => heldRow(repo, library);

  // The "Set up your tools" screen is gone (2026-10-16, S3: "There is a super ugly install claude code and codex screen
  // right after the welcome to engelbart screen"): Welcome's Continue goes on at once when Claude Code or Codex is
  // installed, signed in and subscribed (updated in the background when too old), and otherwise asks in a popup over
  // Welcome (../import/AgentSetup.jsx). The step stays out of the flow, so the pager never counts it.
  const flowOptions = { tools: false, connect: connectMode };
  const fit = useWindowSize(); // { width, height }: the window's, for Welcome's picture
  const [gate, setGate] = React.useState(null); // null | 'checking' (Continue pressed, the check not answered) | 'ask' (the popup)
  const [agentProviders, setAgentProviders] = React.useState(null);
  React.useEffect(() => {
    if (!connectMode || step !== 'welcome' || !tools || !tools.checked) return undefined;
    let live = true;
    importApi.providers(true).then((out) => { if (live) setAgentProviders(out); }).catch(() => { if (live) setAgentProviders((now) => now || { providers: [] }); });
    return () => { live = false; };
  }, [connectMode, step, tools]);

  const go = (next) => { setPlace((now) => ({ ...now, ...next })); setEntry(''); setEntryErr(''); setError(''); };
  // Forward from here; past a new user's last screen the project is made, past the guided setup's the Welcome workspace.
  const goForward = (options = flowOptions) => {
    const next = forward(flowMode, place, options);
    const end = endOf(flowMode, next);
    if (end === 'project') { openProject(added.filter((item) => byId.has(item.id)).map((item) => item.id)); return; }
    if (end === 'welcome') { addWelcome(); return; }
    go(next);
  };
  const advance = () => goForward();

  // Welcome's Continue (S3). Without Connect (+ Project) nothing needs an agent: on at once.
  const welcomeNext = () => { if (!connectMode) { advance(); return; } if (!gate) setGate('checking'); };
  React.useEffect(() => {
    if (gate !== 'checking') return;
    const out = agentGate(tools, agentProviders);
    if (!out) return;
    if (out.git) api.toolsInstall(['git']).catch(() => {}); // Git is never asked about: it comes with the app
    if (!out.go) { setGate('ask'); return; }
    for (const id of out.update) api.toolsUpdate(id).catch(() => {});
    onTools('skip'); // nothing is asked about the tools after onboarding either: one runs
    setGate(null);
    advance();
  }, [gate, tools, agentProviders]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentDone = (choice) => {
    const provider = providerOfChoice(choice);
    if (provider) importApi.rememberProvider(provider).catch(() => {});
    onTools('skip');
    setGate(null);
    advance();
  };
  // Skip: on to Import your context, whose Import context asks again (it can't run without one). The guided setup's
  // Connect your library can't either: its old screens come back in its place, as Skip on the tools screen did.
  const agentSkip = () => {
    onTools('skip');
    setGate(null);
    if (flowMode === 'guided') { setConnectDropped(true); goForward({ ...flowOptions, connect: false }); return; }
    advance();
  };

  // Enter on the welcome screen continues, as the design has it.
  React.useEffect(() => {
    if (step !== 'welcome' || gate) return undefined;
    const onKey = (event) => { if (event.key === 'Enter' && !/^(INPUT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) welcomeNext(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const take = (row, src, fresh) => {
    setAdded((now) => (now.some((item) => item.id === row.id) ? now : [...now, { id: row.id, src, fresh }]));
    setSel((now) => ({ ...now, [row.id]: true }));
  };

  // Something picked or pasted: added to the library now; what is already there counts as added and stays.
  const addOne = async (input, src) => {
    try {
      const row = await api.addLibraryItem(input);
      take(row, src, true);
      // A GitHub repository is added even when its sandbox could not start (src/main/sandbox); that is said, not refused.
      if (row.sandbox_error) setError(row.sandbox_error);
      return null;
    } catch (failure) {
      const message = errorMessage(failure);
      const existing = /^Already in the library as “(.*)”$/.exec(message);
      if (existing) {
        const rows = await readLibrary();
        const found = await api.lookupLibraryItem(input).catch(() => null);
        const row = found && found.row ? found.row : rows.find((candidate) => candidate.name === existing[1]);
        if (row) take(row, src, false);
      }
      return message;
    } finally {
      await readLibrary();
    }
  };

  const toggleRepo = async (repo) => {
    const row = heldRepo(repo);
    setBusy(repo.id);
    try {
      if (!row) { const problem = await addOne(repo.url, 'github'); if (problem && !/^Already/.test(problem)) setError(problem); return; }
      const mine = added.find((item) => item.id === row.id);
      if (mine && mine.fresh && await api.discardLibraryItem(row.id)) {
        setAdded((now) => now.filter((item) => item.id !== row.id));
        await readLibrary();
      }
    } finally {
      setBusy('');
    }
  };

  const addEntry = async (event) => {
    if (event) event.preventDefault();
    const value = entry.trim();
    if (!value) { if (addedHere('url').length) advance(); return; }
    let address = value;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address) && !address.startsWith('~') && !address.startsWith('/')) address = `https://${address}`;
    let host = '';
    try { host = new URL(address).hostname; } catch { host = ''; }
    if (/^https?:/i.test(address) && !host.includes('.') && host !== 'localhost') { setEntryErr('that doesn’t look like a web address'); return; }
    setBusy('url');
    const listed = new Set(addedHere('url').map((row) => row.id));
    const found = await api.lookupLibraryItem(address).catch(() => null);
    const problem = await addOne(address, 'url');
    setBusy('');
    // A link already in the list says so; one the library held before joins the list like any other.
    if (!problem || /^Already/.test(problem)) setEntry('');
    if (problem) setEntryErr(/^Already/.test(problem) ? (found && found.row && listed.has(found.row.id) ? 'already added' : '') : problem);
    setTimeout(() => entryRef.current && entryRef.current.focus(), 0);
  };

  const pickPapers = async () => {
    const paths = await api.pickLibraryPaths('pdf').catch(() => []);
    if (!paths.length) return;
    setBusy('pdf');
    const problems = [];
    for (const file of paths) {
      const problem = await addOne(file, 'pdf');
      if (problem && !/^Already/.test(problem)) problems.push(problem);
    }
    setBusy('');
    setError(problems[0] || '');
  };

  const saveInstructions = async () => {
    try { await api.setInstructions(instr); advance(); } catch (failure) { setError(errorMessage(failure)); }
  };

  // Continue (and Skip) on the create screen: the next part, then the next screen. A new user's project is not made here
  // (2026-10-10) but past the flow's last screen (goForward), so Connect is told about it first. A folder picked under
  // the name is checked here.
  const createNext = async () => {
    const part = SUBS.create[sub];
    if (part === 'name' && !name.trim()) return;
    if (part === 'name' && folder === 'existing') {
      try { await api.checkFolder(folderPath); } catch (failure) { setError(errorMessage(failure)); return; }
    }
    advance();
  };

  // "Use an existing folder…" under the name: the folder picked takes the place of the one made at ~/<name>.
  const browseFolder = async () => {
    const chosen = await window.terminalAPI.pickDirectory(undefined).catch(() => null);
    if (chosen) { setFolder('existing'); setFolderPath(chosen); setError(''); }
  };

  // The project made, from + Project's context screen or past a new user's last screen (its Welcome workspace holding what
  // this onboarding added; Connect's imports join it in main). A failure goes back to the screen it was made from.
  const openProject = async (ids) => {
    const back = { ...place, detour: false };
    go({ step: 'open', sub: 0 });
    try {
      const made = await api.startProject(projectInput({ name, desc, folder, folderPath, ids, connectId, mode: flowMode }));
      await onDone(made, { stageLinks: [...stageLinks.current] });
    } catch (failure) {
      setPlace(back);
      setError(errorMessage(failure));
    }
  };
  const open = () => openProject(contextRows(library).filter((row) => sel[row.id]).map((row) => row.id));

  // The guided setup's end inside a project (ipc welcome-workspace): a Welcome workspace in `into` holding what this
  // setup added, with the walkthrough and Connect's session; nothing the project had is touched. A failure goes back to
  // the last screen, saying so.
  const addWelcome = async () => {
    const back = { ...place, detour: false };
    go({ step: 'open', sub: 0 });
    try {
      const made = await api.welcomeWorkspace(into, { context: added.filter((item) => byId.has(item.id)).map((item) => item.id), ...(connectId ? { connect: connectId } : {}) });
      await onDone(made, { stageLinks: [...stageLinks.current] });
    } catch (failure) {
      setPlace(back);
      setError(errorMessage(failure));
    }
  };

  const pager = shownPager(flowMode, step, flowOptions);
  // Connect's page draws the pager in their own foot, beside their button.
  const pagePager = pager && (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 16 }}>
      <Pager count={pager.count} index={pager.index} />
      <div data-onboarding-step-of="1" style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{`${pager.index + 1} of ${pager.count}`}</div>
    </div>
  );
  const errorLine = error ? <span data-onboarding-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', textAlign: 'center', overflowWrap: 'anywhere' }}>{error}</span> : null;
  const projName = name.trim() || 'your project';

  let body = null;
  if (step === 'welcome') {
    // S1/S2 (2026-10-16): "Move continue to the right not in the middle"; "generally make everything bigger, there is too
    // much whitespace. this should be minimum size but should expand with window"): the picture as large as the window's
    // height leaves room for, Continue lower right as on Import your context's screens. Not zoomed ("Zoom back out the
    // onboarding, it looks ugly zoomed in", the same day).
    const room = Math.min(fit.height - 54 - 300, (fit.width - 48) * (758 / 1199));
    const wide = Math.round(Math.max(300, Math.min(640, room * (1199 / 758))));
    body = (
      <div data-screen-label="01 Welcome" style={{ width: wide, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 30, animation: rise }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <h1 style={welcomeH1}>Welcome to Engelbart</h1>
          <p style={welcomeLead}>The best way to brainstorm and create research projects</p>
        </div>
        <img src={welcomePng} alt="" style={{ display: 'block', width: '100%', aspectRatio: '1199/758', objectFit: 'cover', borderRadius: 10 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          {pager ? <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}><Pager count={pager.count} index={pager.index} /><div data-onboarding-step-of="1" style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{`${pager.index + 1} of ${pager.count}`}</div></div> : <span />}
          <span data-onboarding-continue="1"><Button variant="filled" go disabled={gate === 'checking'} onClick={welcomeNext} style={{ padding: '14px 20px', font: '500 15px/1 var(--font-sans)', borderRadius: 10 }}>Continue</Button></span>
        </div>
      </div>
    );
  } else if (step === 'import') {
    const items = addedHere(cur);
    const n = items.length; // what this onboarding added; a repository the library already held is ticked in the list but not counted
    const signedIn = cur === 'github' && ghStatus && ghStatus.connected;
    const buttons = importButtons(sub, n, { signedIn });
    body = (
      <div data-screen-label="03 Import context" data-part={cur} style={{ ...column, minHeight: 0, gap: 24, animation: rise }}>
        <Head title="Add to your library">Bring in the papers, websites, and code you've already read to conduct research. You can add more any time.</Head>
        <div style={{ flex: '0 1 300px', minHeight: 180, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 12px' }}>
            <Mark done={n > 0} />
            <Glyph>{ICON[cur]}</Glyph>
            <span style={{ flex: 1, minWidth: 0, font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>{LABEL[cur]}</span>
            {!signedIn && n > 0 && <span style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{n} added</span>}
            {signedIn && (
              <>
                <span style={{ flex: 'none', font: '12.5px/1 var(--font-sans)', color: '#4d4d4d' }}>{ghStatus.login}</span>
                <button type="button" className="hov-ink" data-github-signout="1" onClick={() => api.githubDisconnect().catch((failure) => setError(errorMessage(failure)))} style={{ ...plain, flex: 'none', padding: '4px 0 4px 4px', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Sign out</button>
              </>
            )}
          </div>
          {cur === 'github' && <GithubRepos held={heldRepo} onToggle={toggleRepo} busyId={busy} />}
          {cur === 'url' && (
            <form onSubmit={addEntry} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', animation: riseSub }}>
              <div data-onboarding-items="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 2px' }}>
                {items.map((row) => <div key={row.id} title={row.url || ''} style={{ flex: 'none', padding: '4px 0', font: '13.5px/1.5 var(--font-sans)', color: '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>)}
                {!items.length && <span style={{ padding: '4px 0', ...faint }}>nothing added yet…</span>}
              </div>
              <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10 }}>
                <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 0 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 6 }}>
                  <input ref={entryRef} value={entry} onChange={(event) => { setEntry(event.target.value); setEntryErr(''); }} readOnly={busy === 'url'} placeholder="paste a link…" autoFocus spellCheck={false} data-onboarding-link="1" style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '13.5px/1.4 var(--font-sans)', color: '#171717' }} />
                  <button type="submit" disabled={!entry.trim() || busy === 'url'} style={{ ...plain, flex: 'none', padding: '4px 6px', font: '500 12.5px/1 var(--font-sans)', color: entry.trim() && busy !== 'url' ? '#171717' : '#c9c9c9' }}>{busy === 'url' ? 'Adding…' : 'Add'}</button>
                </div>
                {entryErr && <span data-onboarding-entry-error="1" style={{ padding: '0 2px', font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{entryErr}</span>}
              </div>
            </form>
          )}
          {cur === 'pdf' && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', animation: riseSub }}>
              <div data-onboarding-items="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '8px 2px' }}>
                {items.map((row) => (
                  <div key={row.id} style={{ flex: 'none', display: 'flex', alignItems: 'baseline', gap: 10, padding: '4px 0' }}>
                    <span style={{ flex: '0 1 auto', minWidth: 0, font: '13.5px/1.5 var(--font-sans)', color: '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                    <span style={{ flex: 'none', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{rowWhy(row)}</span>
                  </div>
                ))}
                {!items.length && <span style={{ padding: '4px 0', ...faint }}>nothing added yet…</span>}
              </div>
              <div style={{ flex: 'none', paddingTop: 10 }}>
                <button type="button" className="hov-bd2" data-onboarding-pick-papers="1" disabled={busy === 'pdf'} onClick={pickPapers} style={{ width: '100%', display: 'flex', alignItems: 'center', padding: '6px 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 6, textAlign: 'left', font: 'italic 13.5px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'border-color 120ms' }}>{busy === 'pdf' ? 'adding…' : items.length ? 'add more papers…' : 'choose papers…'}</button>
              </div>
            </div>
          )}
          {signedIn && ghStatus.installUrl && (
            <div style={{ flex: 'none', display: 'flex', paddingTop: 8 }}>
              <button type="button" className="hov-ink" data-github-install="1" onClick={() => api.githubOpen('install').catch((failure) => setError(errorMessage(failure)))} style={{ ...plain, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Choose repositories in browser…</button>
            </div>
          )}
        </div>
        {IS_MAC && (
          <div style={{ flex: 'none', display: 'flex', justifyContent: 'center', paddingTop: 2 }}>
            <button type="button" className="hov-ink" data-onboarding-import-signins="1" onClick={() => setImporting(true)} style={{ ...plain, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Bring over your sign-ins from another browser…</button>
          </div>
        )}
        {errorLine}
        <Footer showSkip={buttons.showSkip} onSkip={advance} continueDisabled={buttons.continueDisabled} onContinue={advance} />
      </div>
    );
  } else if (step === 'instructions') {
    body = (
      <div data-screen-label="04 Custom instructions" style={{ ...column, gap: 16, animation: rise }}>
        <div style={{ marginBottom: 6 }}><Head title="Custom instructions">Tell Engelbart about your research and occupation.</Head></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8 }}>
          <Option data="import" on={instrSrc === 'claude'} label="Import from an AI provider" onClick={() => { setInstrSrc('claude'); setCopied(false); }} />
          <Option data="own" on={instrSrc === 'own'} label="Write my own" onClick={() => setInstrSrc('own')} />
        </div>
        {instrSrc === 'claude' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 2px' }}>
            <span style={{ flex: 1, minWidth: 0, font: '13px/1.45 var(--font-sans)', color: '#4d4d4d' }}>Copy the prompt, paste it into Claude or ChatGPT, then paste the reply below.</span>
            <span data-onboarding-copy-prompt="1"><Button size="sm" onClick={() => { api.copyText(PROFILE_PROMPT).then(() => setCopied(true)).catch((failure) => setError(errorMessage(failure))); }}>{copied ? 'Copied ✓' : 'Copy prompt'}</Button></span>
          </div>
        )}
        {instrSrc && (
          <textarea value={instr} onChange={(event) => setInstr(event.target.value)} autoFocus rows={4} data-onboarding-instructions="1" placeholder={instrSrc === 'own' ? 'e.g. I’m a PhD student in HCI. Explain methods before results. Cite sources…' : 'paste the reply here…'} className="focus-bd2" style={{ width: '100%', resize: 'none', padding: '10px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '14px/1.6 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }} />
        )}
        {errorLine}
        <div style={{ paddingTop: 4 }}>
          <Footer showSkip={!instr.trim()} onSkip={advance} continueDisabled={!instr.trim()} onContinue={saveInstructions} />
        </div>
      </div>
    );
  } else if (step === 'create') {
    const buttons = createButtons(sub, { name, desc, folder, folderPath });
    const quietLink = { ...plain, padding: 0, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textDecoration: 'underline', textUnderlineOffset: 3 };
    const part = SUBS.create[sub];
    body = (
      <form data-screen-label="06 Create project" data-part={part} onSubmit={(event) => { event.preventDefault(); createNext(); }} style={{ ...column, gap: 24, animation: rise }}>
        <Head title="Create a new project">Projects let you organize all of the citations, websites, papers, and code for your research without anything getting lost.</Head>
        <div style={{ width: '100%', minHeight: 150, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {part === 'name' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: riseSub }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ font: '500 14px/1.4 var(--font-sans)' }}>Project name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="e.g. Teachable agents for debugging" spellCheck={false} data-onboarding-name="1" className="focus-bd2" style={{ width: '100%', padding: '11px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '15.5px/1.4 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }} />
              </label>
              {/* The folder part is gone (2026-10-09): a folder is made at ~/<name>, unless one is picked here. */}
              {folder === 'existing' && folderPath ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '0 2px' }}>
                  <span data-onboarding-folder-path="1" style={{ font: '12.5px/1.5 var(--font-mono)', color: '#171717', overflowWrap: 'anywhere' }}>{folderPath}</span>
                  <button type="button" className="hov-ink" data-onboarding-new-folder="1" onClick={() => { setFolder('new'); setFolderPath(''); setError(''); }} style={quietLink}>Create a folder for me instead</button>
                </div>
              ) : (
                <div style={{ padding: '0 2px' }}>
                  <button type="button" className="hov-ink" data-onboarding-use-folder="1" onClick={browseFolder} title={newPath ? `Otherwise a folder is made at ${newPath}` : undefined} style={quietLink}>Use an existing folder…</button>
                </div>
              )}
            </div>
          )}
          {part === 'desc' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: riseSub }}>
              <span style={{ font: '500 14px/1.4 var(--font-sans)' }}>Project description</span>
              <textarea value={desc} onChange={(event) => setDesc(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); createNext(); } }} autoFocus rows={3} placeholder="what you're studying, and what done looks like…" data-onboarding-desc="1" className="focus-bd2" style={{ width: '100%', resize: 'none', padding: '11px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '15px/1.6 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }} />
            </label>
          )}
        </div>
        {errorLine}
        <Footer showSkip={buttons.showSkip} onSkip={createNext} label={buttons.label} continueDisabled={buttons.continueDisabled} onContinue={createNext} />
      </form>
    );
  } else if (step === 'context') {
    // What this onboarding added comes first, in the order it was added; the rest of the library after it.
    const order = new Map(added.map((item, i) => [item.id, i]));
    const rows = contextRows(library).map((row, i) => ({ row, i })).sort((a, b) => (order.has(a.row.id) ? order.get(a.row.id) : 1e6 + a.i) - (order.has(b.row.id) ? order.get(b.row.id) : 1e6 + b.i)).map(({ row }) => row);
    const nSel = rows.filter((row) => sel[row.id]).length;
    const allOn = rows.length > 0 && nSel === rows.length;
    body = (
      <div data-screen-label="07 Project context" style={{ ...column, minHeight: 0, gap: 28, animation: rise }}>
        <Head title="Project context">Choose what from your library {projName} should know about.</Head>
        {rows.length > 0 && (
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
              <span data-onboarding-selected="1" style={{ font: '500 10px/1 var(--font-sans)', letterSpacing: '1.4px', textTransform: 'uppercase', color: '#8f8f8f' }}>{`${nSel} of ${rows.length} selected`}</span>
              <Button variant="link" onClick={() => setSel(Object.fromEntries(rows.map((row) => [row.id, !allOn])))}>{allOn ? 'Select none' : 'Select all'}</Button>
            </div>
            <div data-onboarding-context="1" style={{ minHeight: 0, maxHeight: 272, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((row) => <Option key={row.id} data={row.id} many on={!!sel[row.id]} label={row.name} why={rowWhy(row)} onClick={() => setSel((now) => ({ ...now, [row.id]: !now[row.id] }))} />)}
            </div>
          </div>
        )}
        {!rows.length && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '32px 24px', textAlign: 'center' }}>
            <span style={{ font: '14px/1.6 var(--font-sans)', color: '#4d4d4d' }}>Your library is empty.</span>
            <Button variant="link" go onClick={() => go({ step: 'import', sub: 0, detour: flowMode === 'existing' })}>Add to library</Button>
          </div>
        )}
        {errorLine}
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 8 }}>
          <span data-onboarding-open="1"><Button variant="filled" go onClick={open}>Open project</Button></span>
        </div>
      </div>
    );
  } else if (step === 'connect') {
    // Drawn outside the 800 × 600 window below, as pages of their own: Connect is wider and its chat needs the height, and
    // its foot is its own.
    body = null;
  } else if (step === 'open') {
    body = <div data-screen-label="08 Opening" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}><ThinkingDots label={flowMode === 'guided' ? 'opening Welcome' : 'opening Getting started'} /></div>;
  }

  // Import your context (2026-10-13, the "Onboarding" workspace) in place of Create and Connect your library: it asks what
  // the person works on, finds their projects and tools, makes a project for each one picked and opens the first (or, Start
  // from scratch, one empty project). Its own page across the window, the title bar above it.
  if (connectMode && flowMode !== 'guided' && (step === 'create' || step === 'connect')) {
    return (
      <div data-screen-label="Import your context" data-onboarding={flowMode} data-step="import-context" style={{ position: 'absolute', inset: 0, overflow: 'auto', background: '#fff' }}>
        <div className="title-bar title-lead" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 54, zIndex: 5, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
          {onBack && <button type="button" className="hov-ink" onClick={onBack} title={backTitle} style={{ ...plain, font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>}
        </div>
        <ImportFlow api={flowApi} mode="new" platform={IS_MAC ? 'darwin' : 'other'} onDone={(made, extra = {}) => onDone(made, { stageLinks: [...stageLinks.current], session: extra.session || null })}
          // Import manually (From Amitav, 2026-10-15): the librarian's chat, Connect your library's page as it was here, on
          // the session the flow started. Put away (or skipped), the flow makes the projects and opens the first.
          renderLibrarian={({ sessionId, project, onDone: done, onBack: goBack }) => (
            <ConnectLibrary mode="onboarding" sessionId={sessionId} project={project} onContinue={done} onSkip={done} onBack={goBack} onAdded={(row) => take(row, 'github', true)} />
          )} />
      </div>
    );
  }

  return (
    <div data-screen-label="Onboarding" data-onboarding={flowMode} data-step={step} style={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '54px 24px 24px', background: '#fff', color: '#171717', fontFamily: 'var(--font-sans)' }}>
      <div className="title-bar title-lead" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 54, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        {onBack && <button type="button" className="hov-ink" onClick={onBack} title={backTitle} style={{ ...plain, font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>}
      </div>
      {/* Connect your library: a page across the window (2026-10-08: "more horizontal … not a popup"). Its foot is its own
          (2026-10-09, David's mockup): Skip for now, then the pager and "Bring these in"; in the chat how far the work is,
          the pager and "Skip the rest". Leaving with a session puts it away: it goes on in the background, the chip in the
          top right following it. Skipping it counts as the one-time offer seen: the project about to open does not ask again. */}
      {step === 'connect' && (
        <div data-screen-label="03 Connect library" style={{ flex: 'none', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          {/* sessionId: back here after the guided setup's Welcome workspace could not be added, the session it began */}
          <ConnectLibrary mode="onboarding" sessionId={connectId} project={flowMode === 'guided' ? intoProject : { name, description: desc }}
            pager={pagePager}
            onSession={(id) => { setConnectId(id); api.connectOfferSeen('started').catch(() => {}); }}
            onContinue={advance}
            onSkip={() => { api.connectOfferSeen('dismissed').catch(() => {}); advance(); }}
            onAdded={(row) => take(row, 'github', true)} />
          {errorLine}
        </div>
      )}
      {/* No card (2026-09-28): the same 800 × 600 at most, drawn on nothing, so lists inside still scroll and the page never does. */}
      {/* Welcome (2026-10-16, S2) takes the whole window, its picture growing with it. */}
      {step !== 'intro' && step !== 'connect' && <div data-screen-label="Onboarding window" style={{ flex: 'none', display: 'flex', flexDirection: 'column', width: step === 'welcome' ? '100%' : 'min(800px, 100%)', height: step === 'welcome' ? '100%' : 'min(600px, 100%)', overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 24, padding: step === 'welcome' ? '8px 24px 24px' : '40px 32px 28px' }}>
          {body}
          {pager && !place.detour && step !== 'welcome' && (
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <Pager count={pager.count} index={pager.index} />
              <div data-onboarding-step-of="1" style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{`${pager.index + 1} of ${pager.count}`}</div>
            </div>
          )}
        </div>
      </div>}
      {gate === 'ask' && step === 'welcome' && <AgentSetupPopup api={flowApi} tools={tools} providers={agentProviders} onDone={agentDone} onSkip={agentSkip} />}
      {importing && <ImportSignins opensLater onClose={() => setImporting(false)} onOpenSite={(url) => { if (!stageLinks.current.includes(url)) stageLinks.current.push(url); }} />}
    </div>
  );
}
