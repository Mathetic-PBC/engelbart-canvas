// The selector under the @bart chip (Claude Design "Bart Selector", 2026-09-20): models on the left under a provider
// field, efforts on the right. Everything it lists comes from ~/.engelbart/model-effort-inline-question.json, cut down to
// the providers config.json offers (main: `bart-models`). It holds no choice of its own: a pick goes back to the editor,
// which writes it into the line as flags, and what is marked here is read from the line.
// Answer Card (2026-09-21): the same selector opens under a card's Regenerate, hung from its left edge, and only there it
// carries a round blue button in its lower right that regenerates with what is marked (`onSend`).
import React from 'react';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { usePlaced } from '../ui/usePlaced.js';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const WIDTH = 332;

const Mark = ({ on }) => (
  <span style={{ flex: 'none', width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', border: on ? 0 : '1.5px solid #c9c9c9', background: on ? '#171717' : 'transparent', color: '#fff', font: '600 10px/1 var(--font-sans)' }}>{on ? '✓' : ''}</span>
);

const Caret = ({ up }) => (
  <span style={{ flex: 'none', width: 10, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}><span style={{ position: 'relative', top: up ? 3 : -3 }}>{up ? '⌃' : '⌄'}</span></span>
);

function Row({ label, on, title, onPick }) {
  const [over, setOver] = React.useState(false);
  return (
    <div role="option" aria-selected={on} title={title || undefined} onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)} onMouseDown={(e) => { e.preventDefault(); onPick(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, padding: '0 8px 0 10px', borderRadius: 6, cursor: 'pointer', background: over ? '#f2f2f2' : 'transparent', font: `${on ? 500 : 400} 13px/1 var(--font-sans)`, color: '#171717' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <Mark on={on} />
    </div>
  );
}

const HEAD = { padding: '6px 10px 6px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' };

const REGENERATE = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>;

// `hover` (the default) marks it a hover preview, which post-its stay above; the Build panel's (2026-09-27) is opened by a
// click and, with `cover`, covers them as the panel does.
export default function BartPicker({ models, current, anchor, onPick, onSend, onEnter, onLeave, hover = true, cover = false }) {
  const ids = Object.keys(models.providers);
  const [viewed, setViewed] = React.useState(current.provider);
  const [listing, setListing] = React.useState(false);
  React.useEffect(() => { setViewed(current.provider); }, [current.provider]);
  const provider = models.providers[viewed] ? viewed : ids[0], entry = models.providers[provider], here = provider === current.provider;
  // A model alone keeps the effort in force when this provider offers it; an effort alone keeps the model, or starts this provider's ladder.
  const pair = (model) => (entry.ladder.find((step) => step.model === model) || { effort: entry.efforts[0] }).effort;
  const pickModel = (model) => onPick({ model, effort: here && entry.efforts.includes(current.effort) ? current.effort : pair(model) });
  const pickEffort = (effort) => onPick({ model: here ? current.model : entry.ladder[0].model, effort });
  // Measured, not estimated: under the chip, above it near the bottom of the window, cut to the room there if neither fits.
  const [ref, placed] = usePlaced(anchor, { align: anchor.left != null ? 'start' : 'end' });
  return (
    <div ref={ref} data-bart-picker="1" data-overlay="1" data-hover={hover ? '1' : undefined} data-cover={cover ? '1' : undefined} role="dialog" aria-label="Model and effort" onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => e.preventDefault()} style={{ ...placed, zIndex: 60, width: WIDTH, boxSizing: 'border-box', display: 'flex', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, animation: `rise 160ms ${EASE}` }}>
      <div style={{ flex: '1 1 0', minWidth: 0, padding: 4 }}>
        <div style={{ position: 'relative', marginBottom: 4 }}>
          <div role="button" aria-haspopup="listbox" aria-expanded={listing} onMouseDown={(e) => { e.preventDefault(); if (ids.length > 1) setListing((open) => !open); }} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: ids.length > 1 ? 'pointer' : 'default', font: '500 13px/1 var(--font-sans)', color: '#171717' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
            {ids.length > 1 && <Caret up={listing} />}
          </div>
          {listing && (
            <div role="listbox" style={{ position: 'absolute', left: 0, right: 0, top: 36, zIndex: 1, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8 }}>
              {ids.map((id) => <Row key={id} label={models.providers[id].name} on={id === provider} onPick={() => { setViewed(id); setListing(false); }} />)}
            </div>
          )}
        </div>
        <div role="listbox" aria-label="Model">
          {Object.entries(entry.models).map(([key, model]) => <Row key={key} label={model.name} title={model.use} on={here && key === current.model} onPick={() => pickModel(key)} />)}
        </div>
      </div>
      <div style={{ flex: 'none', width: 1, margin: '4px 0', background: '#eaeaea' }} />
      <div style={{ flex: 'none', width: 136, padding: 4 }}>
        <div style={{ ...HEAD, height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', marginBottom: 4 }}>Effort</div>
        <div role="listbox" aria-label="Effort">
          {entry.efforts.map((effort) => <Row key={effort} label={EFFORT_LABELS[effort] || effort} on={here && effort === current.effort} onPick={() => pickEffort(effort)} />)}
        </div>
        {onSend && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 4px 0' }}>
            <button type="button" className="bart-send" aria-label="Regenerate" onMouseDown={(e) => { e.preventDefault(); onSend(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: '50%', background: '#0070f3', color: '#fff', cursor: 'pointer' }}>{REGENERATE}</button>
          </div>
        )}
      </div>
    </div>
  );
}
