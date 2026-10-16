import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import { PROVIDER_LOGOS } from './logos.js';
import { agentChoice, providerOfCli } from '../model/onboarding.js';

// The agent popup (2026-10-16, the onboarding beta's S3; Hudson: "a popup on this screen (there should be no auth screen
// that looks like this) should ask if they would like to use Claude Code, Codex, or both. it should then download
// appropriately based on their selection, as well as update if it is already downloaded and not up to date. if it is
// downloaded and up to date but not signed in, they should have to press a button saying 'Connect to {Claude, ChatGPT,
// or Claude and ChatGPT}'"). It takes the place of the "Set up your tools" screen after Welcome (../screens/Onboarding.jsx,
// asked only when neither CLI is installed, signed in and subscribed) and of Import your context's "Connect Claude Code or
// Codex" (./ImportFlow.jsx 'tools-setup'). No line under the title or the rows, no versions ("No one cares about the
// version"), Skip in plain text on the far left. What to do for each state is model/onboarding.js agentChoice.

const CHECK = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>;
const CHOICES = [
  { id: 'claude', name: 'Claude Code', logos: ['anthropic'] },
  { id: 'codex', name: 'Codex', logos: ['openai'] },
  { id: 'both', name: 'Both', logos: ['anthropic', 'openai'] },
];
const tidy = (failure) => String((failure && failure.message) || failure || '').replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

/**
 * The popup's contents, inside an `.ix` (ImportFlow's modal, or AgentSetupPopup below). `api`: toolsInstall, toolsUpdate
 * (else toolsConnect), toolsSignIn, openExternal. `tools` the tool check's snapshot, `providers` providers.cjs's status.
 * `initial` the choice to start on ('claude' | 'codex' | 'both' | null: a provider the flow asked for), `refused` the CLI
 * that turned the agents away while signed in. `onDone(choice)` once one of them runs (`watchDone`: the host may decide that
 * itself, as Import your context does); `onSkip()`.
 */
export function AgentSetupBody({ api, tools, providers, initial = null, refused = null, onDone = () => {}, onSkip = () => {}, watchDone = true }) {
  const [choice, setChoice] = React.useState(initial);
  const [error, setError] = React.useState('');
  const plan = agentChoice(tools, providers, choice, { refused });
  // What a choice starts, started once per tool (a failure's Try again starts it again).
  const started = React.useRef(new Set());
  React.useEffect(() => {
    for (const id of plan.install) {
      if (started.current.has(`install:${id}`)) continue;
      started.current.add(`install:${id}`);
      Promise.resolve(api.toolsInstall([id])).catch((failure) => setError(tidy(failure)));
    }
    for (const id of plan.update) {
      if (started.current.has(`update:${id}`)) continue;
      started.current.add(`update:${id}`);
      const update = api.toolsUpdate ? api.toolsUpdate(id) : api.toolsConnect(id);
      Promise.resolve(update).catch((failure) => setError(tidy(failure)));
    }
  }, [plan.install.join(','), plan.update.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // One of them runs: the flow goes on by itself, no Continue to press.
  const fired = React.useRef(false);
  React.useEffect(() => {
    if (!watchDone || !plan.done || fired.current) return;
    fired.current = true;
    onDone(choice);
  }, [plan.done]); // eslint-disable-line react-hooks/exhaustive-deps

  const primary = () => {
    setError('');
    const { action, ids, url } = plan.primary;
    if (action === 'open' && url) { Promise.resolve(api.openExternal(url)).catch((failure) => setError(tidy(failure))); return; }
    if (action === 'sign-in') { for (const id of ids) Promise.resolve(api.toolsSignIn(id)).catch((failure) => setError(tidy(failure))); return; }
    if (action === 'retry') {
      for (const id of ids) { started.current.delete(`install:${id}`); started.current.delete(`update:${id}`); }
      Promise.resolve(api.toolsInstall(ids)).catch((failure) => setError(tidy(failure)));
    }
  };
  const line = error || plan.problem;
  const readyRow = (id) => (id === 'both' ? false : plan.stages[id] === 'ready');
  return (
    <div className="agent-setup" data-agent-setup={choice || ''} data-agent-state={plan.done ? 'ready' : plan.primary.action || (plan.primary.disabled ? 'waiting' : '')}>
      <h3>Use Claude Code, Codex, or both?</h3>
      <div className="profiles agent-choices" role="radiogroup" aria-label="Claude Code, Codex, or both">
        {CHOICES.map((one) => (
          <button key={one.id} type="button" className="prof browser-choice" role="radio" aria-checked={choice === one.id} data-agent-choice={one.id} onClick={() => { setError(''); setChoice(one.id); }}>
            <span className={`agent-logos ${one.logos.length > 1 ? 'two' : ''}`} aria-hidden="true">{one.logos.map((logo) => <img key={logo} src={PROVIDER_LOGOS[logo]} alt="" />)}</span>
            <span>{one.name}</span>
            {readyRow(one.id) ? CHECK : null}
          </button>
        ))}
      </div>
      {line ? <p className="need-error" role="status" data-agent-line="1">{line}</p> : null}
      <div className="mf agent-actions">
        <button type="button" className="link mf-left" data-agent-skip="1" onClick={onSkip}>Skip</button>
        <button type="button" className="btn small" data-agent-primary={plan.primary.action || ''} disabled={plan.primary.disabled} onClick={primary}>{plan.primary.label}</button>
      </div>
    </div>
  );
}

/** The popup over a screen that is not inside an `.ix` (Welcome): its own scrim and styles, as ./ProviderPopup.jsx. */
export default function AgentSetupPopup(props) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onSkip(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onSkip]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ix ix-overlay ix-fluid" data-overlay="1" data-cover="1" data-agent-popup="1">
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:160}.ix .mf .mf-left{margin-right:auto}'}{ROUND3_CSS}{ROUND4_CSS}</style>
      <div className="scrim">
        <section className="modal agent-modal" role="dialog" aria-modal="true" aria-label="Use Claude Code, Codex, or both?">
          <AgentSetupBody {...props} />
        </section>
      </div>
    </div>
  );
}

/** The provider a single choice names (remembered, so Import your context does not ask again), or null for both. */
export const providerOfChoice = (choice) => (choice === 'claude' || choice === 'codex' ? providerOfCli(choice) : null);
