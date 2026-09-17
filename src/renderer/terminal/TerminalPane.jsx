// The Terminal pane (design 2026-09-17): a tab strip like the browser's, a light xterm body,
// and a bottom bar with the running agent, the working directory, and a Terminal /
// Claude Code / Codex switcher. Every tab is a real PTY session from the Experimental
// Terminal engine; sessions live in ./sessions.js and survive unmounts.
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
  providerName,
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
const basename = (value) => (String(value || '~').replace(/\/+$/, '').split('/').pop() || '/');

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
  const [activeId, setActiveId] = useState(null);
  const [launching, setLaunching] = useState(null);
  const autoStarted = useRef(new Set());

  const sessions = sessionsFor(projectId);
  const active = sessions.find((record) => record.snapshot.id === activeId) || null;
  const current = active || sessions[0] || null;
  const currentId = current ? current.snapshot.id : null;
  const currentCwd = current ? current.snapshot.cwd : cwd;

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

  const activate = (id) => {
    setActiveId(id);
    requestAnimationFrame(() => requestAnimationFrame(() => { fitSession(id); focusSession(id); }));
  };

  const launch = async (provider, at) => {
    const info = state.providers.get(provider);
    if (provider !== 'shell' && info && !info.available) return null;
    setLaunching({ provider });
    try {
      const dims = estimateDimensions(stageRef.current);
      const record = await createSession({ provider, cwd: at || currentCwd || cwd, projectId, ...dims });
      activate(record.snapshot.id);
      setLaunching(null);
      return record;
    } catch (error) {
      setLaunching({ error: `${providerName(provider)} could not be started: ${errorText(error)}` });
      return null;
    }
  };

  // The switcher: Claude Code / Codex run in the tab's directory; Terminal is the plain shell.
  const pickAgent = (provider) => {
    if (current && current.snapshot.provider === provider && current.snapshot.status === 'running') { focusSession(currentId); return; }
    const existing = [...sessions].reverse().find((record) => record.snapshot.provider === provider && record.snapshot.status === 'running');
    if (existing) { activate(existing.snapshot.id); return; }
    void launch(provider, currentCwd);
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

  // ⌘T opens a new terminal while the pane is showing; ⌘1–9 switch tabs while the shell has focus.
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
  const agentId = current ? current.snapshot.provider : 'shell';
  const agentLabel = (AGENTS.find((agent) => agent.id === agentId) || AGENTS[0]).label;

  return (
    <div ref={rootRef} data-terminal="1" onKeyDown={stopKeys} onKeyUp={stopKeys} style={{ flex: 1, minHeight: 0, display: visible ? 'flex' : 'none', flexDirection: 'column', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '6px 8px 0', background: '#fafafa', borderBottom: '1px solid #eaeaea', flex: 'none', overflow: 'hidden' }}>
        {sessions.map((record) => {
          const id = record.snapshot.id;
          const on = id === currentId;
          const running = record.snapshot.status === 'running';
          const title = `${basename(record.snapshot.cwd)}${running ? '' : ` · exited${Number.isInteger(record.snapshot.exitCode) ? ` ${record.snapshot.exitCode}` : ''}`}`;
          return (
            <div key={id} className="hov-ink" onClick={() => activate(id)} title={`${providerName(record.snapshot.provider)} · ${record.snapshot.cwd}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto', maxWidth: 220, padding: '7px 10px 8px', border: `1px solid ${on ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', marginBottom: -1, background: on ? '#fff' : 'transparent', cursor: 'pointer', font: `${on ? 500 : 400} 12.5px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap', transition: 'color 120ms' }}>
              <span style={{ flex: 'none', font: `11px/1 ${MONO}`, color: '#8f8f8f' }}>›_</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); void close(id); }} aria-label="Close terminal" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            </div>
          );
        })}
        <button type="button" className="hov-ink-wash" onClick={() => void launch('shell', currentCwd)} title="New terminal (⌘T)" style={{ flex: 'none', alignSelf: 'center', width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '16px/1 var(--font-sans)', color: '#4d4d4d' }}>+</button>
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
          <span title={currentCwd || ''} style={{ flex: '0 1 auto', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', font: `11.5px/1.4 ${MONO}`, color: '#4d4d4d', whiteSpace: 'nowrap', overflow: 'hidden' }}><span style={{ color: '#8f8f8f' }}>▭</span><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentCwd || '~'}</span></span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
            {AGENTS.map((agent) => {
              const info = state.providers.get(agent.id);
              const available = agent.id === 'shell' || !info || info.available;
              const on = agentId === agent.id;
              return (
                <button key={agent.id} type="button" className="hov-ink" disabled={!available} title={available ? `${agent.label} in ${currentCwd || 'home'}` : 'not found on PATH'} onClick={() => pickAgent(agent.id)} style={{ padding: '0 0 3px', border: 0, background: 'transparent', cursor: available ? 'pointer' : 'default', font: `${on ? 500 : 400} 13.5px/1 var(--font-sans)`, color: on ? '#171717' : (available ? '#8f8f8f' : '#c9c9c9'), borderBottom: `1.5px solid ${on ? '#171717' : 'transparent'}`, whiteSpace: 'nowrap', transition: 'color 120ms' }}>{agent.label}</button>
              );
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
