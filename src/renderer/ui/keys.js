// The workspace's shortcuts off the Mac (2026-10-18, the beta's Windows catch-up, docs/windows-port-log.md): what a Mac does
// with ⌘ is done with Ctrl elsewhere, as the main process's own shortcuts already are (src/main/browser/views.cjs), and the
// labels say the key the person presses. The platform is the one preload marks on <html> (data-platform).

/** Whether this window is on a Mac. */
export function isMac() {
  try { const marked = document.documentElement.dataset.platform; if (marked) return marked === 'darwin'; } catch { /* not a page */ }
  try { return /Mac/i.test(navigator.platform || ''); } catch { return true; }
}

/** Whether `event` holds the shortcut key alone of the two: ⌘ (not Ctrl) on a Mac, Ctrl (not the Windows key) elsewhere. */
export const modDown = (event, mac = isMac()) => (mac ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey);

/** How a shortcut's keys are written: ⌘ ⌃ ⌥ on a Mac, Ctrl+ Ctrl+ Alt elsewhere (an ⌥-click, an Alt-click). */
export const keyLabels = (mac = isMac()) => (mac ? { mod: '⌘', ctrl: '⌃', alt: '⌥' } : { mod: 'Ctrl+', ctrl: 'Ctrl+', alt: 'Alt' });
