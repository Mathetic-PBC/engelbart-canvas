// A shared server may appear in several Build tabs (or a restored accepted
// tab). Update only tabs still showing that server, never a page navigated away.
export function buildPreviewTabChanges(tabs, preview) {
  if (!preview?.replacesUrl) return [];
  const previous = new URL(preview.replacesUrl);
  return tabs.flatMap(tab => {
    if (!tab.requestKey?.startsWith('build-preview:') && tab.requestKey !== 'accepted-build-preview') return [];
    let current;
    try { current = new URL(tab.url); } catch { return []; }
    if (current.origin !== previous.origin) return [];
    const url = preview.status === 'ready' && preview.url
      ? current.href === previous.href ? preview.url : new URL(current.pathname + current.search + current.hash, new URL(preview.url).origin).href
      : null;
    return [{ id: tab.id, url }];
  });
}
