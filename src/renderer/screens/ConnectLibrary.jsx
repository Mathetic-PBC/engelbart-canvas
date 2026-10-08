import React from 'react';
import { api, errorMessage } from '../api.js';
import BartPicker from '../workspace/BartPicker.jsx';
import { useGithubStatus } from '../workspace/useGithubStatus.js';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { SOURCES, initialPicks, subOf, choicesOf, statusOf, allEnded } from '../model/connect.js';
import obsidian from '../../../design/assets/logos/obsidian.svg';
import notion from '../../../design/assets/logos/notion.svg';
import apple from '../../../design/assets/logos/apple.svg';
import onenote from '../../../design/assets/logos/microsoft-onenote.svg';
import zotero from '../../../design/assets/logos/zotero.svg';
import overleaf from '../../../design/assets/logos/overleaf.svg';
import googledocs from '../../../design/assets/logos/googledocs.svg';
import evernote from '../../../design/assets/logos/evernote.svg';
import granola from '../../../design/assets/logos/granola-light.svg';
import meet from '../../../design/assets/logos/google-meet.svg';
import zoom from '../../../design/assets/logos/zoom.svg';
import openai from '../../../design/assets/logos/openai.svg';
import codex from '../../../design/assets/logos/codex_light.svg';
import claude from '../../../design/assets/logos/claude-ai-icon.svg';
import grok from '../../../design/assets/logos/grok-light.svg';
import gemini from '../../../design/assets/logos/gemini.svg';
import perplexity from '../../../design/assets/logos/perplexity.svg';
import cursor from '../../../design/assets/logos/cursor_light.svg';
import github from '../../../design/assets/logos/github.svg';

// Connect your library (2026-10-07): port of Claude Design "Connect Library.dc.html" (design/connect-library/), an
// experimental onboarding screen shown only in test mode. Choose: what should go in the library, by source and app, ticked
// where main found the app on this Mac (connect-detect). Refine: one continuous chat with the librarian agent
// (src/main/connect), whose questions are single choice (chips), multiple choice (chips that tick, then Continue) or open
// (the reply box), and whose buttons sign in or choose a folder or an export; each source it settles starts importing in
// the background while the chat goes on, shown under the header. Import: every source not yet started goes now, and the
// list follows them. Everything lands in the test library; notes wait for the project onboarding makes next.

const LOGOS = { Obsidian: obsidian, Notion: notion, 'Apple Notes': apple, OneNote: onenote, Zotero: zotero, Overleaf: overleaf, 'Google Docs': googledocs, Evernote: evernote, Granola: granola, 'Google Meet': meet, Zoom: zoom, ChatGPT: openai, Codex: codex, Claude: claude, 'Claude Code': claude, Grok: grok, Gemini: gemini, Perplexity: perplexity, Cursor: cursor, GitHub: github };
const EASE = 'cubic-bezier(.25,.1,.25,1)';
// The design's classes (DocEditor's CARD_CSS, not mounted during onboarding).
const CSS = '.bart-ic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#4d4d4d}.bart-ic:hover{background:#f2f2f2;color:#171717}'
  + '.bart-chip{transition:border-color 120ms}.bart-chip:hover{border-color:#c9c9c9!important}.bart-send{transition:background 120ms}.bart-send:hover{opacity:.86}'
  + '.bart-text{padding:4px 2px;border:0;background:transparent;color:#8f8f8f;font:500 12px/1.4 var(--font-sans);cursor:pointer}.bart-text:hover{color:#171717}'
  + '.connect-chip[data-on="1"]{background:#171717!important;border-color:#171717!important;color:#fff!important}';

