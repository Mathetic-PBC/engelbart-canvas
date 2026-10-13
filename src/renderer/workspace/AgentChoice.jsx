// The menu under an answer's "via Bart" (2026-10-12): Bart, the router, picked the agent that wrote it; picking another
// here writes the line as that agent's (@chat, @brainstorm, @discover, @create) and asks it again (DocEditor pickVia). The agent
// that wrote it is marked.
import React from 'react';
import { usePlaced } from '../ui/usePlaced.js';
import { Row } from './BartPicker.jsx';

const EASE = 'cubic-bezier(.25,.1,.25,1)';
export const VIA_AGENTS = [
  { agent: 'bart', label: 'Chat', detail: 'an answer' },
  { agent: 'brainstorm', label: 'Brainstorm', detail: 'think it through' },
  { agent: 'discover', label: 'Discover', detail: 'what to read' },
  { agent: 'create', label: 'Create', detail: 'a new file' },
];

// `current`: the agent that answered ('bart' is Chat). `onPick(agent)`.
export default function AgentChoice({ current, anchor, onPick, onEnter, onLeave }) {
  const [ref, placed] = usePlaced(anchor, { align: 'end' });
  return (
    <div ref={ref} data-bart-picker="1" data-overlay="1" data-hover="1" role="dialog" aria-label="Ask another agent" onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => e.preventDefault()} style={{ ...placed, zIndex: 60, width: 232, boxSizing: 'border-box', padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 12, animation: `rise 160ms ${EASE}` }}>
      <div style={{ padding: '6px 10px 4px', font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Bart picked this agent. Ask another:</div>
      <div role="listbox" aria-label="Agent" style={{ padding: 4 }}>
        {VIA_AGENTS.map((row) => (
          <Row key={row.agent} label={<>{row.label}<span style={{ marginLeft: 8, fontWeight: 400, color: '#8f8f8f' }}>{row.detail}</span></>} on={row.agent === current} onPick={() => { if (row.agent !== current) onPick(row.agent); }} />
        ))}
      </div>
    </div>
  );
}
