// Port of engelbart-web/components/run-timeline.tsx at afd4af9.
// Tailwind utilities are expressed in scoped CSS; the row layout is unchanged.
import React from 'react';
import { canvasBuildSteps } from '../model/canvas-build.js';
import { formatDuration, stepDuration } from '../model/run-steps.js';
import { terminalLines } from '../model/build-events.js';
import './run-timeline.css';

function Icon({ name, ...props }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {name === 'check' ? <path d="M20 6 9 17l-5-5" /> : name === 'x' ? <path d="m18 6-12 12M6 6l12 12" /> : name === 'minus' ? <path d="M5 12h14" /> : name === 'spinner' ? <path d="M21 12a9 9 0 1 1-6.219-8.56" /> : <path d="m9 18 6-6-6-6" />}
  </svg>;
}

function StateIcon({ state }) {
  const name = { active: 'spinner', done: 'check', warned: 'check', failed: 'x', skipped: 'minus' }[state];
  return <span className={`build-state build-state-${state}`} aria-label={state}>{name && <Icon name={name} strokeWidth={state === 'active' ? 2 : 3} />}</span>;
}

function RunLog({ lines }) {
  const scroller = React.useRef(null);
  const follow = React.useRef(true);
  React.useLayoutEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);
  return <section ref={scroller} aria-label="Run log" className="build-log" onScroll={(event) => {
    const el = event.currentTarget;
    follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  }}>
    {lines.length ? lines.map((line, index) => <div key={index} className={`build-log-line build-log-${line.kind}`}>
      <span aria-hidden="true" className="build-log-prompt">{line.kind === 'command' ? '$' : ''}</span>
      <span>{line.text}</span>
    </div>) : <p>Nothing recorded for this step.</p>}
  </section>;
}

function StepRow({ step, index, now, expanded, onToggle }) {
  const duration = stepDuration(step, now);
  const has = step.events.length > 0 || !!step.error;
  const lines = React.useMemo(() => expanded ? terminalLines(step.events) : [], [expanded, step.events]);
  const panelId = React.useId();
  return <li className={`build-step build-step-${step.state}`}>
    <button type="button" className="build-step-button" disabled={!has} onClick={has ? onToggle : undefined}
      aria-expanded={has ? expanded : undefined} aria-controls={has ? panelId : undefined}
      title={has ? `${expanded ? 'Hide what' : 'What'} ${step.title} printed` : undefined}>
      <StateIcon state={step.state} />
      <span className="build-step-title"><span className="build-step-number">{index + 1}</span>{step.title}</span>
      <span className="build-step-summary" title={step.summary}>{step.summary}</span>
      {has && <Icon name="chevron" strokeWidth="2" className={`build-step-chevron${expanded ? ' expanded' : ''}`} />}
      <span className="build-step-duration">{duration !== null && step.state !== 'waiting' ? formatDuration(duration) : ''}</span>
    </button>
    {expanded && <div id={panelId} className="build-step-output">
      {step.error && <p role="alert" className="build-step-error">{step.error}</p>}
      <div style={{ height: Math.min(220, Math.max(56, lines.length * 23 + 16)) }}><RunLog lines={lines} /></div>
    </div>}
  </li>;
}

export default function RunTimeline({ run, repoName }) {
  const steps = React.useMemo(() => canvasBuildSteps(run, repoName), [run, repoName]);
  const [expanded, setExpanded] = React.useState(null);
  const [now, setNow] = React.useState(Date.now);
  const ticking = steps.some((step) => step.since);
  React.useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return <section aria-label="Run steps" className="build-timeline">
    <ol>{steps.map((step, index) => <StepRow key={step.id} step={step} index={index} now={now}
      expanded={expanded === step.id} onToggle={() => setExpanded((current) => current === step.id ? null : step.id)} />)}</ol>
  </section>;
}
