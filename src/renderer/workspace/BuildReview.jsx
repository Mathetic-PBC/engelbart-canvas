// Review (2026-09-25; design B14): what a Build changed since it started — the files, then the diff — in a dialog. For an
// accepted Build, its commit. Bare: added lines green, removed red, a file's header bold; Hudson redraws it in Claude Design.
// What its run steps changed to make the repository run (2026-09-29, main/build/run-step.cjs) is a section of its own.
//
// What runs comes first (2026-09-29, later): when the run step got something running, Review opens on Running, one entry
// per runnable (its name, kind, where it stands, its last error), and clicking one opens it: a UI in a Stage tab, a
// terminal program in Engelbart's terminal, a desktop app's window to the front (main/build/manager.cjs showRunnable).
// The dialog leaves the right pane uncovered then (`aside`), so what opens is beside it. The diff is under Changes; when
// nothing runs, Review opens there, with what did not run and why.
import React from 'react';
import { createPortal } from 'react-dom';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed' };

function lineStyle(line) {
  if (line.startsWith('diff --git')) return { color: '#171717', fontWeight: 600, marginTop: 14 };
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || /^(new|deleted) file mode|^similarity index|^rename (from|to)/.test(line)) return { color: '#8f8f8f' };
  if (line.startsWith('@@')) return { color: '#0761d1' };
  if (line.startsWith('+')) return { color: '#1a7f37', background: '#f0fbf2' };
  if (line.startsWith('-')) return { color: '#cf222e', background: '#fff5f5' };
  return { color: '#4d4d4d' };
}

