import React from 'react';
import { api, errorMessage } from '../api.js';
import { GH } from '../ui/Icons.jsx';
import { Group, Row, BUTTON, text } from '../ui/SettingsRows.jsx';
import { rowOf } from '../model/tools.js';
import { useGithubStatus } from './useGithubStatus.js';
import { useZoteroStatus } from './useZoteroStatus.js';
import ConnectionActions, { ConnectionProgress } from './ConnectionActions.jsx';

// Connections (restored 2026-10-02 from feat/canvas-workspace-updates-2026-09-28): the app's accounts. A page of the
// Settings window, after Model (../ui/Settings.jsx; MATH-64, 2026-10-06: until then an icon in the top-right controls,
// its panel hanging under it). GitHub, Zotero (MATH-65), then Claude Code and Codex (2026-10-03), each a row of the page's
// one group, laid out as Model's are. GitHub's sign-in, its device page and its "Repository access" page all open in the
// default browser (github-open, src/main/ipc.cjs → shell.openExternal), never in Stage or an Engelbart window; so do
// Zotero's (main opens the broker's page itself) and Claude Code's and Codex's, which their own CLIs open.

const button = { flex: 'none', padding: '5px 8px', border: 0, borderRadius: 5, background: 'transparent', cursor: 'pointer', ...text(12, '#4d4d4d') };
// A row's one button (Connect, Sign in, Install…): Settings' own, dimmed while it cannot be pressed.
const bordered = disabled => ({ ...BUTTON, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' });
const note = (color = '#8f8f8f') => ({ ...text(12.5, color), margin: '4px 0 0', overflowWrap: 'anywhere' });

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
  return <Row data-connection="github" icon={<GH />}
    label={<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>GitHub
      {pending?.userCode && <button type="button" className="hov-wash" data-connection-action="copy" aria-label="Copy sign-in code" title="Copy sign-in code" disabled={!!busy} onClick={() => onAction('copy')} style={{ ...button, padding: '2px 0', font: '11px/1.4 var(--font-mono)' }}>{pending.userCode}</button>}
    </span>}
    hint={!connecting && <span role="status" style={{ overflowWrap: 'anywhere' }}>{description}</span>}
    detail={<>
      {connected && status.persisted === false && <p style={note()}>Connected until Engelbart quits.</p>}
      {status && !status.configured && !connected && <p style={note()}>GitHub sign-in isn’t configured.</p>}
      {!connecting && problem && <p role="alert" style={note('var(--red-600)')}>{problem}</p>}
    </>}>
    {connected ? <ConnectionActions provider="github" label="GitHub" busy={busy} onAction={onAction} items={[
      ...(status.installUrl ? [{ action: 'manage', label: 'Repository access' }] : []),
      { action: 'disconnect', label: 'Disconnect', separator: !!status.installUrl },
    ]} /> : pending ? <ConnectionProgress label="GitHub" active={!problem || !!busy} cancelling={busy === 'cancel'} disabled={disabled} onCancel={() => onAction('cancel')} onReopen={() => onAction('reopen')} reopenDisabled={!!busy} />
      : <button type="button" className="hov-bd2" data-connection-action={action} disabled={disabled} onClick={() => onAction(action)} style={bordered(disabled)}>
        {busy === action ? (action === 'connect' ? 'Connecting…' : 'Cancelling…') : label}
      </button>}
  </Row>;
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

// Zotero (MATH-65): the account, laid out as GitHub's row. Connect opens the broker's sign-in in the default browser
// (src/main/zotero/browser-auth.cjs); while it waits, the row says to finish there and offers Cancel. Disconnect, behind
// the options menu, forgets the key, revokes it and deletes the mirror of the library. Connected, the row says where the
// mirror stands (build 2, src/main/zotero/sync.cjs: `status.sync`): "Syncing…", "Synced · N items", or what went wrong;
// "Sync now" in the menu syncs it again.
const ZoteroIcon = () => <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 3h9l-9 10h9" /></svg>;

export function ZoteroConnection({ status, busy, error, onAction }) {
  const connected = !!status?.connected;
  const pending = !connected && !!status?.pending;
  const problem = error || status?.error || '';
  const description = !status ? 'Checking connection…' : connected && busy === 'disconnect' ? 'Disconnecting…' : connected ? `Connected${status.username ? ` · ${status.username}` : ''}`
    : pending ? 'Finish signing in in your browser' : busy === 'connect' ? 'Connecting…' : !status.configured ? 'Not configured' : 'Not connected';
  const library = connected && busy !== 'disconnect' ? zoteroSyncLine(status.sync) : null;
  const spinning = pending || busy === 'connect' || (connected && busy === 'disconnect');
  const disabled = !!busy || !status || (!status.configured && !connected);
  return <Row data-connection="zotero" icon={<ZoteroIcon />} label="Zotero"
    hint={<span role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>{spinning && <Spinner />}<span style={{ minWidth: 0 }}>{description}</span></span>}
    detail={<>
      {library && <p data-zotero-sync={status.sync.state} role={library.error ? 'alert' : 'status'} style={{ ...note(library.error ? 'var(--red-600)' : undefined), display: 'flex', alignItems: 'center', gap: 6 }}>{library.busy && <Spinner />}<span style={{ minWidth: 0 }}>{library.text}</span></p>}
      {connected && status.persisted === false && <p style={note()}>Connected until Engelbart quits.</p>}
      {!pending && problem && <p role="alert" style={note('var(--red-600)')}>{problem}</p>}
    </>}>
    {connected ? <ConnectionActions provider="zotero" label="Zotero" busy={busy} onAction={onAction} items={[{ action: 'sync', label: 'Sync now' }, { action: 'disconnect', label: 'Disconnect', separator: true }]} />
      : pending ? <button type="button" className="hov-bd2" data-connection-action="cancel" disabled={!!busy} onClick={() => onAction('cancel')} style={bordered(!!busy)}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
      : <button type="button" className="hov-bd2" data-connection-action="connect" disabled={disabled} onClick={() => onAction('connect')} style={bordered(disabled)}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>}
  </Row>;
}

/** What the Zotero row says of the library's mirror (`sync` { state, items, error }) → { text, busy, error }, or null. */
export function zoteroSyncLine(sync) {
  if (!sync) return null;
  if (sync.state === 'syncing') return { text: 'Syncing…', busy: true, error: false };
  if (sync.state === 'error') return { text: sync.error || 'The library could not be synced.', busy: false, error: true };
  if (sync.state === 'synced') return { text: `Synced · ${sync.items} ${sync.items === 1 ? 'item' : 'items'}`, busy: false, error: false };
  return null;
}

/** What each Zotero action calls. The answers are the status, which never carries the key. */
export function zoteroAction(action) {
  if (action === 'sync') return api.zoteroSync();
  if (action === 'connect') return api.zoteroConnect();
  if (action === 'cancel') return api.zoteroCancel();
  if (action === 'disconnect') return api.zoteroDisconnect();
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

/** `tool`: the snapshot's record (absent until the first snapshot). `busy`: the action this page is waiting on. */
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
  return <Row data-connection={id} title={version} icon={<Icon />} label={name}
    hint={<span role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>{spinning && <Spinner />}<span style={{ minWidth: 0 }}>{description}</span></span>}
    detail={problem && <p role="alert" style={note('var(--red-600)')}>{problem}</p>}>
    {signingIn ? <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
      {row.page && <button type="button" className="hov-wash" data-connection-action="reopen" disabled={!!busy} onClick={() => onAction('reopen')} style={{ ...quiet(!!busy), ...text(13, '#4d4d4d') }}>Reopen page</button>}
      <button type="button" className="hov-bd2" data-connection-action="cancel" disabled={!!busy} onClick={() => onAction('cancel')} style={bordered(!!busy)}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
    </div> : ready ? <ConnectionActions provider={id} label={name} busy={busy || (checking ? 'check' : null)} onAction={onAction} items={[{ action: 'sign-out', label: 'Sign out' }]} />
      : row?.action ? <button type="button" className="hov-bd2" data-connection-action={row.action} disabled={working} onClick={() => onAction(row.action)} style={bordered(working)}>{TOOL_LABEL[row.action]}</button> : null}
  </Row>;
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

/** The tool check's snapshot while the page is open: what api.tools() has, then every change on api.onTools. → stop */
export function watchTools(take) {
  let live = true;
  let changed = false; // a change came first: the answer to api.tools() is no newer than it
  const off = api.onTools(snapshot => { if (live && snapshot?.tools) { changed = true; take(snapshot); } });
  api.tools().then(snapshot => { if (live && !changed && snapshot?.tools) take(snapshot); }).catch(() => {});
  return () => { live = false; off(); };
}

/** The Connections page: the accounts' state, and what their rows' actions call. Its rows follow every change while it is open. */
export function ConnectionsPage() {
  const [status, setStatus] = useGithubStatus();
  const [busy, setBusy] = React.useState(null);
  const [problem, setProblem] = React.useState('');
  const [zotero, setZotero] = useZoteroStatus();
  const [zoteroBusy, setZoteroBusy] = React.useState(null);
  const [zoteroProblem, setZoteroProblem] = React.useState('');
  const [tools, setTools] = React.useState(null);
  const [toolBusy, setToolBusy] = React.useState({});
  const [toolProblem, setToolProblem] = React.useState({});
  React.useEffect(() => watchTools(setTools), []);
  const act = async action => {
    if (busy) return;
    setBusy(action); setProblem('');
    try {
      const next = await githubAction(action, status);
      if (next) setStatus(next);
    } catch (error) { setProblem(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const actZotero = async action => {
    if (zoteroBusy) return;
    setZoteroBusy(action); setZoteroProblem('');
    try {
      const next = await zoteroAction(action);
      if (next) setZotero(next);
    } catch (error) { setZoteroProblem(errorMessage(error)); }
    finally { setZoteroBusy(null); }
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
  return <Group title="Accounts" data-connections-page="1">
    <GithubConnection key="github" status={status} busy={busy} error={problem} onAction={act} />
    <ZoteroConnection key="zotero" status={zotero} busy={zoteroBusy} error={zoteroProblem} onAction={actZotero} />
    {TOOL_CONNECTIONS.map(name => <ToolConnection key={name} id={name} tool={tools?.tools?.[name]} busy={toolBusy[name] || null} error={toolProblem[name] || ''} onAction={action => actTool(name, action)} />)}
  </Group>;
}
