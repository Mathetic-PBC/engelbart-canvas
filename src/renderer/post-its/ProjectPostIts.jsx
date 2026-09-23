import React from 'react';
import { api } from '../api.js';

// A project's post-its: native cards above the window (main/post-its/views.cjs). This keeps them to the workspace screen,
// hides them while a menu or a dialog is open (they would cover it), and reports a card being dragged (`onDrag`
// { active, over, thrown }) to the sidebar's trash can, which is where one is thrown away (2026-09-22).
export default function ProjectPostIts({ projectId, active, onError, onDrag }) {
  const error = React.useRef(onError);
  error.current = onError;
  const drag = React.useRef(onDrag);
  drag.current = onDrag;
  React.useEffect(() => {
    if (!active) return undefined;
    const fail = (e) => error.current(e);
    const offDrag = api.onPostItsDrag((state) => { if (drag.current) drag.current(state); });
    const offError = api.onPostItsError(fail);
    let last = null;
    const check = () => {
      const blocked = [...document.querySelectorAll('[data-overlay]')].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (last !== blocked) { last = blocked; api.postItsSuspend(blocked).catch(fail); }
    };
    // Native cards temporarily yield to the app's menus/dialogs. This is not a saved hidden state.
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-overlay'] });
    check();
    api.postItsActivate(projectId).catch(fail);
    const resize = () => api.postItsLayout().catch(fail);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect(); offDrag(); offError(); window.removeEventListener('resize', resize);
      if (drag.current) drag.current({ active: false, over: false });
      api.postItsActivate(null).catch(fail);
    };
  }, [projectId, active]);
  return null;
}
