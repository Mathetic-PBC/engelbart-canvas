import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { TOOL_LOGOS } from './logos.js';
import { shownName } from '../../shared/connect-sources.cjs';

// "Imports in progress" (2026-10-13, the mockup's work-import-status modal): an Import your context run, in the workspace
// after Import to Engelbart. Its imports with how each goes, and every step an agent hands the person (a sign-in, a
// permission, a code) as a card: the workspace's ask was "Sign-in and permission prompts appear as modals inside
// Engelbart because the user will just be able to like use it". It opens by itself when a new step comes up, and from the
// chip in the top right; "Continue to project" puts it away, and once everything has ended its button is Done (the old
// window's "Run in background" stayed after the imports had finished). Second round (2026-10-13): no Agent trace button
// (View ▸ Agent Trace has it), Stop all on the left and asked again ("Are you sure?", stopping the quiet link and Keep
// importing the button), and a browser agent's stop in the person's own browser says so: Open brings that browser forward,
// Done once they have signed in there.

const ENDED = new Set(['done', 'failed', 'stopped']);
const WORK = new Set(['import', 'recall', 'survey']);

const FOLDER = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h7l2 2h11v13H2z" /></svg>;
const WEB = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" /></svg>;
const logoOf = (apps) => { const app = (apps || [])[0]; return app && TOOL_LOGOS[app] ? <img src={TOOL_LOGOS[app]} alt="" /> : app ? FOLDER : WEB; };

/** A job's state in the list's last column. */
export function jobState(job) {
  if (job.skipped) return 'Left out';
  if (job.status === 'waiting') return 'Needs you';
  if (job.status === 'running') { const n = (job.notes || 0) + (job.items || 0); return n ? `${n} added` : 'Working'; }
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'done') { const n = (job.notes || 0) + (job.items || 0); return n ? `Done · ${n}` : 'Done'; }
  return 'Left out';
}

/** A card's words: what the app needs, and its button. */
export function needWords(need) {
  const app = shownName(need.app);
  // A browser agent waiting at a sign-in page in the person's own browser (connect/session.cjs askInBrowser).
  if (need.own) {
    const title = need.kind === '2fa' || need.kind === 'code' ? `${app} needs a code in ${need.browser}` : need.kind === 'captcha' ? `${app} needs you to answer a check in ${need.browser}` : `Sign in to ${app} in ${need.browser}`;
    return { title, button: need.opened ? 'Done' : `Open ${need.browser}`, done: !!need.opened };
  }
  const title = need.kind === 'permission' ? `${app} needs permission` : need.kind === 'folder' ? `${app} needs its folder` : need.kind === 'code' || need.kind === '2fa' ? `${app} needs a code` : need.kind === 'connector' ? `${app} needs you to connect it` : `${app} needs you to sign in`;
  const button = need.kind === 'permission' ? 'Allow' : need.kind === 'folder' ? 'Choose folder' : need.kind === 'code' || need.kind === '2fa' ? 'Open' : need.busy ? 'Open page' : 'Log in';
  return { title, button };
}

/**
 * `session` the run's snapshot (connect/session.cjs, `direct` set); `onClose()` puts it away; `onNeed(need)`,
 * `onNeedDone(need)` (a browser agent's card, once its browser was opened) and `onSkip(need)` a card's buttons; `onStop()`
 * Stop all, once confirmed; `onDone()` the run dismissed once everything has ended. `previewStop`: the standalone page
 * shows the Stop all question at once.
 */
export default function ImportStatus({ session, onClose, onNeed, onNeedDone = null, onSkip, onStop, onDone, previewStop = false }) {
  const [confirmStop, setConfirmStop] = React.useState(previewStop);
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (confirmStop) setConfirmStop(false); else onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, confirmStop]);
  const jobs = (session.jobs || []).filter((job) => WORK.has(job.kind));
  const ended = jobs.length > 0 && jobs.every((job) => ENDED.has(job.status)) && !(session.needs || []).length;
  const projects = (session.direct && session.direct.projects) || [];
  const memory = session.memory && session.memory.status;
  return (
    <div className="ix ix-overlay" data-overlay="1" data-cover="1" data-import-status={session.id}>
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:140}.ix.ix-overlay .scrim.stop-confirm{z-index:150}.ix .background-job-list small{display:block}.ix .mf .mf-left{margin-right:auto}'}</style>
      <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section className="modal wide" role="dialog" aria-modal="true" aria-label="Imports in progress">
          <div className="modal-head">
            <h3>{ended ? 'Your imports are done' : 'Imports in progress'}</h3>
            <button type="button" className="close" aria-label="Close import status" onClick={onClose}>×</button>
          </div>
          <p>{`Every agent is limited to the projects you selected${projects.length ? `: ${projects.join(' · ')}` : ''}.`}</p>
          <div className="background-job-list">
            {jobs.map((job) => (
              <div key={job.id} data-background-job={job.id}>
                {logoOf(job.apps)}
                <span><b>{job.label}</b><small>{job.activity || job.summary || job.error || projects.join(' · ')}</small></span>
                <span>{jobState(job)}</span>
              </div>
            ))}
          </div>
          <div className="background-needs-list">
            {(session.needs || []).map((need) => {
              const words = needWords(need);
              return (
                <div key={need.id} className="needs-card" data-import-need={need.app}>
                  {logoOf([need.app])}
                  <span><b>{words.title}</b><small>{need.error || (need.own ? need.note || need.reason : need.busy ? (need.browser ? `Waiting for you to finish in ${need.browser}…` : 'Waiting for you to finish…') : need.reason)}</small></span>
                  <button type="button" className="link" onClick={() => onSkip(need)}>Skip</button>
                  <button type="button" className="btn small" data-need-open={need.id} onClick={() => (words.done && onNeedDone ? onNeedDone(need) : onNeed(need))}>{words.button}</button>
                </div>
              );
            })}
          </div>
          {memory && memory !== 'waiting' && memory !== 'skipped' && <p style={{ fontSize: 13 }}>{memory === 'saved' ? 'MEMORY.md is saved.' : memory === 'writing' ? 'Writing MEMORY.md from what came in…' : memory === 'failed' ? 'MEMORY.md could not be written.' : ''}</p>}
          <div className="mf">
            {!ended && <button type="button" className="link mf-left" data-import-stop-all="1" onClick={() => setConfirmStop(true)}>Stop all</button>}
            <button type="button" className="btn" data-import-status-close="1" onClick={ended ? onDone : onClose}>{ended ? 'Done' : 'Continue to project'}</button>
          </div>
          {confirmStop && !ended && (
            <div className="scrim stop-confirm" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmStop(false); }}>
              <section className="modal" role="alertdialog" aria-modal="true" aria-label="Stop all imports?">
                <h3>Are you sure?</h3>
                <p>Every import stops now. What came in stays in your library; the rest is not brought in.</p>
                <div className="mf"><button type="button" className="link" data-import-stop-confirm="1" onClick={() => { setConfirmStop(false); onStop(); }}>Stop all</button><button type="button" className="btn small" onClick={() => setConfirmStop(false)}>Keep importing</button></div>
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
