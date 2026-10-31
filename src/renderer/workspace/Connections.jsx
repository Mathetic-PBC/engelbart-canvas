import React from 'react';
import { api, errorMessage } from '../api.js';
import { GH } from '../ui/Icons.jsx';
import { Group, Row, BUTTON, text } from '../ui/SettingsRows.jsx';
import { rowOf } from '../model/tools.js';
import { useGithubStatus } from './useGithubStatus.js';
import { useZoteroStatus } from './useZoteroStatus.js';
import { useRemarkableStatus } from './useRemarkableStatus.js';
import ConnectionActions, { ConnectionProgress } from './ConnectionActions.jsx';

// Connections (restored 2026-10-02 from feat/canvas-workspace-updates-2026-09-28): the app's accounts. A page of the
// Settings window, after Model (../ui/Settings.jsx; MATH-64, 2026-10-06: until then an icon in the top-right controls,
// its panel hanging under it). GitHub, Zotero (MATH-65), reMarkable (2026-10-31), then Claude Code and Codex (2026-10-03), each a row of the page's
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
// "Sync now" in the menu syncs it again. Build 5: with groups, "Synced · N items · M groups" (items of every library), and
// a group that could not be synced is said under it.
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
      {library && library.groups && <p data-zotero-groups role="alert" style={note('var(--red-600)')}>{library.groups}</p>}
      {connected && status.persisted === false && <p style={note()}>Connected until Engelbart quits.</p>}
      {!pending && problem && <p role="alert" style={note('var(--red-600)')}>{problem}</p>}
    </>}>
    {connected ? <ConnectionActions provider="zotero" label="Zotero" busy={busy} onAction={onAction} items={[{ action: 'sync', label: 'Sync now' }, { action: 'disconnect', label: 'Disconnect', separator: true }]} />
      : pending ? <button type="button" className="hov-bd2" data-connection-action="cancel" disabled={!!busy} onClick={() => onAction('cancel')} style={bordered(!!busy)}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>
      : <button type="button" className="hov-bd2" data-connection-action="connect" disabled={disabled} onClick={() => onAction('connect')} style={bordered(disabled)}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>}
  </Row>;
}

/**
 * What the Zotero row says of the library's mirror (`sync` { state, items, error, groups, problems }) → { text, busy,
 * error, groups }, or null. `groups`: the groups the last sync could not, in words ('' when none).
 */
