import React from 'react';
import { api } from '../api.js';

export function PostItIcon() {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2Z" /><path d="M15 21v-4a2 2 0 0 1 2-2h4" /></svg>;
}

export default function ProjectPostIts({ projectId, active, onError }) {
  const [drag, setDrag] = React.useState({ active: false, over: false });
  const error = React.useRef(onError);
  error.current = onError;
  React.useEffect(() => {
    if (!active) return undefined;
    const fail = (e) => error.current(e);
    const offDrag = api.onPostItsDrag(setDrag);
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
      api.postItsActivate(null).catch(fail);
    };
  }, [projectId, active]);
  if (!active || !drag.active) return null;
  return <div data-post-it-trash="1" aria-label="Post-it trash" style={{ position: 'fixed', left: 0, bottom: 0, width: 160, height: 112, zIndex: 180, border: `2px dashed ${drag.over ? '#c43c35' : '#c9c9c9'}`, borderRadius: '0 14px 0 0', background: drag.over ? '#ffe5df' : '#faf8ee', color: drag.over ? '#a6231e' : '#71664a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, pointerEvents: 'none', font: '12px/1.4 var(--font-sans)' }}>
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
    {drag.over ? 'Release to delete' : 'Drop here to delete'}
  </div>;
}
