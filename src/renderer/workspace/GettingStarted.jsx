import React from 'react';
import { firstOpen, libraryTabs, stepMeta } from '../model/getting-started.js';

// The Welcome walkthrough (2026-10-09): under the title of a new user's "Welcome" workspace, above its document and never
// written into it, "Get started" in the look of design/onboarding-brainstorm/6-workspace.dc.html (the climbs' rows): each
// step a row of its circle, number, title and what is under it (its hint the title's tooltip); a click on the row shows
// or hides what is under it; a thin line runs from each step's circle down to the next, as the design has it.
// 1 (open to begin with) lists the Library's tabs with how many each holds, a click opening the Library on that tab;
// 2 is @brainstorm, typed at the end of the document and run on a click: three questions (what they are working on, where
// they are, their next steps; main's bart/ask.cjs welcome path), whose answer starts @discover by itself; 3 is @discover,
// run on a click too, then the papers its guides found, each opened at its passage. The window ticks a step
// when it is done (screens/Workspace.jsx); a circle clicked ticks or unticks it by hand. Hide takes it away for good.

const GREY = '#8A8F98';
const INK = '#1F2633';
const BLUE = '#0070f3';
const ENTRY = { width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', border: 0, borderRadius: 7, background: 'transparent', font: '13px/1.45 var(--font-sans)', color: INK, textAlign: 'left', cursor: 'pointer' };

const icon = (paths) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B6F76" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}>{paths}</svg>;
const DOC = icon(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></>);
const FOLDER = icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
const AT = icon(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>);
const GLOBE = icon(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" /></>);
const TAB_GLYPH = { notes: DOC, papers: DOC, repos: FOLDER, web: GLOBE, files: FOLDER };
const CHEVRON = (open) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}><path d="M9 6l6 6-6 6" /></svg>;

function Circle({ done, n, onClick }) {
  return (
    <button type="button" role="checkbox" aria-checked={done} aria-label={`Step ${n} done`} data-getting-started-tick={n} title={done ? 'Mark as not done' : 'Mark as done'}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      style={{ flex: 'none', width: 16, height: 16, padding: 0, borderRadius: '50%', border: done ? `1.5px solid ${BLUE}` : '1.5px dashed #b4b8bf', background: done ? BLUE : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {done && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>}
    </button>
  );
}

/** One row under a step: its icon, words, the grey lines under them, and what sits at its right (`aside`). */
function Entry({ glyph, title, sub, note, aside, tip, active, disabled, onClick, ...data }) {
  return (
    <li>
      <button type="button" className={disabled ? undefined : 'hov-wash'} aria-current={active ? 'true' : undefined} disabled={disabled} title={tip} onClick={onClick} {...data} style={{ ...ENTRY, background: active ? '#EFEEEA' : 'transparent', cursor: disabled ? 'default' : 'pointer' }}>
        {glyph}
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{title}</span>
          {sub && <span style={{ font: '12px/1.45 var(--font-sans)', color: GREY }}>{sub}</span>}
          {note && <span style={{ color: '#77746E' }}>{note}</span>}
        </span>
        {aside && <span style={{ flex: 'none', marginTop: 1, font: '12px/1.45 var(--font-sans)', color: GREY }}>{aside}</span>}
      </button>
    </li>
  );
}

/**
 * `state` main's walkthrough; `steps` the ones this workspace shows (model stepsHere). `library` the rows step 1 counts,
 * `papers` step 3's (model discoverPapers). `onTick(n, on)`, `onHide()`, `onOpenLibrary(tab)`, `onWrite()` (the caret
 * to the end of the document), `onBrainstorm()` (@brainstorm written there and run), `onDiscover()` (@discover on its result, else from the
 * workspace), `onOpenPaper(paper)`.
 */
export default function GettingStarted({ state, steps, library = [], papers = [], onTick, onHide, onOpenLibrary, onWrite, onBrainstorm, onDiscover, onOpenPaper }) {
  const ticked = state.ticked || [];
  const first = firstOpen(steps, ticked);
  // The first step is open to begin with ("have that first step dropped down by default"), and so is the first not done;
  // a step done opens the next.
  const [open, setOpen] = React.useState(() => new Set([steps[0] && steps[0].n, first].filter(Boolean)));
  React.useEffect(() => { if (first) setOpen((now) => (now.has(first) ? now : new Set([...now, first]))); }, [first]);
  const { tabs, total } = React.useMemo(() => libraryTabs(library), [library]);
  const [active, setActive] = React.useState(null); // the row last clicked
  const toggle = (n) => setOpen((now) => { const next = new Set(now); if (next.has(n)) next.delete(n); else next.add(n); return next; });
  const choose = (key, run) => { setActive(key); run(); };
  const body = (n) => {
    if (n === 1) {
      if (!tabs.length) return <Entry data-getting-started-row="1:all" glyph={FOLDER} title="Library" aside="Nothing yet" active={active === '1:all'} onClick={() => choose('1:all', () => onOpenLibrary('all'))} />;
      return tabs.map((tab) => <Entry key={tab.id} data-getting-started-row={`1:${tab.id}`} glyph={TAB_GLYPH[tab.id] || DOC} title={tab.label} aside={String(tab.count)} active={active === `1:${tab.id}`} onClick={() => choose(`1:${tab.id}`, () => onOpenLibrary(tab.id))} />);
    }
    if (n === 2) return <Entry data-getting-started-row="2:brainstorm" glyph={AT} title="@brainstorm" note="Click to start. Bart asks three quick questions about your work, then finds papers on your next steps." active={active === '2'} onClick={() => choose('2', onBrainstorm || onWrite)} />;
    return (
      <>
        <Entry data-getting-started-row="3:discover" glyph={AT} title="@discover" note="Starts by itself after Brainstorm, or click to start it now. Bart finds papers and a guide to reading them." active={active === '3'} onClick={() => choose('3', onDiscover || onWrite)} />
        {papers.map((paper) => <Entry key={paper.key} data-getting-started-row={`3:${paper.key}`} glyph={DOC} title={paper.title} sub={paper.byline} note={paper.why} active={active === `3:${paper.key}`} onClick={() => choose(`3:${paper.key}`, () => onOpenPaper(paper))} />)}
      </>
    );
  };

  return (
    <section data-getting-started="1" aria-label="Get started" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '22px 0 18px', paddingBottom: 10, borderBottom: '1px solid #EFEDE8', userSelect: 'text', cursor: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 4px 4px 8px', minHeight: 24 }}>
        <h2 style={{ flex: 1, margin: 0, font: '500 12.5px/1 var(--font-sans)', color: GREY, whiteSpace: 'nowrap' }}>Get started</h2>
        <button type="button" className="hov-ink" data-getting-started-hide="1" onClick={onHide} title="Hide these steps for good" style={{ padding: '2px 4px', border: 0, background: 'none', cursor: 'pointer', font: '12px/1.4 var(--font-sans)', color: GREY }}>Hide</button>
      </div>
      <ol style={{ margin: 0, padding: '0 0 0 4px', listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
        {steps.map((step, i) => {
          const done = ticked.includes(step.n), isOpen = open.has(step.n), last = i === steps.length - 1;
          const meta = stepMeta(step.n, { items: total, papers: papers.length });
          return (
            <li key={step.n} data-getting-started-step={step.n} data-open={isOpen ? '1' : '0'} data-done={done ? '1' : '0'} style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: '0 0 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingLeft: 6 }}>
                <span style={{ flex: 'none', marginTop: 11 }}><Circle done={done} n={step.n} onClick={() => onTick(step.n, !done)} /></span>
                {!last && <span aria-hidden="true" data-getting-started-line="1" style={{ flex: 1, width: 1, minHeight: 12, marginTop: 4, background: '#E4E2DD' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', paddingBottom: isOpen && !last ? 6 : 0 }}>
                <div className="hov-wash" role="button" tabIndex={0} aria-expanded={isOpen} data-getting-started-title={step.n} onClick={() => toggle(step.n)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(step.n); } }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 38, padding: '0 10px', borderRadius: 8, cursor: 'pointer', font: '14px/1.45 var(--font-sans)', color: INK }}>
                  <span style={{ flex: 'none', width: 12, font: '13px/1 var(--font-sans)', color: GREY, fontVariantNumeric: 'tabular-nums' }}>{step.shown}</span>
                  <span title={step.hint} style={{ flex: 1, minWidth: 0 }}>{step.title}</span>
                  {meta && <span data-getting-started-meta={step.n} style={{ flex: 'none', maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '12.5px/1.4 var(--font-sans)', color: GREY }}>{meta}</span>}
                  {CHEVRON(isOpen)}
                </div>
                {isOpen && (
                  <div data-getting-started-body={step.n} style={{ display: 'flex', flexDirection: 'column' }}>
                    <ul style={{ margin: 0, padding: '0 0 0 22px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>{body(step.n)}</ul>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
