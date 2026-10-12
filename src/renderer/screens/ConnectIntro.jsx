import React from 'react';
import { shownName } from '../model/connect.js';
import { LOGOS, Foot, FOOT_BUTTON } from './ConnectLibrary.jsx';
import googleDocs from '../../../design/assets/logos/googledocs.svg';

// The screen before Connect your library (2026-10-11, David's mockup "All your context in one place"; MATH-142): why
// Engelbart asks for the person's tools, and what happens to what comes in, answered before they are asked to pick any,
// so the choose screen after it can open on the consent. Under the questions, the apps it works with.
// Drawn to David's design (2026-10-12, why-we-ask K6), its CSS taken as is: a 640px column, the heading at 34px, the
// questions in a card (16px, 20px above and below each), then "Works with" and a row of app tiles ending in "+N", 52px
// apart and together in the middle of the height above the foot. The foot (Skip for now, the pager and the one button) is
// Connect's page's, its button as the design draws it.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
// The column (the mockup's card and foot, edge to edge).
export const INTRO_WIDTH = 640;
const CARET = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
// The design's button: 11px above and below 13px type (37px tall), its caret the › character.
const BUTTON = { ...FOOT_BUTTON, height: 'auto', padding: '11px 16px', font: '500 13px/1 var(--font-sans)' };

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
    { id: 'others', q: 'Does anyone else see it?', a: 'Not us. We never receive anything you bring in. Only Anthropic or OpenAI see what Engelbart reads, through your own account.' },
    { id: 'later', q: 'Can I take things out later?', a: 'Yes. You can remove anything from a project or your library at any time.' },
  ];
}

// "re‑explain" with a non-breaking hyphen (U+2011), as the design has it, so the line never breaks inside it.
export function introLead(guided) {
  return `Bring in your work once, so you never have to re\u2011explain your ${guided ? 'research' : 'project'} again.`;
}

const CSS = '.cx-faq{display:flex;align-items:center;gap:10px;width:100%;padding:20px 0;border:0;background:none;cursor:pointer;text-align:left;font:500 16px/normal var(--font-sans);color:#171717}'
  + '.cx-faq:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18);border-radius:6px}';

function Question({ item, open, last, onToggle }) {
  return (
    <div data-connect-intro-q={item.id} style={{ borderBottom: last ? 0 : '1px solid #eeeeee' }}>
      <button type="button" className="cx-faq" aria-expanded={open ? 'true' : 'false'} onClick={onToggle}>
        <span style={{ flex: 1, minWidth: 0 }}>{item.q}</span>
        <span style={{ flex: 'none', display: 'inline-flex', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform 150ms ease' }}>{CARET}</span>
      </button>
      {open && <p data-connect-intro-a={item.id} style={{ margin: 0, padding: '0 0 22px', font: '15px/1.65 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty', animation: `rise 160ms ${EASE}` }}>{item.a}</p>}
    </div>
  );
}

const TILE = { flex: 'none', boxSizing: 'border-box', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eeeeee', borderRadius: 11, background: '#fff' };

/** "Works with" and the apps' tiles, the last counting the rest; pressed, it shows them all, ten to a row. */
function WorksWith() {
  const [all, setAll] = React.useState(false);
  const { shown, more } = worksWith();
  const tile = (app) => (
    <span key={app} title={shownName(app)} style={TILE}>
      <span role="img" aria-label={shownName(app)} style={{ width: 23, height: 23, background: `url(${logoOf(app)}) center / contain no-repeat` }} />
    </span>
  );
  return (
    <div data-connect-intro-apps="1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <span style={{ font: '13px/normal var(--font-sans)', color: '#8f8f8f' }}>Works with</span>
      <div data-connect-intro-tiles={all ? 'all' : 'some'} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 9, maxWidth: 10 * 44 + 9 * 9 }}>
        {(all ? APPS : shown).map(tile)}
        {!all && more > 0 && <button type="button" className="hov-bd2" data-connect-intro-more="1" aria-label={`Show ${more} more`} onClick={() => setAll(true)} style={{ ...TILE, padding: 0, cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>+{more}</button>}
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
      <div data-connect-intro-scroll="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '0 0 40px' }}>
        <div data-connect-intro-block="1" style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 52 }}>
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ margin: 0, font: '500 34px/1.2 var(--font-sans)', letterSpacing: '-0.65px', color: '#171717', textWrap: 'balance' }}>All your context in one place</h1>
            <p data-connect-intro-lead="1" style={{ margin: '16px auto 0', font: '16.5px/1.6 var(--font-sans)', color: '#6b6f76', textWrap: 'pretty' }}>{introLead(guided)}</p>
          </div>
          <div data-connect-intro-card="1" style={{ padding: '4px 26px', border: '1px solid #eaeaea', borderRadius: 14, background: '#fff' }}>
            {introQuestions().map((item, index, all) => <Question key={item.id} item={item} last={index === all.length - 1} open={open === item.id} onToggle={() => setOpen((now) => (now === item.id ? '' : item.id))} />)}
          </div>
          <WorksWith />
        </div>
      </div>
      <Foot pager={pager}
        left={<button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={{ padding: '10px 12px', marginLeft: -12, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Skip for now</button>}
        button={<span data-onboarding-continue="1"><button type="button" onClick={onContinue} style={BUTTON}>Continue<span style={{ fontSize: 14 }}>›</span></button></span>} />
    </div>
  );
}
