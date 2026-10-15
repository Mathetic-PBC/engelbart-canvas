import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import { TOOL_LOGOS } from './logos.js';
import { shownName } from '../../shared/connect-sources.cjs';
import { catalogTool } from '../../shared/import-flow.cjs';

// "Imports in progress" (2026-10-13, the mockup's work-import-status modal): an Import your context run, in the workspace
// after Import to Engelbart. Its imports with how each goes, and every step an agent hands the person (a sign-in, a
// permission, a code) as a card: the workspace's ask was "Sign-in and permission prompts appear as modals inside
// Engelbart because the user will just be able to like use it". It opens by itself when a new step comes up, and from the
// chip in the top right; "Continue to project" puts it away, and once everything has ended its button is Done (the old
// window's "Run in background" stayed after the imports had finished). Second round (2026-10-13): no Agent trace button
// (View ▸ Agent Trace has it), Stop all on the left and asked again ("Are you sure?", stopping the quiet link and Keep
// importing the button), and a browser agent's stop in the person's own browser says so: Open brings that browser forward,
// Done once they have signed in there.
// Round 3 (2026-10-13, docs/onboarding-round-3.md): the steps for the person are popups of their own (./NeedPopup.jsx),
// their rows first with a "Needs you" link that brings the popup back; no subtext and no dividing lines; ended, it is
// "Your imports are complete!" with a tile for each source that brought something in (one tile a logo).

const ENDED = new Set(['done', 'failed', 'stopped']);
const WORK = new Set(['import', 'recall', 'survey']);

const FOLDER = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h7l2 2h11v13H2z" /></svg>;
const WEB = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18" /></svg>;
const logoOf = (apps) => { const app = (apps || [])[0]; return app && TOOL_LOGOS[app] ? <img src={TOOL_LOGOS[app]} alt="" /> : app ? FOLDER : WEB; };
/** A row's name: the app ("Obsidian", "Google Drive"), not the job's "Notes: Obsidian". */
const rowName = (job) => {
  const app = (job.apps || []).length === 1 ? job.apps[0] : null;
  if (app) return catalogTool(app) ? catalogTool(app).name : shownName(app);
  return String(job.label || '').replace(/^[^:]{1,30}:\s*/, '');
};
/** Whether a job brought anything into the library. */
const brought = (job) => job.status === 'done' && (job.notes || 0) + (job.items || 0) > 0;
const RANK = { waiting: 0, running: 1, queued: 2 };

/** A job's state in the list's last column. */
export function jobState(job) {
  if (job.skipped) return 'Left out';
  if (job.status === 'waiting') return 'Needs you';
  if (job.status === 'running') { const n = (job.notes || 0) + (job.items || 0); return n ? `${n} added` : 'Working'; }
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'done') { const n = (job.notes || 0) + (job.items || 0); return n ? `Done · ${n}` : 'Done'; }
  // A failed import is not one the person left out (2026-10-14: Granola's "model at capacity" read as "Left out").
  if (job.status === 'failed') return 'Couldn’t import';
  if (job.status === 'stopped') return 'Stopped';
  return 'Left out';
}

