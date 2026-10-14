// The menu under a Brainstorm conversation's topic chip (2026-10-14; DocEditor topicChipHtml): Rename topic changes the
// label alone, with no reply; Change topic takes a new topic and asks Brainstorm to go on from it, the conversation kept
// (DocEditor changeTopic). Either opens a field in the menu: Enter does it, Escape or a click outside closes the menu.
import React from 'react';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';

// A row that does something (the model picker's rows choose, and carry a mark; these do not).
function Action({ label, disabled = false, title = '', onPick }) {
  const [over, setOver] = React.useState(false);
  return (
    <div role="menuitem" aria-disabled={disabled} title={title || undefined} onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)} onMouseDown={(e) => { e.preventDefault(); if (!disabled) onPick(); }} style={{ display: 'flex', alignItems: 'center', height: 32, padding: '0 10px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', background: over && !disabled ? '#f2f2f2' : 'transparent', font: '13px/1 var(--font-sans)', color: disabled ? '#8f8f8f' : '#171717' }}>{label}</div>
  );
}
const FIELDS = {
  rename: { label: 'Rename topic', placeholder: 'Topic', send: 'Rename' },
  change: { label: 'Change topic', placeholder: 'What do you want to talk about now?', send: 'Change' },
};

// `topic`: the label now. `canChange`: false while Brainstorm is answering (a follow-up waits for its answer).
export default function TopicMenu({ anchor, topic, canChange = true, onRename, onChange, onClose }) {
  const [ref, placed] = usePlaced(anchor, { align: 'start' });
  const [mode, setMode] = React.useState(null);
  const [value, setValue] = React.useState('');
  const field = React.useRef(null);
  React.useEffect(() => {
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !(e.target.closest && e.target.closest('[data-act="topic"]'))) onClose(); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose, ref]);
  React.useEffect(() => { if (mode && field.current) { field.current.focus({ preventScroll: true }); field.current.select(); } }, [mode]);
  const open = (next) => { setMode(next); setValue(next === 'rename' ? topic : ''); };
  const done = () => {
    const said = value.replace(/\s+/g, ' ').trim();
    if (!said) return;
    if (mode === 'rename') { if (said !== topic) onRename(said); onClose(); return; }
    onChange(said); onClose();
  };
  const key = (e) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); done(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  const look = FIELDS[mode];
  return (
    <div ref={ref} data-topic-menu="1" data-overlay="1" role="dialog" aria-label="Topic" onMouseDown={(e) => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }} style={{ ...placed, zIndex: 60, width: 220, boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, animation: `rise 160ms ${EASE}` }}>
      {!look ? (
        <div role="menu" aria-label="Topic" style={{ padding: 4 }}>
          <Action label="Rename topic" onPick={() => open('rename')} />
          <Action label="Change topic" disabled={!canChange} title={canChange ? '' : 'Once Brainstorm has answered'} onPick={() => open('change')} />
        </div>
      ) : (
        <div style={{ padding: 6 }}>
          <div style={{ padding: '2px 4px 6px', font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{look.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input ref={field} data-topic-input={mode} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={key} placeholder={look.placeholder} aria-label={look.label} spellCheck={false} autoComplete="off" maxLength={200} style={{ flex: 1, minWidth: 0, height: 30, boxSizing: 'border-box', padding: '0 8px', border: '1px solid #eaeaea', borderRadius: 8, outline: 'none', font: '13px/1 var(--font-sans)', color: '#171717', background: '#fff' }} />
            <button type="button" data-topic-send={mode} disabled={!value.trim()} onClick={done} style={{ flex: 'none', height: 30, padding: '0 10px', border: 0, borderRadius: 8, background: value.trim() ? '#171717' : '#f2f2f2', color: value.trim() ? '#fff' : '#8f8f8f', font: '500 12px/1 var(--font-sans)', cursor: value.trim() ? 'pointer' : 'default' }}>{look.send}</button>
          </div>
        </div>
      )}
    </div>
  );
}
