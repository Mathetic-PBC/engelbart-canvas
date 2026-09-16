import React from 'react';
import { KIND, kindOf } from '../ui/Icons.jsx';

// The left rail: Topics / Notes / Future. Port of Goal Canvas.dc.html lines 114–164 and the
// topic/note/idea view models at lines 1027–1040.

const SECTION = { padding: '22px 12px 14px', font: '600 11px/1.3 var(--font-sans)', color: '#4d4d4d' };
const ADD = { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' };

function markStyle(status, active) {
  const done = status === 'done';
  const prog = status === 'progress';
  const base = { flex: 'none', width: 14, height: 14, padding: 0, cursor: 'pointer', boxSizing: 'border-box', appearance: 'none', borderRadius: '50%' };
  if (done) return { ...base, border: 0, background: '#171717', color: '#fff', font: '600 9px/14px var(--font-sans)', textAlign: 'center' };
  return { ...base, background: 'transparent', border: `1.5px ${prog ? 'dashed' : 'solid'} ${prog || active ? '#171717' : '#c9c9c9'}` };
}

function statusTitle(status) {
  if (status === 'done') return 'Done — click for todo';
  if (status === 'progress') return 'In progress — click for done';
  return 'Todo — click for in progress';
}

function IdeaRow({ idea, onChange, onEnter, onRemove }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [idea.text]);
  React.useEffect(() => {
    if (idea.focus && ref.current) ref.current.focus();
  }, [idea.focus]);
  return (
    <div data-idea-row="1" className="hov-wash" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 12px', borderRadius: 8 }}>
      <span style={{ flex: 'none', marginTop: 4, width: 14, textAlign: 'center', font: '14px/1 var(--font-sans)', color: '#8f8f8f' }}>–</span>
      <textarea
        ref={ref}
        rows={1}
        spellCheck={false}
        value={idea.text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onEnter();
          }
          if (event.key === 'Escape') event.target.blur();
        }}
        onBlur={() => { if (!idea.text.trim()) onRemove(); }}
        style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', resize: 'none', overflow: 'hidden', font: '14px/1.5 var(--font-sans)', color: '#171717', fieldSizing: 'content' }}
      />
      <button type="button" onClick={onRemove} aria-label="Remove idea" className="hov-del-show focus-show" style={{ flex: 'none', marginTop: 3, padding: '0 2px', border: 0, background: 'transparent', font: '14px/1 var(--font-sans)', color: '#c9c9c9', cursor: 'pointer', opacity: 0, transition: 'color 120ms, opacity 120ms' }} />
    </div>
  );
}

export default function Rail({
  width, topics, activeTopicId, expanded, hoverTopic, rowsFor, activeRowId, notes, activeTab, ideas,
  onSelectTopic, onCycleTopic, onTogglePin, onHoverTopic, onLeaveTopic, onOpenRow, onAddContext, onAddTopic,
  onOpenNote, onAddNote, onIdeasChange, onAddIdea,
}) {
  return (
    <aside aria-label="Topics" style={{ flex: 'none', width, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 5, overflow: 'auto', background: '#fafafa' }}>
      <div style={{ padding: '0 12px 14px', font: '600 11px/1.3 var(--font-sans)', color: '#4d4d4d' }}>Topics</div>
      {topics.map((topic) => {
        const active = topic.id === activeTopicId;
        const pinned = !!expanded[topic.id];
        const open = pinned || hoverTopic === topic.id;
        const rows = rowsFor(topic);
        return (
          <div key={topic.id} onMouseEnter={() => onHoverTopic(topic.id)} onMouseLeave={onLeaveTopic} style={{ display: 'flex', flexDirection: 'column' }}>
            <div onClick={() => onSelectTopic(topic.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8, cursor: 'pointer', background: active ? '#fff' : 'transparent', boxShadow: active ? '0 1px 3px #0000000a, 0 0 0 1px #eaeaea' : 'none', transition: 'background 120ms' }}>
              <button type="button" onClick={(event) => { event.stopPropagation(); onCycleTopic(topic); }} title={statusTitle(topic.status)} aria-label={statusTitle(topic.status)} style={markStyle(topic.status, active)}>{topic.status === 'done' ? '✓' : ''}</button>
              <span style={{ flex: 1, minWidth: 0, font: `${active ? 600 : 400} 14px/1.5 var(--font-sans)`, color: '#171717', overflowWrap: 'anywhere' }}>{topic.name}</span>
              {(pinned || active) && (
                <button type="button" className="hov-ink-wash" onClick={(event) => { event.stopPropagation(); onTogglePin(topic.id); }} title={pinned ? 'Collapse' : 'Expand'} style={{ flex: 'none', width: 22, height: 22, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#8f8f8f' }}>{pinned ? '⌃' : '›'}</button>
              )}
            </div>
            {open && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '2px 0 8px 22px', animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
                {rows.map((row) => {
                  const on = active && row.id === activeRowId;
                  const kind = row.type === 'workspace' ? KIND.workspace : kindOf(row);
                  const dark = row.type === 'workspace' || row.type === 'note';
                  return (
                    <div key={row.id} className="hov-wash" onClick={(event) => { event.stopPropagation(); onOpenRow(topic, row); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', background: on ? '#fff' : 'transparent', transition: 'background 120ms' }}>
                      <span style={{ flex: 'none', width: 18, height: 18, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', color: dark ? '#171717' : '#4d4d4d', font: '500 12px/1 var(--font-sans)' }}>{kind.glyph}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 500 : 400} 13px/1.5 var(--font-sans)`, color: '#171717' }}>{row.name}</span>
                      <span style={{ flex: 'none', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#8f8f8f' }}>{row.type === 'workspace' ? '' : kind.label}</span>
                    </div>
                  );
                })}
                <div className="hov-ink-wash" onClick={(event) => { event.stopPropagation(); onAddContext(topic); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', color: '#8f8f8f', transition: 'color 120ms' }}>
                  <span style={{ flex: 'none', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 13px/1 var(--font-sans)' }}>+</span>
                  <span style={{ font: '13px/1.5 var(--font-sans)' }}>Context</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="hov-ink" onClick={onAddTopic} style={ADD}>+ Topic</div>

      <div style={SECTION}>Notes</div>
      {notes.map((note) => {
        const on = activeTab === note.id;
        return (
          <div key={note.id} className="hov-wash" onClick={() => onOpenNote(note)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 8, cursor: 'pointer', background: on ? '#fff' : 'transparent', boxShadow: on ? '0 1px 3px #0000000a, 0 0 0 1px #eaeaea' : 'none', transition: 'background 120ms' }}>
            <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717', fontSize: 16, lineHeight: 1 }}>{KIND.note.glyph}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: '#171717' }}>{note.name}</span>
          </div>
        );
      })}
      <div className="hov-ink" onClick={onAddNote} style={ADD}>+ Note</div>

      <div style={SECTION}>Future</div>
      {ideas.map((idea, index) => (
        <IdeaRow
          key={idea.id}
          idea={idea}
          onChange={(text) => onIdeasChange(ideas.map((candidate, i) => (i === index ? { ...candidate, text } : candidate)))}
          onEnter={onAddIdea}
          onRemove={() => onIdeasChange(ideas.filter((_, i) => i !== index))}
        />
      ))}
      <div className="hov-ink" onClick={onAddIdea} style={ADD}>+ Idea</div>
    </aside>
  );
}
