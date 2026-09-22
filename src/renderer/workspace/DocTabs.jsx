import React from 'react';
import { isUntitled } from '../model/names.js';

const SLIDE = 'transform 160ms cubic-bezier(.25,.1,.25,1)';
const THRESHOLD = 4; // px of travel before a press becomes a drag

/** Document tabs, rendered inside the header's middle column (design 2026-09-17): Workspace plus opened notes.
 *  A note tab drags the way a browser tab does: the tab itself follows the pointer along the strip,
 *  its neighbours slide out of the way as its leading edge passes their middle, and it settles into the gap on
 *  release. Workspace stays first and nothing moves past it. */
export default function DocTabs({ tabs, activeTab, onSelect, onClose, onMove }) {
  const els = React.useRef(new Map()); // tab id → element
  const drag = React.useRef(null); // { id, pointerId, startX, x, moved }
  const lefts = React.useRef(new Map()); // tab id → offsetLeft at the last layout
  const [draggingId, setDraggingId] = React.useState(null);

  const place = () => {
    const d = drag.current;
    const el = d && els.current.get(d.id);
    if (!el) return;
    // Between the end of Workspace and the end of the last tab, as a browser's strip holds its tabs.
    const ws = els.current.get('ws');
    const last = els.current.get(tabs[tabs.length - 1].id) || el;
    const min = (ws ? ws.offsetLeft + ws.offsetWidth + 2 : 0) - el.offsetLeft;
    const max = last.offsetLeft + last.offsetWidth - el.offsetWidth - el.offsetLeft;
    const dx = Math.max(min, Math.min(Math.max(min, max), d.x - d.startX));
    el.style.transform = `translateX(${dx}px)`;
    return dx;
  };

  // After every reorder: the dragged tab keeps its place under the pointer (its slot moved, so its
  // offset is rebased), and every other tab that changed slot slides there from where it was.
  React.useLayoutEffect(() => {
    const d = drag.current;
    for (const [id, el] of els.current) {
      const before = lefts.current.get(id);
      const now = el.offsetLeft;
      lefts.current.set(id, now);
      if (before == null || before === now) continue;
      if (d && d.id === id) { d.startX += now - before; place(); continue; }
      if (!d) continue;
      el.style.transition = 'none';
      el.style.transform = `translateX(${before - now}px)`;
      el.getBoundingClientRect(); // commit the starting point before the slide
      el.style.transition = SLIDE;
      el.style.transform = '';
    }
    for (const id of [...lefts.current.keys()]) if (!els.current.has(id)) lefts.current.delete(id);
  });

  const onPointerDown = (event, tab) => {
    if (event.button !== 0 || tab.id === 'ws' || !onMove || event.target.closest('button')) return;
    drag.current = { id: tab.id, pointerId: event.pointerId, startX: event.clientX, x: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(tab.id);
  };

  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    d.x = event.clientX;
    if (!d.moved) {
      if (Math.abs(d.x - d.startX) < THRESHOLD) return;
      d.moved = true;
      setDraggingId(d.id);
      const el = els.current.get(d.id);
      if (el) el.style.transition = 'none';
    }
    const el = els.current.get(d.id);
    const dx = place();
    if (!el || dx == null) return;
    // A neighbour gives way once the dragged tab's leading edge passes its middle.
    const left = el.offsetLeft + dx, right = left + el.offsetWidth;
    const index = tabs.findIndex((tab) => tab.id === d.id);
    const next = tabs[index + 1] && els.current.get(tabs[index + 1].id);
    const prev = index > 1 ? els.current.get(tabs[index - 1].id) : null; // index 0 is Workspace
    if (next && right > next.offsetLeft + next.offsetWidth / 2) onMove(d.id, tabs[index + 1].id);
    else if (prev && left < prev.offsetLeft + prev.offsetWidth / 2) onMove(d.id, tabs[index - 1].id);
  };

  const onPointerEnd = (event) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId) return;
    drag.current = null;
    const el = els.current.get(d.id);
    if (el) {
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      el.style.transition = d.moved ? SLIDE : '';
      el.style.transform = '';
    }
    setDraggingId(null);
  };

  return tabs.map((tab) => {
    const on = tab.id === activeTab;
    const dragging = draggingId === tab.id;
    return (
      <div
        key={tab.id}
        ref={(element) => { if (element) els.current.set(tab.id, element); else els.current.delete(tab.id); }}
        className="hov-ink"
        onClick={() => onSelect(tab.id)}
        onPointerDown={(event) => onPointerDown(event, tab)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        data-doc-tab={tab.id}
        style={{ position: 'relative', zIndex: dragging ? 2 : undefined, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: 220, flex: '0 1 auto', padding: '7px 12px 8px', marginBottom: -1, border: `1px solid ${on || dragging ? '#eaeaea' : 'transparent'}`, borderBottomColor: on ? '#fff' : 'transparent', borderRadius: '8px 8px 0 0', background: on ? '#fff' : (dragging ? '#fafafa' : 'transparent'), cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none', font: `${on ? 500 : 400} 12.5px/1.3 var(--font-sans)`, color: on ? '#171717' : '#4d4d4d', whiteSpace: 'nowrap' }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: isUntitled(tab.title) ? '#8f8f8f' : undefined }}>{tab.title}</span>
        {tab.id !== 'ws' && (
          <button type="button" className="hov-del" onClick={(event) => { event.stopPropagation(); onClose(tab.id); }} aria-label="Close tab" style={{ flex: 'none', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#c9c9c9' }}>×</button>
        )}
      </div>
    );
  });
}
