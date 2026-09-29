import React from 'react';

// The shared editor also runs in post-it windows, which intentionally expose only
// postItAPI. Keep their view state in memory; only the main window persists it.
// Do not import api.js here: its required app bridge would abort a post-it's startup.
const sessionAPI = window.engelbartAPI;

let values = {}, dirty = {}, timer = null, saving = Promise.resolve();
const listeners = new Set(), flushers = new Set(), inFlight = new Set();
export async function loadSessionUI() {
  values = sessionAPI ? await sessionAPI.sessionUI() : {}; dirty = {};
}
export const sessionValue = (key, fallback) => {
  const value = values[key];
  if (value === undefined || value === null) return fallback;
  if (fallback != null && (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback))) return fallback;
  return value;
};
export function saveSessionValue(key, value) {
  if (!key) return;
  value = JSON.parse(JSON.stringify(value ?? null));
  if (JSON.stringify(values[key]) === JSON.stringify(value)) return;
  values = { ...values, [key]: value };
  dirty[key] = value;
  for (const listener of listeners) listener();
  clearTimeout(timer);
  timer = setTimeout(() => { void flushSessionUI().catch(() => {}); }, 250);
}
export function flushSessionUI() {
  clearTimeout(timer); timer = null;
  const patch = dirty; dirty = {};
  const send = async () => {
    if (!sessionAPI || !Object.keys(patch).length) return;
    try { await sessionAPI.saveSessionUI(patch); }
    catch (error) {
      for (const [key, value] of Object.entries(patch)) if (JSON.stringify(values[key]) === JSON.stringify(value) && !Object.hasOwn(dirty, key)) dirty[key] = value;
      throw error;
    }
  };
  saving = saving.catch(() => {}).then(send);
  return saving;
}
const subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };
export function useSessionState(key, fallback) {
  const initial = React.useRef();
  if (!initial.current || initial.current.key !== key || (fallback == null || typeof fallback !== 'object' && typeof fallback !== 'function') && initial.current.value !== fallback) initial.current = { key, value: typeof fallback === 'function' ? fallback() : fallback };
  const value = React.useSyncExternalStore(subscribe, () => sessionValue(key, initial.current.value), () => sessionValue(key, initial.current.value));
  const set = React.useCallback(next => {
    const previous = sessionValue(key, initial.current.value);
    saveSessionValue(key, typeof next === 'function' ? next(previous) : next);
  }, [key]);
  return [value, set];
}
export const registerViewFlusher = callback => { flushers.add(callback); return () => flushers.delete(callback); };
export function trackViewSave(promise) {
  inFlight.add(promise);
  promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
  return promise;
}
export async function flushCanvasView() {
  await Promise.all([...flushers].map(callback => callback()));
  while (inFlight.size) await Promise.all([...inFlight]);
  await flushSessionUI();
  // A save that failed earlier is requeued; quit waits for it too.
  if (Object.keys(dirty).length) await flushSessionUI();
}

// Restore again as asynchronously loaded lists grow, until the user interacts.
export function useScrollMemory(key) {
  const ref = React.useRef(null), active = React.useRef(false);
  const remember = React.useCallback(() => { if (active.current && ref.current) saveSessionValue(key, ref.current.scrollTop); }, [key]);
  React.useLayoutEffect(() => {
    const box = ref.current; if (!box) return;
    active.current = false;
    const top = sessionValue(key, 0);
    const restore = () => { if (active.current) return; box.scrollTop = top; if (Math.abs(box.scrollTop - top) < 1) active.current = true; };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(box, { childList: true, subtree: true });
    return () => { remember(); observer.disconnect(); };
  }, [key, remember]);
  React.useEffect(() => registerViewFlusher(remember), [remember]);
  return { ref, onScroll: remember, onWheel: () => { active.current = true; }, onPointerDown: () => { active.current = true; }, onKeyDown: () => { active.current = true; } };
}
