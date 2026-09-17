// The Terminal pane (design 2026-09-17, chat-style per Hudson): a tab strip with an agent
// dropdown at its right, an empty light transcript (xterm), and a bottom bar with the agent and
// working-directory chips and — for plain shells — a "Run commands" box you type into like a
// chat. Claude Code and Codex draw their own input, so the box hides while they run. Every tab
// is a real PTY session from the Experimental Terminal engine; the shell's prompt is emptied by
// the ZDOTDIR wrapper in src/main/shell-rc.cjs so the transcript starts blank.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  bootstrap,
  closeSession,
  createSession,
  dismissError,
  estimateDimensions,
  fitSession,
  focusSession,
  getState,
  mountView,
  pickDirectory,
  providerName,
  sendInput,
  sessionsFor,
  subscribe,
  unmountView,
} from './sessions.js';

const AGENTS = [
  { id: 'shell', label: 'Terminal' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];
const MONO = 'var(--font-mono)';
const EASE = 'cubic-bezier(.25,.1,.25,1)';
const basename = (value) => (String(value || '~').replace(/\/+$/, '').split('/').pop() || '/');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let version = 0;
const bump = () => { version += 1; };
function subscribeVersion(callback) {
  return subscribe(() => { bump(); callback(); });
}
function getVersion() {
  return version;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export default function TerminalPane({ cwd, projectId, visible = true }) {
  useSyncExternalStore(subscribeVersion, getVersion);
  const state = getState();
  const stageRef = useRef(null);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const menuRef = useRef(null);
  const [activeId, setActiveId] = useState(null);
  const [launching, setLaunching] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y }
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(null);
  const [cwdOverride, setCwdOverride] = useState({}); // session id → directory chosen from the picker
  const autoStarted = useRef(new Set());

  const sessions = sessionsFor(projectId);
  const active = sessions.find((record) => record.snapshot.id === activeId) || null;
  const current = active || sessions[0] || null;
  const currentId = current ? current.snapshot.id : null;
  const provider = current ? current.snapshot.provider : 'shell';
  const isAgent = provider !== 'shell';
  const running = !!current && current.snapshot.status === 'running';
  const cwdOf = (record) => cwdOverride[record.snapshot.id] || record.snapshot.cwd;
  const currentCwd = current ? cwdOf(current) : cwd;
  const agentLabel = (AGENTS.find((agent) => agent.id === provider) || AGENTS[0]).label;

  // Bootstrap once; start one shell in the project directory when this project has none.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await bootstrap();
      if (cancelled || !projectId || !cwd) return;
      if (sessionsFor(projectId).length || autoStarted.current.has(projectId)) return;
      autoStarted.current.add(projectId);
      try {
        const dims = estimateDimensions(stageRef.current);
        const record = await createSession({ provider: 'shell', cwd, projectId, ...dims });
        if (!cancelled) setActiveId(record.snapshot.id);
      } catch (error) {
        autoStarted.current.delete(projectId);
        if (!cancelled) setLaunching({ error: `Shell could not be started: ${errorText(error)}` });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, cwd]);

  // Adopt the current session's view into the stage; detach the others.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    for (const record of state.sessions.values()) {
      if (record.snapshot.id !== currentId) unmountView(record.snapshot.id);
    }
    if (currentId && visible) {
      mountView(currentId, stage);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => { fitSession(currentId); }));
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [currentId, visible, state.sessions.size]);

  // Refit whenever the stage resizes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (currentId && visible) requestAnimationFrame(() => requestAnimationFrame(() => fitSession(currentId)));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [currentId, visible]);

  // Detach on unmount; the xterm instances and PTYs stay alive in the store.
  useEffect(() => () => {
    for (const record of getState().sessions.values()) unmountView(record.snapshot.id);
  }, []);

  // Where typing goes: the box for shells, the transcript for agents that draw their own input.
  useEffect(() => {
    if (!visible || !currentId) return;
    if (isAgent) focusSession(currentId);
    else if (inputRef.current) inputRef.current.focus();
  }, [visible, currentId, isAgent]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setMenu(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const activate = (id) => {
    setActiveId(id);
    requestAnimationFrame(() => requestAnimationFrame(() => { fitSession(id); }));
  };

  const launch = async (nextProvider, at) => {
    const info = state.providers.get(nextProvider);
    if (nextProvider !== 'shell' && info && !info.available) return null;
    setLaunching({ provider: nextProvider });
    try {
      const dims = estimateDimensions(stageRef.current);
      const record = await createSession({ provider: nextProvider, cwd: at || currentCwd || cwd, projectId, ...dims });
      activate(record.snapshot.id);
      setLaunching(null);
      return record;
    } catch (error) {
      setLaunching({ error: `${providerName(nextProvider)} could not be started: ${errorText(error)}` });
      return null;
    }
  };

  // The dropdown: Claude Code / Codex run in the current directory; Terminal is the plain shell.
  const pickAgent = (nextProvider) => {
    setMenu(null);
    if (current && provider === nextProvider && running) { if (isAgent) focusSession(currentId); else if (inputRef.current) inputRef.current.focus(); return; }
    const existing = [...sessions].reverse().find((record) => record.snapshot.provider === nextProvider && record.snapshot.status === 'running');
    if (existing) { activate(existing.snapshot.id); return; }
    void launch(nextProvider, currentCwd);
  };

  const close = async (id) => {
    const ids = sessions.map((record) => record.snapshot.id);
    const index = ids.indexOf(id);
    const closed = await closeSession(id);
    if (!closed) return;
    if (id === currentId) {
      const remaining = sessionsFor(projectId);
      const next = remaining[Math.min(index, remaining.length - 1)];
      setActiveId(next ? next.snapshot.id : null);
    }
  };

  // The working-directory chip: pick a folder; a shell changes into it, an agent remembers it for the next launch.
  const changeCwd = async () => {
    const chosen = await pickDirectory(currentCwd).catch(() => null);
    if (!chosen || !currentId) return;
    setCwdOverride((map) => ({ ...map, [currentId]: chosen }));
    if (!isAgent && running) sendInput(currentId, `cd -- ${shellQuote(chosen)}\r`);
  };

  // The box: Enter sends the line, ↑/↓ walk what you typed here, ^C ^D ^L reach the shell.
  const onInputKey = (event) => {
    if (!currentId) return;
    const key = event.key;
    if (key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = draft;
      if (running) sendInput(currentId, `${text}\r`);
      if (text.trim()) setHistory((list) => [...list.filter((item) => item !== text), text].slice(-200));
      setHistIdx(null);
      setDraft('');
      return;
    }
    if (key === 'ArrowUp' && history.length) {
      event.preventDefault();
      const idx = histIdx == null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx); setDraft(history[idx]);
      return;
    }
    if (key === 'ArrowDown' && histIdx != null) {
      event.preventDefault();
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(null); setDraft(''); } else { setHistIdx(idx); setDraft(history[idx]); }
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      const letter = key.toLowerCase();
      if (letter === 'c') { event.preventDefault(); if (running) sendInput(currentId, ''); setDraft(''); return; }
      if (letter === 'd' && !draft) { event.preventDefault(); if (running) sendInput(currentId, ''); return; }
      if (letter === 'l') { event.preventDefault(); if (running) sendInput(currentId, ''); return; }
    }
    if (key === 'Tab') { event.preventDefault(); return; }
    if (key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); }
  };

  // ⌘T opens a new terminal while the pane is showing; ⌘1–9 switch tabs while focus is in the pane.
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const inside = rootRef.current && event.target && rootRef.current.contains(event.target);
      if (event.key.toLowerCase() === 't' && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); void launch('shell', currentCwd); return; }
      if (inside && /^[1-9]$/.test(event.key)) {
        const record = sessions[Number(event.key) - 1];
        if (record) { event.preventDefault(); event.stopPropagation(); activate(record.snapshot.id); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, sessions, currentCwd]);

  const stopKeys = (event) => { event.stopPropagation(); };
  const menuW = 200;

  return (
    <div ref={rootRef} data-terminal="1" onKeyDown={stopKeys} onKeyUp={stopKeys} style={{ flex: 1, minHeight: 0, display: visible ? 'flex' : 'none', flexDirection: 'column', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '6px 8px 0', background: '#fafafa', borderBottom: '1px solid #eaeaea', flex: 'none', overflow: 'hidden' }}>
        {sessions.map((record) => {
          const id = record.snapshot.id;
          const on = id === currentId;
          const alive = record.snapshot.status === 'running';
          const title = `${basename(cwdOf(record))}${alive ? '' : ` · exited${Number.isInteger(record.snapshot.exitCode) ? ` ${record.snapshot.exitCode}` : ''}`}`;
          return (
            <div key={id} className="hov-ink" onClick={() => activate(id)} title={`${providerName(record.snapshot.provider)} · ${cwdOf(record)}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto', maxWidth: 220, padding: '7px 10px 8px', border: `1px solid ${on ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', marginBottom: -1, background: on ? '#fff' : 'transparent', cursor: 'pointer', font: `${on ? 500 : 400} 12.5px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap', transition: 'color 120ms' }}>
              <span style={{ flex: 'none', font: `11px/1 ${MONO}`, color: '#8f8f8f' }}>›_</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); void close(id); }} aria-label="Close terminal" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            </div>
          );
        })}
        <button type="button" className="hov-ink-wash" onClick={() => void launch('shell', currentCwd)} title="New terminal (⌘T)" style={{ flex: 'none', alignSelf: 'center', width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '16px/1 var(--font-sans)', color: '#4d4d4d' }}>+</button>
        <div ref={menuRef} style={{ marginLeft: 'auto', alignSelf: 'center', flex: 'none', position: 'relative' }}>
          <button type="button" className="hov-ink-wash" data-agent-menu="1" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right, y: r.bottom }); }} title="Terminal, Claude Code or Codex" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: 0, borderRadius: 6, background: menu ? '#eaeaea' : 'transparent', cursor: 'pointer', font: '500 12.5px/1.3 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}>
            <span>{agentLabel}</span>
            <span style={{ font: '10px/1 var(--font-sans)', color: '#8f8f8f' }}>⌄</span>
          </button>
          {menu && (
            <div role="menu" style={{ position: 'fixed', left: clamp(menu.x - menuW, 8, (window.innerWidth || 1200) - menuW - 8), top: menu.y + 6, zIndex: 60, width: menuW, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
              {AGENTS.map((agent) => {
                const info = state.providers.get(agent.id);
                const available = agent.id === 'shell' || !info || info.available;
                const on = provider === agent.id;
                return (
                  <div key={agent.id} role="menuitem" className={available ? 'hov-wash' : ''} onClick={() => { if (available) pickAgent(agent.id); }} title={available ? `${agent.label} in ${currentCwd || 'home'}` : 'not found on PATH'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: available ? 'pointer' : 'default', color: available ? '#171717' : '#c9c9c9' }}>
                    <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '12px/1 var(--font-sans)' }}>{on ? '✓' : ''}</span>
                    <span style={{ flex: 1, font: `${on ? 500 : 400} 13px/1.4 var(--font-sans)` }}>{agent.label}</span>
                    {!available && <span style={{ font: '10px/1 var(--font-sans)', color: '#c9c9c9' }}>not installed</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div ref={stageRef} onClick={() => { if (currentId) focusSession(currentId); }} style={{ position: 'relative', flex: 1, minHeight: 0, padding: '10px 14px 0', background: '#fff', cursor: 'text', overflow: 'hidden' }}>
        {!currentId && (
          <div style={{ font: `12.5px/1.7 ${MONO}`, color: '#8f8f8f' }}>{!state.bootstrapComplete ? 'starting…' : (cwd ? 'no terminal yet — press + or ⌘T' : 'no project directory')}</div>
        )}
        {launching && launching.error ? <div style={{ font: `12.5px/1.7 ${MONO}`, color: '#e70022', whiteSpace: 'pre-wrap' }}># {launching.error}</div> : null}
        {state.errors.map((entry) => (
          <div key={entry.at} style={{ display: 'flex', gap: 8, font: `12.5px/1.7 ${MONO}`, color: '#e70022' }}>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}># {entry.message}</span>
            <button type="button" aria-label="Dismiss" onClick={(event) => { event.stopPropagation(); dismissError(entry.at); }} style={{ padding: 0, border: 0, background: 'transparent', color: '#8f8f8f', cursor: 'pointer', font: `12px/1 ${MONO}` }}>×</button>
          </div>
        ))}
      </div>

      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px 12px', borderTop: '1px solid #eaeaea', background: '#fafafa' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 6px' }}>
          <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', font: `500 11.5px/1.4 ${MONO}`, color: '#171717', whiteSpace: 'nowrap' }}><span style={{ color: '#8f8f8f' }}>›_</span>{agentLabel}</span>
          <button type="button" className="hov-bd2" onClick={() => void changeCwd()} disabled={!currentId} title="Change working directory…" data-cwd-chip="1" style={{ flex: '0 1 auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', font: `11.5px/1.4 ${MONO}`, color: '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden', cursor: currentId ? 'pointer' : 'default', textAlign: 'left', transition: 'border-color 120ms' }}><span style={{ color: '#8f8f8f' }}>▭</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentCwd || '~'}</span></button>
        </div>
        {currentId && !isAgent && (
          <input
            ref={inputRef}
            data-term-input="1"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setHistIdx(null); }}
            onKeyDown={onInputKey}
            spellCheck={false}
            autoComplete="off"
            aria-label="Terminal input"
            placeholder={running ? 'Run commands' : 'this terminal has exited — press + for a new one'}
            disabled={!running}
            style={{ display: 'block', width: '100%', padding: '2px 0', border: 0, background: 'transparent', font: `12.5px/1.7 ${MONO}`, color: '#171717', caretColor: '#0070f3' }}
          />
        )}
      </div>
    </div>
  );
}
