// The SVG kind icons the design defines (Goal Canvas.dc.html lines 395–402) as React components,
// plus the KIND map keyed by a row's kind (model/kind.js: its tags first, then its type).

import { kindKey, kindLabel } from '../model/kind.js';

export const GH = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export const PDF = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 1.5h6l3 3v10h-9z" />
    <path d="M9.5 1.5v3h3" />
  </svg>
);

export const LAYERS = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M8 2.5 14 5.5 8 8.5 2 5.5z" />
    <path d="M2 8.5l6 3 6-3" />
    <path d="M2 11.5l6 3 6-3" />
  </svg>
);

export const FOLDER = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 4a1 1 0 0 1 1-1h3.3l1.5 1.8h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);

export const CODE = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </svg>
);

export const WS = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <rect x={1.5} y={1.5} width={4.5} height={4.5} rx={1} />
    <rect x={8} y={1.5} width={6.5} height={4.5} rx={1} />
    <rect x={1.5} y={8} width={6.5} height={6.5} rx={1} />
    <rect x={10} y={8} width={4.5} height={4.5} rx={1} />
  </svg>
);

// A sheet with its corner turned down and three lines (Hudson's reference drawing, 2026-09-21).
export const NOTE = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />
    <path d="M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2" />
    <path d="M5.5 7.75h5M5.5 10h5M5.5 12.25h5" />
  </svg>
);

export const SEARCH = () => (
  <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
    <circle cx={6.75} cy={6.75} r={4.5} />
    <path d="M10.25 10.25 14 14" />
  </svg>
);

// Bart: two speech bubbles, one answering the other (Add - Mention.dc.html, 2026-09-22).
export const CHAT = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M3 2.5h6.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6.5L4 11.5v-2H3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" />
    <path d="M12.5 5.5h.5a2 2 0 0 1 2 2v2.5a2 2 0 0 1-2 2h-.5v2l-2.5-2H7.5" />
  </svg>
);

// A website with no favicon of its own (none are fetched): the generic globe (Add - Mention.dc.html, 2026-09-22).
export const GLOBE = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z" />
    <path d="M1.75 8h12.5" />
    <path d="M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25" />
    <path d="M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25" />
  </svg>
);

export const IMAGE = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <rect x={1.5} y={2.5} width={13} height={11} rx={1.2} />
    <circle cx={5.5} cy={6} r={1.25} />
    <path d="M14.5 10.5 11 7l-4.5 4.5L4.5 9.5 1.5 12.5" />
  </svg>
);

// A task: a clipboard with a check on it (Add - Mention.dc.html, 2026-09-22).
export const TASK = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M5.75 3H5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-.75" />
    <path d="M6.75 1.75h2.5a1 1 0 0 1 1 1v.5a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-.5a1 1 0 0 1 1-1z" />
    <path d="M6.25 9.25l1.25 1.25 2.5-2.5" />
  </svg>
);

/** Kind → glyph (React node or Unicode string) and the kind's name, keyed by `kindKey(row)`. */
// Full screen: arrows out to take the middle, arrows in to give it back (Hudson's two pictures). The Stage's, and the
// document's (MATH-23).
export const Expand = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block', fill: 'none', stroke: '#171717', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M9.3 2.5h4.2v4.2M13.5 2.5L9 7M6.7 13.5H2.5V9.3M2.5 13.5L7 9" /></svg>;
export const Collapse = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block', fill: 'none', stroke: '#171717', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }}><path d="M13.5 2.5L9.5 6.5M9.5 3.3v3.2h3.2M2.5 13.5l4-4M6.5 12.7V9.5H3.3" /></svg>;

export const KIND = {
  note: { glyph: <NOTE />, label: 'note' },
  md: { glyph: <NOTE />, label: 'md' },
  docx: { glyph: <NOTE />, label: 'docx' },
  pdf: { glyph: <PDF />, label: 'pdf' },
  git: { glyph: <GH />, label: 'git repo' },
  folder: { glyph: <FOLDER />, label: 'folder' },
  website: { glyph: <GLOBE />, label: 'link' },
  html: { glyph: <CODE />, label: 'html' },
  data: { glyph: <LAYERS />, label: 'data file' },
  chat: { glyph: <CHAT />, label: 'chat', fixed: true },
  task: { glyph: <TASK />, label: 'task', fixed: true },
  workspace: { glyph: <WS />, label: 'workspace', fixed: true },
  image: { glyph: <IMAGE />, label: 'image' },
};

/** A row's glyph, and the words beside it: a library row says its type then its tags ("pdf · paper"); the editor's own items keep their name. */
export function kindOf(item) {
  const kind = KIND[kindKey(item)] || KIND.note;
  return kind.fixed || !item || !item.type ? kind : { glyph: kind.glyph, label: kindLabel(item) };
}

// The design draws a note at 15px, a globe at 14 and every other kind at 12, centred in a box of 16 (18 in a list):
// the workspace sidebar's rows and search, and the @ menu (Canvas.dc.html, Add - Mention.dc.html `icon`).
const GLYPH_SIZE = { note: 15, md: 15, website: 14 };
export function KindGlyph({ item, kind: key = null, box = 16, color = '#171717' }) {
  const name = key || (item.type === 'workspace' || item.type === 'child' ? 'workspace' : kindKey(item));
  const kind = KIND[name] || kindOf(item || {});
  const size = GLYPH_SIZE[name] || 12;
  return (
    <span style={{ flex: 'none', width: box, height: box, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
      <span className="glyph-fit" style={{ display: 'flex', width: size, height: size }}>{kind.glyph}</span>
    </span>
  );
}