/** A reason's first sentence, without its full stop, at most `max` characters. */
const firstSentence = (text, max = 140) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Why each source that ended brought nothing in (2026-10-14, a beta tester's Zotero: "when she finally hit later,
 * nothing was imported, so she was super confused") → [{ name, line }], one line each: what the run left out and why
 * (`session.leftOut`, main's words: "you skipped signing in"), else a failed import's error, else what its
 * agent said it found. `jobs` the status's rows; `imported` those that brought something in.
 */
export function nothingLines(session, jobs, imported) {
  const leftOut = Array.isArray(session.leftOut) ? session.leftOut : [];
  const whyOf = (apps) => { const entry = leftOut.find((one) => (apps || []).includes(one.app)); return entry ? entry.why : ''; };
  const out = new Map();
  const add = (name, line) => { if (name && !out.has(name) && !imported.some((job) => rowName(job) === name)) out.set(name, line); };
  for (const job of jobs) {
    if (brought(job) || !ENDED.has(job.status)) continue;
    const name = rowName(job);
    const why = whyOf(job.apps);
    if (why) add(name, `Nothing came in from ${name}: ${why}.`);
    else if (job.status === 'failed') add(name, `Nothing came in from ${name}: its import failed${job.error ? ` (${firstSentence(job.error, 100)})` : ''}.`);
    else if (job.status === 'stopped') add(name, `Nothing came in from ${name}: it was stopped.`);
    else if (job.summary) add(name, `Nothing came in from ${name}. ${firstSentence(job.summary)}.`);
    else add(name, `Nothing came in from ${name}.`);
  }
  // An app left out before any import of it started (Skip on its sign-in, a sign-in macOS refused): no row of its own.
  for (const entry of leftOut) {
    if (jobs.some((job) => (job.apps || []).includes(entry.app))) continue;
    const name = catalogTool(entry.app) ? catalogTool(entry.app).name : shownName(entry.app);
    add(name, `Nothing came in from ${name}: ${entry.why}.`);
  }
  return [...out].map(([name, line]) => ({ name, line }));
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
  // The rows that need the person first, then what is working, queued and ended (a stable sort: their order otherwise).
  const jobs = (session.jobs || []).filter((job) => WORK.has(job.kind) && job.kind !== 'recall').sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
  // Apps left out before an import of theirs started (Skip on a sign-in held at the start): a row each, "Left out".
  const leftOnly = (Array.isArray(session.leftOut) ? session.leftOut : []).filter((entry) => !jobs.some((job) => (job.apps || []).includes(entry.app)) && !(session.needs || []).some((need) => need.app === entry.app))
    .map((entry) => ({ id: `left-${entry.app}`, kind: 'import', apps: [entry.app], label: entry.app, status: 'stopped', skipped: true }));
  // Ended with nothing to run at all (every app left out) is ended too: it said "Imports in progress" for good.
  const ended = (jobs.length > 0 || (leftOnly.length > 0 && session.finished && !session.thinking)) && jobs.every((job) => ENDED.has(job.status)) && !(session.needs || []).length;
  const imported = jobs.filter(brought);
  const all = ended && imported.length === jobs.length && !leftOnly.length;
  // The sources that ended without bringing anything in, each named once with why (the completion said nothing about the
  // ones left out, and only "Nothing came in from …" about the rest).
  const missed = ended ? nothingLines(session, jobs, imported) : [];
  // A step belongs to the jobs that asked for it (jobIds), else to a job of its app.
  const needOf = (job) => (session.needs || []).find((need) => (job.needId ? need.id === job.needId : (need.jobIds || []).includes(job.id) || (job.apps || []).includes(need.app)));
  // An app held on its sign-in has no import yet (it starts once signed in): its row all the same, first.
  const held = (session.needs || []).filter((need) => !(need.jobIds || []).length && !jobs.some((job) => (job.apps || []).includes(need.app)))
    .map((need) => ({ id: `need-${need.id}`, needId: need.id, kind: 'import', apps: [need.app], label: need.app, status: 'waiting' }));
  const rows = [...held, ...jobs, ...leftOnly];
  return (
    <div className="ix ix-overlay" data-cover="1" data-import-status={session.id}>
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:140}.ix.ix-overlay .scrim.stop-confirm{z-index:150}.ix .mf .mf-left{margin-right:auto}.ix .review-logos.one-row{flex-wrap:nowrap;overflow:hidden}.ix .review-logo.more{border:1px dashed #c9c9c9;font-size:14px;color:var(--mute)}.ix .modal p.missed-line{margin:0 0 4px;font-size:13px;color:var(--mute)}'}{ROUND3_CSS}{ROUND4_CSS}</style>
      {/* the scrim is the overlay (as NeedPopup's): the outer element has no height, and the Stage's page and the post-it
          cards, native views, only step aside for an overlay they can see is over them */}
      <div className="scrim" data-overlay="1" data-cover="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section className={`modal ${ended ? 'done-modal' : 'wide'}`} role="dialog" aria-modal="true" aria-label={ended ? 'Your imports are complete' : 'Imports in progress'}>
          <div className="modal-head">
            <h3>{ended ? (all ? 'Your imports are complete!' : 'Your imports have finished') : 'Imports in progress'}</h3>
            <button type="button" className="close" aria-label="Close import status" onClick={onClose}>×</button>
          </div>
          {ended && <p>{all ? 'All of the sources you have selected are now inside of your Engelbart Library.' : imported.length ? 'These sources are now inside of your Engelbart Library.' : 'Nothing new came into your Engelbart Library.'}</p>}
          {ended ? (
            <>
              {imported.length > 0 && <CompletionLogos jobs={completionJobs(imported)} />}
              {!all && missed.map((entry) => <p key={entry.name} className="missed-line" data-imported-none={entry.name}>{entry.line}</p>)}
            </>
          ) : (
            <div className="background-job-list">
              {rows.map((job) => {
                const need = job.status === 'waiting' ? needOf(job) : null;
                return (
                  <div key={job.id} data-background-job={job.id} title={job.status === 'failed' && job.error ? String(job.error).slice(0, 300) : undefined}>
                    {logoOf(job.apps)}
                    <span><b>{rowName(job)}</b></span>
                    {need ? <button type="button" className="need-link" data-need-open={need.id} onClick={() => onNeed(need)}>Needs you</button> : <span>{jobState(job)}</span>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="mf">
            {!ended && <button type="button" className="link mf-left" data-import-stop-all="1" onClick={() => setConfirmStop(true)}>Stop all</button>}
            <button type="button" className="btn" data-import-status-close="1" onClick={ended ? onDone : onClose}>{ended ? 'Open library' : 'Continue in Engelbart'}</button>
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

// One row of logos (2026-10-14: "we only wanna show one row of logos"): as many as fit, the rest a dashed "+N" tile.
const ROW = 8;
function CompletionLogos({ jobs }) {
  const shown = jobs.length > ROW ? jobs.slice(0, ROW - 1) : jobs;
  const rest = jobs.slice(shown.length);
  return (
    <div className="review-logos one-row">
      {shown.map((job) => <div className="review-logo" key={job.id} title={job.label} aria-label={`${job.label} imported`} data-imported={job.label}>{job.apps[0] === '__sites' || !job.apps.length ? WEB : logoOf(job.apps)}</div>)}
      {rest.length > 0 && <div className="review-logo more" title={rest.map((job) => job.label).join(', ')} data-imported-more={rest.length}>{`+${rest.length}`}</div>}
    </div>
  );
}

/** A tile for each source that brought something in: one per source (2026-10-14: the folder and web logos had merged
 *  different sources into one tile, so "not everything is being showed"), the same source's jobs as one. */
function completionJobs(jobs) {
  const logos = new Map();
  for (const job of jobs) {
    const key = rowName(job);
    const previous = logos.get(key);
    if (previous) {
      previous.apps = [...new Set([...previous.apps, ...(job.apps || [])])];
      previous.labels = [...new Set([...previous.labels, rowName(job)])];
      previous.label = previous.labels.join(' · ');
    } else logos.set(key, { ...job, apps: [...(job.apps || [])], labels: [rowName(job)], label: rowName(job) });
  }
  return [...logos.values()];
}
