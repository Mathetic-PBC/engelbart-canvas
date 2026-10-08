import React from 'react';
import DocEditor from './DocEditor.jsx';
import { isUntitled } from '../model/names.js';

// One document of the middle column (MATH-23): its title, the notice when another window saved over edits here, and its
// editor. Pane 0 is the document in front (the tab), with the footer's Copy, Build and Clear; pane 1 is a note or a
// workspace's document opened beside it from a mention (model/panes.js), Andy Matuschak's working notes style, with a ×
// in its header instead. The two sit side by side, each half the column (Workspace.jsx): neither covers the other.

const FOOT_BUTTON = { padding: '3px 6px', border: 0, borderRadius: 5, background: '#fff', cursor: 'pointer', font: '400 15px/1.4 var(--font-sans)', color: '#8f8f8f', transition: 'color 120ms' };

export default function DocPane({
  index, kind = 'note', editorRef, docKey, text, readOnly = false, title, onRename, titleFocus,
  conflict, onKeepMine, onTakeTheirs, onClose, empty, editor, style,
}) {
  // The title is a field of its own: a draft while it is typed, named on Enter or when the caret leaves it. An untitled
  // name is its hint, not its value.
  const shown = isUntitled(title) ? '' : title || '';
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => { setDraft(shown); }, [shown, docKey]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === title || readOnly || !onRename) { setDraft(shown); return; }
    onRename(next);
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <input
        ref={(element) => { if (element && titleFocus && titleFocus.current) { titleFocus.current = false; element.focus(); } }}
        value={draft}
        readOnly={readOnly}
        onChange={(event) => setDraft(event.target.value.replace(/[/\\]/g, '-'))} // a title is a file name: slashes become hyphens as you type
        onBlur={commit}
        onKeyDown={(event) => {
          // Escape leaves the title, and that is all it does: marked as used, so the window's Escape (leaving the full
          // screen) leaves it alone.
          if (event.key === 'Escape') { event.preventDefault(); event.target.blur(); return; }
          if (event.key !== 'Enter') return;
          // Enter names the document and drops the caret into it.
          event.preventDefault();
          event.target.blur();
          if (editorRef && editorRef.current && editorRef.current.focusStart) editorRef.current.focusStart();
        }}
        placeholder={isUntitled(title) ? title : 'Untitled'}
        data-doc-title="1"
        aria-label="Title"
        spellCheck={false}
        style={{ display: 'block', flex: '1 1 auto', minWidth: 0, width: '100%', padding: 0, border: 0, background: 'transparent', font: '500 22px/1.35 var(--font-sans)', letterSpacing: '-0.3px', color: '#171717' }}
      />
      {onClose && <button type="button" className="hov-x" data-pane-close={index} onClick={onClose} aria-label="Close the pane beside" title="Close" style={{ flex: 'none', width: 26, height: 26, marginTop: 2, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '18px/1 var(--font-sans)', color: '#8f8f8f', transition: 'background 120ms' }}>×</button>}
    </div>
  );

  return (
    <section data-doc-pane={index} aria-label={index === 0 ? 'Document' : `${kind === 'workspace' ? 'Workspace' : 'Note'}: ${title || 'Untitled'}`} style={{ position: 'relative', minWidth: 0, minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: '#fff', ...style }}>
      {conflict && (
        <div role="alert" data-doc-conflict="1" data-overlay="1" style={{ position: 'absolute', top: 10, right: 16, zIndex: 30, display: 'flex', alignItems: 'center', gap: 4, maxWidth: 'calc(100% - 32px)', padding: '5px 6px 5px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', boxShadow: '0 4px 14px #0000000f', font: '12.5px/1.4 var(--font-sans)', color: '#4d4d4d' }}>
          <span style={{ marginRight: 6 }}>Saved in another window while you were editing.</span>
          <button type="button" className="hov-ink" data-conflict-keep="1" onClick={onKeepMine} title="Save your version over theirs" style={{ ...FOOT_BUTTON, font: '500 12.5px/1.4 var(--font-sans)', color: '#171717' }}>Keep mine</button>
          <button type="button" className="hov-ink" data-conflict-take="1" onClick={onTakeTheirs} title="Show their version and drop your unsaved edits here" style={{ ...FOOT_BUTTON, font: '12.5px/1.4 var(--font-sans)' }}>Take theirs</button>
        </div>
      )}
      {docKey && text !== undefined ? (
        <DocEditor {...editor} ref={editorRef} docKey={docKey} text={text} readOnly={readOnly} header={header} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          {empty || <span style={{ font: '13px/1.6 var(--font-sans)', color: '#8f8f8f' }}>Opening…</span>}
        </div>
      )}
    </section>
  );
}
