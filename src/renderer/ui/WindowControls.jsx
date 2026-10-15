import React from 'react';
import SandboxNotifications from './SandboxNotifications.jsx';
import Settings from './Settings.jsx';

/** The controls on every screen, fixed top-right: the sandbox notification bell, the Settings gear (./Settings.jsx, which
 *  holds Connections, the app's accounts; `test` gives it the Test data section in a developer's copy), then what
 *  `children` adds (the test mode pill in a developer's copy). `bare`: onboarding's screens, which show neither the bell
 *  nor the gear (From Amitav, 2026-10-15). */
export default function WindowControls({ test = null, bare = false, children }) {
  return (
    <div data-no-drag="1" data-window-controls="1" style={{ position: 'fixed', top: 13, right: 16, zIndex: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
      {!bare && <SandboxNotifications />}
      {!bare && <Settings test={test} />}
      {children}
    </div>
  );
}
