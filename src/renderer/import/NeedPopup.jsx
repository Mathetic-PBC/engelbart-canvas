import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import { shownName } from '../../shared/connect-sources.cjs';

// A step an Import your context run hands the person (round 3, 2026-10-13: "the permission prompts … should be popups
// instead of like little pills in the popup"): one at a time, over whatever is showing, drawn as the review mockup's
// "Sign in to Notion · Continue in Arc." Nothing signs in inside Engelbart: Open brings up the app in the browser the
// person chose, and "I'm signed in" has Engelbart copy that sign-in (connect/session.cjs need 'done' checks it first).
// Skip (it said Later until From Amitav, 2026-10-15) leaves that app out of the run. No "Continue in {browser}." under
// any of them (the same notes): the button says where it goes.
// 2026-10-14 (the beta's Zotero report): Zotero's and GitHub's sign-ins, and a connector's, are Engelbart's own and run in
// main (session.cjs ownSignIn, watchStep): their popup never offers a browser it does not open, and closes by itself once
// signed in. A step whose kind the popup had no words for ("confirm") fell through to "Sign in to … · Open Chrome".

/** A step's words → { title, text, primary, secondary, waiting } (secondary: what the quiet link says). */
export function needCopy(need) {
  const app = shownName(need.app);
  const browser = need.browser || 'your browser';
  // GitHub and Zotero sign in through Engelbart's own sign-in, in the person's default browser.
  if (need.app === 'GitHub' || need.app === 'Zotero') {
    if (need.busy) return { title: `Sign in to ${app}`, text: '', primary: 'Opening…', secondary: 'Skip', waiting: true };
    if (need.opened) return { title: `Sign in to ${app}`, text: need.code ? `Enter ${need.code} on GitHub, then come back.` : 'Finish signing in in your browser.', primary: 'Open again', secondary: 'Skip' };
    return { title: `Sign in to ${app}`, text: '', primary: 'Sign in', secondary: 'Skip' };
  }
  // A sign-in brought back (connect/session.cjs recover, 2026-10-16): after the quiet copies, one step, Sign in inside
  // Engelbart (Google's in the person's browser, which it refuses Engelbart's window for) or Skip. Nothing under the title.
  if (need.kind === 'signin-here') {
    if (need.busy) return { title: `Sign in to ${app}`, text: '', primary: 'Waiting…', secondary: 'Skip', waiting: true };
    return { title: `Sign in to ${app}`, text: '', primary: need.where === 'browser' ? `Sign in in ${browser}` : 'Sign in inside Engelbart', secondary: 'Skip' };
  }
  if (need.kind === 'permission') return { title: `Allow Engelbart to read ${app}?`, text: '', primary: 'Allow', secondary: 'Don’t allow' };
  if (need.kind === 'folder') return { title: `Choose your ${app} folder`, text: '', primary: 'Choose folder', secondary: 'Skip' };
  // A connector's sign-in opens in the default browser (connectors.cjs), whichever browser was chosen for the copies.
  if (need.kind === 'connector') return { title: `Connect ${app}`, text: need.busy ? 'Finish connecting in your browser.' : '', primary: need.busy ? 'Waiting…' : 'Connect', secondary: 'Skip', waiting: !!need.busy };
  if (need.kind === 'confirm') return { title: String(need.reason || `Finish this in ${app}`).replace(/\.$/, ''), text: '', primary: 'Done', secondary: 'Skip' };
  if (need.kind === 'code' || need.kind === '2fa') return { title: `Enter the code for ${app}`, text: '', primary: need.opened ? 'Done' : `Open ${browser}`, secondary: 'Skip' };
  if (need.kind === 'captcha') return { title: `Finish the check for ${app}`, text: '', primary: need.opened ? 'Done' : `Open ${browser}`, secondary: 'Skip' };
  return { title: `Sign in to ${app}`, text: '', primary: need.opened ? 'I’m signed in' : `Open ${browser}`, secondary: 'Skip' };
}

/**
 * `need` the step (connect/session.cjs publicNeed); `onOpen()` its primary action before it was opened; `onDone()` once
 * opened ("I'm signed in", Done); `onSkip()` for a permission turned down; `onLater()` (Skip) leaves the app out. Skip is
 * never disabled, whatever the step is waiting on.
 */
export default function NeedPopup({ need, onOpen, onDone, onSkip, onLater }) {
  const words = needCopy(need);
  // "I'm signed in" / Done: only for a step the person finishes themselves. Zotero's, GitHub's and a connector's close by
  // themselves once signed in, so their button opens the sign-in (again).
  const own = need.app === 'GitHub' || need.app === 'Zotero';
  const finishing = need.opened && !own && need.kind !== 'connector' && need.kind !== 'permission' && need.kind !== 'folder' && need.kind !== 'confirm';
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLater(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onLater]);
  // The scrim is the overlay (data-overlay, data-cover): it covers the window, so the Stage's page and the post-it cards,
  // native views drawn above the DOM, step aside for it. The outer element has no height of its own (its scrim is fixed),
  // and marked alone it was never seen as over anything (2026-10-14: Later "did not let her click").
  return (
    <div className="ix ix-overlay" data-cover="1" data-need-popup={need.id} data-need-kind={need.kind}>
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:160}'}{ROUND3_CSS}{ROUND4_CSS}</style>
      <div className="scrim" data-overlay="1" data-cover="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onLater(); }}>
        <section className="modal need-modal" role="dialog" aria-modal="true" aria-label={words.title}>
          <h3>{words.title}</h3>
          {words.text ? <p>{words.text}</p> : null}
          {need.error ? <p className="need-error" role="status">{need.error}</p> : null}
          <div className="mf">
            <button type="button" className="link" data-need-later={need.id} onClick={need.kind === 'permission' ? onSkip : onLater}>{words.secondary}</button>
            <button type="button" className="btn small" data-need-primary={need.id} disabled={!!words.waiting} onClick={finishing ? onDone : onOpen}>{words.primary}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