const Svg = ({ size = 12, width = 2, children }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const CARET_RIGHT = <Svg><path d="m9 18 6-6-6-6" /></Svg>;
const CARET_DOWN = <Svg><path d="m6 9 6 6 6-6" /></Svg>;
const PLUS = <Svg size={14} width={1.5}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
const FOLDER = <Svg size={14} width={1.5}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>;
const ARROW_UP = <Svg size={13} width={2.2}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Svg>;
const BACK = <Svg size={16} width={1.5}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Svg>;
const DOWNLOAD = <Svg size={14} width={1.8}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Svg>;
const CHECK = <Svg size={12} width={2.5}><path d="M20 6 9 17l-5-5" /></Svg>;

const shown = (dir) => String(dir || '').replace(/^\/Users\/[^/]+/, '~');
const rectOf = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
const providerOf = (models, key) => Object.keys(models.providers).find((id) => models.providers[id].models[key]) || models.provider;

function Box({ on, size = 14 }) {
  return <span role="checkbox" aria-checked={on ? 'true' : 'false'} style={{ flex: 'none', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, boxSizing: 'border-box', background: on ? '#171717' : '#fff', border: on ? 0 : '1.5px solid #c9c9c9', color: '#fff', font: '600 9px/1 var(--font-sans)', cursor: 'pointer' }}>{on ? '✓' : ''}</span>;
}

const subRow = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 30, padding: '0 8px 0 18px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' };

