import React from 'react';
import SandboxNotifications from './SandboxNotifications.jsx';
import Settings from './Settings.jsx';
import Connections from '../workspace/Connections.jsx';

/** The controls on every screen, fixed top-right: Connections (the app's accounts), the sandbox notification bell, the
 *  Settings gear (./Settings.jsx; `test` gives it the Test data section in a developer's copy), then what `children` adds
 *  (the test mode pill in a developer's copy). */
export default function WindowControls({ test = null, children }) {
  return (
    <div data-no-drag="1" data-window-controls="1" style={{ position: 'fixed', top: 18, right: 16, zIndex: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Connections />
      <SandboxNotifications />
      <Settings test={test} />
      {children}
    </div>
  );
}
