// Local, bounded cache for one mounted sidebar. A newly captured file has a new
// path, so it cannot reuse the previous run's image. Failed reads remain retryable.
export function createRepoThumbnailCache(read, limit = 24) {
  const entries = new Map();
  const keyOf = row => `${row.id}:${row.thumbnail_path || ''}`;
  const keep = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  };
  return {
    peek(row) {
      const key = keyOf(row), entry = entries.get(key);
      if (!entry) return null;
      keep(key, entry);
      return entry.src;
    },
    load(row) {
      if (!row.thumbnail_path) return Promise.resolve(null);
      const key = keyOf(row), held = entries.get(key);
      if (held) { keep(key, held); return held.promise; }
      // Release superseded versions without letting an older in-flight read
      // overwrite (or delete) a newer entry when it finishes.
      for (const [oldKey, entry] of entries) if (entry.id === row.id) entries.delete(oldKey);
      const entry = { id: row.id, src: null, promise: null };
      entry.promise = Promise.resolve().then(() => read(row.id)).then(src => {
        entry.src = src || null;
        if (!src && entries.get(key) === entry) entries.delete(key);
        return entry.src;
      }).catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
        return null;
      });
      keep(key, entry);
      return entry.promise;
    },
    forget(row) { entries.delete(keyOf(row)); },
  };
}

// Top-align with the row, beside the sidebar; only move inward at a window edge.
// `left` includes the hoverable bridge across the gap, not just the image frame.
export function placeRepoThumbnail(rect, edge, view, gap = 8) {
  const margin = 8;
  const width = Math.min(320, Math.max(1, view.width - margin * 2 - gap));
  const height = Math.min(210, Math.max(1, view.height - margin * 2));
  return {
    left: Math.max(margin, Math.min(Math.max(rect.right, edge), view.width - margin - width - gap)),
    top: Math.max(margin, Math.min(rect.top, view.height - margin - height)),
    width, height,
  };
}
