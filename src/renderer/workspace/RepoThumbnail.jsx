import React from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { createRepoThumbnailCache, placeRepoThumbnail } from '../model/repo-thumbnail.js';

export function createThumbnailCache() {
  return createRepoThumbnailCache(async id => {
    const src = await api.repoThumbnail(id);
    if (!src) return null;
    // Read and decode during the existing hover delay, before showing the frame.
    const image = new Image();
    image.src = src;
    await image.decode();
    return src;
  });
}

// A saved image, not a live iframe or another repository inspector. The path is
// resolved by main from the library id; the renderer cannot request arbitrary files.
export default function RepoThumbnail({ row, cache, anchor, gap = 8, onMouseEnter, onMouseLeave }) {
  const [src, setSrc] = React.useState(() => cache.peek(row));
  const [frame, setFrame] = React.useState(null);
  React.useEffect(() => {
    let gone = false;
    cache.load(row).then(image => { if (!gone) setSrc(image); });
    return () => { gone = true; };
  }, [cache, row.id, row.thumbnail_path]);
  const measure = React.useCallback(() => {
    if (!anchor?.isConnected) { setFrame(null); return; }
    const edge = anchor.closest('aside')?.getBoundingClientRect().right || 0;
    const next = placeRepoThumbnail(anchor.getBoundingClientRect(), edge, { width: window.innerWidth, height: window.innerHeight }, gap);
    setFrame(current => current && Object.keys(next).every(key => current[key] === next[key]) ? current : next);
  }, [anchor, gap]);
  // Re-read the row after layout changes, not on pointer movement. The fixed frame
  // does not jump when images of different aspect ratios finish loading.
  React.useLayoutEffect(measure);
  React.useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    if (anchor) observer.observe(anchor);
    const aside = anchor?.closest('aside');
    if (aside) observer.observe(aside);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [anchor, measure]);
  if (!src || !frame) return null;
  return createPortal(
    <div data-overlay="1" data-hover="1" data-rail-peek="1" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{ position: 'fixed', zIndex: 60, left: frame.left, top: frame.top, paddingLeft: gap }}>
      <div data-repo-thumbnail={row.id} style={{ width: frame.width, height: frame.height, boxSizing: 'border-box', overflow: 'hidden', background: '#f5f5f5', border: '1px solid #dedede', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.07)' }}>
        <img src={src} alt={`Saved preview of ${row.name}`} draggable={false} onError={() => { cache.forget(row); setSrc(null); }}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top' }} />
      </div>
    </div>, document.body,
  );
}
