import React from 'react';
import { api, errorMessage } from '../api.js';
import Button from '../ui/Button.jsx';
import Pager from '../ui/Pager.jsx';
import ThinkingDots from '../ui/ThinkingDots.jsx';
import { QUESTIONS, REFLECTED, forward, wrapUp, pagerOf, cardButtons, partsOf, sentenceOf, planFallback, toolsWanted, TOOL_WHY } from '../model/onboarding.js';
import { launchRows, installable, rowOf } from '../model/tools.js';
import welcomePng from '../../../design/assets/welcome-cards.png';

// Onboarding as brainstorm cards (2026-10-07, build 1 of 2): design/onboarding-brainstorm, BSC-1 to BSC-5, its inline
// styles' values replicated here. mode 'new' (first launch: welcome → tools, only when one is missing → the four cards →
// the project) or 'existing' (+ Project: the four cards → the project). The cards ask one question at a time: What are
// you working on? Why this, and why now? What are you least sure about? Putting it together. Skip moves on, Wrap up jumps
// to Putting it together, Submit moves on.
//
// Bart (src/main/bart/onboard.cjs) has one session for the whole onboarding, started as it opens: after a card it says
// the answer back in one line, streamed above the next card ("You're working on …", "So that …"), and searches for papers
// in main. On Putting it together their own words make the sentence, editable in place, Stuck? offers one way to fill
// the blank, and one call names the project, words its question and writes three sub-questions while they are on it.
// Opening the project (api.startProject): Bart's name, the sentence as its description, the default folder, the first
// workspace named with the question and the sub-questions under "Suggested places to start" (workspace/StartsBlock.jsx).
// The tools screen installs Git, Claude Code and Codex in the background (App.jsx holds the setup dialog back until
// onboarding is over).

// The design's colours (its :root): greys, and one muted olive for what is theirs and what moves them on.
const C = { g200: '#eaeaea', g300: '#c9c9c9', g500: '#8f8f8f', g700: '#4d4d4d', ink: '#171717', guess: '#a3a3a3', olive: '#6b7a3a', oliveInk: '#55622c', oliveWash: '#f1f3e8', oliveLine: '#b9c296' };
const rise = 'rise 260ms cubic-bezier(.25,.1,.25,1)';
const plain = { padding: 0, border: 0, background: 'none', cursor: 'pointer' };

// What inline styles cannot say: hover, focus, placeholders.
const CSS = `
.ob-field{display:block;width:100%;margin:0;padding:8px 10px;border:1px solid #d0d0d0;border-radius:8px;background:#fff;resize:none;outline:none;font:15px/1.5 var(--font-sans);color:${C.ink};transition:border-color 120ms}
.ob-field:focus{border-color:#a3a3a3}
.ob-field::placeholder{color:${C.g500};font-style:italic}
.ob-text-btn{padding:4px 2px;border:0;background:transparent;color:${C.g500};font:500 12px/1.5 var(--font-sans);cursor:pointer}
.ob-text-btn:hover{color:${C.ink}}
.ob-submit{padding:8px 14px;border:0;border-radius:8px;background:${C.olive};color:#fff;font:500 13px/1 var(--font-sans);cursor:pointer}
.ob-submit:hover{background:${C.oliveInk}}
.ob-submit:disabled{background:${C.g200};color:${C.g500};cursor:default}
.ob-dark{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px 0 16px;border:0;border-radius:8px;background:#161616;color:#fff;font:600 13.5px/1 var(--font-sans);cursor:pointer}
.ob-theirs{display:inline;color:${C.ink};cursor:text;outline:none;text-decoration:underline;text-decoration-color:${C.oliveLine};text-decoration-thickness:1.5px;text-underline-offset:5px;white-space:pre-wrap;word-break:break-word}
.ob-theirs:hover{text-decoration-color:${C.olive}}
.ob-theirs:focus{background:${C.oliveWash}}
.ob-theirs:empty{display:inline-block;min-width:4em;color:${C.guess};font-style:italic;text-decoration-style:dashed}
.ob-theirs:empty::before{content:attr(data-placeholder)}
.ob-blank{display:inline;padding:0 2px;color:${C.ink};border-bottom:2px solid ${C.olive};outline:none;cursor:text;white-space:pre-wrap;word-break:break-word}
.ob-blank:empty{display:inline-block;min-width:9em}
.ob-blank:empty::before{content:attr(data-placeholder);color:${C.oliveLine};font-style:italic}
.ob-blank:focus{background:${C.oliveWash}}
.ob-stuck{margin-top:10px;padding:0;border:0;background:transparent;color:${C.g500};font:13px/1.5 var(--font-sans);cursor:pointer;text-decoration:underline;text-decoration-color:${C.g300};text-underline-offset:3px}
.ob-stuck:hover{color:${C.ink}}
.ob-stuck:disabled{cursor:default;text-decoration:none}
@keyframes ob-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
`;

