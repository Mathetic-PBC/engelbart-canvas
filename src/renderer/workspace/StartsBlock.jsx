import React from 'react';

// "Suggested places to start" (2026-10-07, onboarding as brainstorm cards; design/onboarding-brainstorm/6-workspace.dc.html,
// its inline styles' values): under the title of the workspace onboarding made, the three sub-questions Bart wrote from
// the person's answers (meta.json `starts`, src/main/store/projects.cjs). Each is marked as Bart's until it is edited;
// a click edits it in place (Enter or leaving keeps it, Escape does not), its × removes it. The papers for each are build 2:
// until then a quiet "Finding places to start…" stands under them.

const CARET_OPEN = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-7 9z" fill="#6B6F76" /></svg>;
const CARET_SHUT = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l9-7z" fill="#6B6F76" /></svg>;
const OPEN_MARK = <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Open" style={{ marginTop: 12, flex: '0 0 auto' }}><circle cx="8" cy="8" r="6.2" fill="none" stroke="#8A8F98" strokeWidth="1.5" strokeDasharray="2.4 2.2" /></svg>;

function Start({ start, n, last, onChange, onRemove }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(start.text);
  React.useEffect(() => { if (!editing) setDraft(start.text); }, [start.text, editing]);
  const commit = () => {
    setEditing(false);
    const text = draft.replace(/\s+/g, ' ').trim();
    if (text && text !== start.text) onChange(text); else setDraft(start.text);
  };
  const bart = start.by === 'bart';
  return (
    <li data-start={start.id} data-start-by={start.by} className="starts-row" style={{ display: 'flex', gap: 12 }}>
      <div style={{ flex: '0 0 16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {OPEN_MARK}
        {!last && <span style={{ display: 'block', flex: '1 1 auto', width: 1, minHeight: 12, background: '#E4E2DD', marginTop: 4 }} />}
      </div>
      <div className="hov-wash" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, minHeight: 40, padding: '0 10px', borderRadius: 8, font: '14px/1.45 var(--font-sans)', color: '#1F2633' }}>
        <span style={{ flex: '0 0 auto', width: 12, fontSize: 12.5, color: '#8A8F98' }}>{n}</span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(start.text); setEditing(false); }
            }}
            aria-label={`Sub-question ${n}`}
            data-start-edit="1"
            spellCheck={false}
            style={{ flex: '1 1 auto', minWidth: 0, padding: '2px 0', border: 0, borderBottom: '1px solid #c9c9c9', background: 'transparent', outline: 'none', font: '500 14px/1.45 var(--font-sans)', color: '#1F2633' }}
          />
        ) : (
          <button type="button" data-start-text="1" onClick={() => setEditing(true)} title={bart ? 'Bart’s suggestion. Click to edit it.' : 'Click to edit'} style={{ flex: '1 1 auto', minWidth: 0, padding: '9px 0', border: 0, background: 'transparent', font: '500 14px/1.45 var(--font-sans)', color: '#1F2633', textAlign: 'left', cursor: 'text' }}>{start.text}</button>
        )}
        {bart && !editing && <span data-start-bart="1" style={{ flex: 'none', font: '11.5px/1 var(--font-sans)', color: '#8A8F98' }}>Bart’s suggestion</span>}
        <button type="button" className="hov-x starts-remove" data-start-remove="1" onClick={onRemove} aria-label={`Remove sub-question ${n}`} title="Remove" style={{ flex: 'none', width: 22, height: 22, padding: 0, border: 0, borderRadius: '50%', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '16px/1 var(--font-sans)', color: '#8A8F98' }}>×</button>
      </div>
    </li>
  );
}

/** `starts`: [{ id, text, by }]. `onSave(next)`: the list as edited (an edited one is the person's, `by: 'you'`). */
export default function StartsBlock({ starts, onSave }) {
  const [open, setOpen] = React.useState(true);
  if (!starts || !starts.length) return null;
  const change = (id, text) => onSave(starts.map((one) => (one.id === id ? { ...one, text, by: 'you' } : one)));
  const remove = (id) => onSave(starts.filter((one) => one.id !== id));
  return (
    <section data-starts="1" aria-label="Suggested places to start" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 26, paddingBottom: 4, borderBottom: '1px solid #EFEDE8' }}>
      <style>{'.starts-row .starts-remove{opacity:0;transition:opacity 120ms}.starts-row:hover .starts-remove,.starts-row .starts-remove:focus-visible{opacity:1}'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px 4px 2px' }}>
        <button type="button" data-starts-toggle="1" onClick={() => setOpen((now) => !now)} aria-expanded={open} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 28, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', font: '600 12px/1 var(--font-sans)', color: '#6B6F76', cursor: 'pointer' }}>
          {open ? CARET_OPEN : CARET_SHUT}<span style={{ whiteSpace: 'nowrap' }}>Suggested places to start</span>
        </button>
        <span style={{ flex: '1 1 auto' }} />
      </div>
      {open && (
        <>
          <ol style={{ margin: 0, padding: '0 0 0 10px', listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
            {starts.map((start, i) => <Start key={start.id} start={start} n={i + 1} last={i === starts.length - 1} onChange={(text) => change(start.id, text)} onRemove={() => remove(start.id)} />)}
          </ol>
          <div data-starts-finding="1" style={{ padding: '4px 0 14px 48px', font: 'italic 13px/1.5 var(--font-sans)', color: '#8A8F98' }}>Finding places to start…</div>
        </>
      )}
    </section>
  );
}
