import React from 'react';
import { api, errorMessage } from '../api.js';
import Button from '../ui/Button.jsx';
import Option from '../ui/Option.jsx';
import Pager from '../ui/Pager.jsx';
import ThinkingDots from '../ui/ThinkingDots.jsx';
import { GH, GLOBE, PDF, SEARCH } from '../ui/Icons.jsx';
import { heldRow } from '../model/github.js';
import { SUBS, forward, pagerOf, importButtons, createButtons, rowWhy, contextRows, toolsWanted, TOOL_WHY, PROFILE_PROMPT } from '../model/onboarding.js';
import { launchRows, installable, rowOf } from '../model/tools.js';
import { useGithubStatus } from '../workspace/useGithubStatus.js';
import welcomePng from '../../../design/assets/welcome-field.png';

// Onboarding (2026-09-28): port of Claude Design "Onboarding.dc.html", Hudson's tweaks in design/onboarding/TWEAKS.md.
// mode 'new' (first launch: welcome → tools → add to library → custom instructions → create → context) or 'existing'
// (+ Project: create → context). Everything is real: library rows are added as they are picked, the instructions are
// saved on Continue, and "Open project" makes the project (src/main/store/onboarding.cjs) and opens its Getting started workspace (after the welcome tour, for a new install).
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
        {showSkip && <button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={skipStyle}>Skip for now</button>}
      </div>
      <span data-onboarding-continue="1"><Button variant="filled" go disabled={continueDisabled} onClick={onContinue}>{label}</Button></span>
    </div>
  );
}