const CHEVRON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;

/** The design's counter: 4px dots (the current one 16px wide, ink) and "n of m". */
function Counter({ pager }) {
  if (!pager) return null;
  return (
    <div data-onboarding-step-of="1" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 14, font: '12px/1 var(--font-sans)', color: C.g500 }}>
      <Pager count={pager.count} index={pager.index} dot={4} wide={16} on={C.ink} off="#d4d4d4" />
      <span>{`${pager.index + 1} of ${pager.count}`}</span>
    </div>
  );
}

/** The design's card: white, a grey edge, its question in bold, 560 wide at most. */
function Card({ title, children, data }) {
  return (
    <div data-onboarding-card={data} style={{ width: '100%', maxWidth: 560, boxSizing: 'border-box', padding: '14px 16px 16px', border: `1px solid ${C.g200}`, borderRadius: 10, background: '#fff', animation: rise }}>
      <div style={{ font: '600 16px/1.45 var(--font-sans)', color: C.ink }}>{title}</div>
      {children}
    </div>
  );
}

/** Skip at the left; Wrap up and Submit at the right. */
function Acts({ showWrap, submitDisabled, onSkip, onWrap, onSubmit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
      <button type="button" className="ob-text-btn" data-onboarding-skip="1" onClick={onSkip} style={{ paddingLeft: 0 }}>Skip</button>
      <span style={{ flex: 1 }} />
      {showWrap && <button type="button" className="ob-text-btn" data-onboarding-wrap="1" onClick={onWrap}>Wrap up</button>}
      <button type="button" className="ob-submit" data-onboarding-submit="1" disabled={submitDisabled} onClick={onSubmit}>Submit</button>
    </div>
  );
}

/**
 * A part of the sentence, edited in place: plain text, one line (Enter leaves it). Its text is set from `value` only
 * while it is not being typed in, so the caret never jumps.
 */
function Inline({ value, onChange, className, placeholder, label, data }) {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element && document.activeElement !== element && element.textContent !== value) element.textContent = value;
  }, [value]);
  return (
    <span
      ref={ref}
      className={className}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      data-placeholder={placeholder}
      data-onboarding-part={data}
      spellCheck={false}
      onInput={(event) => onChange(event.currentTarget.textContent.replace(/\n/g, ' '))}
      onBlur={(event) => { const text = event.currentTarget.textContent.replace(/\s+/g, ' ').trim(); if (text !== event.currentTarget.textContent) event.currentTarget.textContent = text; onChange(text); }}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
      onPaste={(event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/\s+/g, ' ')); }}
    />
  );
}

