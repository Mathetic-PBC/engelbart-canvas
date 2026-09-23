import React from 'react';
import { api, errorMessage } from '../api.js';

export function useGithubStatus() {
  const [status, setStatus] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    api.githubStatus().then((value) => { if (live) setStatus(value); }).catch(() => {});
    const off = api.onGithub((value) => { if (live && value) setStatus(value); });
    return () => { live = false; off(); };
  }, []);
  return [status, setStatus];
}

const button = { padding: '7px 10px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', color: '#171717', cursor: 'pointer', font: '500 12px/1.3 var(--font-sans)' };

// This band occupies layout space above the native view: it cannot disappear behind GitHub
// when the sidebar closes. Only the public user code crosses the bridge; tokens stay in main.
export default function GithubSignIn({ tabId, status }) {
  const [copied, setCopied] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const code = status?.pending?.userCode;
  const copy = React.useCallback(async () => {
    try { await api.copyText(code); setCopied(true); } catch (error) { setMessage(errorMessage(error)); }
  }, [code]);
  React.useEffect(() => { setMessage(''); setCopied(false); if (code) void copy(); }, [code, copy]);
  const paste = async () => {
    setBusy(true);
    setMessage('');
    try {
      const filled = await api.githubPaste(tabId);
      setMessage(filled ? 'Code filled. Press Continue on GitHub, then authorize Engelbart.' : 'Sign in to GitHub and reach the code boxes first. Then press Paste code into GitHub.');
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const act = (work) => work().catch((error) => setMessage(errorMessage(error)));
  if (!status) return null;
  return (
    <section data-github-signin-bar="1" aria-label="Connect GitHub" style={{ flex: 'none', padding: '12px 14px', borderBottom: '1px solid #eaeaea', background: '#fafafa', color: '#171717', font: '12px/1.5 var(--font-sans)' }}>
      {code ? <>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <code data-github-code={code} style={{ font: '600 19px/1.3 var(--font-mono)', letterSpacing: '2px', userSelect: 'all', marginRight: 4 }}>{code}</code>
          <button type="button" data-github-paste="1" disabled={busy} onClick={paste} style={{ ...button, background: '#171717', color: '#fff', borderColor: '#171717' }}>Paste code into GitHub</button>
          <button type="button" data-github-copy="1" onClick={copy} style={button}>{copied ? 'Copy again' : 'Copy code'}</button>
        </div>
        <div style={{ marginTop: 7 }}>Sign in below, then use <strong>Paste code into GitHub</strong> when the code boxes appear.</div>
        <div style={{ color: '#6f6f6f' }}>{copied ? 'Code also copied — you can paste it into the first box yourself.' : 'You can also copy the code and paste it into the first box.'}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 7 }}>
          <button type="button" onClick={() => act(() => api.openExternal(status.pending.verificationUri))} style={{ ...button, padding: 0, border: 0, background: 'transparent', color: '#6f6f6f' }}>Use external browser</button>
          <button type="button" data-github-cancel="1" onClick={() => act(api.githubCancel)} style={{ ...button, padding: 0, border: 0, background: 'transparent', color: '#6f6f6f' }}>Cancel sign-in</button>
        </div>
      </> : status.connected ? <>
        <strong>Connected as {status.login}.</strong>
        <div>Choose which repositories Engelbart can read, then return to + → Add from GitHub.</div>
        <button type="button" data-github-install="1" onClick={() => act(() => api.githubOpen('install'))} style={{ ...button, marginTop: 7 }}>Choose repositories</button>
      </> : <>
        <span>{status.error || 'GitHub sign-in is not active.'}</span>{' '}
        <button type="button" data-github-retry="1" onClick={() => act(api.githubConnect)} style={button}>Sign in again</button>
      </>}
      {message && <div role="status" style={{ marginTop: 7 }}>{message}</div>}
    </section>
  );
}
