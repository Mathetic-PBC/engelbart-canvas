import React from 'react';
import { api } from '../api.js';
import './local-preview.css';

const BUSY = new Set(['planning', 'confirming', 'building', 'installing', 'starting', 'checking', 'repairing']);
const LABELS = { planning: 'Planning', confirming: 'Ready to build', building: 'Building', installing: 'Installing', starting: 'Starting', checking: 'Checking', repairing: 'Repairing', ready: 'Build finished', failed: 'Build failed', stopped: 'Stopped' };

export function useLocalPreview(projectId, workspaceId, onReady) {
  const [preview, setPreview] = React.useState(null);
  const ready = React.useRef(onReady);
  const scope = React.useRef('');
  scope.current = `${projectId}:${workspaceId}`;
  ready.current = onReady;
  React.useEffect(() => {
    let live = true, revision = 0, opened = null;
    setPreview(null);
    if (!workspaceId) return undefined;
    const off = api.onLocalPreview(({ preview: next }) => {
      if (!live || scope.current !== `${projectId}:${workspaceId}` || next?.projectId !== projectId || next?.workspaceId !== workspaceId) return;
      revision++;
      setPreview(next);
      if (next.status === 'ready' && next.url && !next.error && opened !== next.runId) {
        opened = next.runId;
        ready.current?.(next);
      }
    });
    api.localPreview(projectId, workspaceId).then(value => { if (live && !revision && scope.current === `${projectId}:${workspaceId}`) { setPreview(value); opened = value?.runId; } }).catch(() => {}); // global notifications report loading errors
    return () => { live = false; off(); };
  }, [projectId, workspaceId]);
  // Effects reset asynchronously; never show another workspace's previous preview.
  return { preview: preview?.workspaceId === workspaceId && preview?.projectId === projectId ? preview : null };
}

export default function LocalPreview({ state, onOpen }) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = state.preview;
  React.useEffect(() => { setExpanded(false); }, [preview?.id]);
  if (!preview) return null;
  const busy = BUSY.has(preview.status), running = busy || preview.status === 'ready';
  const approval = preview.approval;
  const steps = preview.plan?.steps || [];
  return <section className="local-preview" aria-label="Local interface preview" data-local-preview={preview.status}>
    <div className="local-preview-bar">
      <button type="button" className="local-preview-label" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} title="Show local build details">
        <span className="local-preview-name">{preview.name}</span>
        <span role="status">{preview.error ? 'Build failed' : LABELS[preview.status] || preview.status}</span>
      </button>
      <div className="local-preview-actions">
        {preview.status === 'ready' && <button type="button" onClick={() => onOpen(preview)}>Open</button>}
        {approval ? null : running
          ? <button type="button" disabled={state.working === 'stop'} onClick={() => state.act('stop')}>Stop</button>
          : preview.recipe && <button type="button" disabled={state.working} onClick={() => state.act('restart')}>Restart</button>}
        <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>Details</button>
      </div>
    </div>
    {preview.workspaceName && <p className="local-preview-workspace">{preview.workspaceName} · Local interface</p>}
    {preview.status === 'planning' && <p className="local-preview-workspace">Claude is preparing the steps. No coding has started.</p>}
    {(busy || expanded) && steps.length > 0 && <div className="local-preview-plan" aria-label="Build steps">
      <p>Plan by {preview.plan.by || 'Claude'}</p>
      <ol>{steps.map((row, index) => <li key={row.id} data-build-step={row.id} data-step-status={row.status} title={row.detail || row.instructions}>
        <span className="local-preview-step-mark" aria-label={row.status}>{row.status === 'done' ? '✓' : row.status === 'failed' ? '!' : row.status === 'skipped' || row.status === 'stopped' ? '–' : row.status === 'running' ? '•' : index + 1}</span>
        <span>{row.title}{row.status === 'skipped' && <small>Skipped · {row.detail}</small>}</span>
      </li>)}</ol>
    </div>}
    {approval && <div className="local-preview-approval" data-build-approval={approval.id} data-restart-approval={approval.kind === 'restart' ? approval.id : undefined}>
      <p>{approval.message}</p>
      <p className="local-preview-approval-detail">{approval.detail}</p>
      <div>
        <button type="button" data-build-approve disabled={state.working === 'approve' || state.working === 'decline'} onClick={() => state.act('approve')}>{approval.label}</button>
        <button type="button" data-build-decline disabled={state.working === 'approve' || state.working === 'decline'} onClick={() => state.act('decline')}>Not now</button>
      </div>
    </div>}
    {(state.error || preview.error) && <p className="local-preview-error" role="alert">{state.error || preview.error}</p>}
    {expanded && <div className="local-preview-details">
      <button type="button" className="local-preview-folder" title="Reveal local app folder" onClick={() => state.act('folder')}>{preview.directory}</button>
      {preview.recipe && <div className="local-preview-command">{[preview.recipe.install, preview.recipe.build, preview.recipe.command].filter(Boolean).join('\n')}</div>}
      <pre tabIndex="0" aria-label="Local build logs">{preview.logs.join('\n') || preview.activity || 'No output yet.'}</pre>
    </div>}
  </section>;
}
