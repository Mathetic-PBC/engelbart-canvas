import React from 'react';
import Button from './Button.jsx';

/** Test mode's pill, in the top-right controls on every screen (WindowControls.jsx). What its gear offered (Reveal in
 *  Finder, Start as a new user…, Reset everything…) is the Test data page of Settings since 2026-10-06 (./Settings.jsx),
 *  so there is one gear. */
export default function TestToggle({ testMode, onToggle, busy }) {
  return (
    <div data-no-drag="1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Button caps size="sm" variant={testMode ? 'filled' : 'outline'} disabled={busy} onClick={onToggle} title={testMode ? 'Test mode is on — everything lives in ~/.engelbart/test' : 'Test mode is off — everything lives in ~/.engelbart'}>
        Test · {testMode ? 'on' : 'off'}
      </Button>
    </div>
  );
}
