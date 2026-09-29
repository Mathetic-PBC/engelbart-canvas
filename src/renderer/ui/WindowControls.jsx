import React from 'react';
import SandboxNotifications from './SandboxNotifications.jsx';

/** The controls on every screen, fixed top-right: the sandbox notification bell, then what `children` adds (the test
 *  mode controls in a developer's copy). */
export default function WindowControls({ children }) {
  return (
    <div data-no-drag="1" data-window-controls="1" style={{ position: 'fixed', top: 18, right: 16, zIndex: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
      <SandboxNotifications />
      {children}
    </div>
  );
}
