import React from 'react';
import { shownName } from '../model/connect.js';
import { LOGOS, Foot, FOOT_BUTTON } from './ConnectLibrary.jsx';
import googleDocs from '../../../design/assets/logos/googledocs.svg';

// The screen before Connect your library (2026-10-11, David's mockup "All your context in one place"; MATH-142): why
// Engelbart asks for the person's tools, and what happens to what comes in, answered before they are asked to pick any,
// so the choose screen after it can open on the consent. Under the questions, the apps it works with.
// Drawn to David's second mockup (2026-10-12), measured off it pixel for pixel: a 612px column, the heading at 32px, the
// lead on one line where it fits, the questions in a card (56px rows), then "Works with" and a row of app tiles ending in
// "+N". The foot (Skip for now, the pager and the one button) is Connect's page's.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
// The column (the mockup's card and foot, edge to edge).
export const INTRO_WIDTH = 612;
const caret = (size) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;
const CARET_RIGHT = caret(12);

// Every app Connect reaches, most used first; the first eight have a tile, the rest are counted on the last ("+12").
// 'Google Docs' shows the Docs logo here (LOGOS has Drive's for it).
const SHOWN = ['Zotero', 'Overleaf', 'Obsidian', 'Google Docs', 'Granola', 'Claude', 'Codex', 'GitHub'];
const APPS = [...SHOWN, 'ChatGPT', 'Google Meet', 'Gemini', 'Notion', 'Gmail', 'Zoom', 'Apple Notes', 'OneNote', 'Evernote', 'Perplexity', 'Grok', 'Cursor'].filter((app) => LOGOS[app]);
const logoOf = (app) => (app === 'Google Docs' ? googleDocs : LOGOS[app]);

/** The tiles under "Works with": the first apps, and how many more there are. */
export function worksWith() {
  const shown = SHOWN.filter((app) => APPS.includes(app));
  return { shown, more: APPS.length - shown.length };
}

/** The questions under the lead, each a line that opens to its answer (the first open to begin with). */
export function introQuestions() {
  return [
    { id: 'where', q: 'Where does my data go?', a: 'It’s saved only on this Mac. When Engelbart reads it, it goes through your own Claude or ChatGPT account, so Anthropic or OpenAI sees what it reads, like any other conversation with them.' },
    { id: 'mathetic', q: 'Does Mathetic see any of it?', a: 'No. Nothing you bring in is sent to Mathetic. It stays on this Mac, and the agents read it through your own account, not ours.' },
    { id: 'later', q: 'Can I take things out later?', a: 'Yes. Remove anything from a workspace from its menu in the sidebar. Everything Engelbart keeps is in the ~/.engelbart folder on this Mac, and deleting that folder removes all of it.' },
  ];
}

export function introLead(guided) {
  return `Bring in your work once, so you never have to re-explain your ${guided ? 'research' : 'project'} again.`;
}

const CSS = '.cx-faq{display:flex;align-items:center;gap:12px;width:100%;height:56px;padding:0;border:0;background:none;cursor:pointer;text-align:left;font:500 15.25px/1.4 var(--font-sans);color:#171717}'
  + '.cx-faq:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18);border-radius:6px}';

function Question({ item, open, first, onToggle }) {
  return (
    <div data-connect-intro-q={item.id} style={{ borderTop: first ? 0 : '1px solid #eeeeee' }}>
      <button type="button" className="cx-faq" aria-expanded={open ? 'true' : 'false'} onClick={onToggle}>
        <span style={{ flex: 1, minWidth: 0 }}>{item.q}</span>
        <span style={{ flex: 'none', display: 'inline-flex', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: `transform 140ms ${EASE}` }}>{caret(14)}</span>
      </button>
      {open && <p data-connect-intro-a={item.id} style={{ margin: '-1px 0 0', padding: '0 0 22.5px', font: '14.25px/23.5px var(--font-sans)', color: '#4d4d4d', animation: `rise 160ms ${EASE}` }}>{item.a}</p>}
    </div>
  );
}

const TILE = { flex: 'none', boxSizing: 'border-box', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eeeeee', borderRadius: 10, background: '#fff' };

/** "Works with" and the apps' tiles, the last counting the rest; pressed, it shows them all, ten to a row. */
function WorksWith() {
  const [all, setAll] = React.useState(false);
  const { shown, more } = worksWith();
  const tile = (app) => (
    <span key={app} title={shownName(app)} style={TILE}>
      <span role="img" aria-label={shownName(app)} style={{ width: 22, height: 22, background: `url(${logoOf(app)}) center / contain no-repeat` }} />
    </span>
  );
  return (
    <div data-connect-intro-apps="1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <span style={{ font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>Works with</span>
      <div data-connect-intro-tiles={all ? 'all' : 'some'} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8.6, maxWidth: 10 * 44 + 9 * 8.6 }}>
        {(all ? APPS : shown).map(tile)}
        {!all && more > 0 && <button type="button" className="hov-bd2" data-connect-intro-more="1" aria-label={`Show ${more} more`} onClick={() => setAll(true)} style={{ ...TILE, padding: 0, cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>+{more}</button>}
      </div>
    </div>
  );
}

/** `pager`: onboarding's dots and "2 of 3". `guided`: the guided setup, with no project of theirs. */
export default function ConnectIntro({ pager = null, guided = false, onContinue, onSkip }) {
  const [open, setOpen] = React.useState('where');
  return (
    <div data-connect-intro="1" style={{ flex: 1, minHeight: 0, width: `min(${INTRO_WIDTH}px, 100%)`, alignSelf: 'center', display: 'flex', flexDirection: 'column', animation: `rise 160ms ${EASE}` }}>
      <style>{CSS}</style>
      {/* The block in the middle of the window's height: its auto margins center it while it fits and leave it at the top,
          scrolling, when it does not. The foot stays at the bottom. */}
      <div data-connect-intro-scroll="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '24px 0 64px' }}>
        <div data-connect-intro-block="1" style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 15, textAlign: 'center' }}>
            <h1 style={{ margin: 0, font: '500 32px/38px var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' }}>All your context in one place</h1>
            <p data-connect-intro-lead="1" style={{ margin: 0, font: '16px/24px var(--font-sans)', letterSpacing: '-0.1px', color: '#6b6f76', textWrap: 'balance' }}>{introLead(guided)}</p>
          </div>
          <div data-connect-intro-card="1" style={{ marginTop: 52, padding: '4px 25px 4px 26px', border: '1px solid #eaeaea', borderRadius: 12, background: '#fff' }}>
            {introQuestions().map((item, index) => <Question key={item.id} item={item} first={index === 0} open={open === item.id} onToggle={() => setOpen((now) => (now === item.id ? '' : item.id))} />)}
          </div>
          <div style={{ marginTop: 51 }}><WorksWith /></div>
        </div>
      </div>
      <Foot pager={pager}
        left={<button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={{ padding: '10px 12px', marginLeft: -12, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Skip for now</button>}
        button={<span data-onboarding-continue="1"><button type="button" onClick={onContinue} style={FOOT_BUTTON}>Continue<span style={{ display: 'inline-flex' }}>{CARET_RIGHT}</span></button></span>} />
    </div>
  );
}
