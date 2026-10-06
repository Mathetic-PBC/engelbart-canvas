import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';

// "Import sign-ins…" (MATH-18, 2026-10-06): a picker that reads the person's own browsers and writes the sign-ins they
// tick into the Stage's session, so those sites open already signed in. It shows domains and counts only — cookie values
// never leave the main process (src/main/browser/import-cookies.cjs). Opened from the Stage's ⋮ menu and, as an opt-in
// step, from Onboarding. `onOpenSite(url)` opens a site on the Stage (the "Sign in again" button); `onClose` dismisses.
// `opensLater` (Onboarding, 2026-10-06): there is no Stage yet, so the site is kept for when the project opens, the picker
// stays, and the row says so.

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const CHECK_SITES = { 'github.com': 'GitHub', 'google.com': 'Google', 'overleaf.com': 'Overleaf', 'zotero.org': 'Zotero' };
const SITE_URL = { 'github.com': 'https://github.com', 'google.com': 'https://myaccount.google.com', 'overleaf.com': 'https://www.overleaf.com/project', 'zotero.org': 'https://www.zotero.org' };

const panel = { width: 'min(460px, calc(100vw - 32px))', maxHeight: 'min(600px, calc(100vh - 80px))', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}`, overflow: 'hidden' };
const titleStyle = { font: '500 15px/1.4 var(--font-sans)', color: '#171717' };
const subStyle = { font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' };
const rowButton = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', textAlign: 'left', font: '13.5px/1.4 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' };
const primaryStyle = { height: 34, padding: '0 16px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' };
const ghostStyle = { height: 34, padding: '0 12px', border: 0, background: 'transparent', color: '#8f8f8f', cursor: 'pointer', font: '13px/1 var(--font-sans)' };

export default function ImportSignins({ onClose, onOpenSite, opensLater = false }) {
  const [step, setStep] = React.useState('browser'); // browser → profile → domains → importing → done
  const [sources, setSources] = React.useState(null);
  const [error, setError] = React.useState('');
  const [browser, setBrowser] = React.useState(null); // { id, name, profiles }
  const [profile, setProfile] = React.useState(null); // { id, name }
  const [domains, setDomains] = React.useState(null); // [{ domain, count }]
  const [ticked, setTicked] = React.useState({}); // domain → bool
  const [query, setQuery] = React.useState('');
  const [result, setResult] = React.useState(null); // { imported, skipped, sessionOnly, checks }
  const [later, setLater] = React.useState({}); // domain → true: kept to open on the Stage when the project opens (opensLater)

  React.useEffect(() => {
    api.browserImportSources().then((list) => { setSources(list); if (!list.length) setError('No supported browsers were found on this Mac.'); }).catch((failure) => setError(errorMessage(failure)));
  }, []);

  const pickBrowser = (value) => {
    setBrowser(value); setError('');
    if (value.profiles.length === 1) pickProfile(value, value.profiles[0]);
    else setStep('profile');
  };

  const pickProfile = (chosenBrowser, value) => {
    setProfile(value); setStep('domains'); setDomains(null); setError('');
    api.browserImportDomains(chosenBrowser.id, value.id).then((payload) => {
      setDomains(payload.domains);
      const defaults = Object.fromEntries((payload.defaults || []).filter((d) => payload.domains.some((row) => row.domain === d)).map((d) => [d, true]));
      setTicked(defaults);
    }).catch((failure) => setError(errorMessage(failure)));
  };

  const runImport = () => {
    const chosen = Object.keys(ticked).filter((d) => ticked[d]);
    if (!chosen.length) { setError('Tick at least one site to import.'); return; }
    setStep('importing'); setError('');
    api.browserImport({ browser: browser.id, profile: profile.id, domains: chosen }).then((payload) => { setResult(payload); setStep('done'); })
      .catch((failure) => { setError(errorMessage(failure)); setStep('domains'); });
  };

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (domains || []).filter((row) => words.every((word) => row.domain.includes(word)));
  const tickedCount = Object.values(ticked).filter(Boolean).length;

  let body;
  if (step === 'browser') {
    body = (
      <>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={titleStyle}>Import sign-ins</div>
          <div style={{ ...subStyle, marginTop: 4 }}>Bring your sign-ins from another browser so sites open already signed in. Your passwords stay in that browser.</div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 18px 16px' }}>
          {!sources && !error && <div style={subStyle}>Looking for your browsers…</div>}
          {(sources || []).map((value) => (
            <button key={value.id} type="button" className="hov-bd2" data-import-browser={value.id} onClick={() => pickBrowser(value)} style={rowButton}>
              <span style={{ flex: 1 }}>{value.name}</span>
              <span style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{value.profiles.length === 1 ? '1 profile' : `${value.profiles.length} profiles`}</span>
              <span style={{ color: '#c9c9c9' }}>›</span>
            </button>
          ))}
        </div>
      </>
    );
  } else if (step === 'profile') {
    body = (
      <>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={titleStyle}>{browser.name} · choose a profile</div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 18px 16px' }}>
          {browser.profiles.map((value) => (
            <button key={value.id} type="button" className="hov-bd2" data-import-profile={value.id} onClick={() => pickProfile(browser, value)} style={rowButton}>
              <span style={{ flex: 1 }}>{value.name}</span>
              <span style={{ color: '#c9c9c9' }}>›</span>
            </button>
          ))}
        </div>
      </>
    );
  } else if (step === 'domains') {
    body = (
      <>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={titleStyle}>Choose sites to import</div>
          <div style={{ ...subStyle, marginTop: 4 }}>{browser.name} · {profile.name}. GitHub, Google, Overleaf and Zotero are ticked for you.</div>
        </div>
        <div style={{ flex: 'none', padding: '8px 18px 4px' }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search sites…" spellCheck={false} data-import-search="1" className="focus-bd2" style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, font: '13.5px/1.4 var(--font-sans)', color: '#171717' }} />
        </div>
        <div data-import-domains="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '4px 10px 8px' }}>
          {!domains && !error && <div style={{ padding: 10, ...subStyle }}>Reading cookies…</div>}
          {shown.map((row) => {
            const on = !!ticked[row.domain];
            return (
              <button key={row.domain} type="button" className="hov-ink-wash" data-import-domain={row.domain} data-on={on ? '1' : '0'} onClick={() => setTicked((now) => ({ ...now, [row.domain]: !now[row.domain] }))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: on ? '#1f9d55' : 'transparent', border: on ? 0 : '1.5px solid #c9c9c9', color: '#fff', font: '600 10px/1 var(--font-sans)' }}>{on ? '✓' : ''}</span>
                <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', color: '#171717' }}>{CHECK_SITES[row.domain] ? `${CHECK_SITES[row.domain]} · ${row.domain}` : row.domain}</span>
                <span style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{row.count}</span>
              </button>
            );
          })}
          {domains && !shown.length && <div style={{ padding: 10, ...subStyle }}>No sites match.</div>}
        </div>
      </>
    );
  } else if (step === 'importing') {
    body = <div style={{ padding: '32px 18px', textAlign: 'center', ...subStyle }}>Importing…</div>;
  } else {
    const checks = (result && result.checks) || [];
    body = (
      <>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={titleStyle}>Imported {result.imported} sign-in{result.imported === 1 ? '' : 's'}</div>
          <div style={{ ...subStyle, marginTop: 4 }}>{browser.name} · {profile.name}{result.skipped ? ` · ${result.skipped} could not be read` : ''}{result.sessionOnly ? ` · ${result.sessionOnly} last only this session` : ''}.</div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 18px 16px' }}>
          {checks.length === 0 && <div style={subStyle}>These sites will open on the Stage with their sign-ins.</div>}
          {checks.map((check) => (
            <div key={check.domain} data-import-check={check.domain} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: '1px solid #f2f2f2' }}>
              <span style={{ flex: 1, font: '13.5px/1.4 var(--font-sans)', color: '#171717' }}>{check.site}</span>
              {check.signedIn === true && <span style={{ font: '12.5px/1 var(--font-sans)', color: '#1f9d55' }}>✓ signed in</span>}
              {check.signedIn !== true && later[check.domain] && <span data-import-later={check.domain} style={{ font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>opens on the Stage when you finish</span>}
              {check.signedIn !== true && !later[check.domain] && (
                <button type="button" className="hov-ink" data-import-signin={check.domain} onClick={() => {
                  if (onOpenSite) onOpenSite(SITE_URL[check.domain] || `https://${check.domain}`);
                  if (opensLater) setLater((now) => ({ ...now, [check.domain]: true }));
                  else onClose();
                }} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 12.5px/1 var(--font-sans)', color: '#0070f3' }}>Sign in again</button>
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  const footer = (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 18px', borderTop: '1px solid #eaeaea' }}>
      <div style={{ minWidth: 0, flex: 1 }}>{error && <span data-import-error="1" style={{ font: '12.5px/1.4 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{error}</span>}</div>
      {step === 'domains' && <button type="button" className="hov-bd2" data-import-run="1" onClick={runImport} disabled={!tickedCount} style={{ ...primaryStyle, opacity: tickedCount ? 1 : 0.5, cursor: tickedCount ? 'pointer' : 'default' }}>Import {tickedCount || ''}</button>}
      {step === 'done' && <button type="button" onClick={onClose} style={primaryStyle}>Done</button>}
      {(step === 'browser' || step === 'profile' || step === 'importing') && <button type="button" className="hov-ink" onClick={onClose} style={ghostStyle}>Cancel</button>}
    </div>
  );

  return createPortal(
    <div data-overlay="1" data-import-signins="1" role="dialog" aria-modal="true" aria-label="Import sign-ins" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div style={panel} onMouseDown={(event) => event.stopPropagation()}>
        {body}
        {footer}
      </div>
    </div>,
    document.body,
  );
}
