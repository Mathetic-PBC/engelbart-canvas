import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import { shownName } from '../../shared/connect-sources.cjs';

// A step an Import your context run hands the person (round 3, 2026-10-13: "the permission prompts … should be popups
// instead of like little pills in the popup"): one at a time, over whatever is showing, drawn as the review mockup's
// "Sign in to Notion · Continue in Arc." Nothing signs in inside Engelbart: Open brings up the app in the browser the
// person chose, and "I'm signed in" has Engelbart copy that sign-in (connect/session.cjs need 'done' checks it first).
// Later puts the popup away; the step stays in the status modal's list as "Needs you".

/** A step's words → { title, text, primary, secondary } (secondary: what the quiet link says). */
export function needCopy(need) {
  const app = shownName(need.app);
  const browser = need.browser || 'your browser';
  // GitHub and Zotero sign in through Engelbart's own sign-in (App.jsx engelbartSignIn), not a browser's.
  if ((need.app === 'GitHub' || need.app === 'Zotero') && (need.kind === 'signin' || need.kind === 'password')) return { title: `Sign in to ${app}`, text: '', primary: 'Sign in', secondary: 'Later' };
  if (need.kind === 'permission') return { title: `Allow Engelbart to read ${app}?`, text: '', primary: 'Allow', secondary: 'Don’t allow' };
  if (need.kind === 'folder') return { title: `Choose your ${app} folder`, text: '', primary: 'Choose folder', secondary: 'Later' };
  if (need.kind === 'connector') return { title: `Connect ${app}`, text: `Continue in ${browser}.`, primary: need.busy ? `Waiting for ${browser}…` : `Open ${browser}`, secondary: 'Later' };
  if (need.kind === 'code' || need.kind === '2fa') return { title: `Enter the code for ${app}`, text: `Continue in ${browser}.`, primary: need.opened ? 'Done' : `Open ${browser}`, secondary: 'Later' };
  if (need.kind === 'captcha') return { title: `Finish the check for ${app}`, text: `Continue in ${browser}.`, primary: need.opened ? 'Done' : `Open ${browser}`, secondary: 'Later' };
  return { title: `Sign in to ${app}`, text: `Continue in ${browser}.`, primary: need.opened ? 'I’m signed in' : `Open ${browser}`, secondary: 'Later' };
}

/**
 * `need` the step (connect/session.cjs publicNeed); `onOpen()` its primary action before it was opened; `onDone()` once
 * opened ("I'm signed in", Done); `onSkip()` for a permission turned down; `onLater()` puts it away.
 */
export default function NeedPopup({ need, onOpen, onDone, onSkip, onLater }) {
  const words = needCopy(need);
  const finishing = need.opened && need.kind !== 'connector' && need.kind !== 'permission' && need.kind !== 'folder';
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLater(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onLater]);
  return (
    <div className="ix ix-overlay" data-overlay="1" data-cover="1" data-need-popup={need.id} data-need-kind={need.kind}>
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:160}'}{ROUND3_CSS}{ROUND4_CSS}</style>
      <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onLater(); }}>
        <section className="modal need-modal" role="dialog" aria-modal="true" aria-label={words.title}>
          <h3>{words.title}</h3>
          {words.text ? <p>{words.text}</p> : null}
          {need.error ? <p className="need-error" role="status">{need.error}</p> : null}
          <div className="mf">
            <button type="button" className="link" data-need-later={need.id} onClick={need.kind === 'permission' ? onSkip : onLater}>{words.secondary}</button>
            <button type="button" className="btn small" data-need-primary={need.id} disabled={need.kind === 'connector' && need.busy} onClick={finishing ? onDone : onOpen}>{words.primary}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
