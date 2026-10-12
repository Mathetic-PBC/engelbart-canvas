import React from 'react';
import { shownName } from '../model/connect.js';
import { LOGOS, CHOOSE_WIDTH, Foot, FOOT_BUTTON } from './ConnectLibrary.jsx';

// The screen before Connect your library (2026-10-11, David's mockup "All your context in one place"; MATH-142): why
// Engelbart asks for the person's tools, and what happens to what comes in, answered before they are asked to pick any,
// so the choose screen after it can open on the consent. Under the questions, the apps it connects to, going by on a belt.
// Drawn as Connect's page is (screens/Onboarding.jsx): the same column, the same foot with Skip for now, the pager and the
// one button.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const CARET_RIGHT = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;

// The belt's order: what most people use first. 'Google Docs' is Drive (its logo, and shownName's).
const BELT = ['Google Docs', 'ChatGPT', 'Claude', 'Granola', 'Overleaf', 'GitHub', 'Google Meet', 'Zotero', 'Codex', 'Gemini', 'Notion', 'Obsidian', 'Gmail', 'Zoom', 'Apple Notes', 'OneNote', 'Evernote', 'Perplexity', 'Grok', 'Cursor'].filter((app) => LOGOS[app]);

/** The questions under the lead, each a line that opens to its answer (the first open to begin with). */
export function introQuestions() {
  return [
    { id: 'where', q: 'Where does my data go?', a: 'It’s saved only on this Mac. When Engelbart reads it, it goes through your own Claude or ChatGPT account, so Anthropic or OpenAI sees what it reads, like any other conversation with them.' },
    { id: 'mathetic', q: 'Does Mathetic see any of it?', a: 'No. Nothing you bring in is sent to Mathetic. It stays on this Mac, and the agents read it through your own account, not ours.' },
    { id: 'later', q: 'Can I take things out later?', a: 'Yes. Remove anything from a workspace from its menu in the sidebar. Everything Engelbart keeps is in the ~/.engelbart folder on this Mac, and deleting that folder removes all of it.' },
  ];
}

export function introLead(guided) {
  return `Next, connect the tools you use. Engelbart brings what’s related to your ${guided ? 'research' : 'project'} into one place, so it can connect the dots across all of it.`;
}

const CSS = '@keyframes connect-belt{from{transform:translateX(0)}to{transform:translateX(-50%)}}'
  + '.cx-belt{display:flex;gap:10px;width:max-content;animation:connect-belt 48s linear infinite}.cx-belt-track:hover .cx-belt{animation-play-state:paused}'
  + '@media (prefers-reduced-motion: reduce){.cx-belt{animation:none}}'
  + '.cx-faq{display:flex;align-items:center;gap:12px;width:100%;padding:12px 2px;border:0;background:none;cursor:pointer;text-align:left;font:500 13.5px/1.4 var(--font-sans);color:#171717}'
  + '.cx-faq:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18);border-radius:6px}';

function Question({ item, open, onToggle }) {
  return (
    <div data-connect-intro-q={item.id} style={{ borderTop: '1px solid #eaeaea' }}>
      <button type="button" className="cx-faq" aria-expanded={open ? 'true' : 'false'} onClick={onToggle}>
        <span style={{ flex: 1, minWidth: 0 }}>{item.q}</span>
        <span style={{ flex: 'none', display: 'inline-flex', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: `transform 140ms ${EASE}` }}>{CARET_RIGHT}</span>
      </button>
      {open && <p data-connect-intro-a={item.id} style={{ margin: 0, padding: '0 2px 14px', font: '13.5px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty', animation: `rise 160ms ${EASE}` }}>{item.a}</p>}
    </div>
  );
}

/** The apps Connect reaches, on a belt that keeps moving (held still with reduced motion, paused under the pointer); the list twice, so it loops. */
function Belt() {
  const tile = (app, n) => (
    <span key={`${app}-${n}`} title={n ? undefined : shownName(app)} aria-hidden={n ? 'true' : undefined} style={{ flex: 'none', width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eaeaea', borderRadius: 9, background: '#fff' }}>
      <span role="img" aria-label={n ? undefined : shownName(app)} style={{ width: 18, height: 18, background: `url(${LOGOS[app]}) center / contain no-repeat` }} />
    </span>
  );
  return (
    <div data-connect-intro-belt="1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <span style={{ font: '500 10.5px/1 var(--font-sans)', letterSpacing: '1.4px', textTransform: 'uppercase', color: '#8f8f8f' }}>Connects to</span>
      <div className="cx-belt-track" style={{ width: '100%', overflow: 'hidden', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)', maskImage: 'linear-gradient(to right, transparent, #000 14%, #000 86%, transparent)' }}>
        <div className="cx-belt" style={{ padding: '1px 0' }}>
          {BELT.map((app) => tile(app, 0))}
          {BELT.map((app) => tile(app, 1))}
        </div>
      </div>
    </div>
  );
}

/** `pager`: onboarding's dots and "2 of 3". `guided`: the guided setup, with no project of theirs. */
export default function ConnectIntro({ pager = null, guided = false, onContinue, onSkip }) {
  const [open, setOpen] = React.useState('where');
  return (
    <div data-connect-intro="1" style={{ flex: 1, minHeight: 0, width: `min(${CHOOSE_WIDTH}px, 100%)`, alignSelf: 'center', display: 'flex', flexDirection: 'column', animation: `rise 160ms ${EASE}` }}>
      <style>{CSS}</style>
      {/* The block in the middle of the window's height (2026-10-12; it sat at the top): its auto margins center it while
          it fits and leave it at the top, scrolling, when it does not. More room between the lead, the questions and the
          belt. The foot stays where it is. */}
      <div data-connect-intro-scroll="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '24px 8px' }}>
        <div data-connect-intro-block="1" style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 44 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
            <h1 style={{ margin: 0, font: '500 28px/1.2 var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' }}>All your context in one place</h1>
            <p data-connect-intro-lead="1" style={{ margin: 0, maxWidth: 440, font: '14.5px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{introLead(guided)}</p>
          </div>
          <div style={{ width: '100%', maxWidth: 420, alignSelf: 'center', borderBottom: '1px solid #eaeaea' }}>
            {introQuestions().map((item) => <Question key={item.id} item={item} open={open === item.id} onToggle={() => setOpen((now) => (now === item.id ? '' : item.id))} />)}
          </div>
          <div style={{ width: '100%', maxWidth: 420, alignSelf: 'center' }}><Belt /></div>
        </div>
      </div>
      <Foot pager={pager}
        left={<button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={{ padding: '10px 12px', marginLeft: -12, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Skip for now</button>}
        button={<span data-onboarding-continue="1"><button type="button" onClick={onContinue} style={FOOT_BUTTON}>Continue<span style={{ display: 'inline-flex' }}>{CARET_RIGHT}</span></button></span>} />
    </div>
  );
}
