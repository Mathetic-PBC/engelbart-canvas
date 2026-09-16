import React from 'react';
import { KIND, kindOf } from '../ui/Icons.jsx';

// "Add context to {topic}" (design lines 331–364). Two options only: a new note in this topic,
// or an existing library item (no import — spec §2 #7).

export default function CtxModal({ topic, library, onClose, onNewNote, onAttach }) {
  const [step, setStep] = React.useState(null);
  const candidates = library.filter((row) => !topic.context.includes(row.id) && row.type !== 'note');
  const options = [
    { id: 'note', glyph: KIND.note.glyph, title: 'New note', why: 'A blank note in this topic. Opens in a new tab.', click: onNewNote },
    { id: 'library', glyph: KIND.dataset.glyph, title: 'Library', why: `A paper, dataset, repository or link already in your library · ${candidates.length} available.`, expands: true },
  ];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', background: 'rgba(255,255,255,.55)' }}>
      <div onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Add context" style={{ width: 'min(460px, calc(100vw - 32px))', padding: '18px 18px 14px', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.06)', animation: 'rise 220ms cubic-bezier(.25,.1,.25,1)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '0 2px 12px' }}>
          <span style={{ font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' }}>Add context to {topic.name}</span>
          <button type="button" className="hov-ink" onClick={onClose} aria-label="Close" style={{ padding: '0 4px', border: 0, background: 'transparent', cursor: 'pointer', font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', background: '#fafafa', border: '1px solid #eaeaea', borderRadius: 8, overflow: 'hidden' }}>
          {options.map((option, index) => {
            const active = step === option.id;
            return (
              <div key={option.id} style={{ borderTop: `1px solid ${index ? '#eaeaea' : 'transparent'}` }}>
                <div className="hov-wash" onClick={option.click || (() => setStep(active ? null : option.id))} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', cursor: 'pointer', background: active ? '#fff' : 'transparent', transition: 'background 120ms' }}>
                  <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717', font: '500 13px/1 var(--font-sans)' }}>{option.glyph}</span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: '500 14px/1.4 var(--font-sans)', color: '#171717' }}>{option.title}</span>
                    <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{option.why}</span>
                  </span>
                  <span style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{option.expands ? (active ? '⌃' : '›') : '›'}</span>
                </div>
                {active && option.id === 'library' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 8px 10px 40px', animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
                    {candidates.length === 0 && <span style={{ padding: '6px 8px', font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>everything in the library is already attached</span>}
                    {candidates.map((row) => {
                      const kind = kindOf(row);
                      return (
                        <div key={row.id} className="hov-wash" onClick={() => onAttach(row)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: 'pointer' }}>
                          <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', font: '500 12px/1 var(--font-sans)' }}>{kind.glyph}</span>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
                          <span style={{ flex: 'none', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{kind.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
