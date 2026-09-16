// The design's terminal box (Goal Canvas.dc.html lines 276–292) backed by real PTY sessions
// from the Experimental Terminal engine. Sessions live in ./sessions.js and survive unmounts.
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

const MONO = 'var(--font-mono)';
const LAUNCHERS = ['shell', 'claude', 'codex'];

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

export default function TerminalPane({ cwd, projectId, visible = true, style }) {
  useSyncExternalStore(subscribeVersion, getVersion);
  const state = getState();
  const stageRef = useRef(null);
  const [activeId, setActiveId] = useState(null);
  const [launching, setLaunching] = useState(null);
  const autoStarted = useRef(new Set());

  const sessions = sessionsFor(projectId);
  const active = sessions.find((record) => record.snapshot.id === activeId) || null;
  const current = active || sessions[0] || null;
  const currentId = current ? current.snapshot.id : null;

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
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
        fitSession(currentId);
      }));
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [currentId, visible, state.sessions.size]);

  // Refit whenever the stage resizes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (currentId && visible) {
        requestAnimationFrame(() => requestAnimationFrame(() => fitSession(currentId)));
      }
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
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitSession(id);
      focusSession(id);
    }));
  };

  const launch = async (provider) => {
    const info = state.providers.get(provider);
    if (provider !== 'shell' && info && !info.available) return;
    setLaunching({ provider });
    try {
      const dims = estimateDimensions(stageRef.current);
      const record = await createSession({ provider, cwd, projectId, ...dims });
      activate(record.snapshot.id);
      setLaunching(null);
    } catch (error) {
      setLaunching({ error: `${providerName(provider)} could not be started: ${errorText(error)}` });
    }
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

  // Keys inside the pane belong to the shell: the workspace's global ⌘1–9 / Esc must not fire.
  const stopKeys = (event) => { event.stopPropagation(); };

  const errors = state.errors;

  return (
    <div
      data-terminal="1"
      onKeyDown={stopKeys}
      onKeyUp={stopKeys}
      onClick={() => { if (currentId) focusSession(currentId); }}
      style={{
        display: visible ? 'flex' : 'none',
        flex: 'none',
        height: 210,
        flexDirection: 'column',
        gap: 2,
        padding: '12px 16px 12px',
        borderRadius: 10,
        background: '#0a0a0a',
        color: '#ededed',
        font: `12px/1.7 ${MONO}`,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8, font: `11px/1 ${MONO}`, color: '#8f8f8f', flex: 'none', minWidth: 0 }}>
        <span style={{ flex: 'none' }}>TERMINAL</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflow: 'hidden' }}>
          {sessions.map((record) => {
            const id = record.snapshot.id;
            const on = id === currentId;
            const running = record.snapshot.status === 'running';
            const exit = Number.isInteger(record.snapshot.exitCode) ? ` [exited ${record.snapshot.exitCode}]` : (running ? '' : ' [exited]');
            return (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); activate(id); }}
                  title={`${record.displayTitle} · ${record.snapshot.cwd}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
                    font: `11px/1 ${MONO}`, color: on ? '#ededed' : '#8f8f8f', borderBottom: `1px solid ${on ? '#ededed' : 'transparent'}`,
                    maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  <span aria-hidden="true" style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: running ? '#7ee0a7' : '#454545' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.displayTitle}{exit}</span>
                </button>
                <button
                  type="button"
                  aria-label="Close session"
                  title="Close session"
                  onClick={(event) => { event.stopPropagation(); void close(id); }}
                  style={{ padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: `12px/1 ${MONO}`, color: '#454545' }}
                  className="hov-del"
                >×</button>
              </span>
            );
          })}
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, flex: 'none' }}>
          {LAUNCHERS.map((provider) => {
            const info = state.providers.get(provider);
            const known = provider === 'shell' || !!info;
            const available = provider === 'shell' || (info && info.available);
            const busy = launching && launching.provider === provider;
            const title = !known ? 'checking installation…' : (available ? `new ${providerName(provider)} session in ${cwd || 'home'}` : 'not found on PATH');
            const activeProvider = current && current.snapshot.provider === provider;
            return (
              <button
                key={provider}
                type="button"
                disabled={!available || !!busy}
                title={title}
                onClick={(event) => { event.stopPropagation(); void launch(provider); }}
                style={{
                  padding: 0, border: 0, background: 'transparent', cursor: available ? 'pointer' : 'default',
                  font: `11px/1 ${MONO}`, color: available ? (activeProvider ? '#ededed' : '#8f8f8f') : '#454545',
                  borderBottom: `1px solid ${activeProvider ? '#ededed' : 'transparent'}`,
                }}
              >{busy ? `${provider}…` : provider}</button>
            );
          })}
        </span>
      </div>
      {launching && launching.error ? (
        <div style={{ flex: 'none', color: '#ff5e63', whiteSpace: 'pre-wrap' }}># {launching.error}</div>
      ) : null}
      {errors.map((entry) => (
        <div key={entry.at} style={{ flex: 'none', display: 'flex', gap: 8, color: '#ff5e63' }}>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}># {entry.message}</span>
          <button type="button" aria-label="Dismiss" onClick={(event) => { event.stopPropagation(); dismissError(entry.at); }} style={{ padding: 0, border: 0, background: 'transparent', color: '#8f8f8f', cursor: 'pointer', font: `12px/1 ${MONO}` }}>×</button>
        </div>
      ))}
      <div ref={stageRef} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {!currentId ? (
          <div style={{ color: '#8f8f8f' }}>
            {'# '}{!state.bootstrapComplete ? 'starting…' : (cwd ? 'no session yet' : 'no project directory')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
