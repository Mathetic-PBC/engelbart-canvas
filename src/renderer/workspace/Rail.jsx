import React from 'react';
import { KIND, kindOf } from '../ui/Icons.jsx';

// The sidebar, from the updated Goal Canvas.dc.html (2026-09-16 21:09): the current topic as
// a header (status mark, editable name, "n / m") whose hover reveals the sibling topics and
// "+ New"; below it the topic's context tree (Workspace first, folders expand, double-click
// renames); "+ Context" and "+ Folder"; the Later list pinned to the bottom.

const FOLDER = (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.5H3a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
);

function markStyle(status, interactive = true) {
  const done = status === 'done';
  const prog = status === 'progress';
  const base = done
    ? { background: '#171717', color: '#fff', font: '600 9px/14px var(--font-sans)', textAlign: 'center', border: 0 }
    : { border: `1.5px ${prog ? 'dashed' : 'solid'} #171717`, background: 'transparent' };
  return { ...base, flex: 'none', width: 14, height: 14, borderRadius: '50%', padding: 0, cursor: interactive ? 'pointer' : 'default', boxSizing: 'border-box', appearance: 'none', display: 'inline-block' };
}

function statusTitle(status) {
  if (status === 'done') return 'Done — click for todo';
  if (status === 'progress') return 'In progress — click for done';
  return 'Todo — click for in progress';
}

function blurOnEnter(event) {
  if (event.key === 'Enter' || event.key === 'Escape') event.target.blur();
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

function TopicHeader({ topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic }) {
  const [hover, setHover] = React.useState(false);
  const [draft, setDraft] = React.useState(topic ? topic.name : '');
  const timer = React.useRef(null);
  React.useEffect(() => { setDraft(topic ? topic.name : ''); }, [topic && topic.id, topic && topic.name]);
  const index = topic ? topics.findIndex((candidate) => candidate.id === topic.id) : -1;
  const open = () => { clearTimeout(timer.current); setHover(true); };
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 120); };
  const commit = () => {
    const next = draft.trim();
    if (!topic) return;
    if (!next || next === topic.name) { setDraft(topic.name); return; }
    onRenameTopic(next);
  };
  return (
    <div onMouseEnter={open} onMouseLeave={close} style={{ position: 'relative', padding: '0 0 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 12px' }}>
        {topic
          ? <button type="button" onClick={() => onCycleTopic(topic)} title={statusTitle(topic.status)} aria-label={statusTitle(topic.status)} style={markStyle(topic.status)}>{topic.status === 'done' ? '✓' : ''}</button>
          : <span style={markStyle('open', false)} />}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={blurOnEnter}
          placeholder={topic ? '' : 'no topic yet…'}
          disabled={!topic}
          aria-label="Name"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '600 14px/1.5 var(--font-sans)', color: '#171717' }}
        />
        <span style={{ flex: 'none', font: '11px/1 var(--font-sans)', color: '#8f8f8f' }}>{topics.length ? `${index + 1} / ${topics.length}` : '0 / 0'}</span>
      </div>
      {hover && (
        <div style={{ position: 'absolute', left: 8, right: 8, top: '100%', zIndex: 30, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
          {topics.map((candidate) => {
            const on = topic && candidate.id === topic.id;
            return (
              <div key={candidate.id} className="hov-wash" onClick={() => { setHover(false); onSelectTopic(candidate.id); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: on ? '#fafafa' : 'transparent', transition: 'background 120ms' }}>
                <span style={markStyle(candidate.status, false)}>{candidate.status === 'done' ? '✓' : ''}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 13.5px/1.5 var(--font-sans)`, color: '#171717' }}>{candidate.name}</span>
              </div>
            );
          })}
          <div className="hov-ink-wash" onClick={() => { setHover(false); onAddTopic(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', color: '#8f8f8f', transition: 'color 120ms' }}>
            <span style={{ flex: 'none', width: 14, textAlign: 'center', font: '500 13px/1 var(--font-sans)' }}>+</span>
            <span style={{ font: '13.5px/1.5 var(--font-sans)' }}>New</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeRow({ row, onClick, onRenameStart, onRename, onRenameEnd }) {
  const inputRef = React.useRef(null);
  const [draft, setDraft] = React.useState(row.name);
  React.useEffect(() => { setDraft(row.name); }, [row.name, row.editing]);
  React.useEffect(() => {
    if (row.editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [row.editing]);
  const glyph = row.type === 'workspace' ? KIND.workspace.glyph : row.type === 'folder' ? FOLDER : kindOf(row).glyph;
  const commit = () => {
    const next = draft.trim();
    if (next && next !== row.name) onRename(row, next);
    onRenameEnd();
  };
  return (
    <div
      className="hov-wash"
      onClick={() => { if (!row.editing) onClick(row); }}
      onDoubleClick={(event) => { if (row.type === 'workspace') return; event.stopPropagation(); onRenameStart(row); }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', marginLeft: row.depth * 18, borderRadius: 6, cursor: 'pointer', background: row.on ? '#fff' : 'transparent', boxShadow: row.on ? '0 1px 3px #0000000a, 0 0 0 1px #eaeaea' : 'none', transition: 'background 120ms' }}
    >
      <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717', fontSize: row.type === 'workspace' ? 12 : 15, lineHeight: 1 }}>{glyph}</span>
      {row.editing
        ? (
          <input
            ref={inputRef}
            data-rename={row.id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={blurOnEnter}
            onClick={(event) => event.stopPropagation()}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: '#171717' }}
          />
        )
        : <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: '#171717' }}>{row.name}</span>}
      {row.type === 'folder' && <span style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{row.open ? '⌃' : '›'}</span>}
    </div>
  );
}

export default function Rail({
  width, topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic,
  rows, onRowClick, onRowRenameStart, onRowRename, onRowRenameEnd,
  onAddContext, onAddFolder, ideas, onIdeasChange, onAddIdea,
}) {
  return (
    <aside aria-label="Sidebar" style={{ flex: 'none', width, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 5, overflow: 'auto', background: '#fafafa' }}>
      <TopicHeader topics={topics} topic={topic} onSelectTopic={onSelectTopic} onCycleTopic={onCycleTopic} onRenameTopic={onRenameTopic} onAddTopic={onAddTopic} />
      {rows.map((row) => (
        <TreeRow key={row.id} row={row} onClick={onRowClick} onRenameStart={onRowRenameStart} onRename={onRowRename} onRenameEnd={onRowRenameEnd} />
      ))}
      <div style={{ display: 'flex', gap: 4, padding: '6px 0 0 6px' }}>
        <div className="hov-ink-wash" onClick={onAddContext} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' }}>+ Context</div>
        <div className="hov-ink-wash" onClick={onAddFolder} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' }}>+ Folder</div>
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 22 }}>
        {ideas.map((idea, index) => (
          <IdeaRow
            key={idea.id}
            idea={idea}
            onChange={(text) => onIdeasChange(ideas.map((candidate, i) => (i === index ? { ...candidate, text } : candidate)))}
            onEnter={onAddIdea}
            onRemove={() => onIdeasChange(ideas.filter((_, i) => i !== index))}
          />
        ))}
        <div className="hov-ink" onClick={onAddIdea} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' }}>+ Later</div>
      </div>
    </aside>
  );
}