/** `tools`: the tool check's snapshot (App.jsx). `onTools('install' | 'skip')`: what the tools screen was answered with. */
export default function Onboarding({ mode = 'new', tools = null, onTools = () => {}, onDone, onBack }) {
  const flowMode = mode === 'existing' ? 'existing' : 'new';
  const [step, setStep] = React.useState(flowMode === 'existing' ? 'working' : 'welcome');
  const [drafts, setDrafts] = React.useState({ working: '', why: '', unsure: '' });
  const [answers, setAnswers] = React.useState({ working: '', why: '', unsure: '' });
  const [lines, setLines] = React.useState({}); // Bart's line after a card: { working, why }
  const [parts, setParts] = React.useState(null); // Putting it together's { working, findOut, why }, made as it opens
  const [stuck, setStuck] = React.useState(false);
  const [error, setError] = React.useState('');
  const [id, setId] = React.useState(null); // Bart's onboarding session (src/main/bart/onboard.cjs)
  const idRef = React.useRef(null);
  const made = React.useRef(false);
  const plan = React.useRef({ sentence: null, promise: null });

  // The session starts as onboarding opens, so the first card never waits on a cold start; it ends when the project is
  // made (start-project) or onboarding is left.
  React.useEffect(() => {
    let live = true;
    api.onboardingOpen().then((opened) => { if (!live) { api.onboardingClose(opened.id).catch(() => {}); return; } idRef.current = opened.id; setId(opened.id); }).catch(() => {});
    const off = api.onOnboardingLine((said) => { if (said && said.id === idRef.current && said.line) setLines((now) => ({ ...now, [said.card]: said.line })); });
    return () => { live = false; off(); if (idRef.current && !made.current) api.onboardingClose(idRef.current).catch(() => {}); };
  }, []);
  // As the first card comes into view: started again if it could not start before (the tools screen installed its CLI).
  React.useEffect(() => { if (id && step === 'working') api.onboardingWarm(id).catch(() => {}); }, [id, step]);

  // Whether the tools screen is in the flow: decided by the first check that answers, then kept, so the pager does not
  // change under the person while the installs it started run. While it is undecided the screen is there, checking.
  const [withTools, setWithTools] = React.useState(() => toolsWanted(tools));
  React.useEffect(() => { if (withTools === null) { const wanted = toolsWanted(tools); if (wanted !== null) setWithTools(wanted); } }, [tools, withTools]);
  const flowOptions = { tools: withTools !== false };

  const go = (next) => { setStep(next); setError(''); };
  const advance = () => go(forward(flowMode, step, flowOptions));

  // The check answered with nothing to install while the tools screen was showing: on to the next one.
  React.useEffect(() => { if (step === 'tools' && withTools === false) advance(); }, [step, withTools]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on the welcome screen continues, as the design has it.
  React.useEffect(() => {
    if (step !== 'welcome') return undefined;
    const onKey = (event) => { if (event.key === 'Enter' && !/^(INPUT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) advance(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Putting it together opens on their own words, once.
  React.useEffect(() => { if (step === 'together' && !parts) setParts(partsOf(answers)); }, [step, parts, answers]);

  const fullAnswers = (findOut = parts ? parts.findOut : '') => ({ ...answers, findOut });
  const sentence = parts ? sentenceOf(parts) : '';

  // The project's name, question and sub-questions: asked as Putting it together opens and again once an edit to the
  // sentence has rested, so the latest is ready (or nearly) when they submit. The answer to the sentence as it is is kept.
  const askPlan = React.useCallback((text, findOut) => {
    if (plan.current.sentence === text && plan.current.promise) return plan.current.promise;
    const promise = idRef.current ? api.onboardingPlan(idRef.current, { answers: { ...answers, findOut }, sentence: text }).catch(() => null) : Promise.resolve(null);
    plan.current = { sentence: text, promise };
    return promise;
  }, [answers]);
  const askedOnce = React.useRef(false);
  React.useEffect(() => {
    if (step !== 'together' || !parts || !id) return undefined;
    const timer = setTimeout(() => askPlan(sentence, parts.findOut), askedOnce.current ? 1200 : 0);
    askedOnce.current = true;
    return () => clearTimeout(timer);
  }, [step, id, sentence]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A question card left: by Submit (`keep`, its words are the answer) or by Skip (none). Bart is told either way. */
  const leaveCard = (card, keep) => {
    const text = keep ? drafts[card].trim() : '';
    const next = { ...answers, [card]: text };
    setAnswers(next);
    setLines((now) => { const { [card]: _gone, ...rest } = now; return rest; }); // eslint-disable-line no-unused-vars
    if (text && id) {
      api.onboardingAnswer(id, { card, answers: next }).then((out) => { if (out && out.line) setLines((now) => ({ ...now, [card]: out.line })); }).catch(() => {});
    }
  };
  const submit = (card) => { if (!drafts[card].trim()) return; leaveCard(card, true); go(forward(flowMode, card, flowOptions)); };
  const skip = (card) => { leaveCard(card, false); go(forward(flowMode, card, flowOptions)); };
  // Wrap up keeps what is typed in the field, as Submit would, and goes straight to Putting it together.
  const wrap = (card) => { leaveCard(card, !!drafts[card].trim()); go(wrapUp(flowMode, card, flowOptions)); };

  const askStuck = async () => {
    if (stuck || !id) return;
    setStuck(true);
    try {
      const out = await api.onboardingStuck(id, { answers: fullAnswers() });
      if (out && out.text) setParts((now) => ({ ...now, findOut: out.text }));
    } catch { /* Stuck? stays as it was */ } finally { setStuck(false); }
  };

  // Open the project: Bart's plan for the sentence as it stands (waited for when it is still being written), else their
  // own words. The folder is the default one, made for it.
  const open = async () => {
    const now = parts || partsOf(answers);
    const text = sentenceOf(now);
    go('open');
    try {
      const planned = (await askPlan(text, now.findOut)) || planFallback(answers, now.findOut);
      const result = await api.startProject({ name: planned.name, description: text, question: planned.question, starts: planned.starts, brief: fullAnswers(now.findOut), folder: 'new', onboardingId: idRef.current });
      made.current = true;
      await onDone(result);
    } catch (failure) {
      setStep('together');
      setError(errorMessage(failure));
    }
  };

  const pager = pagerOf(flowMode, step, flowOptions);
  const errorLine = error ? <span data-onboarding-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', textAlign: 'center', overflowWrap: 'anywhere' }}>{error}</span> : null;

  let body = null;
  if (step === 'welcome') {
    body = (
      <div data-screen-label="01 Welcome" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxWidth: 420, textAlign: 'center', animation: rise }}>
        <h1 style={{ margin: 0, font: '700 24px/1.25 var(--font-sans)', letterSpacing: '-0.01em', color: '#161616' }}>Welcome to Engelbart</h1>
        <p style={{ margin: 0, maxWidth: 360, font: '14.5px/1.55 var(--font-sans)', color: C.g700 }}>A research notebook that remembers where all of your thoughts came from.</p>
        <img src={welcomePng} alt="" style={{ display: 'block', width: 360, maxWidth: '100%', height: 'auto', margin: '22px 0 18px' }} />
        <button type="button" className="ob-dark" data-onboarding-continue="1" onClick={advance}>Continue{CHEVRON}</button>
      </div>
    );
  } else if (step === 'tools') {
    // What the launch check would have asked about in the setup dialog, on a screen of the flow instead, before the cards:
    // they need a working model. Install all starts the installs and moves on at once: they run in the background, and
    // the setup dialog asks only what is left (signing in) once onboarding is over. Skip for now asks nothing more until
    // the next launch.
    const ids = withTools ? launchRows(tools) : [];
    const toInstall = withTools ? installable(tools, ids) : [];
    const install = () => {
      if (toInstall.length) api.toolsInstall(toInstall).catch(() => {});
      onTools('install');
      advance();
    };
    const skipTools = () => { onTools('skip'); advance(); };
    body = (
      <div data-screen-label="02 Tools" style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 24, animation: rise }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <h1 style={{ margin: 0, font: '700 24px/1.25 var(--font-sans)', letterSpacing: '-0.01em', color: '#161616' }}>Set up your tools</h1>
          <p style={{ margin: 0, maxWidth: 440, font: '14.5px/1.55 var(--font-sans)', color: C.g700, textWrap: 'pretty' }}>Engelbart works through Git and an agent: Claude Code or Codex. They install in the background while you carry on.</p>
        </div>
        {withTools === null && <div style={{ minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ThinkingDots label="checking this Mac" /></div>}
        {withTools && (
          <div data-onboarding-tools="1" style={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid #f2f2f2' }}>
            {ids.map((tool) => {
              const row = rowOf(tools.tools[tool]);
              const apple = tool === 'git' && tools.platform === 'darwin' && row.action === 'install';
              return (
                <div key={tool} data-tool-row={tool} style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 2px', borderTop: '1px solid #f2f2f2' }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ font: '500 14px/1.4 var(--font-sans)', color: C.ink }}>{row.name}</span>
                    <span style={{ font: '12.5px/1.5 var(--font-sans)', color: C.g500, textWrap: 'pretty' }}>{TOOL_WHY[tool]}{apple ? ' Installing it opens Apple’s installer for the command line tools.' : ''}</span>
                  </span>
                  <span data-tool-state style={{ flex: 'none', paddingTop: 2, font: '12px/1.4 var(--font-mono)', color: row.tone === 'ok' ? C.ink : C.g500 }}>{row.state}</span>
                </div>
              );
            })}
          </div>
        )}
        {errorLine}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <button type="button" className="ob-text-btn" data-onboarding-skip="1" onClick={skipTools} style={{ fontSize: 13 }}>Skip for now</button>
          <span data-onboarding-continue="1"><Button variant="filled" go disabled={withTools === null} onClick={install}>{toInstall.length ? 'Install all' : 'Continue'}</Button></span>
        </div>
      </div>
    );
  } else if (QUESTIONS[step]) {
    const card = step, q = QUESTIONS[card], reflected = REFLECTED[card];
    const said = reflected ? lines[reflected.from] : '';
    const buttons = cardButtons(card, drafts[card]);
    body = (
      <React.Fragment key={card}>
        {said && (
          <div data-onboarding-reflection={reflected.from} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, maxWidth: 560, textAlign: 'center', animation: 'ob-fade 220ms ease-out' }}>
            <div style={{ font: '12px/1.5 var(--font-sans)', color: '#A3A3A3' }}>{reflected.label}</div>
            <div style={{ font: '15px/1.45 var(--font-sans)', color: '#5F5F5F' }}>{said}</div>
          </div>
        )}
        <Card title={q.title} data={card}>
          <div style={{ marginTop: 12 }}>
            <textarea
              className="ob-field"
              rows={2}
              autoFocus
              value={drafts[card]}
              placeholder={q.placeholder}
              aria-label={q.label}
              data-onboarding-field={card}
              onChange={(event) => { const value = event.target.value; setDrafts((now) => ({ ...now, [card]: value })); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(card); } }}
            />
          </div>
          <Acts showWrap={buttons.showWrap} submitDisabled={buttons.submitDisabled} onSkip={() => skip(card)} onWrap={() => wrap(card)} onSubmit={() => submit(card)} />
        </Card>
      </React.Fragment>
    );
  } else if (step === 'together' && parts) {
    const buttons = cardButtons('together', parts.findOut);
    const set = (key) => (value) => setParts((now) => ({ ...now, [key]: value }));
    body = (
      <>
        <Card title="Putting it together" data="together">
          <div data-onboarding-sentence="1" style={{ marginTop: 12, font: '19px/1.75 var(--font-sans)', color: C.g500 }}>
            I’m working on <Inline className="ob-theirs" value={parts.working} onChange={set('working')} placeholder="what you’re working on" label="What you are working on" data="working" />
            {' '}because I want to find out <Inline className="ob-blank" value={parts.findOut} onChange={set('findOut')} placeholder="what you want to find out" label="What you want to find out" data="findOut" />
            {' '}so that <Inline className="ob-theirs" value={parts.why} onChange={set('why')} placeholder="why it matters" label="Why this matters" data="why" />.
          </div>
          <button type="button" className="ob-stuck" data-onboarding-stuck="1" disabled={stuck || !id} onClick={askStuck}>{stuck ? 'Thinking…' : 'Stuck?'}</button>
          <Acts showWrap={buttons.showWrap} submitDisabled={buttons.submitDisabled} onSkip={open} onSubmit={open} />
        </Card>
        {errorLine}
      </>
    );
  } else if (step === 'open') {
    body = <div data-screen-label="Opening" style={{ display: 'flex', justifyContent: 'center', minHeight: 120, alignItems: 'center' }}><ThinkingDots label="opening your project" /></div>;
  }

  return (
    <div data-screen-label="Onboarding" data-onboarding={flowMode} data-step={step} style={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', background: '#fff', color: C.ink, fontFamily: 'var(--font-sans)' }}>
      <style>{CSS}</style>
      <div className="title-bar title-lead" style={{ flex: 'none', height: 54, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        {onBack && <button type="button" className="hov-ink" onClick={onBack} title="All projects" style={{ ...plain, font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: C.ink }}>Engelbart</button>}
      </div>
      {/* The design's slide: one column, centred, 18px between the card and its counter. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 18, padding: '24px 40px 54px' }}>
        {body}
        <Counter pager={pager} />
      </div>
    </div>
  );
}
