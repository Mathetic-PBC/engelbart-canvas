import React from 'react';
import TerminalPane from '../terminal/TerminalPane.jsx';
import Stage from './Stage.jsx';

// Right pane (design 2026-09-17; Stage 2026-09-23): edge to edge, no padding; the switcher lives in the header.
// Stage | Terminal — the Browser and the Paper pane are one Stage now (Add - Mention Stage.dc.html). Both stay mounted while hidden.

export const RIGHT_MODES = [
  { id: 'stage', label: 'Stage' },
  { id: 'terminal', label: 'Terminal' },
];

// `onOpenItem`, `mentionItems` and `onMentionOpen` (MATH-21) are for a pdf's margin notes, which mention library items.
// `pendingAsks`, `onAsk`, `onStopAsk`, `onDismissAsk`, `onContinueAsk` and `onCopyText` (MATH-27) are @bart on a highlight.
const RightPane = React.forwardRef(function RightPane({ mode, projectDir, projectId, full, onFull, onShowStage, onPage, onFront, save, library, inRail, onError, onOpenItem, mentionItems, onMentionOpen, pendingAsks, onAsk, onStopAsk, onDismissAsk, onContinueAsk, onCopyText, style }, stageRef) {
  return (
    <section aria-label="Right pane" style={style}>
      <Stage ref={stageRef} projectId={projectId} visible={mode === 'stage'} full={full} onFull={onFull} onShow={onShowStage} onPage={onPage} onFront={onFront} save={save} library={library} inRail={inRail} onError={onError} onOpenItem={onOpenItem} mentionItems={mentionItems} onMentionOpen={onMentionOpen} pendingAsks={pendingAsks} onAsk={onAsk} onStopAsk={onStopAsk} onDismissAsk={onDismissAsk} onContinueAsk={onContinueAsk} onCopyText={onCopyText} />
      <TerminalPane cwd={projectDir} projectId={projectId} visible={mode === 'terminal'} full={full} onFull={onFull} />
    </section>
  );
});

export default RightPane;
