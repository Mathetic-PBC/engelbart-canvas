import React from 'react';
import { kindOf } from '../ui/Icons.jsx';
import InlineField from '../ui/InlineField.jsx';

// Port of the canvas screen: Goal Canvas.dc.html lines 49–99 (template), 475–486 (wheel),
// 1019–1024 (boxes/goals view model).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BOXES = [
  { id: 'current', label: 'Current', pct: '70%', area: '1 / 1 / 3 / 2' },
  { id: 'experimental', label: 'Experimental', pct: '15%', area: '1 / 2 / 2 / 3' },
  { id: 'past', label: 'Past', pct: '15%', area: '2 / 2 / 3 / 3' },
];
const MICRO = { font: '500 9px/1 var(--font-sans)', letterSpacing: '1.6px', textTransform: 'uppercase', color: '#8f8f8f' };

/** A goal's sources: every library item attached to (or mentioned by) its topics, plus its notes. */
export function goalSources(goal, library) {
  const byId = new Map(library.map((row) => [row.id, row]));
  const seen = new Set();
  const out = [];
  for (const topic of goal.topics) {
    for (const id of topic.context) {
      const row = byId.get(id);
      if (row && !seen.has(id)) {
        seen.add(id);
        out.push(row);
      }
    }
  }
  for (const note of goal.notes) {
    if (!seen.has(note.id)) {
      seen.add(note.id);
      out.push({ id: note.id, name: note.name, type: 'note' });
    }
  }
  return out;
}

function TopicMark({ status }) {
  const done = status === 'done';
  const prog = status === 'progress';
  if (done) return <span style={{ flex: 'none', width: 11, height: 11, borderRadius: '50%', background: '#171717', color: '#fff', font: '600 7px/11px var(--font-sans)', textAlign: 'center' }}>✓</span>;
  return <span style={{ flex: 'none', width: 11, height: 11, borderRadius: '50%', border: `1.5px ${prog ? 'dashed' : 'solid'} ${prog ? '#171717' : '#c9c9c9'}` }} />;
}

function GoalCard({ goal, library, detail, onOpen, onHover, onUnhover }) {
  const sources = goalSources(goal, library);
  const n = sources.length + goal.topics.length;
  return (
    <div
      className="hov-bd2"
      onClick={(event) => onOpen(goal.id, event.currentTarget.getBoundingClientRect())}
      onMouseEnter={(event) => onHover(goal.id, event.currentTarget)}
      onMouseLeave={onUnhover}
      style={{ flex: `${n + 1} 1 ${120 + n * 30}px`, display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 14px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'zoom-in', transition: 'border-color 120ms', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ font: '500 14.5px/1.5 var(--font-sans)', color: '#171717' }}>{goal.name}</span>
        <span style={{ font: '11px/1 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>{sources.length} source{sources.length === 1 ? '' : 's'}</span>
      </div>
      {goal.topics.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {goal.topics.map((topic) => (
            <div key={topic.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <TopicMark status={topic.status} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '13px/1.7 var(--font-sans)', color: '#171717' }}>{topic.name}</span>
            </div>
          ))}
        </div>
      )}
      {detail && sources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #eaeaea', paddingTop: 10 }}>
          {sources.map((source) => {
            const kind = kindOf(source);
            return (
              <div key={source.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span title={kind.label} style={{ flex: 'none', width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4d4d4d', font: '500 12px/1 var(--font-sans)' }}>{kind.glyph}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '12px/1.6 var(--font-sans)', color: '#4d4d4d' }}>{source.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Canvas({ tree, library, style, interactive, onHome, onOpenGoal, onCreateGoal }) {
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [hoverGoal, setHoverGoal] = React.useState(null);
  const [adding, setAdding] = React.useState(null);
  const hoverEl = React.useRef(null);
  const rootRef = React.useRef(null);
  const live = React.useRef({ zoom, pan, hoverGoal });
  live.current = { zoom, pan, hoverGoal };

  React.useEffect(() => {
    const onWheel = (event) => {
      if (!interactive) return;
      const el = rootRef.current;
      if (!el || !el.contains(event.target)) return;
      event.preventDefault();
      const current = live.current;
      const r = el.getBoundingClientRect();
      const cx = event.clientX - r.left;
      const cy = event.clientY - r.top;
      if (event.ctrlKey || event.metaKey) {
        const dy = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -40, 40);
        const z = clamp(current.zoom * Math.exp(-dy * 0.004), 0.5, 4);
        const k = z / current.zoom;
        setZoom(z);
        setPan({ x: cx - (cx - current.pan.x) * k, y: cy - (cy - current.pan.y) * k });
        if (z > 2.6 && current.hoverGoal && hoverEl.current) onOpenGoal(current.hoverGoal, hoverEl.current.getBoundingClientRect());
      } else {
        setPan({ x: current.pan.x - event.deltaX, y: current.pan.y - event.deltaY });
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [interactive, onOpenGoal]);

  const detail = zoom >= 1.15;
  const goalCount = tree.goals.length;

  return (
    <div ref={rootRef} data-canvas="1" style={style}>
      <div style={{ position: 'absolute', left: 24, top: 18, zIndex: 2, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <button type="button" onClick={onHome} title="All projects" style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', font: '500 17px/1 var(--font-sans)', letterSpacing: '-0.2px', color: '#171717' }}>Engelbart</button>
        <span style={{ font: '15px/1 var(--font-sans)', color: '#c9c9c9' }}>/</span>
        <span style={{ font: '400 15px/1.3 var(--font-sans)', color: '#4d4d4d' }}>{tree.project.name}</span>
        <span style={{ font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{goalCount} goal{goalCount === 1 ? '' : 's'}</span>
      </div>
      <div style={{ position: 'absolute', right: 24, bottom: 18, zIndex: 2, padding: '7px 14px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', font: '11.5px/1 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>
        ⌘ + scroll or pinch to zoom · scroll to pan · click a goal to open
      </div>
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '70fr 30fr', gridTemplateRows: '1fr 1fr', gap: 16, width: '100%', height: '100%', padding: '64px 24px 24px' }}>
          {BOXES.map((box) => {
            const goals = tree.goals.filter((goal) => goal.box === box.id);
            return (
              <div key={box.id} style={{ gridArea: box.area, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, padding: '16px 18px 18px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={MICRO}>{box.label}</span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
                    <span style={MICRO}>{box.pct} · {goals.length} goal{goals.length === 1 ? '' : 's'}</span>
                    <button type="button" className="hov-ink" onClick={() => setAdding(box.id)} style={{ ...MICRO, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', transition: 'color 120ms' }}>+ Goal</button>
                  </span>
                </div>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 12 }}>
                  {adding === box.id && (
                    <InlineField placeholder="goal name…" width="100%" style={{ flex: '1 1 100%' }} onCommit={(name) => { setAdding(null); onCreateGoal(name, box.id); }} onCancel={() => setAdding(null)} />
                  )}
                  {goals.map((goal) => (
                    <GoalCard
                      key={goal.id}
                      goal={goal}
                      library={library}
                      detail={detail}
                      onOpen={onOpenGoal}
                      onHover={(id, el) => { hoverEl.current = el; setHoverGoal(id); }}
                      onUnhover={() => { hoverEl.current = null; setHoverGoal(null); }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
