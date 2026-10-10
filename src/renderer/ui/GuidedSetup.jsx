import React from 'react';
import Button from './Button.jsx';

// The guided setup (2026-10-10): a new user's onboarding (screens/Onboarding.jsx, mode 'new'), run for someone who has
// projects already, over what they have. It ends in a new project whose Welcome workspace shows the walkthrough; nothing
// they had is removed. Offered once by GuidedSetupOffer (App.jsx, in place of Connect your library's one-time popup), and
// at any time from Settings ▸ Guided setup, which asks for it by this event.
export const START_GUIDED_SETUP = 'engelbart:guided-setup';
export const startGuidedSetup = () => window.dispatchEvent(new CustomEvent(START_GUIDED_SETUP));

/** The one-time offer, over the workspace: Start runs the guided setup, Not now (or Escape) dismisses it. */
export function GuidedSetupOffer({ onStart, onDismiss }) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);
  return (
    <div data-overlay="1" data-cover="1" data-guided-offer="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }} style={{ position: 'fixed', inset: 0, zIndex: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="guided-offer-title" style={{ width: 'min(400px, 100%)', boxSizing: 'border-box', padding: '22px 24px 20px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 16px 48px #00000024', fontFamily: 'var(--font-sans)', animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
        <div id="guided-offer-title" style={{ font: '600 17px/1.4 var(--font-sans)', color: '#171717', letterSpacing: '-0.2px' }}>New: a guided setup</div>
        <p style={{ margin: '8px 0 0', font: '14px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>Walk through it to bring in your library and try Brainstorm and Discover.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <span data-guided-offer-dismiss="1"><Button size="sm" onClick={onDismiss}>Not now</Button></span>
          <span data-guided-offer-start="1"><Button size="sm" variant="filled" go onClick={onStart}>Start</Button></span>
        </div>
      </div>
    </div>
  );
}