/** Add to your library, part 2a: GitHub through the app's own sign-in (src/main/github), then a tick per repository. */
function GithubPart({ held, onToggle, busyId }) {
  const [status, setStatus] = useGithubStatus();
  const [starting, setStarting] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const [list, setList] = React.useState(null);
  const [q, setQ] = React.useState('');
  const connected = !!(status && status.connected);

  const load = React.useCallback(() => {
    api.githubRepos().then((value) => { setList(value.repos || []); setProblem(''); }).catch((error) => { setList([]); setProblem(errorMessage(error)); });
  }, []);
  React.useEffect(() => {
    if (!connected) { setList(null); return undefined; }
    load();
    window.addEventListener('focus', load); // an install on GitHub may have added repositories
    return () => window.removeEventListener('focus', load);
  }, [connected, load]);

  const connect = async () => {
    setStarting(true);
    setProblem('');
    try { setStatus(await api.githubConnect()); } catch (error) { setProblem(errorMessage(error)); } finally { setStarting(false); }
  };

  const error = problem || (status && status.error) || '';
  const pending = status && !connected && status.pending;
  if (!status) return <div style={{ flex: 1 }} />;
  if (!status.configured) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', font: '13px/1.6 var(--font-sans)', color: '#e70022' }}>{problem || 'GitHub is not set up in this build.'}</div>;
  if (!connected && (pending || starting)) {
    return (
      <div data-github-pane="code" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, animation: riseSub }}>
        <ThinkingDots label="waiting for GitHub" />
        {pending && (
          <div style={{ display: 'flex', gap: 14 }}>
            <button type="button" className="hov-ink" onClick={() => api.githubOpen('device').catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plain, font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Open browser again</button>
            <button type="button" className="hov-ink" data-github-cancel="1" onClick={() => api.githubCancel().then(setStatus).catch((failure) => setProblem(errorMessage(failure)))} style={{ ...plain, font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Cancel</button>
          </div>
        )}
      </div>
    );
  }
  if (!connected) {
    return (
      <div data-github-pane="signed-out" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center', animation: riseSub }}>
        <span style={{ maxWidth: 300, font: '13.5px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>Sign in to choose which repositories Engelbart can read.</span>
        <span data-github-signin="1"><Button variant="filled" onClick={connect}>Sign in with GitHub</Button></span>
        {error && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</span>}
      </div>
    );
  }
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (list || []).filter((repo) => { const hay = `${repo.fullName} ${repo.description || ''}`.toLowerCase(); return words.every((word) => hay.includes(word)); });
  return (
    <div data-github-pane="repos" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', animation: riseSub }}>
      <div style={{ flex: 'none', padding: '10px 0 6px' }}>
        <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8 }}>
          <Glyph size={14} color="#8f8f8f"><SEARCH /></Glyph>
          <input value={q} onChange={(event) => setQ(event.target.value)} autoFocus placeholder="search repositories…" spellCheck={false} data-github-search="1" style={{ flex: 1, minWidth: 0, padding: '7px 0', border: 0, background: 'transparent', font: '13.5px/1.4 var(--font-sans)', color: '#171717' }} />
        </div>
      </div>
      <div data-github-repos="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '0 0 4px', margin: '0 -10px' }}>
        {!list && <span style={{ padding: 10, ...faint }}>…</span>}
        {rows.map((repo) => {
          const on = !!held(repo);
          return (
            <button key={repo.id} type="button" className="hov-ink-wash" data-github-repo={repo.fullName} data-on={on ? '1' : '0'} disabled={busyId === repo.id} onClick={() => onToggle(repo)} title={repo.description || repo.fullName} style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 10px', textAlign: 'left', background: 'transparent', border: 0, borderRadius: 6, cursor: 'pointer' }}>
              <Glyph size={14} color="#8f8f8f"><GH /></Glyph>
              <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#8f8f8f' }}>{repo.owner}/</span><span style={{ color: '#171717' }}>{repo.fullName.slice(repo.owner.length + 1)}</span></span>
              {repo.private && <span aria-label="private" style={{ flex: 'none', display: 'flex', color: '#8f8f8f', opacity: 0.8 }}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg></span>}
              <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: on ? '#1f9d55' : 'transparent', color: '#fff', font: '600 10px/1 var(--font-sans)' }}>{on ? '✓' : ''}</span>
            </button>
          );
        })}
        {list && !rows.length && <span style={{ padding: 10, ...faint }}>no repositories match…</span>}
        {error && <span style={{ padding: '6px 10px', font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</span>}
      </div>
    </div>
  );
}

/** `tools`: the tool check's snapshot (App.jsx). `onTools('install' | 'skip')`: what the tools screen was answered with. */
export default function Onboarding({ mode = 'new', tools = null, onTools = () => {}, onDone, onBack }) {
  const flowMode = mode === 'existing' ? 'existing' : 'new';
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

  // Whether the tools screen is in the flow: decided by the first check that answers, then kept, so the pager does not
  // change under the person while the installs it started run. While it is undecided the screen is there, checking.
  const [withTools, setWithTools] = React.useState(() => toolsWanted(tools));
  React.useEffect(() => { if (withTools === null) { const wanted = toolsWanted(tools); if (wanted !== null) setWithTools(wanted); } }, [tools, withTools]);
  const flowOptions = { tools: withTools !== false };

  const go = (next) => { setPlace((now) => ({ ...now, ...next })); setEntry(''); setEntryErr(''); setError(''); };
  const advance = () => go(forward(flowMode, place, flowOptions));

  // The check answered with nothing to install while the tools screen was showing: on to the next one.
  React.useEffect(() => { if (step === 'tools' && withTools === false) advance(); }, [step, withTools]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on the welcome screen continues, as the design has it.
  React.useEffect(() => {
    if (step !== 'welcome') return undefined;
    const onKey = (event) => { if (event.key === 'Enter' && !/^(INPUT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) advance(); };
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

  const createNext = async () => {
    const part = SUBS.create[sub];
    if (part === 'name' && !name.trim()) return;
    if (part !== 'folder') { advance(); return; }
    if (folder === 'existing') {
      try { await api.checkFolder(folderPath); } catch (failure) { setError(errorMessage(failure)); return; }
    }
    advance();
  };

  const browseFolder = async () => {
    const chosen = await window.terminalAPI.pickDirectory(undefined).catch(() => null);
    if (chosen) { setFolderPath(chosen); setError(''); }
  };

  const open = async () => {
    const ids = contextRows(library).filter((row) => sel[row.id]).map((row) => row.id);
    go({ step: 'open', sub: 0 });
    try {
      const made = await api.startProject({ name: name.trim(), description: desc.trim(), folder, directory: folder === 'existing' ? folderPath : '', context: ids });
      await onDone(made);
    } catch (failure) {
      setPlace({ step: 'context', sub: 0, detour: false });
      setError(errorMessage(failure));
    }
  };

  const pager = pagerOf(flowMode, step, flowOptions);
  const errorLine = error ? <span data-onboarding-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', textAlign: 'center', overflowWrap: 'anywhere' }}>{error}</span> : null;
  const projName = name.trim() || 'your project';

  let body = null;
  if (step === 'welcome') {
    body = (
      <div data-screen-label="01 Welcome" style={{ ...column, alignItems: 'center', gap: 28, animation: rise }}>
        <Head title="Welcome to Engelbart">The best way to brainstorm and create research projects</Head>
        <img src={welcomePng} alt="" style={{ display: 'block', width: '100%', maxWidth: 420, aspectRatio: '1199/758', objectFit: 'cover', borderRadius: 10 }} />
        <span data-onboarding-continue="1"><Button variant="filled" go onClick={advance}>Continue</Button></span>
      </div>
    );
  } else if (step === 'tools') {
    // What the launch check would have asked about in the setup dialog, on a screen of the flow instead. Install all
    // starts the installs and moves on at once: they run in the background, and the setup dialog asks only what is
    // left (signing in) once onboarding is over. Skip for now asks nothing more until the next launch.
    const ids = withTools ? launchRows(tools) : [];
    const toInstall = withTools ? installable(tools, ids) : [];
    const install = () => {
      if (toInstall.length) api.toolsInstall(toInstall).catch(() => {});
      onTools('install');
      advance();
    };
    const skip = () => { onTools('skip'); advance(); };
    body = (
      <div data-screen-label="02 Tools" style={{ ...column, minHeight: 0, gap: 24, animation: rise }}>
        <Head title="Set up your tools">Engelbart works through Git and an agent: Claude Code or Codex. They install in the background while you carry on.</Head>
        {withTools === null && <div style={{ minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ThinkingDots label="checking this Mac" /></div>}
        {withTools && (
          <div data-onboarding-tools="1" style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #f2f2f2' }}>
            {ids.map((id) => {
              const row = rowOf(tools.tools[id]);
              const apple = id === 'git' && tools.platform === 'darwin' && row.action === 'install';
              return (
                <div key={id} data-tool-row={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 2px', borderTop: '1px solid #f2f2f2' }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ font: '500 14px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
                    <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{TOOL_WHY[id]}{apple ? ' Installing it opens Apple’s installer for the command line tools.' : ''}</span>
                  </span>
                  <span data-tool-state style={{ flex: 'none', paddingTop: 2, font: '12px/1.4 var(--font-mono)', color: row.tone === 'ok' ? '#171717' : '#8f8f8f' }}>{row.state}</span>
                </div>
              );
            })}
          </div>
        )}
        {errorLine}
        <Footer showSkip onSkip={skip} label={toInstall.length ? 'Install all' : 'Continue'} continueDisabled={withTools === null} onContinue={install} />
      </div>
    );
  } else if (step === 'import') {
    const items = addedHere(cur);
    const n = items.length; // what this onboarding added; a repository the library already held is ticked in the list but not counted
    const buttons = importButtons(sub, n);
    const signedIn = cur === 'github' && ghStatus && ghStatus.connected;
    body = (
      <div data-screen-label="03 Import context" data-part={cur} style={{ ...column, minHeight: 0, gap: 24, animation: rise }}>
        <Head title="Add to your library">Bring in the papers, websites, and code you've already read to conduct research. You can add more any time.</Head>
        <div style={{ flex: '0 1 300px', minHeight: 180, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 2px 12px', borderBottom: '1px solid #f2f2f2' }}>
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
          {cur === 'github' && <GithubPart held={heldRepo} onToggle={toggleRepo} busyId={busy} />}
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
    const part = SUBS.create[sub];
    body = (
      <form data-screen-label="06 Create project" data-part={part} onSubmit={(event) => { event.preventDefault(); createNext(); }} style={{ ...column, gap: 24, animation: rise }}>
        <Head title="Create a new project">Projects let you organize all of the citations, websites, papers, and code for your research without anything getting lost.</Head>
        <div style={{ width: '100%', minHeight: 150, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {part === 'name' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: riseSub }}>
              <span style={{ font: '500 14px/1.4 var(--font-sans)' }}>Project name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="e.g. Teachable agents for debugging" spellCheck={false} data-onboarding-name="1" className="focus-bd2" style={{ width: '100%', padding: '11px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '15.5px/1.4 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }} />
            </label>
          )}
          {part === 'desc' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: riseSub }}>
              <span style={{ font: '500 14px/1.4 var(--font-sans)' }}>Project description</span>
              <textarea value={desc} onChange={(event) => setDesc(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); createNext(); } }} autoFocus rows={3} placeholder="what you're studying, and what done looks like…" data-onboarding-desc="1" className="focus-bd2" style={{ width: '100%', resize: 'none', padding: '11px 14px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '15px/1.6 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' }} />
            </label>
          )}
          {part === 'folder' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: riseSub }}>
              <span style={{ font: '500 14px/1.4 var(--font-sans)' }}>Folder</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8 }}>
                <Option data="folder-new" on={folder === 'new'} label="Create a folder for me" onClick={() => { setFolder('new'); setError(''); }} />
                <Option data="folder-existing" on={folder === 'existing'} label="Use an existing folder" onClick={() => setFolder('existing')} />
              </div>
              {folder === 'new' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 0', font: '13px/1.5 var(--font-mono)', color: '#8f8f8f' }}>
                  <span>will create</span><span data-onboarding-new-path="1" style={{ color: '#171717' }}>{newPath}</span>
                </div>
              )}
              {folder === 'existing' && (
                <div className="focus-bd2" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 2px 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8 }}>
                  <input value={folderPath} onChange={(event) => { setFolderPath(event.target.value); setError(''); }} autoFocus placeholder="~/research/my-project" spellCheck={false} data-onboarding-folder="1" style={{ flex: 1, minWidth: 0, padding: '6px 0', border: 0, background: 'transparent', font: '13px/1.4 var(--font-mono)', color: '#171717' }} />
                  <span data-onboarding-browse="1"><Button size="sm" onClick={browseFolder}>Choose…</Button></span>
                </div>
              )}
            </div>
          )}
        </div>
        {errorLine}
        <Footer showSkip={buttons.showSkip} onSkip={advance} continueDisabled={buttons.continueDisabled} onContinue={createNext} />
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
  } else if (step === 'open') {
    body = <div data-screen-label="08 Opening" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}><ThinkingDots label="opening Getting started" /></div>;
  }

  return (
    <div data-screen-label="Onboarding" data-onboarding={flowMode} data-step={step} style={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '54px 24px 24px', background: '#fff', color: '#171717', fontFamily: 'var(--font-sans)' }}>
      <div className="title-bar title-lead" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 54, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        {onBack && <button type="button" className="hov-ink" onClick={onBack} title="All projects" style={{ ...plain, font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>}
      </div>
      {/* No card (2026-09-28): the same 800 × 600 at most, drawn on nothing, so lists inside still scroll and the page never does. */}
      <div data-screen-label="Onboarding window" style={{ flex: 'none', display: 'flex', flexDirection: 'column', width: 'min(800px, 100%)', height: 'min(600px, 100%)', overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 24, padding: '40px 32px 28px' }}>
          {body}
          {pager && !place.detour && (
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <Pager count={pager.count} index={pager.index} />
              <div data-onboarding-step-of="1" style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{`${pager.index + 1} of ${pager.count}`}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
