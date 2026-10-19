import React from 'react';
import { IMPORT_CSS } from './import-css.js';
import { ROUND3_CSS } from './round3-css.js';
import { ROUND4_CSS } from './round4-css.js';
import SignInCode from './SignInCode.jsx';

// "Connect Claude Code" / "Connect Codex" over the workspace (2026-10-14, a beta tester's import that failed before it
// brought anything in: "ensure that in the app if they have already onboarded but context import failed before importing
// they see a claude or codex (whatever theyre using) connection prompt"). An Import your context run whose agents found
// their CLI not installed or not signed in waits (src/main/connect/session.cjs holdForProvider, `blocked`); this asks the
// person to connect that provider. Connect installs, checks and signs in, whichever the CLI still needs
// (src/main/tools/manager.cjs connect); once it is signed in the run goes on by itself (connect-unblock). Drawn as the
// run's other steps are (./NeedPopup.jsx): a white card, one line under the title at most, no dividers.

const CLI = { anthropic: 'claude', openai: 'codex' };
const NAME = { anthropic: 'Claude Code', openai: 'Codex' };

/** A CLI's record (the tool check's snapshot) → whether it can run: installed, working, signed in by its own word. */
export function cliReady(tool) {
  return !!tool && !!tool.installed && tool.signedIn === true && (tool.status === 'ready' || tool.status === 'updating' || (tool.status === 'outdated' && !!tool.autoUpdate));
}

/**
 * What the popup says for the blocked provider's CLI record → { state, line, primary, waiting }. state: 'ready' (it became
 * able to run while the popup was up: the run goes on) | 'refused' (the CLI says it is signed in, yet the run was turned
 * away, e.g. an account without a subscription: `why` is what it said, and Connect signs in again) | 'signing-in' |
 * 'connecting' | 'not-connected'. `changed`: the popup has seen it not ready since it opened.
 */
export function providerCopy(provider, tool, { why = '', changed = false } = {}) {
  const name = NAME[provider] || 'Claude Code';
  if (cliReady(tool) && !(tool.busy && tool.busy.action === 'sign-in')) {
    if (changed) return { state: 'ready', line: 'Connected. Your imports are starting again.', primary: 'Connected', waiting: true };
    return { state: 'refused', line: why ? String(why).slice(0, 160) : `${name} couldn’t run your imports.`, primary: 'Sign in again', waiting: false, problem: true };
  }
  const busy = (tool && tool.busy) || null;
  if (busy && busy.action === 'sign-in') return { state: 'signing-in', line: 'Finish signing in in your browser.', primary: busy.url ? 'Open page' : 'Waiting…', waiting: !busy.url };
  if ((busy && busy.action !== 'sign-out') || (tool && ['installing', 'checking', 'unknown', 'updating'].includes(tool.status))) return { state: 'connecting', line: `Connecting ${name}…`, primary: 'Connecting…', waiting: true };
  const problem = tool && tool.error ? String(tool.error).split(/(?<=[.!?])\s/)[0].slice(0, 160) : '';
  // No line under the title unless something went wrong (From Amitav, 2026-10-15: no subtext on these prompts).
  return { state: 'not-connected', line: problem || '', primary: 'Connect', waiting: false, problem: !!problem };
}

/**
 * `session` the run (its `blocked`: { provider, name, error }); `tools` the tool check's snapshot; `onConnect(cli)`,
 * `onOpenPage(url)`, `onSignInCode(cli, code)` (the sign-in page's code, when its sign-in asks for one), `onContinue(provider)`
 * (the run goes on, on `provider`) and `onLater()`.
 */
export default function ProviderPopup({ session, tools, onConnect, onSignIn, onOpenPage, onSignInCode = () => false, onContinue, onLater }) {
  const provider = session.blocked.provider === 'openai' ? 'openai' : 'anthropic';
  const other = provider === 'anthropic' ? 'openai' : 'anthropic';
  const tool = tools && tools.tools ? tools.tools[CLI[provider]] : null;
  const otherReady = !!(tools && tools.tools && cliReady(tools.tools[CLI[other]]));
  // Ready only counts once it was seen otherwise: a CLI that says it is signed in when the run is turned away anyway
  // (no subscription) is not tried again on its own, over and over.
  const changed = React.useRef(false);
  if (!cliReady(tool) || (tool && tool.busy && tool.busy.action === 'sign-in')) changed.current = true;
  const words = providerCopy(provider, tool, { why: session.blocked.error, changed: changed.current });
  const [error, setError] = React.useState('');
  const [pressed, setPressed] = React.useState(false);

  // Signed in (here, in Settings or in a terminal): the run goes on by itself, no second press.
  const tried = React.useRef(false);
  React.useEffect(() => {
    if (words.state !== 'ready' || tried.current) return;
    tried.current = true;
    Promise.resolve(onContinue(provider)).catch((failure) => { tried.current = false; setError(String((failure && failure.message) || failure).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')); });
  }, [words.state]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLater(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onLater]);

  const primary = () => {
    setError('');
    if (words.state === 'signing-in' && tool && tool.busy && tool.busy.url) { onOpenPage(tool.busy.url); return; }
    setPressed(true);
    Promise.resolve(words.state === 'refused' ? onSignIn(CLI[provider]) : onConnect(CLI[provider])).catch((failure) => setError(String((failure && failure.message) || failure)));
  };
  // After Connect, a CLI that stopped short (an install that failed, a sign-in cancelled) says why in its line.
  const line = error || words.line;
  return (
    <div className="ix ix-overlay" data-overlay="1" data-cover="1" data-provider-popup={provider} data-provider-state={words.state}>
      <style>{IMPORT_CSS}{'.ix.ix-overlay{min-height:0;background:transparent}.ix.ix-overlay .scrim{z-index:160}'}{ROUND3_CSS}{ROUND4_CSS}</style>
      <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onLater(); }}>
        <section className="modal need-modal" role="dialog" aria-modal="true" aria-label={`Connect ${NAME[provider]}`}>
          <h3>{`Connect ${NAME[provider]}`}</h3>
          {line ? <p className={error || (words.problem && (pressed || words.state === 'refused')) ? 'need-error' : undefined} role="status" data-provider-line="1">{line}</p> : null}
          {words.state === 'signing-in' && tool.busy.code ? <SignInCode cli={CLI[provider]} onSend={onSignInCode} /> : null}
          <div className="mf">
            {otherReady ? <button type="button" className="link" data-provider-other={other} onClick={() => Promise.resolve(onContinue(other)).catch((failure) => setError(String((failure && failure.message) || failure)))}>{`Use ${NAME[other]}`}</button> : null}
            <button type="button" className="link" data-provider-later="1" onClick={onLater}>Skip</button>
            <button type="button" className="btn small" data-provider-connect={provider} disabled={words.waiting} onClick={primary}>{words.primary}</button>
          </div>
        </section>
      </div>
    </div>
  );
}
