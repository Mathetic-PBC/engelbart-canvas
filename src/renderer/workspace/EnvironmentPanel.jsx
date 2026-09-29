import React from 'react';
import { api, errorMessage } from '../api.js';
import { isEnvironmentName, environmentReportOf, environmentRows, describeEnvironment } from '../../shared/environment.cjs';
import './environment-panel.css';

export default function EnvironmentPanel({ repo, run, embedded = false }) {
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
        setNotice('Restarting app…');
      } else setNotice('Saved. Restart the app to apply.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const canRestart = !!run?.sandbox_id && ['ready', 'failed'].includes(run.status);
  const pending = saved && saved.revision !== (run?.env_revision || null);
  const Container = embedded ? 'section' : 'details';
  return <Container aria-label="Environment variables" className={`environment-panel${embedded ? ' environment-panel-embedded' : ''}`}>
    {!embedded && <summary>Environment</summary>}
    <fieldset disabled={busy || !saved} className="environment-fields">
      <div className="environment-columns" aria-hidden="true"><span>Name</span><span>Value</span><span /></div>
      {rows.map((row) => {
        const key = row.name;
        const removing = changes[key] === null;
        const edited = Object.hasOwn(changes, key);
        const action = removing ? 'Undo' : row.saved ? 'Remove' : 'Reset';
        const needsValue = row.variable?.status === 'missing' && !row.saved && !edited;
        return <div key={key} className="environment-row" data-removing={removing ? 'true' : undefined}>
        <input className="environment-input environment-name" aria-label={`Name of ${key}`} title={key} value={key} readOnly tabIndex={-1} />
        <input id={`env-${repo.id}-${key}`} className="environment-input" aria-label={`Value for ${key}`} aria-describedby={`env-status-${repo.id}-${key}`} type="password" autoComplete="new-password" spellCheck={false} disabled={removing} placeholder={removing ? 'Will be removed' : row.saved ? 'Saved · leave unchanged' : row.variable?.status === 'local' ? 'Provided by sandbox' : 'Value'} value={changes[key] ?? ''} onChange={(event) => setChanges((current) => ({ ...current, [key]: event.target.value }))} />
        {row.saved || edited ? <button type="button" className="environment-button environment-row-action" aria-label={`${removing ? 'Undo removal of' : action} ${key}`} onClick={() => setChanges((current) => {
          const next = { ...current };
          if (next[key] === null || !row.saved) delete next[key]; else next[key] = null;
          return next;
        })}>{action}</button> : <span />}
        <div id={`env-status-${repo.id}-${key}`} className={`environment-row-note${needsValue ? ' environment-missing' : ''}`}>
          {removing ? 'Will be removed' : edited ? 'Unsaved change' : describeEnvironment(row, { pending, removed: saved?.removed.includes(key) })}
        </div>
      </div>;
      })}
      <div className="environment-row environment-new-row">
        <input aria-label="Environment variable name" className="environment-input" placeholder="VARIABLE_NAME" value={name} autoComplete="off" spellCheck={false} onChange={(event) => setName(event.target.value)} />
        <input aria-label="New environment value" type="password" className="environment-input" placeholder="Value" value={value} autoComplete="new-password" spellCheck={false} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" className="environment-button environment-button-primary" onClick={add} disabled={!name.trim()}>Add</button>
      </div>
      <div className="environment-actions">
        <button type="button" className="environment-button" onClick={() => save(false)} disabled={!Object.keys(changes).length}>Save</button>
        <button type="button" className="environment-button" onClick={() => save(true)} disabled={!canRestart}>{busy ? 'Saving…' : 'Save & restart app'}</button>
      </div>
    </fieldset>
    {!saved && !error && <p role="status" className="environment-message">Loading variables…</p>}
    {saved?.removed.length > 0 && <p className="environment-message">Removed: {saved.removed.join(', ')}</p>}
    {notice && <p role="status" className="environment-message">{notice}</p>}
    {error && <div role="alert" className="environment-error"><p>{error}</p><button type="button" className="environment-button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { setSaved(await api.sandboxEnvironment(repo.id)); setError(''); setNotice('Reloaded saved names. Review your draft changes before saving.'); }
      catch (e) { setError(errorMessage(e)); }
      finally { setBusy(false); }
    }}>Reload saved names</button></div>}
  </Container>;
}
