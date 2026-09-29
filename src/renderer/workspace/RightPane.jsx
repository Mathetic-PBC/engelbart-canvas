import React from 'react';
import TerminalPane from '../terminal/TerminalPane.jsx';
import Stage from './Stage.jsx';

// Right pane (design 2026-09-17; Stage 2026-09-23): edge to edge, no padding; the switcher lives in the header.
// Stage | Terminal. Both stay mounted while hidden; builds live in notifications.

export const RIGHT_MODES = [
  { id: 'stage', label: 'Stage' },
  { id: 'terminal', label: 'Terminal' },
];

const RightPane = React.forwardRef(function RightPane({ mode, projectDir, projectId, workspaceId, terminalRequest, onActiveTerminal, full, onFull, onShowStage, onPage, onFront, onAskAnnotation, save, library, inRail, onError, style }, stageRef) {
  return (
    <section aria-label="Right pane" style={style}>
      <Stage ref={stageRef} projectId={projectId} workspaceId={workspaceId} visible={mode === 'stage'} full={full} onFull={onFull} onShow={onShowStage} onPage={onPage} onFront={onFront} onAskAnnotation={onAskAnnotation} save={save} library={library} inRail={inRail} onError={onError} />
      <TerminalPane cwd={projectDir} projectId={projectId} workspaceId={workspaceId} visible={mode === 'terminal'} requestedSession={terminalRequest} onActiveSession={onActiveTerminal} />
    </section>
  );
});

export default RightPane;
