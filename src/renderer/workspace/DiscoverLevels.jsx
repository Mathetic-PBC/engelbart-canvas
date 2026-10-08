// The menu under an @discover line's chip (2026-10-03): its three levels, Quick, Standard and Deep, each with the model and
// effort it runs on, from the models file's `discover` block (main: `bart-models`). Above them, when more than one provider
// is offered, the provider field BartPicker has: viewing Codex lists Codex's three levels. It holds no choice of its own: a
// pick ({ mode, provider }) goes back to the editor, which writes it into the line as flags (question.cjs withMode), and
// what is marked here is read from the line. A line with a model or effort flag runs on that by hand, so no level is
// marked; picking one takes the flag off.
import React from 'react';
import { EFFORT_LABELS, MODES, levelOf } from '../../main/bart/question.cjs';
import { usePlaced } from '../ui/usePlaced.js';
import { ProviderField, Row } from './BartPicker.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
const WIDTH = 248;
export const LEVEL_LABELS = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };

/** The menu's rows on `provider`: per level its name and "<model> · <effort>" (a level whose model is gone shows the ladder's first, as it runs). */
export function levelRows(models, provider = models.provider) {
  const entry = models.providers[provider];
  return MODES.map((mode) => {
    const rung = levelOf(models, provider, mode), model = entry.models[rung.model];
    return { mode, label: LEVEL_LABELS[mode], detail: `${model.name} · ${EFFORT_LABELS[rung.effort] || rung.effort}` };
  });
}

// `current`: { mode, provider, pinned }, as readDiscover reads the line.
export default function DiscoverLevels({ models, current, anchor, onPick, onEnter, onLeave }) {
  const ids = Object.keys(models.providers), at = models.providers[current.provider] ? current.provider : models.provider;
  const [viewed, setViewed] = React.useState(at);
  React.useEffect(() => { setViewed(at); }, [at]);
  const provider = models.providers[viewed] ? viewed : at;
  const [ref, placed] = usePlaced(anchor, { align: 'end' });
  return (
    <div ref={ref} data-bart-picker="1" data-overlay="1" data-hover="1" role="dialog" aria-label="How far Discover looks" onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => e.preventDefault()} style={{ ...placed, zIndex: 60, width: WIDTH, boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, animation: `rise 160ms ${EASE}` }}>
      {ids.length > 1 && <div style={{ padding: '4px 4px 0' }}><ProviderField models={models} provider={provider} onView={setViewed} /></div>}
      <div role="listbox" aria-label="Level" style={{ padding: 4 }}>
        {levelRows(models, provider).map((row) => (
          <Row key={row.mode} label={<>{row.label}<span style={{ marginLeft: 8, fontWeight: 400, color: '#8f8f8f' }}>{row.detail}</span></>} on={!current.pinned && provider === at && current.mode === row.mode} onPick={() => onPick({ mode: row.mode, provider })} />
        ))}
      </div>
    </div>
  );
}
