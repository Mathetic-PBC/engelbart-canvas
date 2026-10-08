// The existing pipeline list, with each step's output kept directly beneath its row.
import React from 'react';
import { buildEvents, canvasBuildSteps } from '../model/canvas-build.js';
import { formatDuration, stepDuration } from '../model/run-steps.js';
import { terminalLines } from '../model/build-events.js';
import './run-timeline.css';

function Icon({ name, ...props }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {name === 'check' ? <path d="M20 6 9 17l-5-5" /> : name === 'warning' ? <path d="M12 5v8m0 5h.01" /> : name === 'x' ? <path d="m18 6-12 12M6 6l12 12" /> : name === 'minus' ? <path d="M5 12h14" /> : name === 'spinner' ? <path d="M21 12a9 9 0 1 1-6.219-8.56" /> : <path d="m9 18 6-6-6-6" />}
  </svg>;
}

function StateIcon({ state }) {
  const name = { active: 'spinner', done: 'check', warned: 'warning', failed: 'x', skipped: 'minus' }[state];
  return <span className={`build-state build-state-${state}`} aria-label={state}>{name && <Icon name={name} strokeWidth={state === 'active' ? 2 : 3} />}</span>;
}

function RunLog({ lines, error, expanded, running, onOpenPreview, className = '', emptyMessage = 'Nothing recorded for this step.' }) {
  const scroller = React.useRef(null);
  const follow = React.useRef(true);
  const position = React.useRef({ top: 0, left: 0 });
  React.useLayoutEffect(() => {
    if (!expanded || !scroller.current) return;
    const el = scroller.current;
    el.scrollTop = running && follow.current ? el.scrollHeight : position.current.top;
    el.scrollLeft = position.current.left;
  }, [expanded, lines, running]);
  return <section ref={scroller} aria-label="Run log" className={`build-log${className ? ` ${className}` : ''}`} tabIndex={0} onScroll={(event) => {
    if (!expanded) return;
    const el = event.currentTarget;
    position.current = { top: el.scrollTop, left: el.scrollLeft };
    follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  }}>
    {error && <p role={expanded ? 'alert' : undefined} className="build-step-error">{error}</p>}
    {lines.length ? lines.map((line, index) => <div key={index} className={`build-log-line build-log-${line.kind}`}>
      <span aria-hidden="true" className="build-log-prompt">{line.kind === 'command' ? '$' : ''}</span>
      <span>{line.text}</span>
    </div>) : !error && !onOpenPreview && <p>{emptyMessage}</p>}
    {onOpenPreview && <button type="button" className="build-preview-link" onClick={onOpenPreview}>Open preview ↗</button>}
  </section>;
}

// Only shorten presentation copy. Outcomes, timestamps, and the original output
// still come from the existing step computation and are not modified.
export function stepSummary(step) {
  if (step.state !== 'done') return step.summary;
  if (step.id === 'start') {
    const setup = step.events.findLast((event) => event.data?.phase === 'setup');
    if (setup?.data.status === 'done') return step.title === 'Restart application' ? 'Application restarted' : 'Repository prepared';
    if (['Installing and preparing…', 'Preparing repository…', 'Replaying saved setup…', 'Restarting application…', 'Switching setup provider…', 'Starting…'].includes(step.summary)) return 'Setup activity recorded';
  }
  if (step.id === 'health' && step.summary === 'The check passed') return 'Check passed';
  if (step.id === 'sandbox' && /^Sandbox (running|stopped).* · cloning/.test(step.summary)) return step.summary.split(' · cloning')[0];
  return step.summary;
}

export function RunLogs({ run, visible = true }) {
  const lines = React.useMemo(() => terminalLines(buildEvents(run)), [run]);
  return <RunLog lines={lines} error={run?.error} expanded={visible} running={run?.status === 'starting'} className="build-log-full"
    emptyMessage={run ? 'No logs recorded for this run.' : 'Logs will appear when setup starts.'} />;
}

export function StepRow({ step, index, now, expanded, onToggle, onOpenPreview, visible = true }) {
  const duration = stepDuration(step, now);
  const summary = stepSummary(step);
  const has = step.events.length > 0 || !!step.error || !!onOpenPreview;
  const lines = React.useMemo(() => terminalLines(step.events), [step.events]);
  const panelId = React.useId();
  return <li className={`build-step build-step-${step.state}`} data-build-step={step.id}>
    <button type="button" className="build-step-button" disabled={!has} onClick={has ? onToggle : undefined}
      aria-expanded={has ? expanded : undefined} aria-controls={has ? panelId : undefined}>
      <StateIcon state={step.state} />
      <span className="build-step-title"><span className="build-step-number">{index + 1}</span>{step.title}</span>
      <span className="build-step-summary" title={summary}>{summary}</span>
      {has && <Icon name="chevron" strokeWidth="2" className={`build-step-chevron${expanded ? ' expanded' : ''}`} />}
      <span className="build-step-duration">{duration !== null && step.state !== 'waiting' ? formatDuration(duration) : ''}</span>
    </button>
    {has && <div id={panelId} className="build-step-output" hidden={!expanded}>
      <RunLog lines={lines} error={step.error} expanded={expanded && visible} running={!!step.since} onOpenPreview={onOpenPreview} />
    </div>}
  </li>;
}

export default function RunTimeline({ run, repoName, onOpenPreview, visible = true }) {
  const steps = React.useMemo(() => canvasBuildSteps(run, repoName), [run, repoName]);
  const [expanded, setExpanded] = React.useState(null);
  const scrollAnchor = React.useRef(null);
  const [now, setNow] = React.useState(Date.now);
  const ticking = visible && steps.some((step) => step.since);
  React.useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  React.useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (!anchor) return;
    // Keep the clicked row in place when closing an earlier expanded step. Let
    // the browser clamp naturally at the beginning/end of the inspector.
    anchor.scroller.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
    scrollAnchor.current = null;
  }, [expanded]);
  const toggle = (id, event) => {
    const row = event.currentTarget;
    const scroller = row.closest('.repo-details-scroll');
    if (scroller) scrollAnchor.current = { row, scroller, top: row.getBoundingClientRect().top };
    setExpanded((current) => current === id ? null : id);
  };
  return <section aria-label="Run steps" className="build-timeline">
    <ol>{steps.map((step, index) => <StepRow key={step.id} step={step} index={index} now={now}
      expanded={expanded === step.id} visible={visible} onToggle={(event) => toggle(step.id, event)} onOpenPreview={step.id === 'live' ? onOpenPreview : undefined} />)}</ol>
  </section>;
}
