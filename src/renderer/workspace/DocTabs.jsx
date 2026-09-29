import React from 'react';
import { isUntitled } from '../model/names.js';
import { KindGlyph } from '../ui/Icons.jsx';
import { FluidTab, TabCard, TabClose, TabTitle, useTabCard } from '../ui/FluidTab.jsx';

const SLIDE = 'transform 160ms cubic-bezier(.25,.1,.25,1)';
const THRESHOLD = 4; // px of travel before a press becomes a drag

/** Document tabs, rendered inside the header's middle column (design 2026-09-17): Workspace plus opened notes.
 *  Each tab carries its document icon; the selected tab has a white background and darker label.
 *  A note tab drags the way a browser tab does: the tab itself follows the pointer along the strip,
 *  its neighbours slide out of the way as its leading edge passes their middle, and it settles into the gap on
 *  release. Workspace stays first and nothing moves past it.
 *  Every note tab closes; Workspace is always there and has no × (2026-09-25; it closed too from 2026-09-23).
 *  The Workspace tab is the only workspace document in the strip (2026-09-25). */
export default function DocTabs({ tabs, activeTab, onSelect, onClose, onMove }) {
  const els = React.useRef(new Map()); // tab id → element
  const drag = React.useRef(null); // { id, pointerId, startX, x, moved }
  const lefts = React.useRef(new Map()); // tab id → offsetLeft at the last layout
  const [draggingId, setDraggingId] = React.useState(null);
  const card = useTabCard();
  const hovered = card.card && tabs.find((tab) => tab.id === card.card.id);

  const place = () => {
    const d = drag.current;
    const el = d && els.current.get(d.id);
    if (!el) return;
    // Between the end of Workspace and the end of the last tab, as a browser's strip holds its tabs.
    const ws = els.current.get('ws');
    const last = els.current.get(tabs[tabs.length - 1].id) || el;
    const min = (ws ? ws.offsetLeft + ws.offsetWidth + 4 : 0) - el.offsetLeft;
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
    const prev = index > 0 && tabs[index - 1].id !== 'ws' ? els.current.get(tabs[index - 1].id) : null; // nothing moves past Workspace
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

  // Document tabs have rounded top corners and a flat bottom that meets the editor.
  // Workspace is always there and first; it has no ×.
  return (
    <>
      {tabs.map((tab) => {
        const on = tab.id === activeTab;
        const dragging = draggingId === tab.id;
        const ws = tab.id === 'ws';
        const untitled = isUntitled(tab.title);
        return (
          <FluidTab
            key={tab.id}
            ref={(element) => { if (element) els.current.set(tab.id, element); else els.current.delete(tab.id); }}
            on={on}
            variant="document"
            lifted={dragging}
            data-no-drag="1"
            data-doc-tab={tab.id}
            onClick={() => onSelect(tab.id)}
            onPointerDown={(event) => { card.hide(); onPointerDown(event, tab); }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onMouseEnter={(event) => { if (!on && !ws && !drag.current) card.enter(event, tab.id); }}
            onMouseLeave={card.leave}
            style={{ touchAction: 'none' }}
          >
            <span data-ws-icon={ws ? '1' : undefined} style={{ flex: 'none', display: 'flex', color: on ? '#737373' : '#8f8f8f' }}><KindGlyph kind={ws ? 'workspace' : 'note'} box={16} size={14} color="currentColor" /></span>
            <TabTitle size={14} weight={on ? 500 : 400} color={untitled || !on ? '#8f8f8f' : '#171717'}>{tab.title}</TabTitle>
            {!ws && <TabClose onClose={() => onClose(tab.id)} title="Close" />}
          </FluidTab>
        );
      })}
      {hovered && <TabCard card={card.card} title={hovered.title} detail="Note" />}
    </>
  );
}