function AppRow({ name, on, onToggle }) {
  return (
    <button type="button" className="hov-wash" data-connect-app={name} onClick={onToggle} style={subRow}>
      <span aria-hidden="true" style={{ flex: 'none', display: 'block', width: 14, height: 14, margin: '0 1px', background: LOGOS[name] ? `url(${LOGOS[name]}) center / contain no-repeat` : 'none' }} />
      <span style={{ flex: 1, minWidth: 0, font: '13px/1 var(--font-sans)', color: on ? '#171717' : '#4d4d4d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <Box on={on} />
    </button>
  );
}

function FolderRow({ path, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 8px 0 18px', color: '#171717' }}>
      {FOLDER}
      <span style={{ flex: 1, minWidth: 0, font: '12px/1 var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown(path)}</span>
      <button type="button" className="hov-ink" onClick={onRemove} aria-label="Remove folder" style={{ display: 'inline-flex', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', color: '#8f8f8f', font: '14px/1 var(--font-sans)' }}>×</button>
    </div>
  );
}

function AddRow({ label, hint, onClick, data }) {
  return (
    <button type="button" className="hov-wash" data-connect-add={data} onClick={onClick} style={{ ...subRow, color: '#8f8f8f' }}>
      {PLUS}
      <span style={{ flex: 1, minWidth: 0, font: '13px/1 var(--font-sans)' }}>{label}</span>
      {hint && <span style={{ font: '12px/1 var(--font-sans)', color: '#c9c9c9' }}>{hint}</span>}
    </button>
  );
}

/** The model chip: "Refine with Claude Code  Opus ⌄ | ↑" on the choose screen, "Opus High ⌄ | ↑" under the chat. */
function Chip({ lead, label, onPicker, onSend, sendOn, sendLabel, style }) {
  return (
    <span className="bart-chip" role="button" data-connect-chip="1" onClick={(event) => onPicker(event.currentTarget)} title="Choose the model" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap', ...style }}>
      {lead && <span>{lead}</span>}
      <span style={{ color: lead ? '#8f8f8f' : '#171717' }}>{label}</span>
      <span style={{ display: 'inline-flex', color: '#8f8f8f' }}>{CARET_DOWN}</span>
      <span style={{ width: 1, height: 14, background: '#eaeaea', margin: '0 2px' }} />
      <button type="button" className="bart-send" data-connect-send="1" aria-label={sendLabel} onClick={(event) => { event.stopPropagation(); onSend(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, border: 0, borderRadius: '50%', background: sendOn ? '#0070f3' : '#f2f2f2', color: sendOn ? '#fff' : '#8f8f8f', cursor: 'pointer' }}>{ARROW_UP}</button>
    </span>
  );
}

/** The repositories the GitHub sign-in can read, to tick (Code's "Select repositories…"). */
function RepoList({ chosen, onToggle }) {
  const [list, setList] = React.useState(null);
  const [q, setQ] = React.useState('');
  const [problem, setProblem] = React.useState('');
  React.useEffect(() => { api.githubRepos().then((value) => setList(value.repos || [])).catch((error) => { setList([]); setProblem(errorMessage(error)); }); }, []);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (list || []).filter((repo) => words.every((word) => repo.fullName.toLowerCase().includes(word)));
  return (
    <div data-connect-repos="1" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 8px 4px 18px' }}>
      <input value={q} onChange={(event) => setQ(event.target.value)} autoFocus placeholder="search repositories…" spellCheck={false} className="focus-bd2" style={{ padding: '6px 10px', border: '1px solid #eaeaea', borderRadius: 6, font: '12.5px/1.4 var(--font-sans)', color: '#171717', background: '#fff' }} />
      <div style={{ maxHeight: 168, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {!list && <span style={{ padding: '6px 2px', font: 'italic 12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>…</span>}
        {rows.map((repo) => (
          <button key={repo.id || repo.fullName} type="button" className="hov-wash" onClick={() => onToggle(repo.fullName)} style={{ ...subRow, padding: '0 2px', height: 28 }}>
            <span style={{ flex: 1, minWidth: 0, font: '12.5px/1 var(--font-sans)', color: '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.fullName}</span>
            <Box on={chosen.includes(repo.fullName)} />
          </button>
        ))}
        {list && !rows.length && <span style={{ padding: '6px 2px', font: 'italic 12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{problem || 'no repositories match…'}</span>}
      </div>
    </div>
  );
}

/** A librarian's message: its words, then its question's chips or its button. Only the last message's are live. */
function AgentMessage({ entry, live, onPick, onConnect, connecting }) {
  const [ticked, setTicked] = React.useState([]);
  const ask = live ? entry.ask : null;
  const connect = live ? entry.connect : null;
  return (
    <div data-connect-agent="1" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '92%', animation: `rise 260ms ${EASE}` }}>
      {entry.text && <div style={{ font: '14.5px/1.7 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', textWrap: 'pretty' }}>{entry.text}</div>}
      {entry.ask && <div style={{ font: '500 14.5px/1.6 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{entry.ask.title}</div>}
      {ask && ask.kind !== 'open' && ask.options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ask.options.map((label) => {
            const on = ticked.includes(label);
            return <button key={label} type="button" className="bart-chip connect-chip" data-on={on ? '1' : '0'} data-connect-option={label} onClick={() => (ask.kind === 'multi' ? setTicked((now) => (now.includes(label) ? now.filter((x) => x !== label) : [...now, label])) : onPick([label]))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', cursor: 'pointer', font: '13px/1.2 var(--font-sans)', color: '#171717' }}>{ask.kind === 'multi' && <span style={{ font: '600 10px/1 var(--font-sans)' }}>{on ? '✓' : '+'}</span>}{label}</button>;
          })}
          {ask.kind === 'multi' && <button type="button" data-connect-continue="1" disabled={!ticked.length} onClick={() => onPick(ticked)} style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 12px', border: 0, borderRadius: 999, background: ticked.length ? '#0070f3' : '#f2f2f2', color: ticked.length ? '#fff' : '#8f8f8f', cursor: ticked.length ? 'pointer' : 'default', font: '500 13px/1.2 var(--font-sans)' }}>Continue</button>}
        </div>
      )}
      {connect && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          {connect.how && <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{connect.how}</span>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" className="hov-dim" data-connect-button={connect.kind} disabled={connecting} onClick={() => onConnect(connect)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 12px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: connecting ? 'default' : 'pointer', font: '500 13px/1 var(--font-sans)', opacity: connecting ? 0.6 : 1 }}>
              {LOGOS[connect.app] && <span aria-hidden="true" style={{ width: 14, height: 14, background: `url(${LOGOS[connect.app]}) center / contain no-repeat`, filter: 'brightness(0) invert(1)' }} />}
              {connecting ? 'Waiting…' : connect.label}
            </button>
            <button type="button" className="bart-text" data-connect-skip="1" onClick={() => onPick(null)}>Skip</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * `onDone(sessionId | null)`: Done after Import (its id, for the project onboarding makes), or Skip for now (null).
 * `onSession(id)`: a session began, so onboarding can hand it to start-project even if the person leaves early.
 */
export default function ConnectLibrary({ onDone, onSession = () => {} }) {
  const [found, setFound] = React.useState(null);
  const [step, setStep] = React.useState('choose'); // choose | chat | sent
  const [picks, setPicks] = React.useState(null); // { picks, apps, open }
  const [folders, setFolders] = React.useState({ papers: [], code: [] });
  const [repos, setRepos] = React.useState([]);
  const [listing, setListing] = React.useState(false); // Code's repository list is open
  const [computer, setComputer] = React.useState(true);
  const [custom, setCustom] = React.useState('');
  const [models, setModels] = React.useState(null);
  const [pick, setPick] = React.useState(null);
  const [picker, setPicker] = React.useState(null); // the chip's rect while the model list is open
  const [session, setSession] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState('');
  const [connecting, setConnecting] = React.useState(false);
  const [gh] = useGithubStatus();
  const chatRef = React.useRef(null);
  const draftRef = React.useRef(null);
  const idRef = React.useRef(null);

  React.useEffect(() => {
    api.connectDetect().then((value) => { setFound(value); setPicks(initialPicks(value)); }).catch((failure) => { setError(errorMessage(failure)); setPicks(initialPicks(null)); });
    api.buildModels('build').then((value) => { setModels(value); const start = value.providers[value.provider].ladder[0]; setPick({ provider: value.provider, model: start.model, effort: start.effort }); }).catch(() => {});
    return api.onConnect((snapshot) => { if (snapshot && snapshot.id === idRef.current) setSession(snapshot); });
  }, []);

  // The chat follows its newest message.
  const length = session ? session.chat.length : 0;
  const thinking = !!(session && session.thinking);
  React.useEffect(() => { const el = chatRef.current; if (el) setTimeout(() => { el.scrollTop = el.scrollHeight; }, 40); }, [length, thinking, step]);

  if (!picks) return <div data-connect-library="loading" style={{ minHeight: 200 }} />;

  const entry = models && pick ? models.providers[pick.provider] : null;
  const targetName = entry ? entry.name : 'Claude Code';
  const modelName = entry && entry.models[pick.model] ? entry.models[pick.model].name : '';
  const effortName = pick ? (EFFORT_LABELS[pick.effort] || pick.effort) : '';
  const allOn = SOURCES.every((source) => picks.picks[source.id]);
  const anyOn = SOURCES.some((source) => picks.picks[source.id]);

  const toggleSource = (id) => setPicks((now) => ({ ...now, picks: { ...now.picks, [id]: !now.picks[id] } }));
  const expand = (id) => (id === 'sites' ? toggleSource(id) : setPicks((now) => ({ ...now, open: { ...now.open, [id]: !now.open[id] } })));
  const toggleApp = (id, app) => setPicks((now) => {
    const was = !!now.picks[id] && !!(now.apps[id] && now.apps[id][app]);
    const apps = { ...now.apps, [id]: { ...now.apps[id], [app]: !was } };
    return { ...now, apps, picks: { ...now.picks, [id]: Object.values(apps[id]).some(Boolean) } };
  });
  const pickFolder = async (id) => {
    const chosen = await window.terminalAPI.pickDirectory(undefined).catch(() => null);
    if (!chosen) return;
    setFolders((now) => ({ ...now, [id]: id === 'papers' ? [chosen] : (now[id].includes(chosen) ? now[id] : [...now[id], chosen]) }));
    setPicks((now) => ({ ...now, picks: { ...now.picks, [id]: true } }));
  };
  const toggleRepo = (name) => {
    setRepos((now) => (now.includes(name) ? now.filter((x) => x !== name) : [...now, name]));
    setPicks((now) => ({ ...now, picks: { ...now.picks, code: true } }));
  };
  const githubSignIn = () => { setError(''); api.githubConnect().catch((failure) => setError(errorMessage(failure))); };

  const start = async () => {
    setPicker(null);
    if (!anyOn) { setError('Pick at least one source.'); return; }
    setError('');
    try {
      const snapshot = await api.connectStart(choicesOf({ picks: picks.picks, apps: picks.apps, folders, repos, custom, computer, pick }));
      idRef.current = snapshot.id;
      setSession(snapshot);
      onSession(snapshot.id);
      setStep('chat');
      setTimeout(() => draftRef.current && draftRef.current.focus(), 60);
    } catch (failure) { setError(errorMessage(failure)); }
  };

  const reply = async (input) => {
    if (!session || session.thinking) return;
    setError('');
    try { setSession(await api.connectAnswer(session.id, { ...input, pick })); setDraft(''); } catch (failure) { setError(errorMessage(failure)); }
  };
  const sendDraft = () => { const text = draft.trim(); if (text) reply({ text }); };

  // A button in the chat: Zotero's or GitHub's sign-in (waits for it to finish), or a folder or an export chosen.
  const useButton = async (connect) => {
    setError('');
    if (connect.kind === 'signin') {
      setConnecting(true);
      try {
        const done = connect.app === 'Zotero' ? await waitFor(api.zoteroConnect, api.zoteroStatus, api.onZotero) : await waitFor(api.githubConnect, api.githubStatus, api.onGithub);
        if (!done) { setConnecting(false); return; }
        if (connect.app === 'Zotero') await api.zoteroSync().catch(() => {});
        setSession(await api.connectChose(session.id, { app: connect.app, kind: 'signin' }));
      } catch (failure) { setError(errorMessage(failure)); }
      setConnecting(false);
      return;
    }
    const chosen = connect.kind === 'file'
      ? (await api.pickLibraryPaths('any').catch(() => []))[0]
      : await window.terminalAPI.pickDirectory(undefined).catch(() => null);
    if (!chosen) return;
    try { setSession(await api.connectChose(session.id, { app: connect.app, kind: connect.kind, path: chosen })); } catch (failure) { setError(errorMessage(failure)); }
  };

  const importNow = async () => {
    setPicker(null);
    try { setSession(await api.connectImport(session.id)); setStep('sent'); } catch (failure) { setError(errorMessage(failure)); }
  };
  const back = () => {
    setPicker(null);
    if (session) api.connectStop(session.id).catch(() => {});
    idRef.current = null;
    setSession(null);
    setStep('choose');
  };

  const openPicker = (element) => setPicker((now) => (now ? null : rectOf(element)));
  const jobs = session ? session.jobs : [];
  const last = session ? session.chat.length - 1 : -1;
  const lastEntry = session && last >= 0 ? session.chat[last] : null;
  const openAsk = lastEntry && lastEntry.role === 'agent' && lastEntry.ask && lastEntry.ask.kind === 'open' ? lastEntry.ask : null;
  const chatW = step === 'chat';

  return (
    <div data-connect-library={step} role="dialog" aria-label="Connect your library" onMouseDown={(event) => { if (picker && !(event.target.closest && event.target.closest('[data-bart-picker], .bart-chip'))) setPicker(null); }} style={{ position: 'relative', flex: '0 1 auto', minHeight: 0, width: `min(${chatW ? 600 : 520}px, calc(100% - 32px))`, height: chatW ? 'min(640px, 100%)' : 'auto', maxHeight: 'min(720px, 100%)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }}>
      <style>{CSS}</style>

      {step === 'choose' && (
        <>
          <div style={{ padding: '18px 20px 6px' }}><div style={{ font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>What should go in your library?</div></div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 20px 16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', margin: '0 -8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>
                Sources<span style={{ fontSize: 9 }}>▾</span><span style={{ flex: 1 }} />
                <button type="button" className="bart-text" data-connect-all="1" onClick={() => setPicks((now) => ({ ...now, picks: Object.fromEntries(SOURCES.map((source) => [source.id, !allOn])) }))}>{allOn ? 'Clear' : 'Select all'}</button>
              </div>
              {SOURCES.map((source) => {
                const on = !!picks.picks[source.id];
                const open = !!picks.open[source.id] && source.id !== 'sites';
                const sub = subOf(source.id, { on, apps: picks.apps, repos, folders: folders[source.id] || [] });
                const where = source.id === 'sites' ? (found && found.sites && found.sites.where) : '';
                return (
                  <React.Fragment key={source.id}>
                    <div className="hov-wash" data-connect-source={source.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 8px 0 4px', borderRadius: 6 }}>
                      <button type="button" onClick={() => expand(source.id)} aria-expanded={open ? 'true' : 'false'} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: on ? '#171717' : '#8f8f8f' }}>
                        <span style={{ flex: 'none', width: 12, display: 'flex', justifyContent: 'center', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform 140ms' }}>{source.id === 'sites' ? null : CARET_RIGHT}</span>
                        <span style={{ flex: 1, minWidth: 0, font: '13.5px/1 var(--font-sans)', color: '#171717' }}>{source.label}</span>
                        <span title={where || undefined} style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{sub || (where && on ? where : '')}</span>
                      </button>
                      <span onClick={(event) => { event.stopPropagation(); toggleSource(source.id); }}><Box on={on} /></span>
                    </div>
                    {open && (
                      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1, padding: '1px 0 4px 26px' }}>
                        <span style={{ position: 'absolute', left: 33, top: 2, bottom: 6, width: 1, background: '#eaeaea' }} />
                        {source.apps.map((app) => <AppRow key={app} name={app} on={on && !!(picks.apps[source.id] && picks.apps[source.id][app])} onToggle={() => toggleApp(source.id, app)} />)}
                        {source.id === 'papers' && (folders.papers.length
                          ? folders.papers.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => setFolders((now) => ({ ...now, papers: [] }))} />)
                          : <AddRow label="Select a folder…" hint="optional" data="papers-folder" onClick={() => pickFolder('papers')} />)}
                        {source.id === 'code' && (
                          <>
                            {repos.map((name) => <AppRow key={name} name={name} on={on} onToggle={() => toggleRepo(name)} />)}
                            {folders.code.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => setFolders((now) => ({ ...now, code: now.code.filter((x) => x !== dir) }))} />)}
                            {gh && gh.connected
                              ? <AddRow label="Select repositories…" data="repos" onClick={() => setListing((now) => !now)} />
                              : <AddRow label={gh && gh.pending ? 'Waiting for GitHub…' : 'Sign in to GitHub…'} hint="repositories" data="github" onClick={githubSignIn} />}
                            {listing && gh && gh.connected && <RepoList chosen={repos} onToggle={toggleRepo} />}
                            <AddRow label="Select a folder…" hint="local repos" data="code-folder" onClick={() => pickFolder('code')} />
                          </>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            <button type="button" role="checkbox" aria-checked={computer ? 'true' : 'false'} data-connect-computer="1" onClick={() => setComputer((now) => !now)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
              <Box on={computer} />
              <span style={{ font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Allow agents to use my computer</span>
            </button>
            <div className="focus-bd2" style={{ display: 'flex', padding: '10px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fafafa', transition: 'border-color 120ms' }}>
              <textarea value={custom} onChange={(event) => setCustom(event.target.value)} rows={2} spellCheck={false} data-connect-custom="1" placeholder="custom instructions… e.g. skip papers I only skimmed" style={{ all: 'unset', flex: 1, minHeight: 40, resize: 'none', font: '13px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} />
            </div>
          </div>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '12px 20px', borderTop: '1px solid #eaeaea' }}>
            {error && <span data-connect-error="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.4 var(--font-sans)', color: '#e70022' }}>{error}</span>}
            <Chip lead={`Refine with ${targetName}`} label={modelName} onPicker={openPicker} onSend={start} sendOn={anyOn} sendLabel="Refine" />
          </div>
        </>
      )}

      {step === 'chat' && session && (
        <>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 12px 12px', borderBottom: '1px solid #eaeaea' }}>
            <button type="button" className="bart-ic" onClick={back} aria-label="Back" title="Back">{BACK}</button>
            <div style={{ flex: 1, minWidth: 0, font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>Refine with {targetName}</div>
            <button type="button" className="hov-dim" data-connect-import="1" onClick={importNow} style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px 0 12px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', whiteSpace: 'nowrap' }}>{DOWNLOAD}Import</button>
          </div>
          {jobs.length > 0 && (
            <div data-connect-jobs="1" style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', gap: '4px 14px', padding: '8px 20px', borderBottom: '1px solid #f2f2f2', font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>
              {jobs.map((job) => { const status = statusOf(job); return <span key={job.id} title={job.activity || job.summary || job.error || ''} style={{ whiteSpace: 'nowrap' }}><span style={{ color: '#4d4d4d' }}>{job.label}</span> · <span style={{ color: status.failed ? '#e70022' : status.done ? '#171717' : '#8f8f8f' }}>{status.text}</span></span>; })}
            </div>
          )}
          <div ref={chatRef} data-connect-chat="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px' }}>
            {session.chat.map((item, i) => (item.role === 'agent'
              ? <AgentMessage key={i} entry={item} live={i === last && !session.thinking && !session.finished} connecting={connecting} onPick={(labels) => reply(labels ? { picked: labels } : { skipped: true })} onConnect={useButton} />
              : <div key={i} data-connect-user="1" style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 12, background: '#f2f2f2', font: '14.5px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', animation: `rise 160ms ${EASE}` }}>{item.text}</div>))}
            {session.thinking && <div data-connect-thinking="1" style={{ font: 'italic 14px/1.5 var(--font-sans)', color: '#8f8f8f' }}>{session.activity ? `${session.activity}…`.replace(/……$/, '…') : 'Thinking…'}</div>}
            {(session.error || error) && <div data-connect-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{session.error || error}{session.error ? ' Reply to try again.' : ''}</div>}
          </div>
          <div style={{ flex: 'none', padding: '0 16px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 14px 14px 16px', background: '#fafafa', borderRadius: 10 }}>
              <textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} rows={1} data-connect-draft="1" placeholder={openAsk && openAsk.placeholder ? openAsk.placeholder : 'Reply…'} spellCheck={false} style={{ flex: 1, minWidth: 0, display: 'block', minHeight: 24, margin: 0, padding: 0, border: 0, background: 'none', outline: 'none', resize: 'none', font: '15px/1.6 var(--font-sans)', color: '#171717' }} />
              <Chip label={`${modelName} ${effortName}`.trim()} onPicker={openPicker} onSend={sendDraft} sendOn={!!draft.trim() && !session.thinking} sendLabel="Send" style={{ marginTop: -3 }} />
            </div>
          </div>
        </>
      )}

      {step === 'sent' && session && (
        <>
          <div style={{ padding: '18px 20px 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: '#171717', color: '#fff' }}>{CHECK}</span>
            <div style={{ font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>Importing with {targetName}</div>
          </div>
          <div data-connect-progress="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '6px 20px 16px' }}>
            {jobs.map((job) => {
              const status = statusOf(job);
              return (
                <div key={job.id} data-connect-job={job.status} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 0', borderBottom: '1px solid #f2f2f2' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', color: '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.label}</span>
                    <span style={{ flex: 'none', font: '12.5px/1 var(--font-sans)', color: status.failed ? '#e70022' : status.done ? '#171717' : '#8f8f8f' }}>{status.text}</span>
                  </div>
                  {(job.activity || job.summary || job.error) && <span style={{ font: '12px/1.5 var(--font-sans)', color: job.error ? '#e70022' : '#8f8f8f', overflowWrap: 'anywhere' }}>{job.error || (status.done ? job.summary : `${job.activity}…`.replace(/……$/, '…'))}</span>}
                </div>
              );
            })}
            {!jobs.length && <span style={{ padding: '9px 0', font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing could be read yet: sign in or choose a folder in the chat first.</span>}
            <span style={{ paddingTop: 12, font: '12px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{allEnded(jobs) ? 'Everything has finished.' : 'Imports keep running in the background while you go on.'} Notes go into the project you create next.</span>
          </div>
          <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid #eaeaea' }}>
            <button type="button" data-connect-done="1" onClick={() => onDone(session.id)} style={{ flex: 'none', whiteSpace: 'nowrap', height: 34, padding: '0 16px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' }}>Done</button>
          </div>
        </>
      )}

      {picker && models && pick && step !== 'sent' && (
        <BartPicker
          models={models}
          current={pick}
          anchor={picker}
          hover={false}
          cover
          onPick={(next) => setPick({ provider: providerOf(models, next.model), model: next.model, effort: next.effort })}
          onEnter={() => {}}
          onLeave={() => {}}
        />
      )}
    </div>
  );
}

/** A sign-in started, then waited for: true once its status says connected, false when it stops waiting (cancelled, an error). */
function waitFor(begin, status, subscribe) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const settle = (value) => { off(); resolve(value); };
    let waiting = false; // a status that is neither connected nor waiting only ends it once the sign-in was waiting
    off = subscribe((next) => {
      if (!next) return;
      if (next.connected) settle(true);
      else if (next.pending) waiting = true;
      else if (waiting) settle(false);
    });
    begin().then((first) => {
      if (first && first.connected) settle(true);
      else if (first && first.pending) waiting = true;
      else if (first && first.error) settle(false);
    }).catch((error) => { off(); reject(error); });
    status().then((now) => { if (now && now.connected) settle(true); }).catch(() => {});
  });
}
