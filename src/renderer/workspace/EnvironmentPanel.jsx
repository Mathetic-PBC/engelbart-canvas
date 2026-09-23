import React from 'react';
import { api, errorMessage } from '../api.js';
import { isEnvironmentName, environmentReportOf, environmentRows, describeEnvironment } from '../../shared/environment.cjs';

const field = { minWidth: 0, width: '100%', border: '1px solid #ddd', borderRadius: 5, padding: '6px 8px', font: '12px var(--font-mono, monospace)', background: '#fff' };
const button = { padding: '5px 8px', border: '1px solid #ddd', borderRadius: 5, background: '#fff', color: '#171717', font: '12px var(--font-sans)', cursor: 'pointer' };

export default function EnvironmentPanel({ repo, run }) {
  const [saved, setSaved] = React.useState(null);
  const [changes, setChanges] = React.useState({});
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  React.useEffect(() => {
    let live = true;
    api.sandboxEnvironment(repo.id).then((result) => { if (live) setSaved(result); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [repo.id, run?.id, run?.status]);
  const report = environmentReportOf(run) || saved?.report;
  const rows = environmentRows(report, saved?.names, Object.keys(changes));
  const missing = rows.filter((row) => row.variable?.status === 'missing' && !row.saved).length;
  const add = () => {
    const key = name.trim();
    if (!isEnvironmentName(key)) { setError('Use letters, digits and underscores; do not start with a digit. Runner configuration names are reserved.'); return; }
    setChanges((current) => ({ ...current, [key]: value }));
    setName(''); setValue(''); setError(''); setNotice('');
  };
  const save = async (restart) => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (name.trim() || value) throw new Error('Click Add to include the new variable before saving.');
      const result = await api.saveSandboxEnvironment(repo.id, Object.entries(changes).map(([name, value]) => ({ name, value })), saved.revision);
      setSaved(result); setChanges({});
      setNotice('Saved.');
      if (restart) {
        await api.restartSandbox(repo.id);
        setNotice('Restarting in the same sandbox. The preview opens automatically when ready.');
      } else setNotice('Saved for the next launch. Restart the app to apply these changes to the current sandbox.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const canRestart = !!run?.sandbox_id && ['ready', 'failed'].includes(run.status);
  const pending = saved && saved.revision !== (run?.env_revision || null);
  return <details style={{ margin: '18px 22px', border: '1px solid #eaeaea', borderRadius: 7, padding: '10px 12px' }}>
    <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Environment variables {saved || report ? `· ${rows.length}` : ''}{missing ? ` · ${missing} missing` : ''}{pending ? ' · unapplied changes' : ''}</summary>
    <p style={{ color: '#666', fontSize: 12 }}>Values are encrypted locally and sent only to this repository’s sandbox. Saved values are never displayed again. Restarting briefly interrupts the app but keeps its installed files.</p>
    {!rows.length && <p style={{ color: '#666', fontSize: 12 }}>{report ? 'The setup scan found no environment variables.' : 'Variable names appear here automatically when setup scans the repository. You can also add one below.'}</p>}
    {report && report.runId !== run?.id && <p style={{ color: '#666', fontSize: 12 }}>Showing variables detected by an earlier build.</p>}
    <fieldset disabled={busy || !saved} style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
      {rows.map((row) => {
        const key = row.name;
        const removing = changes[key] === null;
        const edited = Object.hasOwn(changes, key);
        const action = removing ? 'Undo' : row.saved ? 'Remove' : 'Reset';
        return <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <label htmlFor={`env-${repo.id}-${key}`} style={{ font: '12px monospace', overflowWrap: 'anywhere', textDecoration: removing ? 'line-through' : undefined }}>{key}</label>
          <div style={{ color: row.variable?.status === 'missing' && !row.saved ? '#c22' : '#666', fontSize: 11, overflowWrap: 'anywhere' }}>
            {removing ? 'Will be removed' : edited ? 'Unsaved change' : describeEnvironment(row, { pending, removed: saved?.removed.includes(key) })}
            {row.variable?.public ? ' · sent to the browser' : ''}
          </div>
        </div>
        <input id={`env-${repo.id}-${key}`} aria-label={`Value for ${key}`} type="password" autoComplete="new-password" spellCheck={false} style={field} disabled={removing} placeholder={removing ? 'Will be removed' : row.saved ? 'Saved · leave unchanged' : row.variable?.status === 'local' ? 'Provided by sandbox' : 'Value (can be empty)'} value={changes[key] ?? ''} onChange={(event) => setChanges((current) => ({ ...current, [key]: event.target.value }))} />
        {row.saved || edited ? <button type="button" style={button} aria-label={`${removing ? 'Undo removal of' : action} ${key}`} onClick={() => setChanges((current) => {
          const next = { ...current };
          if (next[key] === null || !row.saved) delete next[key]; else next[key] = null;
          return next;
        })}>{action}</button> : <span />}
      </div>;
      })}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto', gap: 6, margin: '10px 0' }}>
        <input aria-label="Environment variable name" style={field} placeholder="VARIABLE_NAME" value={name} autoComplete="off" spellCheck={false} onChange={(event) => setName(event.target.value)} />
        <input aria-label="New environment value" type="password" style={field} placeholder="Value" value={value} autoComplete="new-password" spellCheck={false} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" style={button} onClick={add}>Add</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" style={button} onClick={() => save(false)} disabled={!Object.keys(changes).length}>Save</button>
        <button type="button" style={button} onClick={() => save(true)} disabled={!canRestart}>{busy ? 'Saving…' : 'Save & restart app'}</button>
      </div>
    </fieldset>
    {saved?.removed.length > 0 && <p style={{ color: '#666', fontSize: 12, overflowWrap: 'anywhere' }}>Removed overrides: {saved.removed.join(', ')}. Their saved values will no longer be injected. Defaults loaded by the repository itself may still apply.</p>}
    <p style={{ color: '#8f8f8f', fontSize: 11 }}>Public frontend variables (NEXT_PUBLIC_*, VITE_*) are not secrets. Values baked into a production bundle may require rebuilding those assets; a process restart alone cannot change them.</p>
    {notice && <p role="status" style={{ fontSize: 12 }}>{notice}</p>}
    {error && <div role="alert" style={{ color: '#c22', fontSize: 12 }}><p>{error}</p><button type="button" style={button} disabled={busy} onClick={async () => {
      setBusy(true);
      try { setSaved(await api.sandboxEnvironment(repo.id)); setError(''); setNotice('Reloaded saved names. Review your draft changes before saving.'); }
      catch (e) { setError(errorMessage(e)); }
      finally { setBusy(false); }
    }}>Reload saved names</button></div>}
  </details>;
}
