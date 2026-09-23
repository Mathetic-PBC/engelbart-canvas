import React from 'react';
import TerminalPane from '../terminal/TerminalPane.jsx';
import RepoPane from './RepoPane.jsx';
import Stage from './Stage.jsx';

// Right pane (design 2026-09-17; Stage 2026-09-23): edge to edge, no padding; the switcher lives in the header.
// Stage | Terminal | Repo. Stage and Terminal stay mounted while hidden.

export const RIGHT_MODES = [
  { id: 'stage', label: 'Stage' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'repo', label: 'Repo' },
];

const RightPane = React.forwardRef(function RightPane({ mode, repositories, repoId, onRepo, projectDir, projectId, full, onFull, onShowStage, onPage, onFront, save, library, inRail, onError, style }, stageRef) {
  return (
    <section aria-label="Right pane" style={style}>
      {mode === 'repo' && <RepoPane repositories={repositories} selectedId={repoId} onSelect={onRepo} />}
      <Stage ref={stageRef} projectId={projectId} visible={mode === 'stage'} full={full} onFull={onFull} onShow={onShowStage} onPage={onPage} onFront={onFront} save={save} library={library} inRail={inRail} onError={onError} />
      <TerminalPane cwd={projectDir} projectId={projectId} visible={mode === 'terminal'} />
    </section>
  );
});

export default RightPane;
