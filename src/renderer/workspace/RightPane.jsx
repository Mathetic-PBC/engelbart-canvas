import React from 'react';
import PaperView from '../pdf/PaperView.jsx';
import TerminalPane from '../terminal/TerminalPane.jsx';

// Right pane (design lines 192–328): Live preview | Paper | Dataset. Live preview and Dataset
// are placeholders for now; the terminal below the preview is the real thing.

const MODES = [
  { id: 'preview', label: 'Live preview' },
  { id: 'paper', label: 'Paper' },
  { id: 'dataset', label: 'Dataset' },
];

function Placeholder({ label }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>
      placeholder{label ? ` · ${label}` : ''}
    </div>
  );
}

export default function RightPane({ mode, onMode, paper, onMarksChange, projectDir, projectId, style }) {
  return (
    <section aria-label="Preview" style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 38, borderBottom: '1px solid #eaeaea', flex: 'none' }}>
        {MODES.map((candidate) => {
          const on = mode === candidate.id;
          return (
            <button key={candidate.id} type="button" className="hov-ink" onClick={() => onMode(candidate.id)} style={{ flex: 'none', padding: '10px 0 12px', marginBottom: -1, border: 0, borderBottom: `2px solid ${on ? '#171717' : 'transparent'}`, background: 'transparent', font: `${on ? 600 : 400} 13px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 120ms' }}>
              {candidate.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: mode === 'preview' ? 'flex' : 'none', flexDirection: 'column', gap: 10, paddingTop: 14 }}>
        <div style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #eaeaea', flex: 'none' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9c9c9' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9c9c9' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#c9c9c9' }} />
            <span style={{ marginLeft: 8, flex: 1, height: 16, padding: '0 8px', borderRadius: 4, background: '#fafafa', font: '10px/16px var(--font-mono)', color: '#8f8f8f', overflow: 'hidden', whiteSpace: 'nowrap' }}>live preview</span>
          </div>
          <Placeholder label="live preview" />
        </div>
        <TerminalPane cwd={projectDir} projectId={projectId} visible={mode === 'preview'} style={{ flex: 'none', height: '46%', minHeight: 210 }} />
      </div>

      {mode === 'paper' && (
        paper && paper.bytes
          ? <PaperView key={paper.id} bytes={paper.bytes} title={paper.name} marks={paper.marks} onMarksChange={(marks) => onMarksChange(paper.id, marks)} />
          : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14 }}>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eaeaea', borderRadius: 8, font: '13px/1.5 var(--font-sans)', color: '#8f8f8f', textAlign: 'center', padding: 24 }}>
                {paper && paper.loading ? 'Opening the paper…' : paper && paper.error ? paper.error : 'Open a paper from the rail or an @mention to read it here.'}
              </div>
            </div>
          )
      )}

      {mode === 'dataset' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
          <Placeholder label="dataset" />
        </div>
      )}
    </section>
  );
}
