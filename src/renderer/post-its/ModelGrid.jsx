// The model and effort grid of a post-it's Build popup and of its "Needs you" card (Claude Design "Post-it Quick Task",
// 2026-09-27; the @bart selector's black and white, drawn as that design draws it): the provider field and the models on
// the left, the efforts of the model under the pointer on the right. `models` is what `build-models` returns; `choice`
// { provider, model, effort } is what is marked, and a pick goes back through `onChoose`. Each model keeps the effort it
// was last given here (`efforts`, kept by the caller), else its provider's default.
import React from 'react';
import { EFFORT_LABELS } from '../../main/bart/question.cjs';

export const EASE = 'cubic-bezier(.25,.1,.25,1)';

export const effortName = (effort) => EFFORT_LABELS[effort] || effort;
/** The provider a model key belongs to (keys are unique across providers). */
export const providerOf = (models, key) => Object.keys(models.providers).find((id) => models.providers[id].models[key]) || models.provider;
/** The effort a model starts at when picked: the one it was last given, else its provider's default when it is that model's, else the provider's first. */
export function effortFor(models, key, efforts = {}) {
  const entry = models.providers[providerOf(models, key)];
  if (efforts[key] && entry.efforts.includes(efforts[key])) return efforts[key];
  const step = entry.ladder.find((held) => held.model === key);
  if (step) return step.effort;
  return entry.efforts.includes(entry.ladder[0].effort) ? entry.ladder[0].effort : entry.efforts[0];
}
/** "Opus High": what a chip or the popup's foot says. */
export function choiceLabel(models, choice) {
  const entry = models && choice && models.providers[choice.provider];
  const model = entry && entry.models[choice.model];
  return model ? `${model.name} ${effortName(choice.effort)}` : '';
}

const HEAD = { padding: '6px 10px 8px', font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' };

export function Caret({ up }) {
  return (
    <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, font: '11px/1 var(--font-sans)', color: '#8f8f8f' }}>
      <span style={{ display: 'block', transform: `translateY(${up ? 1 : -3}px)` }}>{up ? '⌃' : '⌄'}</span>
    </span>
  );
}

function Radio({ on }) {
  return <span style={{ flex: 'none', width: 14, height: 14, boxSizing: 'border-box', borderRadius: '50%', border: `1.5px solid ${on ? '#171717' : '#c9c9c9'}`, background: on ? '#171717' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 9px/1 var(--font-sans)', color: '#fff' }}>{on ? '✓' : ''}</span>;
}

function Row({ on, lit, onPick, onEnter, children, trailing, hoverWash = true }) {
  const [over, setOver] = React.useState(false);
  return (
    <div role="option" aria-selected={on} onMouseEnter={() => { setOver(true); if (onEnter) onEnter(); }} onMouseLeave={() => setOver(false)} onMouseDown={(event) => event.preventDefault()} onClick={onPick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: lit || (hoverWash && over) ? (lit === 'white' ? '#fff' : '#f2f2f2') : 'transparent', transition: 'background 120ms' }}>
      <Radio on={on} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 500 : 400} 13px/1.4 var(--font-sans)`, color: '#171717' }}>{children}</span>
      {trailing}
    </div>
  );
}

export default function ModelGrid({ models, choice, efforts = {}, onChoose }) {
  const [viewed, setViewed] = React.useState(choice.provider); // the provider whose models are listed
  const [preview, setPreview] = React.useState(choice.model); // the model whose efforts are listed
  const [listing, setListing] = React.useState(false); // the provider field is open
  React.useEffect(() => { setViewed(choice.provider); setPreview(choice.model); }, [choice.provider, choice.model]);
  const ids = Object.keys(models.providers);
  const provider = models.providers[viewed] ? viewed : ids[0];
  const entry = models.providers[provider];
  const keys = Object.keys(entry.models);
  const shown = entry.models[preview] ? preview : keys[0];
  const markedEffort = shown === choice.model ? choice.effort : effortFor(models, shown, efforts);
  return (
    <div data-model-grid="1" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 1px minmax(0,1fr)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 8 }}>
        <div style={{ position: 'relative', margin: '0 0 6px' }}>
          <button type="button" aria-label="Provider" aria-haspopup="listbox" aria-expanded={listing} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (ids.length > 1) setListing((open) => !open); }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: `1px solid ${listing ? '#c9c9c9' : '#eaeaea'}`, borderRadius: 8, background: '#fafafa', font: '500 12.5px/1.2 var(--font-sans)', color: '#171717', cursor: ids.length > 1 ? 'pointer' : 'default', textAlign: 'left', transition: 'border-color 120ms' }}>
            <span style={{ flex: 1, minWidth: 0 }}>{entry.name}</span>
            {ids.length > 1 && <Caret up={listing} />}
          </button>
          {listing && (
            <div role="listbox" data-overlay="1" data-cover="1" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, marginTop: 4, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, animation: `rise 120ms ${EASE}` }}>
              {ids.map((id) => (
                <Row key={id} on={id === provider} lit={id === provider} onPick={() => { setViewed(id); setPreview(Object.keys(models.providers[id].models)[0]); setListing(false); }}>{models.providers[id].name}</Row>
              ))}
            </div>
          )}
        </div>
        <span style={HEAD}>Model</span>
        <div role="listbox" aria-label="Model" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {keys.map((key) => (
            <Row key={key} on={provider === choice.provider && key === choice.model} lit={key === shown} hoverWash={false} onEnter={() => setPreview(key)}
              onPick={() => onChoose({ provider, model: key, effort: effortFor(models, key, efforts) })}
              trailing={<span style={{ flex: 'none', width: 14, textAlign: 'center', font: '12px/14px var(--font-sans)', color: '#c9c9c9' }}>›</span>}>
              {entry.models[key].name}
            </Row>
          ))}
        </div>
      </div>
      <div style={{ background: '#eaeaea' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 8, background: '#fafafa' }}>
        <span style={HEAD}>Effort · {entry.models[shown].name}</span>
        <div role="listbox" aria-label="Effort" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {entry.efforts.map((effort) => {
            const on = effort === markedEffort;
            return <Row key={effort} on={on} lit={on ? 'white' : false} onPick={() => onChoose({ provider, model: shown, effort })}>{effortName(effort)}</Row>;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Where a popout goes that neighbours a panel (the design's Context search and the "Needs you" model selector): beside
 * it, bottoms level, on its right when `width` + a gap fits there, else on its left. `panel` is the panel's element ref.
 * Measured after every render, as usePlaced is. → style for position: fixed.
 */
export function useBeside(panel, width, open) {
  const [at, setAt] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) { if (at) setAt(null); return; }
    const r = el.getBoundingClientRect();
    const view = window.innerWidth || 1200;
    const right = view - r.right - 8 >= width + 6;
    const left = right ? r.right + 6 : Math.max(8, r.left - 6 - width);
    const bottom = Math.max(8, (window.innerHeight || 800) - r.bottom);
    if (!at || at.left !== left || at.bottom !== bottom) setAt({ left, bottom });
  });
  return at ? { position: 'fixed', left: at.left, bottom: at.bottom, width } : { position: 'fixed', left: 0, bottom: 0, width, visibility: 'hidden' };
}
