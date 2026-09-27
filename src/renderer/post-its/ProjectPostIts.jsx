import React from 'react';
import { api } from '../api.js';

const plainRect = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const shown = (r) => r.width > 0 && r.height > 0;

/** The app's open menus and dialogs (hover previews, marked data-hover, are left out: a card stays over those, 2026-09-22). */
function blockingRects() {
  return [...document.querySelectorAll('[data-overlay]:not([data-hover])')].map((el) => el.getBoundingClientRect()).filter(shown).slice(0, 64).map(plainRect);
}

// A project's post-its: native cards above the window (main/post-its/views.cjs). This keeps them to the workspace screen,
// moves a card aside while one of the app's menus or dialogs is open over it, reports a card being dragged (`onDrag`
// { active, over, thrown }) to the sidebar's trash can, and hands on what main tells the workspace: a note to open
// (`onOpenNote`), how many cards are in the trash (`onTrashCount`), and that main showed hidden cards again because one
// was made or restored (`onShown`). `hidden` is the sidebar's show/hide toggle; it only changes what is drawn.
export default function ProjectPostIts({ projectId, active, hidden, onError, onDrag, onOpenNote, onTrashCount, onShown }) {
  const props = React.useRef({});
  props.current = { onError, onDrag, onOpenNote, onTrashCount, onShown };
  // Before the cards are activated below, so a hidden set never flashes up.
  React.useEffect(() => { api.postItsHide(!!hidden).catch((e) => props.current.onError(e)); }, [hidden]);
  React.useEffect(() => api.onPostItsHidden((now) => { if (!now && props.current.onShown) props.current.onShown(); }), []);
  React.useEffect(() => {
    if (!active) return undefined;
    const fail = (e) => props.current.onError(e);
    let lastBlock = null;

    const checkBlocking = () => {
      const rects = blockingRects(), key = JSON.stringify(rects);
      if (key !== lastBlock) { lastBlock = key; api.postItsBlock(rects).catch(fail); }
    };

    const offs = [
      api.onPostItsDrag((state) => { if (props.current.onDrag) props.current.onDrag(state); }),
      api.onPostItsError(fail),
      api.onPostItsOpenNote((note) => { if (note.projectId === projectId && props.current.onOpenNote) props.current.onOpenNote(note); }),
      api.onPostItsTrash((state) => { if (state.projectId === projectId && props.current.onTrashCount) props.current.onTrashCount(state.count); }),
    ];
    // Menus and dialogs come and go with the DOM.
    const observer = new MutationObserver(checkBlocking);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-overlay'] });
    const resize = () => api.postItsLayout().catch(fail);
    window.addEventListener('resize', resize);
    checkBlocking();
    api.postItsActivate(projectId).catch(fail);
    return () => {
      observer.disconnect(); offs.forEach((off) => off());
      window.removeEventListener('resize', resize);
      if (props.current.onDrag) props.current.onDrag({ active: false, over: false });
      api.postItsActivate(null).catch(fail);
    };
  }, [projectId, active]);
  return null;
}
