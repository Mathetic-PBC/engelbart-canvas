import PaperView from '../pdf/PaperView.jsx';
import TerminalPane from '../terminal/TerminalPane.jsx';
import Browser from './Browser.jsx';
import RepoPane from './RepoPane.jsx';

// Right pane (design 2026-09-17): edge to edge, no padding; the switcher lives in the header.
// Browser | Terminal | Paper | Repo. Browser and Terminal stay mounted while hidden.

export const RIGHT_MODES = [
  { id: 'preview', label: 'Browser' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'paper', label: 'Paper' },
  { id: 'repo', label: 'Repo' },
];

export default function RightPane({ mode, repositories, repoId, onRepo, paper, onMarksChange, projectDir, projectId, onExpand, onPage, save, style }) {
  return (
    <section aria-label="Preview" style={style}>
      {mode === 'repo' && <RepoPane repositories={repositories} selectedId={repoId} onSelect={onRepo} />}
      <Browser projectId={projectId} visible={mode === 'preview'} onExpand={onExpand} onPage={onPage} save={save} />
      <TerminalPane cwd={projectDir} projectId={projectId} visible={mode === 'terminal'} />
      {mode === 'paper' && (
        paper && paper.bytes
          ? <PaperView key={paper.id} bytes={paper.bytes} title={paper.name} marks={paper.marks} onMarksChange={(marks) => onMarksChange(paper.id, marks)} />
          : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid #eaeaea', font: '13px/1.5 var(--font-sans)', color: '#8f8f8f', textAlign: 'center', padding: 24 }}>
                {paper && paper.loading ? 'Opening the paper…' : paper && paper.error ? paper.error : 'Open a paper from the sidebar or an @mention to read it here.'}
              </div>
            </div>
          )
      )}
    </section>
  );
}
