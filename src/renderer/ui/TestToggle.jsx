import React from 'react';
import Button from './Button.jsx';

/** Test mode's controls, in the top-right controls on every screen (WindowControls.jsx): the settings gear (test mode only)
 *  and the test pill. The gear resets the whole test root after a native confirmation: "Start as a new user…"
 *  leaves it as a new install has it (empty library, signed out of GitHub) and runs onboarding. */
export default function TestToggle({ testMode, onToggle, onReset, onStartNew, onReveal, busy }) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div data-no-drag="1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {testMode && (
        <div style={{ position: 'relative' }} onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="hov-ink"
            title="Settings"
            aria-label="Settings"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            style={{ width: 30, height: 30, padding: 0, border: '1px solid transparent', borderRadius: '50%', background: 'transparent', cursor: 'pointer', font: '17px/1 var(--font-sans)', color: open ? '#171717' : '#8f8f8f', transition: 'color 120ms' }}
          >
            ⚙
          </button>
          {open && (
            <div data-overlay="1" role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', minWidth: 230, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
              <div style={{ padding: '6px 10px 6px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>Test data · ~/.engelbart/test</div>
              <div role="menuitem" className="hov-wash" onClick={() => { setOpen(false); onReveal(); }} style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Reveal in Finder</div>
              <div role="menuitem" className="hov-wash" data-start-new-user="1" onClick={() => { setOpen(false); onStartNew(); }} style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Start as a new user…</div>
              <div role="menuitem" className="hov-wash" onClick={() => { setOpen(false); onReset(); }} style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', font: '13px/1.4 var(--font-sans)', color: '#e70022' }}>Reset everything…</div>
            </div>
          )}
        </div>
      )}
      <Button caps size="sm" variant={testMode ? 'filled' : 'outline'} disabled={busy} onClick={onToggle} title={testMode ? 'Test mode is on — everything lives in ~/.engelbart/test' : 'Test mode is off — everything lives in ~/.engelbart'}>
        Test · {testMode ? 'on' : 'off'}
      </Button>
    </div>
  );
}
