import React from 'react';

// "Questions to investigate" ("Suggested places to start" until 2026-10-08; 2026-10-07, onboarding as brainstorm cards;
// design/onboarding-brainstorm/6-workspace.dc.html, its inline styles' values): under the title of the workspace
// onboarding made, the three sub-questions Bart wrote from the person's answers (meta.json `starts`,
// src/main/store/projects.cjs). A click edits one in place (Enter or leaving keeps it, Escape does not).
// Build 2 (2026-10-08): under each, its climb (src/main/bart/climbs.cjs): the approved rungs in order, each "paper · part"
// and its one line, "what you'll learn here" (and a one-line gloss when it has one); a click opens the paper at its passage
// in the Stage, highlighted as Bart's guide (`onOpenRung`). Later rungs appear as each is approved, "Bart is checking the
// next step…" under them meanwhile. A step that is not a paper ("Add your data: …") opens the file picker (`onAction`).
// Papers whose text could not be had are listed apart, "More reading, not checked". The caret on a sub-question shows or
// hides its climb: the first is open, as in the design.
// Follow-ups (2026-10-08, from a hand test): the heading is "Questions to investigate"; a sub-question is a row of a
// disclosure triangle and its words, nothing else (no dashed circle, number, "Bart's suggestion" or ×): sub-questions
// cannot be deleted, only edited. A paper is a row of its title, "author year · section" and its one line. Nothing shown
// goes: a climb is shown under its sub-question whatever words it was made for (an edited one keeps what it showed, and
// its new climb adds to it). When OpenAlex refused the searches (status 'unavailable'), the block says so under the
// sub-questions; they are climbed again the next time the workspace shows.

const CARET_OPEN = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-7 9z" fill="#6B6F76" /></svg>;
const CARET_SHUT = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l9-7z" fill="#6B6F76" /></svg>;
const CARET_DOWN = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-7 9z" fill="#8A8F98" /></svg>;
const CARET_RIGHT = <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l9-7z" fill="#8A8F98" /></svg>;

