import React from 'react';
import Button from './Button.jsx';

/** The Agent map's button (2026-10-12, src/main/agent-map): beside the Test pill, in a copy with test mode alone
 *  (`available`, config.testModeAvailable), whether test mode is on or off. It opens the map window, or brings it forward. */
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