export function zoteroSyncLine(sync) {
  if (!sync) return null;
  if (sync.state === 'syncing') return { text: 'Syncing…', busy: true, error: false, groups: '' };
  const problems = Array.isArray(sync.problems) ? sync.problems.filter((p) => p && p.name) : [];
  const groups = problems.slice(0, 2).map((p) => `${p.name}: ${p.error || 'could not be synced.'}`).join(' ')
    + (problems.length > 2 ? ` And ${problems.length - 2} more ${problems.length - 2 === 1 ? 'group' : 'groups'} could not be synced.` : '');
  if (sync.state === 'error') return { text: sync.error || 'The library could not be synced.', busy: false, error: true, groups };
  const count = Number(sync.groups) || 0;
  if (sync.state === 'synced') return { text: `Synced · ${sync.items} ${sync.items === 1 ? 'item' : 'items'}${count ? ` · ${count} ${count === 1 ? 'group' : 'groups'}` : ''}`, busy: false, error: false, groups };
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

// reMarkable (2026-10-31, src/main/remarkable/sync.cjs): the notebooks in the reMarkable app's library on this Mac,
// each a row of the library (src/main/remarkable/rows.cjs). No sign-in: Connect finds the app's library and reads it, macOS asking once.
// Laid out as Zotero's row. Not connected, the row says in one line what it does; when it cannot connect, what to do,
// with a button for it (the reMarkable app's download page, or Privacy & Security). Connected, where the folder stands:
// "Syncing…", "Synced · N notebooks in your library", or what went wrong, and the notebooks that could not be read; "Sync now" and
// Disconnect (the copies deleted, the app's own library never touched) in the options menu.
const RemarkableIcon = () => <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="1.5" width="9" height="13" rx="1.5" /><path d="M6 5h4M6 7.5h4M6 10h2" /></svg>;
const REMARKABLE_HELP = { unavailable: { action: 'get-app', label: 'Get the reMarkable app' }, permission: { action: 'privacy', label: 'Open Privacy & Security' } };

export function RemarkableConnection({ status, busy, error, onAction }) {
  const connected = !!status?.connected;
  const problem = error || (!connected && status?.error) || '';
  const help = !connected && status?.code ? REMARKABLE_HELP[status.code] : null;
  const description = !status ? 'Checking…' : connected && busy === 'disconnect' ? 'Disconnecting…' : connected ? 'Connected · the reMarkable app on this Mac'
    : busy === 'connect' ? 'Connecting…' : 'Not connected';
  const folder = connected && busy !== 'disconnect' ? remarkableSyncLine(status) : null;
  const spinning = busy === 'connect' || (connected && busy === 'disconnect');
  const disabled = !!busy || !status;
  return <Row data-connection="remarkable" icon={<RemarkableIcon />} label="reMarkable"
    hint={<span role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>{spinning && <Spinner />}<span style={{ minWidth: 0 }}>{description}</span></span>}
    detail={<>
      {status && !connected && !problem && busy !== 'connect' && <p style={note()}>Brings in the notebooks the reMarkable app keeps on this Mac, and keeps them up to date.</p>}
      {folder && <p data-remarkable-sync={status.state} role={folder.error ? 'alert' : 'status'} style={{ ...note(folder.error ? 'var(--red-600)' : undefined), display: 'flex', alignItems: 'center', gap: 6 }}>{folder.busy && <Spinner />}<span style={{ minWidth: 0 }}>{folder.text}</span></p>}
      {folder && folder.problems && <p data-remarkable-problems role="alert" style={note('var(--red-600)')}>{folder.problems}</p>}
      {problem && <p role="alert" style={note('var(--red-600)')}>{problem}</p>}
      {help && <button type="button" className="hov-wash" data-connection-action={help.action} disabled={!!busy} onClick={() => onAction(help.action)} style={{ ...button, padding: '2px 0', marginTop: 2, color: '#0070f3' }}>{help.label}</button>}
    </>}>
    {connected ? <ConnectionActions provider="remarkable" label="reMarkable" busy={busy} onAction={onAction} items={[{ action: 'sync', label: 'Sync now' }, { action: 'disconnect', label: 'Disconnect', separator: true }]} />
      : <button type="button" className="hov-bd2" data-connection-action="connect" disabled={disabled} onClick={() => onAction('connect')} style={bordered(disabled)}>{busy === 'connect' ? 'Connecting…' : problem ? 'Try again' : 'Connect'}</button>}
  </Row>;
}

/** What the reMarkable row says of its folder (status { state, documents, error, problems }) → { text, busy, error, problems }, or null. */
export function remarkableSyncLine(status) {
  if (!status || !status.connected) return null;
  const problems = Array.isArray(status.problems) ? status.problems.filter((p) => p && p.name) : [];
  const failed = problems.length ? `${problems.length === 1 ? `“${problems[0].name}” could not be read` : `${problems.length} notebooks could not be read: ${problems.slice(0, 3).map((p) => `“${p.name}”`).join(', ')}${problems.length > 3 ? '…' : ''}`}. They’ll be tried again.` : '';
  if (status.state === 'syncing') return { text: 'Syncing…', busy: true, error: false, problems: failed };
  if (status.state === 'reading' && status.reading) return { text: `Reading handwriting… ${Math.min(status.reading.done + 1, status.reading.of)} of ${status.reading.of}`, busy: true, error: false, problems: failed };
  if (status.state === 'error') return { text: status.error || 'Your notebooks could not be synced.', busy: false, error: true, problems: failed };
  const kept = Number(status.kept) || 0;
  if (status.state === 'synced') return { text: `Synced · ${status.documents} ${status.documents === 1 ? 'notebook' : 'notebooks'} in your library${kept ? ` · ${kept} kept that the reMarkable app no longer has` : ''}`, busy: false, error: false, problems: failed };
  return null;
}

/** What each reMarkable action calls. The answers are the status. */
export function remarkableAction(action) {
  if (action === 'connect') return api.remarkableConnect();
  if (action === 'sync') return api.remarkableSync();
  if (action === 'disconnect') return api.remarkableDisconnect();
  if (action === 'get-app') { void api.remarkableHelp('app'); return null; }
  if (action === 'privacy') { void api.remarkableHelp('privacy'); return null; }
  return null;
}

// Claude Code and Codex (2026-10-03): the sign-ins the setup dialog runs (../ui/ToolSetup.jsx, src/main/tools/manager.cjs),
// not a second way in. A row is the tool check's snapshot through rowOf; its one button does what the dialog's does. While
// the CLI waits for the browser, Reopen page opens its page there again (open-external). Sign out runs the CLI's logout.
export const TOOL_CONNECTIONS = Object.freeze(['claude', 'codex']);
export const TOOL_NAME = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
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
  const [remarkable, setRemarkable] = useRemarkableStatus();
  const [remarkableBusy, setRemarkableBusy] = React.useState(null);
  const [remarkableProblem, setRemarkableProblem] = React.useState('');
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
  const actRemarkable = async action => {
    if (remarkableBusy) return;
    setRemarkableBusy(action); setRemarkableProblem('');
    try {
      const next = await remarkableAction(action);
      if (next) setRemarkable(next);
    } catch (error) { setRemarkableProblem(errorMessage(error)); }
    finally { setRemarkableBusy(null); }
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
    <RemarkableConnection key="remarkable" status={remarkable} busy={remarkableBusy} error={remarkableProblem} onAction={actRemarkable} />
    {TOOL_CONNECTIONS.map(name => <ToolConnection key={name} id={name} tool={tools?.tools?.[name]} busy={toolBusy[name] || null} error={toolProblem[name] || ''} onAction={action => actTool(name, action)} />)}
  </Group>;
}
