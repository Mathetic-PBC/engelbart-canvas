import React from 'react';
import SandboxNotifications from './SandboxNotifications.jsx';

/** Shared top-right controls on every screen. */
export default function WindowControls() {
  return (
    <div className="window-controls window-no-drag" style={{ position: 'fixed', top: 8, right: 26, zIndex: 200, display: 'flex', alignItems: 'center', gap: 8 }}>
      <SandboxNotifications />
    </div>
  );
}
