import React from 'react';
import { api, errorMessage } from '../api.js';
import Button from '../ui/Button.jsx';
import Pager from '../ui/Pager.jsx';
import ThinkingDots from '../ui/ThinkingDots.jsx';
import { QUESTIONS, forward, wrapUp, pagerOf, cardButtons, partsOf, sentenceOf, joinedOf, FRAME, JOIN_MS, planFallback, questionOf, toolsWanted, preparingState, TOOL_WHY } from '../model/onboarding.js';
import { launchRows, installable, rowOf } from '../model/tools.js';
import welcomePng from '../../../design/assets/welcome-cards.png';

// Onboarding as brainstorm cards (2026-10-07, build 1 of 2): design/onboarding-brainstorm, BSC-1 to BSC-5, its inline
// styles' values replicated here. mode 'new' (first launch: welcome → tools, only when one is missing → the cards → the
// project) or 'existing' (+ Project: the cards → the project). The cards ask one question at a time: What are you
// working on? Why are you interested in this? Putting it together. Skip moves on, Wrap up jumps to Putting it together,
// Submit moves on. (2026-10-08, from a hand test: "What are you least sure about?" is gone, and the second card asked
// "Why this, and why now?".) A question card shows its question and its box, nothing above it (the sentence growing
// above the cards is gone, 2026-10-08).
//
// Bart (src/main/bart/onboard.cjs) has one session for the whole onboarding, started as it opens: after a card it
// searches for papers in main. On the way to Putting it together he joins their answers into one sentence that reads
// naturally, their own words kept ("I'm working on predicting student behavior because AI is changing how students
// learn."), each part underlined and editable in place; when he has not answered within JOIN_MS, their words as they
// are ("I'm working on … because …"). Under it the question they want to answer, filled with Bart's suggestion as soon as the plan has one;
// they can change it, and Stuck? suggests another. One call names the project, words a question and writes three
// sub-questions while they are on the card, and again for their question when they change it. Submit always works: an
// empty field takes Bart's suggestion. (It had been "because I want to find out ___", Submit greyed until the blank
// was filled, and nothing said so.)
// Opening the project (api.startProject): Bart's name, the sentence as its description, the default folder, the first
// workspace named with the question and the sub-questions under "Questions to investigate" (workspace/StartsBlock.jsx).
// The tools screen installs Git, Claude Code and Codex in the background (App.jsx holds the setup dialog back until
// onboarding is over).
// Build 2 (2026-10-08): after Open project, a preparing screen (berkeley-research's 3×3 dots, larger, and a lowercase
// label naming the step under way; no step counter) until the first sub-question has two approved papers, 60 seconds at
// most, then the workspace opens with what there is and the rest fills in (model/onboarding.js preparingState). The
// climbs began on the plan, while they were on Putting it together (src/main/bart/climbs.cjs).

// The design's colours (its :root): greys, and one muted olive for what is theirs and what moves them on.
const C = { g200: '#eaeaea', g300: '#c9c9c9', g500: '#8f8f8f', g700: '#4d4d4d', ink: '#171717', guess: '#a3a3a3', olive: '#6b7a3a', oliveInk: '#55622c', oliveWash: '#f1f3e8', oliveLine: '#b9c296' };
const rise = 'rise 260ms cubic-bezier(.25,.1,.25,1)';
const plain = { padding: 0, border: 0, background: 'none', cursor: 'pointer' };

