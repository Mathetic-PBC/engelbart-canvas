import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import { GH } from '../ui/Icons.jsx';
import { usePlaced } from '../ui/usePlaced.js';
import { rowOf } from '../model/tools.js';
import { useGithubStatus } from './useGithubStatus.js';
import ConnectionActions, { ConnectionProgress } from './ConnectionActions.jsx';

// Connections (restored 2026-10-02 from feat/canvas-workspace-updates-2026-09-28): the app's accounts. Its icon sits in the
// top-right controls on every screen, left of the notification bell (ui/WindowControls.jsx; it was at the right of the
// sidebar's footer until 2026-10-03). GitHub, then Claude Code and Codex (2026-10-03). GitHub's sign-in, its device page and
// its "Repository access" page all open in the default browser (github-open, src/main/ipc.cjs → shell.openExternal), never
// in Stage or an Engelbart window; so do Claude Code's and Codex's, which their own CLIs open.

const text = (size, color = '#171717', weight = 400) => ({ font: `${weight} ${size}px/1.4 var(--font-sans)`, color });
const button = { flex: 'none', padding: '5px 8px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', ...text(12, '#4d4d4d') };

// Account controls only. Repository browsing and imports live elsewhere in the sidebar (GithubPane, from + Add context).
export function GithubConnection({ status, busy, error, onAction }) {
  const connected = !!status?.connected;
  const pending = !connected && status?.pending;
  const problem = error || status?.error || '';
  const connecting = busy === 'connect' || (pending && (!problem || !!busy));
  const description = !status ? 'Checking connection…' : connected && busy === 'disconnect' ? 'Disconnecting…' : connected ? `Connected${status.login ? ` · @${status.login}` : ''}`
    : pending ? 'Waiting for sign-in…' : !status.configured ? 'Not configured' : 'Not connected';
  const action = pending ? 'cancel' : 'connect';
  const label = status?.error ? 'Reconnect' : 'Connect';
  const disabled = !!busy || !status || (!status.configured && !connected && !pending);
  return <div data-connection="github">
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="glyph-fit" style={{ flex: 'none', display: 'flex', width: 18, height: 18, color: '#4d4d4d' }}><GH /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...text(13, '#171717', 500), display: 'flex', alignItems: 'center', gap: 6 }}>GitHub
          {pending?.userCode && <button type="button" className="hov-wash" data-connection-action="copy" aria-label="Copy sign-in code" title="Copy sign-in code" disabled={!!busy} onClick={() => onAction('copy')} style={{ ...button, padding: '2px 0', font: '11px/1.4 var(--font-mono)' }}>{pending.userCode}</button>}
        </div>
        {!connecting && <div role="status" style={{ ...text(11.5, '#8f8f8f'), overflowWrap: 'anywhere' }}>{description}</div>}
      </div>
      {connected ? <ConnectionActions provider="github" label="GitHub" busy={busy} onAction={onAction} items={[
        ...(status.installUrl ? [{ action: 'manage', label: 'Repository access' }] : []),
        { action: 'disconnect', label: 'Disconnect', separator: !!status.installUrl },
      ]} /> : pending ? <ConnectionProgress label="GitHub" active={!problem || !!busy} cancelling={busy === 'cancel'} disabled={disabled} onCancel={() => onAction('cancel')} onReopen={() => onAction('reopen')} reopenDisabled={!!busy} />
        : <button type="button" className="hov-wash" data-connection-action={action} disabled={disabled} onClick={() => onAction(action)}
        style={{ ...button, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer', ...(!connected && !pending ? { border: '1px solid #eaeaea' } : {}) }}>
        {busy === action ? (action === 'connect' ? 'Connecting…' : 'Cancelling…') : label}
      </button>}
    </div>
    {connected && status.persisted === false && <p style={{ ...text(11.5, '#8f8f8f'), margin: '8px 0 0' }}>Connected until Engelbart quits.</p>}
    {status && !status.configured && !connected && <p style={{ ...text(12, '#8f8f8f'), margin: '10px 0 0' }}>GitHub sign-in isn’t configured.</p>}
    {!connecting && problem && <p role="alert" style={{ ...text(12, 'var(--red-600)'), margin: '10px 0 0', overflowWrap: 'anywhere' }}>{problem}</p>}
  </div>;
}

/** What each GitHub action calls. `manage` and `reopen` are pages: github-open shows them in the default browser. */
export async function githubAction(action, status) {
  if (action === 'connect') return api.githubConnect();
  if (action === 'disconnect') return api.githubDisconnect();
  if (action === 'cancel') return api.githubCancel();
  if (action === 'copy') { await api.copyText(status.pending.userCode); return null; }
  await api.githubOpen(action === 'manage' ? 'install' : 'device');
  return null;
}

// Claude Code and Codex (2026-10-03): the sign-ins the setup dialog runs (../ui/ToolSetup.jsx, src/main/tools/manager.cjs),
// not a second way in. A row is the tool check's snapshot through rowOf; its one button does what the dialog's does. While
// the CLI waits for the browser, Reopen page opens its page there again (open-external). Sign out runs the CLI's logout.
export const TOOL_CONNECTIONS = Object.freeze(['claude', 'codex']);
const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex' };
const TOOL_LABEL = { install: 'Install', update: 'Update', 'sign-in': 'Sign in', retry: 'Try again' };
const glyph = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
const TOOL_ICON = {
  claude: () => <svg {...glyph}><path d="M8 1.5v13M1.5 8h13M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" /></svg>,
  codex: () => <svg {...glyph}><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="m4.5 6 2 2-2 2M8.5 10h3" /></svg>,
};
const Spinner = () => <svg className="connection-spinner" aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flex: 'none' }}><path d="M14 8a6 6 0 1 1-6-6" /></svg>;

