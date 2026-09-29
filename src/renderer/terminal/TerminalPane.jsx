// The Terminal pane (design 2026-09-17, chat-style per Hudson). One rule decides where typing
// goes: while the shell is idle you type in the "Run commands" box at the bottom and the
// transcript does not take keys; while a program runs — a quick command, an arrow-key menu,
// Claude Code or Codex, however it was started — the keyboard belongs to the transcript, as in
// any terminal, and the box steps aside until the program ends. The shell tells us which state
// it is in through the marks emitted by the zsh wrappers (src/main/shell-rc.cjs); they also
// keep the session's working directory current. Every tab is a real PTY from the Experimental Terminal engine.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import './terminal.css';
import { FluidTab, TabCard, TabClose, TabTitle, useTabCard } from '../ui/FluidTab.jsx';
import {
  bootstrap,
  clearSession,
  closeSession,
  createSession,
  dismissError,
  estimateDimensions,
  fitSession,
  focusSession,
  getState,
  mountView,
  providerName,
  selectionText,
  sendInput,
  sessionsFor,
  setInputLock,
  subscribe,
  unmountView,
} from './sessions.js';

const AGENTS = [
  { id: 'shell', label: 'Terminal' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];
const LABEL = Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.label]));
const MONO = 'var(--font-mono)';
const EASE = 'cubic-bezier(.25,.1,.25,1)';
// Control characters by code, never as literals: editors and tools strip the raw bytes.
const CTRL = { c: String.fromCharCode(3), d: String.fromCharCode(4), l: String.fromCharCode(12) };
const TAKEOVER_DELAY = 200; // commands that finish faster never move the keyboard
const AGENT_COMMAND = /^(?:\s*(?:command|exec|noglob|nocorrect|sudo)\s+|\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\s*(?:\S*\/)?(claude|codex)(?:\s|$)/;
const basename = (value) => (String(value || '~').replace(/\/+$/, '').split('/').pop() || '/');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const agentOfCommand = (command) => { const match = AGENT_COMMAND.exec(command || ''); return match ? match[1] : null; };

function displayPath(value, homeDirectory) {
  const root = String(homeDirectory || '').replace(/[\\/]+$/, '');
  if (!root || !value) return value;
  if (value === root) return '~';
  return value.startsWith(`${root}/`) || value.startsWith(`${root}\\`) ? `~${value.slice(root.length)}` : value;
}

function fitCommandInput(input) {
  if (!input?.clientWidth) return;
  input.style.overflowY = 'hidden';
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`; // CSS caps the height for long commands.
  input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
}

/** What a tab is right now: a plain terminal, or an agent (by dropdown launch or by typing its name). */
function describe(record) {
  const shell = record.shell || {};
  const integrated = !!shell.integrated;
  const busy = integrated ? !!shell.busy : record.snapshot.provider !== 'shell';
  const agent = integrated ? (busy ? agentOfCommand(shell.command) || 'shell' : 'shell') : record.snapshot.provider;
  return { integrated, busy, agent, command: shell.command || '', cwd: (integrated && shell.cwd) || null };
}

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

export default function TerminalPane({ cwd, projectId, workspaceId, visible = true, requestedSession, onActiveSession }) {
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
  const [touched, setTouched] = useState({}); // session id → a command was sent from the box
  const [takeover, setTakeover] = useState(false); // the running program has the keyboard
  const autoStarted = useRef(new Set());
  const card = useTabCard();

  const sessions = sessionsFor(projectId);
  const active = sessions.find((record) => record.snapshot.id === activeId) || null;
  const current = active || sessions[0] || null;
  const currentId = current ? current.snapshot.id : null;
  useEffect(() => {
    if (requestedSession && sessionsFor(projectId).some((record) => record.snapshot.id === requestedSession.id)) setActiveId(requestedSession.id);
  }, [requestedSession, projectId]);
  useEffect(() => { onActiveSession?.(currentId); }, [currentId, onActiveSession]);
  const running = !!current && current.snapshot.status === 'running';
  const now = current ? describe(current) : { integrated: false, busy: false, agent: 'shell', command: '', cwd: null };
  const cwdOf = (record) => describe(record).cwd || record.snapshot.cwd;
  const projectCwd = cwd || state.settings?.lastCwd || state.home || null; // independent of the workspace's Build repository
  const currentCwd = current ? cwdOf(current) : projectCwd;
  const agentLabel = LABEL[now.agent] || LABEL.shell;
  const showBox = running && now.agent === 'shell' && !takeover;
  const boxIsInput = showBox && now.integrated; // the box owns typing; the transcript is locked

  useLayoutEffect(() => {
    if (visible) fitCommandInput(inputRef.current);
  }, [draft, showBox, visible]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || !visible) return undefined;
    let cancelled = false, width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      // Ignore our own height changes; refit wrapped lines only when width changes.
      if (next !== width) { width = next; fitCommandInput(input); }
    });
    observer?.observe(input);
    document.fonts?.ready.then(() => { if (!cancelled) fitCommandInput(input); });
    return () => { cancelled = true; observer?.disconnect(); };
  }, [showBox, visible]);

  // Bootstrap once; start one shell using the terminal's directory when this project has none.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await bootstrap();
      if (cancelled || !projectId || !visible) return;
      if (sessionsFor(projectId).length || autoStarted.current.has(projectId)) return;
      autoStarted.current.add(projectId);
      try {
        const dims = estimateDimensions(stageRef.current);
        const record = await createSession({ provider: 'shell', cwd, projectId, workspaceId, ...dims });
        if (!cancelled) setActiveId(record.snapshot.id);
      } catch (error) {
        autoStarted.current.delete(projectId);
        if (!cancelled) setLaunching({ error: `Shell could not be started: ${errorText(error)}` });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, cwd, visible]);

  // Existing sessions never follow a connection change, even before the first command.

  // ↑ recalls real commands from the first keypress: seed the box from the shell's history file.
  useEffect(() => {
    let cancelled = false;
    api.shellHistory().then((list) => { if (!cancelled && Array.isArray(list)) setHistory((mine) => [...list.filter((item) => !mine.includes(item)), ...mine].slice(-500)); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Adopt the current session's view into the stage; detach the others.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    for (const record of state.sessions.values()) {
      if (record.snapshot.id !== currentId) unmountView(record.snapshot.id);
    }
    if (currentId && visible) {
      mountView(currentId, stage);
      let cancelled = false;
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => { fitSession(currentId); }));
      // The first grid can be measured before the bundled monospace font loads.
      document.fonts?.ready.then(() => { if (!cancelled) fitSession(currentId); });
      return () => { cancelled = true; cancelAnimationFrame(raf); };
    }
    return undefined;
  }, [currentId, visible, state.sessions.size, now.agent]);

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
    for (const record of getState().sessions.values()) { unmountView(record.snapshot.id); setInputLock(record.snapshot.id, false); }
  }, []);

  // A running program takes the keyboard — after a beat, so `ls` does not make the focus jump.
  useEffect(() => {
    if (!now.busy) { setTakeover(false); return undefined; }
    if (!now.integrated) { setTakeover(true); return undefined; }
    const timer = setTimeout(() => setTakeover(true), TAKEOVER_DELAY);
    return () => clearTimeout(timer);
  }, [now.busy, now.integrated, currentId]);

  // While the box is the input, keys that reach the transcript are handed to the box.
  useEffect(() => {
    if (!currentId) return undefined;
    setInputLock(currentId, boxIsInput, (event) => {
      event.preventDefault();
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey) setDraft((text) => text + event.key);
    }, () => { if (inputRef.current) inputRef.current.focus(); });
    return () => setInputLock(currentId, false);
  }, [currentId, boxIsInput]);

  // Where typing goes.
  useEffect(() => {
    if (!visible || !currentId) return;
    if (takeover) focusSession(currentId);
    else if (inputRef.current) inputRef.current.focus();
  }, [visible, currentId, takeover, showBox]);

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

  const launch = async (provider, at) => {
    const info = state.providers.get(provider);
    if (provider !== 'shell' && info && !info.available) return null;
    setLaunching({ provider });
    try {
      const dims = estimateDimensions(stageRef.current);
      const record = await createSession({ provider, cwd: at || projectCwd, projectId, workspaceId, ...dims });
      activate(record.snapshot.id);
      setLaunching(null);
      return record;
    } catch (error) {
      setLaunching({ error: `${providerName(provider)} could not be started: ${errorText(error)}` });
      return null;
    }
  };

  // The dropdown. An untouched idle terminal becomes the agent in place, in its current
  // directory. Otherwise the agent gets its own tab here.
  const pickAgent = (agent) => {
    setMenu(null);
    if (current && running && now.agent === agent) { if (takeover) focusSession(currentId); else if (inputRef.current) inputRef.current.focus(); return; }
    const alive = (record) => record.snapshot.status === 'running' && record.snapshot.id !== currentId;
    if (agent === 'shell') {
      const idle = [...sessions].reverse().find((record) => alive(record) && describe(record).agent === 'shell');
      if (idle) activate(idle.snapshot.id); else void launch('shell', currentCwd);
      return;
    }
    if (current && running && now.integrated && !now.busy && !touched[currentId]) { sendInput(currentId, `${agent}\r`); return; }
    const here = [...sessions].reverse().find((record) => alive(record) && describe(record).agent === agent && cwdOf(record) === currentCwd);
    if (here) activate(here.snapshot.id); else void launch(agent, currentCwd);
  };

  // The last terminal never goes (2026-09-25: "it should sort of always stay there and if there is only one it should just
  // clear the terminal but not delete that tab"): an idle shell is cleared in place; a program running in it, or a
  // terminal that has exited, gives way to a fresh shell where it was, as × would have ended it in any other tab.
  const close = async (id) => {
    const only = sessions.length === 1 && sessions[0].snapshot.id === id ? sessions[0] : null;
    if (only) {
      const shell = describe(only);
      setDraft('');
      setHistIdx(null);
      if (only.snapshot.status === 'running' && shell.integrated && !shell.busy) {
        clearSession(id);
        if (inputRef.current) inputRef.current.focus();
        return;
      }
      const fresh = await launch('shell', cwdOf(only));
      if (fresh) await closeSession(id);
      return;
    }
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

  // The box: Enter sends the draft, Shift+Enter adds a line; ↑/↓ walk history
  // at the edges of a multiline draft, leaving normal caret movement intact.
  // ^C ^D ^L reach the shell; ⌘C with nothing selected in the box copies the transcript selection.
  const onInputKey = (event) => {
    if (!currentId) return;
    const key = event.key;
    if (key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = draft;
      if (running) sendInput(currentId, `${text}\r`);
      if (text.trim()) {
        setHistory((list) => [...list.filter((item) => item !== text), text].slice(-500));
        setTouched((map) => (map[currentId] ? map : { ...map, [currentId]: true }));
      }
      setHistIdx(null);
      setDraft('');
      return;
    }
    if (key === 'ArrowUp' && history.length && (!draft.includes('\n') || event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0)) {
      event.preventDefault();
      const idx = histIdx == null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx); setDraft(history[idx]);
      return;
    }
    if (key === 'ArrowDown' && histIdx != null && (!draft.includes('\n') || event.currentTarget.selectionStart === draft.length && event.currentTarget.selectionEnd === draft.length)) {
      event.preventDefault();
      const idx = histIdx + 1;
      if (idx >= history.length) { setHistIdx(null); setDraft(''); } else { setHistIdx(idx); setDraft(history[idx]); }
      return;
    }
    if (event.metaKey && key.toLowerCase() === 'c') {
      const input = event.currentTarget;
      const text = input.selectionStart === input.selectionEnd ? selectionText(currentId) : '';
      if (text) { event.preventDefault(); navigator.clipboard.writeText(text).catch(() => {}); }
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      const letter = key.toLowerCase();
      if (letter === 'c') { event.preventDefault(); if (running) sendInput(currentId, CTRL.c); setDraft(''); setHistIdx(null); return; }
      if (letter === 'd' && !draft) { event.preventDefault(); if (running) sendInput(currentId, CTRL.d); return; }
      if (letter === 'l') { event.preventDefault(); if (running) sendInput(currentId, CTRL.l); return; }
    }
    if (key === 'Tab') { event.preventDefault(); return; }
    if (key === 'Escape') { event.preventDefault(); event.currentTarget.blur(); }
  };

  // Clicking the transcript: a running program gets the keyboard; under an idle shell the
  // transcript is inert and the box keeps the caret (⌘C there copies a dragged selection).
  const onStageClick = () => {
    if (!currentId) return;
    if (!boxIsInput) { focusSession(currentId); return; }
    if (inputRef.current) inputRef.current.focus();
  };

  // While focus is in the pane: ⌘T opens a new terminal, ⌘W closes the current tab and ⌘1–9 switch tabs.
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const inside = rootRef.current && event.target && rootRef.current.contains(event.target);
      // ⌘T opens a terminal whenever the Terminal shows, wherever the keyboard is (2026-09-25: "cmd t in terminal new
      // terminal not browser"); while the Stage shows it is the Stage's.
      if (event.metaKey && event.key.toLowerCase() === 't' && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); void launch('shell', currentCwd); return; }
      if (inside && currentId && event.metaKey && event.key.toLowerCase() === 'w' && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); void close(currentId); return; }
      if (inside && event.metaKey && /^[1-9]$/.test(event.key)) {
        const record = sessions[Number(event.key) - 1];
        if (record) { event.preventDefault(); event.stopPropagation(); activate(record.snapshot.id); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible, sessions, currentCwd, currentId]);

  const stopKeys = (event) => { event.stopPropagation(); };
  const menuW = 200;

  return (
    <div ref={rootRef} className="terminal-pane" data-terminal="1" data-agent={now.agent} onKeyDown={stopKeys} onKeyUp={stopKeys} style={{ display: visible ? 'flex' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, padding: '6px 8px 0', background: '#fafafa', borderBottom: '1px solid #eaeaea', flex: 'none', overflow: 'hidden' }}>
        {sessions.map((record) => {
          const id = record.snapshot.id;
          const on = id === currentId;
          const alive = record.snapshot.status === 'running';
          const title = `${basename(cwdOf(record))}${alive ? '' : ` · exited${Number.isInteger(record.snapshot.exitCode) ? ` ${record.snapshot.exitCode}` : ''}`}`;
          return (
            <div key={id} className="hov-ink" onClick={() => activate(id)} title={`${LABEL[describe(record).agent] || 'Terminal'} · ${cwdOf(record)}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto', maxWidth: 220, padding: '7px 10px 8px', border: `1px solid ${on ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', marginBottom: -1, background: on ? '#fff' : 'transparent', cursor: 'pointer', font: `${on ? 500 : 400} 12.5px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap', transition: 'color 120ms' }}>
              <span style={{ flex: 'none', font: `11px/1 ${MONO}`, color: '#8f8f8f' }}>›_</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
              <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); void close(id); }} aria-label="Close terminal" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
            </div>
          );
        })}
        <button type="button" className="hov-ink-wash" onClick={() => void launch('shell', currentCwd)} title="New terminal (⌘T) in the current directory" style={{ flex: 'none', alignSelf: 'center', width: 26, height: 26, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '16px/1 var(--font-sans)', color: '#4d4d4d' }}>+</button>
        <div ref={menuRef} style={{ marginLeft: 'auto', alignSelf: 'center', flex: 'none', position: 'relative' }}>
          <button type="button" className="hov-ink-wash" data-agent-menu="1" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right, y: r.bottom }); }} title="Terminal, Claude Code or Codex — started in this tab's directory" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: 0, borderRadius: 6, background: menu ? '#eaeaea' : 'transparent', cursor: 'pointer', font: '500 12.5px/1.3 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}>
            <span>{agentLabel}</span>
            <span style={{ font: '10px/1 var(--font-sans)', color: '#8f8f8f' }}>⌄</span>
          </button>
          {menu && (
            <div data-overlay="1" role="menu" style={{ position: 'fixed', left: clamp(menu.x - menuW, 8, (window.innerWidth || 1200) - menuW - 8), top: menu.y + 6, zIndex: 60, width: menuW, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 160ms ${EASE}` }}>
              {AGENTS.map((agent) => {
                const info = state.providers.get(agent.id);
                const available = agent.id === 'shell' || !info || info.available;
                const on = now.agent === agent.id;
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

      <div ref={stageRef} className="terminal-stage" onClick={onStageClick} data-term-stage="1" style={{ cursor: boxIsInput ? 'default' : 'text' }}>
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

      {(now.agent === 'shell' || (currentId && !running)) && <div className={now.agent === 'shell' ? 'terminal-dock' : 'terminal-ended'} data-term-footer="1">
        {showBox && (
          <textarea
            ref={inputRef}
            data-term-input="1"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setHistIdx(null); }}
            onKeyDown={onInputKey}
            spellCheck={false}
            autoComplete="off"
            aria-label="Terminal input"
            placeholder="Run commands…"
            rows={1}
            className="terminal-command"
          />
        )}
        {currentId && !showBox && <div className={now.agent === 'shell' ? 'terminal-hint' : 'terminal-exited'} data-term-hint="1">
          {running ? '\u00a0' : 'Exited · press + for a new terminal'}
        </div>}
        {now.agent === 'shell' && currentCwd && <div className="terminal-path" data-term-path="1" aria-label="Current working directory" title={currentCwd}>
          {displayPath(currentCwd, state.home)}
        </div>}
      </div>}
    </div>
  );
}
