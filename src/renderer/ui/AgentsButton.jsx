import React from 'react';
import Button from './Button.jsx';

/** The Agent map's button (2026-10-12, src/main/agent-map): beside the Test pill, shown only while test mode is on
 *  (`available`: agentsAvailable(config), a copy with test mode and the mode on). Runs are recorded either way, so they
 *  are there when Test is turned on again. It opens the map window, or brings it forward. */
export const agentsAvailable = (config) => !!(config && config.testModeAvailable && config.testMode);

export default function AgentsButton({ available, onOpen }) {
  if (!available) return null;
  return (
    <div data-no-drag="1" style={{ display: 'flex', alignItems: 'center' }}>
      <Button caps size="sm" variant="outline" onClick={onOpen} title="Agent map: every @bart, @brainstorm and @discover run, live">
        Agents
      </Button>
    </div>
  );
}