/** `tool`: the snapshot's record (absent until the first snapshot). `busy`: the action this panel is waiting on. */
export function ToolConnection({ id, tool, busy, error, onAction }) {
  const row = tool ? rowOf(tool) : null;
  const name = row?.name || TOOL_NAME[id];
  const Icon = TOOL_ICON[id];
  const signingIn = tool?.busy?.action === 'sign-in';
  const checking = tool?.busy?.action === 'check';
  // Ready, or ready while a check runs (one runs before every @bart turn): the menu stays, dimmed until it ends.
  const ready = tool?.status === 'ready' && (!tool.busy || checking);
  const working = !!busy || (!!tool?.busy && !signingIn);
  // Signed in reads like GitHub's row, with the account the CLI is signed in as; the version is the row's tooltip.
  const connected = ready && tool.signedIn === true;
  const description = !row ? 'Checking…' : busy === 'sign-out' ? 'Signing out…' : connected ? `Connected${row.account ? ` · ${row.account}` : ''}` : row.state;
  const version = ready && tool.version ? `${name} ${row.state}` : undefined;
  const spinning = busy === 'sign-out' || (row && row.tone === 'busy' && !checking);
  const problem = error || (row && row.detail && row.detailTone === 'error' ? row.detail : '');
  const quiet = disabled => ({ ...button, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' });
  return <div data-connection={id}>
    <div title={version} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="glyph-fit" style={{ flex: 'none', display: 'flex', width: 18, height: 18, color: '#4d4d4d' }}><Icon /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={text(13, '#171717', 500)}>{name}</div>
        <div role="status" style={{ ...text(11.5, '#8f8f8f'), display: 'flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>{spinning && <Spinner />}<span style={{ minWidth: 0 }}>{description}</span></div>
      </div>
      {signingIn ? <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2 }}>
        {row.page && <button type="button" className="hov-wash" data-connection-action="reopen" disabled={!!busy} onClick={() => onAction('reopen')} style={quiet(!!busy)}>Reopen page</button>}
        <button type="button" className="hov-wash" data-connection-action="cancel" disabled={!!busy} onClick={() => onAction('cancel')} style={{ ...quiet(!!busy), border: '1px solid #eaeaea' }}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
      </div> : ready ? <ConnectionActions provider={id} label={name} busy={busy || (checking ? 'check' : null)} onAction={onAction} items={[{ action: 'sign-out', label: 'Sign out' }]} />
        : row?.action ? <button type="button" className="hov-wash" data-connection-action={row.action} disabled={working} onClick={() => onAction(row.action)} style={{ ...quiet(working), border: '1px solid #eaeaea' }}>{TOOL_LABEL[row.action]}</button> : null}
    </div>
    {problem && <p role="alert" style={{ ...text(12, 'var(--red-600)'), margin: '10px 0 0', overflowWrap: 'anywhere' }}>{problem}</p>}
  </div>;
}

/** What each Claude Code / Codex action calls: the setup dialog's mapping (../ui/ToolSetup.jsx), plus Reopen page and Sign out. */
export function toolAction(action, tool) {
  const row = rowOf(tool);
  if (action === 'install') return api.toolsInstall([row.id]);
  if (action === 'update') return api.toolsUpdate(row.id);
  if (action === 'sign-in') return api.toolsSignIn(row.id);
  if (action === 'cancel') return api.toolsCancelSignIn(row.id);
  if (action === 'retry') return tool.installed ? api.toolsCheck() : api.toolsInstall([row.id]);
  if (action === 'reopen') return row.page ? api.openExternal(row.page) : null;
  if (action === 'sign-out') return api.toolsSignOut(row.id);
  return null;
}

/** The tool check's snapshot while the panel is open: what api.tools() has, then every change on api.onTools. → stop */
export function watchTools(take) {
  let live = true;
  let changed = false; // a change came first: the answer to api.tools() is no newer than it
  const off = api.onTools(snapshot => { if (live && snapshot?.tools) { changed = true; take(snapshot); } });
  api.tools().then(snapshot => { if (live && !changed && snapshot?.tools) take(snapshot); }).catch(() => {});
  return () => { live = false; off(); };
}

function ConnectionsPanel({ id, anchor, triggerRef, onClose }) {
  const [status, setStatus] = useGithubStatus();
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [tools, setTools] = React.useState(null);
  const [toolBusy, setToolBusy] = React.useState({});
  const [toolProblem, setToolProblem] = React.useState({});
  React.useEffect(() => watchTools(setTools), []);
  const [ref, placed] = usePlaced(anchor, { gap: 6, align: 'end', cap: 400 });
  const [, remeasure] = React.useReducer(value => value + 1, 0);
  React.useLayoutEffect(() => {
    // The sign-in's states change the panel's height: placed again, and capped, when they do.
    const observer = new ResizeObserver(() => remeasure());
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  const focused = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current && placed.visibility !== 'hidden' && ref.current) {
      focused.current = true;
      ref.current.focus({ preventScroll: true });
    }
  }, [placed.visibility, ref]);
  React.useEffect(() => {
    const away = event => { if (!ref.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) onClose(); };
    const key = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(true); } };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('focusin', away);
    // A nested options menu handles Escape first, before the enclosing panel.
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose, ref, triggerRef]);
  const act = async action => {
    if (busy) return;
    setBusy(action); setProblem('');
    try {
      const next = await githubAction(action, status);
      if (next) setStatus(next);
    } catch (error) { setProblem(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const actTool = async (name, action) => {
    const tool = tools?.tools?.[name];
    if (!tool || toolBusy[name]) return;
    setToolBusy(current => ({ ...current, [name]: action })); setToolProblem(current => ({ ...current, [name]: '' }));
    try {
      const result = await toolAction(action, tool);
      if (result && result.ok === false && result.error) setToolProblem(current => ({ ...current, [name]: result.error }));
    } catch (error) { setToolProblem(current => ({ ...current, [name]: errorMessage(error) })); }
    finally { setToolBusy(current => ({ ...current, [name]: null })); }
  };
  return createPortal(<div id={id} ref={ref} role="dialog" aria-label="Connections" tabIndex={-1} data-overlay="1" data-connections-panel="1"
    style={{ ...placed, zIndex: 170, width: 320, maxWidth: 'calc(100vw - 16px)', padding: 12, boxSizing: 'border-box', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, outline: 'none' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <span style={text(13, '#171717', 500)}>Connections</span>
      <button type="button" className="hov-wash" aria-label="Close connections" onClick={() => onClose(true)} style={{ ...button, width: 24, height: 24, padding: 0, fontSize: 18, lineHeight: 1 }}>×</button>
    </div>
    <GithubConnection status={status} busy={busy} error={problem} onAction={act} />
    {TOOL_CONNECTIONS.map(name => <div key={name} style={{ marginTop: 14 }}>
      <ToolConnection id={name} tool={tools?.tools?.[name]} busy={toolBusy[name] || null} error={toolProblem[name] || ''} onAction={action => actTool(name, action)} />
    </div>)}
  </div>, document.body);
}

// With the window's controls, on every screen: accounts belong to the app, not a workspace. An icon the bell's size; the
// panel hangs under it, its right edge on the icon's.
export default function Connections() {
  const [anchor, setAnchor] = React.useState(null);
  const triggerRef = React.useRef(null);
  const id = React.useId();
  const open = !!anchor;
  const close = React.useCallback((restoreFocus = false) => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => setAnchor(triggerRef.current.getBoundingClientRect());
    const observer = new ResizeObserver(measure);
    observer.observe(triggerRef.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [open]);
  return <div data-connections="1" style={{ flex: 'none', display: 'flex', alignItems: 'center' }}>
    <button ref={triggerRef} type="button" className="connections-trigger" aria-label="Connections" title="Connections" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : setAnchor(triggerRef.current.getBoundingClientRect())}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, padding: 0, border: 0, borderRadius: 5, background: 'transparent', color: '#171717', cursor: 'pointer' }}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
        <path d="M5.5 1.5v3M10.5 1.5v3M4 4.5h8v2a4 4 0 0 1-8 0zM8 10.5v2a2 2 0 0 1-2 2H4" />
      </svg>
    </button>
    {open && <ConnectionsPanel id={id} anchor={anchor} triggerRef={triggerRef} onClose={close} />}
  </div>;
}
