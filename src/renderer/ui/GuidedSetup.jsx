import React from 'react';
import Button from './Button.jsx';

// The guided setup (2026-10-10): a new user's onboarding (screens/Onboarding.jsx), run for someone who has projects
// already, over what they have. Started inside a project (mode 'guided') its screens have no Create, and after the last one
// that project gets a Welcome workspace showing the walkthrough, with what the setup added as its context; running it again
// adds another. Started from all projects (mode 'new') it ends in a new project whose Welcome workspace shows the
// walkthrough. Since 2026-10-12 nothing in the window starts it: the offer below opens Connect your library instead, and
// Settings ▸ Guided setup is gone. START_GUIDED_SETUP (App.jsx startGuided) and Onboarding's 'guided' mode are kept,
// unreferenced from the UI, to be removed later.
export const START_GUIDED_SETUP = 'engelbart:guided-setup';
export const startGuidedSetup = () => window.dispatchEvent(new CustomEvent(START_GUIDED_SETUP));

/**
 * "Import Context" (2026-10-12, in place of "New: a guided setup"): offered over the workspace while this library's
 * context has not been imported and the offer has not been dismissed (main's guided-offer). Import opens Connect your
 * library's tick-and-import screen over the workspace (App.jsx); Not now, Escape or a click outside dismisses it.
 */
export function ImportContextOffer({ onImport, onDismiss }) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);
  return (
    <div data-overlay="1" data-cover="1" data-import-offer="1" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }} style={{ position: 'fixed', inset: 0, zIndex: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(23,23,23,.18)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="import-offer-title" style={{ width: 'min(400px, 100%)', boxSizing: 'border-box', padding: '22px 24px 20px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, boxShadow: '0 16px 48px #00000024', fontFamily: 'var(--font-sans)', animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
        <div id="import-offer-title" style={{ font: '600 17px/1.4 var(--font-sans)', color: '#171717', letterSpacing: '-0.2px' }}>Import Context</div>
        <p style={{ margin: '8px 0 0', font: '14px/1.6 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>Import your AI chats, papers, notes, and local files into Engelbart</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <span data-import-offer-dismiss="1"><Button size="sm" onClick={onDismiss}>Not now</Button></span>
          <span data-import-offer-import="1"><Button size="sm" variant="filled" go onClick={onImport}>Import</Button></span>
        </div>
      </div>
    </div>
  );
}
