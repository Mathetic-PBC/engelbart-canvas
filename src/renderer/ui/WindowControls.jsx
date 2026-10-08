import React from 'react';
import SandboxNotifications from './SandboxNotifications.jsx';
import Settings from './Settings.jsx';

/** The controls on every screen, fixed top-right: the sandbox notification bell, the Settings gear (./Settings.jsx, which
 *  holds Connections, the app's accounts; `test` gives it the Test data section in a developer's copy), then what
 *  `children` adds (the test mode pill in a developer's copy). During onboarding (`onboarding`, screens/Onboarding.jsx)
 *  there is no bell and no gear: nothing has run yet to tell of, and nothing to set before there is a project. The pill
 *  stays. */
export default function WindowControls({ test = null, onboarding = false, children }) {
  return (
    <div data-no-drag="1" data-window-controls="1" style={{ position: 'fixed', top: 18, right: 16, zIndex: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
      {!onboarding && (
        <>
          <SandboxNotifications />
          <Settings test={test} />
        </>
      )}
      {children}
    </div>
  );
}