// What inline styles cannot say: hover, focus, placeholders.
const CSS = `
.ob-field{display:block;width:100%;margin:0;padding:8px 10px;border:1px solid ${C.g500};border-radius:8px;background:#fff;resize:none;outline:none;font:15px/1.5 var(--font-sans);color:${C.ink};transition:border-color 120ms}
.ob-field:focus{border-color:${C.g700}}
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
.ob-stuck{margin-top:10px;padding:0;border:0;background:transparent;color:${C.g500};font:13px/1.5 var(--font-sans);cursor:pointer;text-decoration:underline;text-decoration-color:${C.g300};text-underline-offset:3px}
.ob-stuck:hover{color:${C.ink}}
.ob-stuck:disabled{cursor:default;text-decoration:none}
@keyframes ob-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes ob-pulse{0%,70%,100%{opacity:.18}35%{opacity:1}}
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

/** The design's card: white, a grey edge (#d4d4d4, a step darker than the design's), its question in bold, 560 wide at most. */
function Card({ title, children, data }) {
  return (
    <div data-onboarding-card={data} style={{ width: '100%', maxWidth: 560, boxSizing: 'border-box', padding: '14px 16px 16px', border: '1px solid #d4d4d4', borderRadius: 10, background: '#fff', animation: rise }}>
      <div style={{ font: '600 16px/1.45 var(--font-sans)', color: C.ink }}>{title}</div>
      {children}
    </div>
  );
}

/**
 * Waiting, as berkeley-research's setup waits (engelbart/lab-search/setup.js generating(), setup.css .generating and
 * .dots): a 3×3 grid of 3px dots pulsing in a wave from the top left, and a muted label.
 */
function Waiting({ label, data }) {
  return (
    <div role="status" data-onboarding-waiting={data} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 19.5, marginTop: 10, font: '11.5px/1.5 var(--font-sans)', letterSpacing: '.3px', color: C.g500, animation: 'ob-fade 220ms ease-out both' }}>
      <span aria-hidden="true" style={{ flex: 'none', display: 'grid', gridTemplateColumns: 'repeat(3, 3px)', gap: 2 }}>
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: C.ink, opacity: 0.18, animation: 'ob-pulse 1.1s ease-in-out infinite', animationDelay: `${((i % 3) + Math.floor(i / 3)) * 90}ms` }} />
        ))}
      </span>
      <span>{label}</span>
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
  const [drafts, setDrafts] = React.useState({ working: '', why: '' });
  const [answers, setAnswers] = React.useState({ working: '', why: '' });
  const [parts, setParts] = React.useState(null); // Putting it together's { working, why }, once joined (or not, in time)
  const [frame, setFrame] = React.useState(FRAME); // the words around them: Bart's join, else their words as they are
  const joining = React.useRef(null); // Bart's join, asked on the way to Putting it together
  const [question, setQuestion] = React.useState(''); // the question they want to answer: Bart's suggestion until changed
  const [suggesting, setSuggesting] = React.useState(false); // the first plan, whose question fills the field, is coming
  const touched = React.useRef(false); // the field was typed in (or filled by Stuck?): a later suggestion leaves it be
  const seen = React.useRef([]); // every question the field was filled with, so Stuck? says a new one
  const [stuck, setStuck] = React.useState(false);
  const [preparing, setPreparing] = React.useState('reading your answers'); // the step the preparing screen names
  const [error, setError] = React.useState('');
  const [id, setId] = React.useState(null); // Bart's onboarding session (src/main/bart/onboard.cjs)
  const idRef = React.useRef(null);
  const made = React.useRef(false);
  const plans = React.useRef(new Map()); // `${sentence}\n${question}` → the plan asked for them

  // The session starts as onboarding opens, so the first card never waits on a cold start; it ends when the project is
  // made (start-project) or onboarding is left.
  React.useEffect(() => {
    let live = true;
    api.onboardingOpen().then((opened) => { if (!live) { api.onboardingClose(opened.id).catch(() => {}); return; } idRef.current = opened.id; setId(opened.id); }).catch(() => {});
    return () => { live = false; if (idRef.current && !made.current) api.onboardingClose(idRef.current).catch(() => {}); };
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

  // Putting it together opens on Bart's join of their answers, once: waited for JOIN_MS at most from the card opening,
  // then their words as they are. A join arriving later is not used: the sentence never changes under them.
  React.useEffect(() => {
    if (step !== 'together' || parts) return undefined;
    let live = true;
    const settle = (joined) => { if (!live) return; live = false; if (joined) { setFrame(joined.frame); setParts(joined.parts); } else { setFrame(FRAME); setParts(partsOf(answers)); } };
    const timer = setTimeout(() => settle(null), JOIN_MS);
    (joining.current || Promise.resolve(null)).then((out) => settle(joinedOf(out)), () => settle(null));
    return () => { live = false; clearTimeout(timer); };
  }, [step, parts]); // eslint-disable-line react-hooks/exhaustive-deps

  const sentence = parts ? sentenceOf(parts, frame) : '';
  const settled = questionOf(question);

  // The project's name, question and sub-questions: asked for the sentence alone as Putting it together opens (its
  // question is Bart's suggestion, which fills the field), and again once an edit to the sentence or a question of
  // theirs has rested, so the plan for what they submit is ready (or nearly). The plan for the sentence alone is also
  // the plan for the question it suggested: keeping that suggestion asks for nothing more.
  const askPlan = React.useCallback((text, asked) => {
    const key = `${text}\n${asked}`;
    if (plans.current.has(key)) return plans.current.get(key);
    const promise = idRef.current ? api.onboardingPlan(idRef.current, { answers: { ...answers, question: asked }, sentence: text }).catch(() => null) : Promise.resolve(null);
    plans.current.set(key, promise);
    if (!asked) promise.then((out) => { const suggested = out && questionOf(out.question); if (suggested && !plans.current.has(`${text}\n${suggested}`)) plans.current.set(`${text}\n${suggested}`, promise); });
    return promise;
  }, [answers]);
  const askedOnce = React.useRef(false);
  React.useEffect(() => {
    if (step !== 'together' || !parts || !id) return undefined;
    const first = !askedOnce.current;
    const timer = setTimeout(() => {
      const asked = touched.current ? settled : '';
      const promise = askPlan(sentence, asked);
      if (asked) return;
      if (first) setSuggesting(true);
      promise.then((out) => {
        setSuggesting(false);
        const suggested = out && questionOf(out.question);
        if (suggested && !touched.current) { setQuestion(suggested); if (!seen.current.includes(suggested)) seen.current.push(suggested); }
      });
    }, first ? 0 : 1200);
    askedOnce.current = true;
    return () => clearTimeout(timer);
  }, [step, id, sentence, settled]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * A question card left for `next`: by Submit (`keep`, its words are the answer) or by Skip (none). Bart is told when
   * there are words; on the way to Putting it together he is asked to join the answers.
   */
  const leaveCard = (card, keep, next) => {
    const text = keep ? drafts[card].trim() : '';
    const now = { ...answers, [card]: text };
    setAnswers(now);
    if (text && id) api.onboardingAnswer(id, { card, answers: now }).catch(() => {});
    if (next === 'together') joining.current = id && (now.working || now.why) ? api.onboardingJoin(id, { answers: now }).catch(() => null) : null;
    go(next);
  };
  const submit = (card) => { if (!drafts[card].trim()) return; leaveCard(card, true, forward(flowMode, card, flowOptions)); };
  const skip = (card) => leaveCard(card, false, forward(flowMode, card, flowOptions));
  // Wrap up keeps what is typed in the field, as Submit would, and goes straight to Putting it together.
  const wrap = (card) => leaveCard(card, !!drafts[card].trim(), wrapUp(flowMode, card, flowOptions));

  // Stuck?: another question to settle on, never one the field has held.
  const askStuck = async () => {
    if (stuck || !id) return;
    setStuck(true);
    try {
      const out = await api.onboardingStuck(id, { answers: { ...answers, question: settled }, seen: [...seen.current, settled].filter(Boolean) });
      const suggested = out && questionOf(out.text);
      if (suggested) { touched.current = true; setQuestion(suggested); seen.current.push(suggested); }
    } catch { /* Stuck? stays as it was */ } finally { setStuck(false); }
  };

  // Open the project: their question (an empty field takes Bart's suggestion, waited for when it is still being
  // written), Bart's plan for it, else their own words. The folder is the default one, made for it. Always works.
  const open = async () => {
    const now = parts || partsOf(answers);
    const text = parts ? sentenceOf(parts, frame) : sentenceOf(now);
    const began = Date.now();
    setPreparing('reading your answers');
    go('open');
    let result;
    try {
      let asked = touched.current || settled ? settled : '';
      let planned = await askPlan(text, asked);
      if (!asked && planned && planned.question) { asked = questionOf(planned.question); }
      planned = planned || planFallback(answers, asked);
      const settledOn = asked || questionOf(planned.question);
      result = await api.startProject({ name: planned.name, description: text, question: settledOn, starts: planned.starts, brief: { working: answers.working, why: answers.why, question: settledOn }, folder: 'new', onboardingId: idRef.current });
      made.current = true;
    } catch (failure) {
      setStep('together');
      setError(errorMessage(failure));
      return;
    }
    await prepared(result, began);
    await onDone(result);
  };

  // The preparing screen: until every sub-question has something approved, or PREPARE_MS from Open project. Asked when
  // main says a climb changed, and every half second besides (a change told before this listened is not missed).
  const prepared = (result, began) => new Promise((resolve) => {
    const starts = (result && result.starts) || [];
    let ended = false, timer = null, stop = () => {};
    const check = async () => {
      if (ended) return;
      let climbs = {};
      try { climbs = (await api.workspaceClimbs(result.project.id, result.workspaceId)).starts || {}; } catch { climbs = {}; }
      const state = preparingState({ starts, climbs, elapsedMs: Date.now() - began });
      if (ended) return;
      setPreparing(state.label);
      if (state.done) { ended = true; clearInterval(timer); stop(); resolve(); }
    };
    stop = api.onClimbsChanged ? api.onClimbsChanged((payload) => { if (payload && payload.workspaceId === result.workspaceId) void check(); }) || (() => {}) : () => {};
    timer = setInterval(() => { void check(); }, 500);
    void check();
  });

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
    const card = step, q = QUESTIONS[card];
    const buttons = cardButtons(card, drafts[card]);
    body = (
      <React.Fragment key={card}>
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
  } else if (step === 'together') {
    const buttons = cardButtons('together', question);
    const set = (key) => (value) => setParts((now) => ({ ...now, [key]: value }));
    // Bart's words around theirs (grey), their parts underlined and editable.
    const part = (key) => (key === 'working'
      ? <Inline key="working" className="ob-theirs" value={parts.working} onChange={set('working')} placeholder="what you’re working on" label="What you are working on" data="working" />
      : <Inline key="why" className="ob-theirs" value={parts.why} onChange={set('why')} placeholder="why it interests you" label="Why you are interested in this" data="why" />);
    const [first, second] = frame.parts;
    body = (
      <>
        <Card title="Putting it together" data="together">
          {parts ? (
            <div data-onboarding-sentence="1" data-joined={frame === FRAME ? undefined : '1'} style={{ marginTop: 12, font: '19px/1.75 var(--font-sans)', color: C.g500 }}>
              {frame.lead}{part(first)}{second ? <>{frame.join}{part(second)}</> : null}{frame.end}
            </div>
          ) : <Waiting label="Thinking…" data="join" />}
          <label htmlFor="ob-question" style={{ display: 'block', marginTop: 16, marginBottom: 6, font: '500 13px/1.5 var(--font-sans)', color: C.g700 }}>The question I want to answer:</label>
          <textarea
            id="ob-question"
            className="ob-field"
            rows={2}
            value={question}
            placeholder={suggesting ? 'Bart is suggesting one…' : 'Your question…'}
            data-onboarding-question="1"
            data-suggested={!touched.current && question ? '1' : undefined}
            onChange={(event) => { touched.current = true; setQuestion(event.target.value.replace(/\n/g, ' ')); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void open(); } }}
          />
          {stuck ? <Waiting label="Thinking…" data="stuck" /> : <button type="button" className="ob-stuck" data-onboarding-stuck="1" disabled={!id} onClick={askStuck} title="Suggest another question">Stuck?</button>}
          <Acts showWrap={buttons.showWrap} submitDisabled={buttons.submitDisabled} onSkip={open} onSubmit={open} />
        </Card>
        {errorLine}
      </>
    );
  } else if (step === 'open') {
    body = <div data-screen-label="Preparing" data-onboarding-preparing={preparing} style={{ display: 'flex', justifyContent: 'center', minHeight: 160, alignItems: 'center' }}><ThinkingDots label={preparing} size={6} labelSize={16} /></div>;
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