function Files({ files, label }) {
  return files.map((file) => (
    <div key={`${label}:${file.status}:${file.path}`} style={{ display: 'flex', gap: 10, font: '13px/1.6 var(--font-mono)', color: '#171717' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.was ? `${file.was} → ${file.path}` : file.path}</span>
      <span style={{ flex: 'none', color: '#8f8f8f', fontFamily: 'var(--font-sans)' }}>{STATUS[file.status] || file.status}</span>
      <span style={{ flex: 'none', width: 90, textAlign: 'right' }}>{file.binary ? 'binary' : <><span style={{ color: '#1a7f37' }}>+{file.adds}</span> <span style={{ color: '#cf222e' }}>−{file.dels}</span></>}</span>
    </div>
  ));
}

const Patch = ({ patch }) => (
  <pre style={{ margin: 0, font: '12.5px/1.6 var(--font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
    {String(patch || '').split('\n').map((line, n) => <div key={n} style={lineStyle(line)}>{line || ' '}</div>)}
  </pre>
);

const KINDS = { ui: 'web UI', app: 'desktop app', terminal: 'terminal program' };
const OPENS = { ui: 'Open in the Stage', app: 'Bring its window forward', terminal: 'Open in the terminal' };
function where(item) {
  if (item.status === 'running') return item.type === 'app' ? 'runs in its own window' : item.url ? `runs at ${item.url}` : 'runs';
  return { failed: 'did not run', stopped: 'stopped', installing: 'installing', checking: 'checking' }[item.status] || 'waiting';
}

function Runnable({ item, onOpen }) {
  const runs = item.status === 'running';
  const color = runs ? '#1a7f37' : item.status === 'failed' ? '#e70022' : '#8f8f8f';
  return (
    <button type="button" data-review-runnable={item.name} data-runnable-status={item.status} disabled={!runs} className={runs ? 'hov-wash' : undefined} onClick={() => { if (runs) onOpen(item.name); }} title={runs ? OPENS[item.type] : undefined} style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', textAlign: 'left', cursor: runs ? 'pointer' : 'default', font: '13px/1.5 var(--font-sans)', color: '#171717' }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{ flex: 'none', fontWeight: 600 }}>{item.name}</span>
        <span style={{ flex: 'none', color: '#8f8f8f' }}>{KINDS[item.type] || item.type}{item.folder && item.folder !== '.' ? ` · ${item.folder}` : ''}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color }}>{where(item)}</span>
        {runs && <span style={{ flex: 'none', color: '#0070f3' }}>{OPENS[item.type]}</span>}
      </span>
      {item.status === 'failed' && item.error && <span style={{ display: 'block', marginTop: 6, maxHeight: 140, overflow: 'auto', font: '12px/1.6 var(--font-mono)', color: '#4d4d4d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.error}</span>}
    </button>
  );
}

/** What did not run, and why: above the diff when nothing runs. */
function Failed({ items }) {
  return (
    <div data-review-failed="1" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid #eaeaea' }}>
      {items.map((item) => (
        <div key={`${item.folder}:${item.name}`} style={{ font: '13px/1.5 var(--font-sans)', color: '#171717' }}>
          <span style={{ fontWeight: 600 }}>{item.name}</span> <span style={{ color: '#8f8f8f' }}>{KINDS[item.type] || item.type}</span> <span style={{ color: '#e70022' }}>did not run</span>
          {item.error && <div style={{ marginTop: 2, font: '12px/1.6 var(--font-mono)', color: '#4d4d4d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.error}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * `task`: the Build (its run step's runnables); `onOpen(name)`: a runnable opened; `aside`: the width on the right the
 * dialog leaves uncovered while it shows what runs (the right pane, where a UI or a terminal opens).
 */
export default function BuildReview({ title, review, error, task = null, aside = 0, onOpen = () => {}, onClose }) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const runnables = (task && task.runStep && task.runStep.runnables) || [];
  const runs = runnables.some((item) => item.status === 'running');
  const [view, setView] = React.useState(() => (runs ? 'running' : 'changes'));
  const shown = runnables.length ? view : 'changes';
  const failed = runnables.filter((item) => item.status === 'failed');
  const run = review && review.runStep && review.runStep.files.length ? review.runStep : null;
  const tab = (id, label) => (
    <button type="button" data-review-view={id} aria-pressed={shown === id} onClick={() => setView(id)} style={{ flex: 'none', padding: '0 0 2px', border: 0, borderBottom: `2px solid ${shown === id ? '#171717' : 'transparent'}`, background: 'transparent', cursor: 'pointer', font: `${shown === id ? 600 : 400} 13px/1.4 var(--font-sans)`, color: shown === id ? '#171717' : '#4d4d4d' }}>{label}</button>
  );
  return createPortal(
    <div data-overlay="1" data-build-review="1" data-review-shown={shown} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', top: 0, bottom: 0, left: 0, right: shown === 'running' ? aside : 0, zIndex: 55, display: 'flex', alignItems: shown === 'running' ? 'flex-start' : 'stretch', justifyContent: 'center', padding: '6vh 24px', background: 'rgba(255,255,255,.35)' }}>
      <div role="dialog" aria-modal="true" aria-label="Review" style={{ width: 'min(980px, 100%)', maxHeight: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '14px 18px 10px', borderBottom: '1px solid #eaeaea' }}>
          <span style={{ font: '600 15px/1.4 var(--font-sans)', color: '#171717' }}>Review</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '15px/1.4 var(--font-sans)', color: '#4d4d4d' }}>{title}</span>
          {runnables.length > 0 && <span style={{ flex: 'none', display: 'flex', gap: 14, alignSelf: 'center' }}>{tab('running', 'Running')}{tab('changes', 'Changes')}</span>}
          {shown === 'changes' && review && review.from && <span style={{ flex: 'none', font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>since {review.from}{review.base ? ` at ${String(review.base).slice(0, 7)}` : ''}</span>}
          <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '18px/1 var(--font-sans)', color: '#8f8f8f' }}>×</button>
        </div>
        {shown === 'running' && (
          <div data-review-running="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 18px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {runnables.map((item) => <Runnable key={`${item.folder}:${item.name}`} item={item} onOpen={onOpen} />)}
          </div>
        )}
        {shown === 'changes' && <div data-review-changes="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 18px 18px' }}>
          {!runs && failed.length > 0 && <Failed items={failed} />}
          {error && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</div>}
          {!review && !error && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Reading…</div>}
          {review && (
            <>
              <div data-review-files="1" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
                {review.files.length === 0 && <div style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing has changed yet.</div>}
                <Files files={review.files} label="build" />
                {review.running && <div style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Still working: this is what its last finished turn saved.</div>}
              </div>
              <Patch patch={review.patch} />
              {review.truncated && <div style={{ marginTop: 8, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>The diff is longer than this; the rest is cut.</div>}
              {run && (
                <div data-review-run="1" style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid #eaeaea' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                    <span style={{ font: '600 13.5px/1.4 var(--font-sans)', color: '#171717' }}>Run step</span>
                    <span style={{ font: '12.5px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{run.apart ? 'changed to make it run, apart from the Build\'s work above' : 'changed to make it run; a later turn changed the same lines, so the Build\'s work above includes these too'}</span>
                  </div>
                  <div data-review-run-files="1" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}><Files files={run.files} label="run" /></div>
                  <Patch patch={run.patch} />
                  {run.truncated && <div style={{ marginTop: 8, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>The diff is longer than this; the rest is cut.</div>}
                </div>
              )}
            </>
          )}
        </div>}
      </div>
    </div>,
    document.body,
  );
}
