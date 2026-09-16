// The six SVG kind icons the design defines (Goal Canvas.dc.html lines 395–402) as React components,
// plus the KIND map keyed by library item type.

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

export const WS = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <rect x={1.5} y={1.5} width={4.5} height={4.5} rx={1} />
    <rect x={8} y={1.5} width={6.5} height={4.5} rx={1} />
    <rect x={1.5} y={8} width={6.5} height={6.5} rx={1} />
    <rect x={10} y={8} width={4.5} height={4.5} rx={1} />
  </svg>
);

export const NOTE = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <rect x={2} y={2.5} width={10} height={11.5} rx={1.2} />
    <path d="M4.5 1v3M7 1v3M9.5 1v3M4.5 7.5h5M4.5 10h5M4.5 12.5h3" />
  </svg>
);

export const CHAT = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 3v-3A1.5 1.5 0 0 1 2 9.5z" />
  </svg>
);

export const IMAGE = () => (
  <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <rect x={1.5} y={2.5} width={13} height={11} rx={1.2} />
    <circle cx={5.5} cy={6} r={1.25} />
    <path d="M14.5 10.5 11 7l-4.5 4.5L4.5 9.5 1.5 12.5" />
  </svg>
);

/** Kind → glyph (React node or Unicode string) and label, keyed by library item `type`. */
export const KIND = {
  note: { glyph: <NOTE />, label: 'note' },
  paper: { glyph: <PDF />, label: 'pdf' },
  git_repo: { glyph: <GH />, label: 'git repo' },
  dataset: { glyph: <LAYERS />, label: 'dataset' },
  website: { glyph: '↗', label: 'link' },
  chat: { glyph: <CHAT />, label: 'chat' },
  workspace: { glyph: <WS />, label: 'workspace' },
  image: { glyph: <IMAGE />, label: 'image' },
};

export function kindOf(item) {
  return (item && KIND[item.type]) || KIND.note;
}
