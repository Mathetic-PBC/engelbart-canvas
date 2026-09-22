import React from 'react';
import { KIND, kindOf } from '../ui/Icons.jsx';
import { isUntitled } from '../model/names.js';
import { PostItIcon } from '../post-its/ProjectPostIts.jsx';

// The sidebar: the current workspace as a header (status mark, editable name, "n / m") whose
// hover reveals its sibling workspaces and "+ New"; below it the workspace's context tree
// (Workspace first; double-click renames), pasted images, and the workspaces nested inside it
// (→); then "+ Context" and "+ Workspace". Folders are gone: a nested workspace groups things.
// Under the list, in the lower left, Copy: the open document with every @mentioned file's
// content placed where it is mentioned (src/main/context/expand-mentions.cjs).

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

function TopicHeader({ topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic }) {
  const [hover, setHover] = React.useState(false);
  const shown = (value) => (value && !isUntitled(value) ? value : '');
  const [draft, setDraft] = React.useState(topic ? shown(topic.name) : '');
  const timer = React.useRef(null);
  React.useEffect(() => { setDraft(topic ? shown(topic.name) : ''); }, [topic && topic.id, topic && topic.name]);
  const index = topic ? topics.findIndex((candidate) => candidate.id === topic.id) : -1;
  const open = () => { clearTimeout(timer.current); setHover(true); };
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 120); };
  const commit = () => {
    const next = draft.trim();
    if (!topic) return;
    if (!next || next === topic.name) { setDraft(shown(topic.name)); return; }
    onRenameTopic(next);
  };
  return (
    <div onMouseEnter={open} onMouseLeave={close} style={{ position: 'relative', padding: '0 0 10px', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 12px' }}>
        {topic
          ? <button type="button" onClick={() => onCycleTopic(topic)} title={statusTitle(topic.status)} aria-label={statusTitle(topic.status)} style={markStyle(topic.status)}>{topic.status === 'done' ? '✓' : ''}</button>
          : <span style={markStyle('open', false)} />}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={blurOnEnter}
          placeholder={topic ? (isUntitled(topic.name) ? topic.name : '') : 'no workspace yet…'}
          disabled={!topic}
          aria-label="Name"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: 'transparent', font: '600 14px/1.5 var(--font-sans)', color: '#171717' }}
        />
        <span style={{ flex: 'none', font: '11px/1 var(--font-sans)', color: '#8f8f8f' }}>{topics.length ? `${index + 1} / ${topics.length}` : '0 / 0'}</span>
      </div>
      {hover && (
        <div data-overlay="1" data-workspace-menu="1" style={{ position: 'absolute', left: 8, right: 8, top: '100%', zIndex: 30, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: 'rise 160ms cubic-bezier(.25,.1,.25,1)' }}>
          {topics.map((candidate) => {
            const on = topic && candidate.id === topic.id;
            return (
              <div key={candidate.id} className="hov-wash" onClick={() => { setHover(false); onSelectTopic(candidate.id); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: on ? '#fafafa' : 'transparent', transition: 'background 120ms' }}>
                <span style={markStyle(candidate.status, false)}>{candidate.status === 'done' ? '✓' : ''}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 400} 13.5px/1.5 var(--font-sans)`, color: isUntitled(candidate.name) ? '#8f8f8f' : '#171717' }}>{candidate.name}</span>
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
  const glyph = row.type === 'workspace' || row.type === 'child' ? KIND.workspace.glyph : kindOf(row).glyph;
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
      <span style={{ flex: 'none', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717', fontSize: row.type === 'workspace' || row.type === 'child' ? 12 : 15, lineHeight: 1 }}>{glyph}</span>
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
        : <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${row.on ? 600 : 400} 14px/1.5 var(--font-sans)`, color: isUntitled(row.name) ? '#8f8f8f' : '#171717' }}>{row.name}</span>}
      {row.type === 'child' && <span title="A workspace inside this one" style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>→</span>}
    </div>
  );
}

function copiedLabel(copied) {
  const parts = ['Copied'];
  if (copied.files) parts.push(`${copied.files} file${copied.files === 1 ? '' : 's'}`);
  if (copied.missing) parts.push(`${copied.missing} missing`);
  return parts.join(' · ');
}

export default function Rail({
  width, topics, topic, onSelectTopic, onCycleTopic, onRenameTopic, onAddTopic,
  rows, onRowClick, onRowRenameStart, onRowRename, onRowRenameEnd,
  onAddContext, onAddChild, onCopy, copied, copyTitle, onPostIt,
}) {
  return (
    <aside aria-label="Sidebar" style={{ flex: 'none', width, display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      <div style={{ flex: 1, minHeight: 0, padding: '24px 16px 8px', display: 'flex', flexDirection: 'column', gap: 5, overflow: 'auto' }}>
        <TopicHeader topics={topics} topic={topic} onSelectTopic={onSelectTopic} onCycleTopic={onCycleTopic} onRenameTopic={onRenameTopic} onAddTopic={onAddTopic} />
        {rows.map((row) => (
          <TreeRow key={row.id} row={row} onClick={onRowClick} onRenameStart={onRowRenameStart} onRename={onRowRename} onRenameEnd={onRowRenameEnd} />
        ))}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 0 0 6px' }}>
          <div className="hov-ink-wash" onClick={onAddContext} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' }}>+ Context</div>
          <div className="hov-ink-wash" onClick={onAddChild} title="A workspace nested inside this one" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f', cursor: 'pointer', transition: 'color 120ms' }}>+ Workspace</div>
        </div>
      </div>
      <div style={{ flex: 'none', padding: '6px 16px 14px 22px', display: 'flex', alignItems: 'center', gap: 4 }}>
        <button type="button" className="hov-ink-wash" onClick={onCopy} disabled={!onCopy} title={copyTitle} data-copy-doc="1" style={{ padding: '6px 8px', border: 0, borderRadius: 6, background: 'transparent', font: '13px/1.4 var(--font-sans)', color: copied ? '#171717' : '#8f8f8f', cursor: onCopy ? 'pointer' : 'default', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'color 120ms' }}>{copied ? copiedLabel(copied) : 'Copy'}</button>
        <button type="button" className="hov-ink-wash" onClick={onPostIt} disabled={!onPostIt} aria-label="Add post-it" title="Add post-it" data-add-post-it="1" style={{ display: 'grid', placeItems: 'center', width: 31, height: 31, padding: 5, border: 0, borderRadius: 6, background: 'transparent', color: '#8f8f8f', cursor: 'pointer', flex: 'none' }}><PostItIcon /></button>
      </div>
    </aside>
  );
}
