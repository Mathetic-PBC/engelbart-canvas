import React from 'react';
import Button from './Button.jsx';

/** The Agent Viewer's button (2026-10-12, src/main/agent-map): beside the Test pill, in a copy with test mode, whether the
 *  mode is on or off (`available`: agentsAvailable(config); it was shown only while it was on). It opens the Viewer
 *  window, or brings it forward. */
export const agentsAvailable = (config) => !!(config && config.testModeAvailable);

export default function AgentsButton({ available, onOpen }) {
  if (!available) return null;
  return (
    <div data-no-drag="1" style={{ display: 'flex', alignItems: 'center' }}>
      <Button caps size="sm" variant="outline" onClick={onOpen} title="Agent Viewer: every ask, from your line to what each agent was sent and wrote, live">
        Agents
      </Button>
    </div>
  );
}