const DOC = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B6F76" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>;
const PLUS = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B6F76" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2 }}><path d="M12 5v14M5 12h14" /></svg>;
const ENTRY = { width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', border: 0, borderRadius: 7, background: 'transparent', font: '13px/1.45 var(--font-sans)', color: '#1F2633', textAlign: 'left', cursor: 'pointer' };
const QUIET = { padding: '4px 10px 6px 38px', font: 'italic 12.5px/1.5 var(--font-sans)', color: '#8A8F98' };

/** One rung: a paper as a row (its title, "Kapur 2008 · Method", its one line, and its gloss when it has one), or a step. */
function Rung({ rung, active, onOpen }) {
  const action = rung.kind === 'action';
  const approval = rung.approval || {};
  const title = action ? approval.note || '' : `Approved by ${approval.model || 'Bart'}${approval.effort ? ` (${approval.effort})` : ''}, who read the passage in its paper${approval.at ? `, ${new Date(approval.at).toLocaleString()}` : ''}`;
  return (
    <li>
      <button type="button" className="hov-wash" data-rung={rung.id} data-rung-kind={rung.kind} aria-current={active ? 'true' : undefined} title={title} onClick={onOpen} style={{ ...ENTRY, background: active ? '#EFEEEA' : 'transparent' }}>
        {action ? PLUS : DOC}
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span data-rung-title="1" style={{ fontWeight: 500 }}>{action ? rung.title : (rung.paper && rung.paper.title) || rung.label}</span>
          {!action && <span data-rung-where="1" style={{ font: '12px/1.45 var(--font-sans)', color: '#8A8F98' }}>{rung.label} · {rung.part}</span>}
          <span style={{ color: '#77746E' }}>{rung.line}</span>
          {!action && rung.gloss && <span data-rung-gloss="1" style={{ font: 'italic 12.5px/1.45 var(--font-sans)', color: '#8A8F98' }}>{rung.gloss}</span>}
        </span>
      </button>
    </li>
  );
}

/** A sub-question's climb as it stands: its approved rungs, what is still being checked, and the reading not checked. */
function Climb({ climb, activeRung, onOpenRung, onAction, onOpenMore }) {
  if (!climb) return <div data-starts-finding="1" style={QUIET}>Finding papers…</div>;
  const rungs = climb.rungs || [];
  const unavailable = climb.status === 'unavailable';
  const busy = climb.status !== 'done' && !unavailable;
  return (
    <div data-climb={climb.status} style={{ display: 'flex', flexDirection: 'column' }}>
      {rungs.length > 0 && (
        <ul style={{ margin: 0, padding: '0 0 0 26px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {rungs.map((rung) => <Rung key={rung.id} rung={rung} active={activeRung === rung.id} onOpen={() => (rung.kind === 'action' ? onAction(rung) : onOpenRung(rung))} />)}
        </ul>
      )}
      {busy && <div data-climb-busy="1" style={QUIET}>{rungs.length ? 'Bart is checking the next step…' : 'Finding papers…'}</div>}
      {unavailable && !rungs.length && <div data-climb-unavailable="1" style={QUIET}>No papers yet: OpenAlex isn’t answering.</div>}
      {!busy && (climb.more || []).length > 0 && (
        <div data-climb-more="1" style={{ padding: '6px 10px 4px 38px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: '600 11.5px/1.5 var(--font-sans)', color: '#8A8F98' }}>More reading, not checked</span>
          {climb.more.map((one) => (
            <button key={one.id} type="button" className="hov-ink" onClick={() => onOpenMore(one.url)} title={one.title} style={{ padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', font: '12.5px/1.5 var(--font-sans)', color: '#77746E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{one.label} · {one.title}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function Start({ start, n, open, onToggle, climb, activeRung, onOpenRung, onAction, onOpenMore, onChange }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(start.text);
  React.useEffect(() => { if (!editing) setDraft(start.text); }, [start.text, editing]);
  const commit = () => {
    setEditing(false);
    const text = draft.replace(/\s+/g, ' ').trim();
    if (text && text !== start.text) onChange(text); else setDraft(start.text);
  };
  return (
    <li data-start={start.id} data-start-by={start.by} style={{ display: 'flex', flexDirection: 'column', paddingBottom: open ? 6 : 0 }}>
      <div className="hov-wash" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, padding: '0 10px 0 4px', borderRadius: 8, font: '14px/1.45 var(--font-sans)', color: '#1F2633' }}>
        <button type="button" data-start-toggle="1" onClick={onToggle} aria-expanded={open} aria-label={open ? `Hide the papers for question ${n}` : `Show the papers for question ${n}`} style={{ flex: 'none', width: 22, height: 22, padding: 0, border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{open ? CARET_DOWN : CARET_RIGHT}</button>
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
            aria-label={`Question ${n}`}
            data-start-edit="1"
            spellCheck={false}
            style={{ flex: '1 1 auto', minWidth: 0, padding: '2px 0', border: 0, borderBottom: '1px solid #c9c9c9', background: 'transparent', outline: 'none', font: '500 14px/1.45 var(--font-sans)', color: '#1F2633' }}
          />
        ) : (
          <button type="button" data-start-text="1" onClick={() => setEditing(true)} title="Click to edit" style={{ flex: '1 1 auto', minWidth: 0, padding: '9px 0', border: 0, background: 'transparent', font: '500 14px/1.45 var(--font-sans)', color: '#1F2633', textAlign: 'left', cursor: 'text' }}>{start.text}</button>
        )}
      </div>
      {open && <Climb climb={climb} activeRung={activeRung} onOpenRung={onOpenRung} onAction={onAction} onOpenMore={onOpenMore} />}
    </li>
  );
}

/**
 * The climb kept for a start, whatever words it was made for: what was shown under a sub-question stays when it is
 * edited (its new climb adds to it). null before it has one.
 */
export function climbFor(start, climbs) {
  return (climbs && climbs[start.id]) || null;
}

/**
 * `starts`: [{ id, text, by }]. `onSave(next)`: the list as edited (an edited one is the person's, `by: 'you'`); none is
 * ever taken out. `climbs` { <start id>: climb }; `onOpenRung(rung)`, `onAction(rung)`, `onOpenMore(url)`; `activeRung`:
 * the rung last opened.
 */
export default function StartsBlock({ starts, onSave, climbs = {}, activeRung = null, onOpenRung = () => {}, onAction = () => {}, onOpenMore = () => {} }) {
  const [open, setOpen] = React.useState(true);
  const [shut, setShut] = React.useState(() => new Set((starts || []).slice(1).map((one) => one.id))); // the design: the first open
  if (!starts || !starts.length) return null;
  const unavailable = starts.some((start) => { const climb = climbFor(start, climbs); return climb && climb.status === 'unavailable'; });
  const change = (id, text) => onSave(starts.map((one) => (one.id === id ? { ...one, text, by: 'you' } : one)));
  const toggle = (id) => setShut((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <section data-starts="1" aria-label="Questions to investigate" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 26, paddingBottom: 10, borderBottom: '1px solid #EFEDE8' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px 4px 2px' }}>
        <button type="button" data-starts-toggle="1" onClick={() => setOpen((now) => !now)} aria-expanded={open} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 28, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', font: '600 12px/1 var(--font-sans)', color: '#6B6F76', cursor: 'pointer' }}>
          {open ? CARET_OPEN : CARET_SHUT}<span style={{ whiteSpace: 'nowrap' }}>Questions to investigate</span>
        </button>
        <span style={{ flex: '1 1 auto' }} />
      </div>
      {open && (
        <ol style={{ margin: 0, padding: '0 0 0 4px', listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
          {starts.map((start, i) => (
            <Start
              key={start.id}
              start={start}
              n={i + 1}
              open={!shut.has(start.id)}
              onToggle={() => toggle(start.id)}
              climb={climbFor(start, climbs)}
              activeRung={activeRung}
              onOpenRung={onOpenRung}
              onAction={onAction}
              onOpenMore={onOpenMore}
              onChange={(text) => change(start.id, text)}
            />
          ))}
        </ol>
      )}
      {open && unavailable && <div data-starts-unavailable="1" role="status" style={{ padding: '2px 10px 4px 42px', font: '12.5px/1.5 var(--font-sans)', color: '#77746E' }}>OpenAlex, where Bart finds papers, isn’t available right now. Bart will look again the next time this workspace opens.</div>}
    </section>
  );
}
