import React from 'react';

// A code to paste back (2026-10-19, Linux in a VM): when Claude Code cannot open the browser itself, the page it signs in
// on ends with "paste this code into Claude Code", and Claude Code runs out of sight here (src/main/tools/sign-in.cjs).
// This box passes the code on (its `send`). Shown while that CLI's sign-in says it takes one (`busy.code`), under the
// popup's rows: in the agent popup (./AgentSetup.jsx) and Connect Claude Code (./ProviderPopup.jsx).
export default function SignInCode({ cli, onSend }) {
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState('');
  const submit = (event) => {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    setError('');
    Promise.resolve(onSend(cli, value))
      .then((sent) => { if (!sent) setError('The code couldn’t be passed on. Start the sign-in again.'); })
      .catch((failure) => setError(String((failure && failure.message) || failure).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')));
  };
  return (
    <>
      <form className="sender-input" data-sign-in-code={cli} style={{ marginTop: 14 }} onSubmit={submit}>
        <input className="field" aria-label="Code from the sign-in page" placeholder="Paste the code from the sign-in page" value={code} autoComplete="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} />
        <button type="submit" className="btn small" disabled={!code.trim()}>Sign in</button>
      </form>
      {error ? <p className="need-error" role="status">{error}</p> : null}
    </>
  );
}
