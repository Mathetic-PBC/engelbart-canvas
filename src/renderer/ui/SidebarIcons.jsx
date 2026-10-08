// The workspace sidebar's icons (2026-10-07), drawn from Hudson's Iconography note: Agents (a pointer), Projects (layers),
// Connectors (blocks), Stickies (a note with its corner turned, solid while shown and dotted while hidden), Toggle sidebar,
// Workspace ("B · small on bottom"), Add, Inbox (empty, or with a dot when something is new), Search, the chevrons, a link
// for websites, Note, Folder, Star, Code and the gear. Most are Lucide's (ISC), pasted in; the workspace, the sticky and
// the gear are drawn to match the pictures. Each is a 24-unit square stroked in the text's colour, 16px unless told.

import React from 'react';

function Svg({ size = 16, stroke = 2, style, children, ...rest }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', display: 'block', ...style }} {...rest}>
      {children}
    </svg>
  );
}

// The inbox's tray; with `dot`, a dot on its corner says something is new (the picture's "New"), the tray cut away round it.
const TRAY = (
  <>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </>
);
export function InboxIcon({ dot = false, ...rest }) {
  if (!dot) return <Svg {...rest}>{TRAY}</Svg>;
  return (
    <Svg {...rest}>
      <mask id="sb-inbox-dot" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect x="0" y="0" width="24" height="24" fill="#fff" stroke="none" />
        <circle cx="20" cy="4" r="5.2" fill="#000" stroke="none" />
      </mask>
      <g mask="url(#sb-inbox-dot)">{TRAY}</g>
      <circle cx="20" cy="4" r="3.2" fill="currentColor" stroke="none" data-inbox-dot="1" />
    </Svg>
  );
}

export const AgentsIcon = (props) => <Svg {...props}><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z" /></Svg>;
export const ConnectionsIcon = (props) => <Svg {...props}><rect width="7" height="7" x="14" y="3" rx="1" /><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" /></Svg>;
export const LibraryIcon = (props) => <Svg {...props}><path d="m16 6 4 14" /><path d="M12 6v14" /><path d="M8 8v12" /><path d="M4 4v16" /></Svg>;
export const AddIcon = (props) => <Svg {...props}><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></Svg>;
export const ProjectIcon = (props) => <Svg {...props}><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></Svg>;
// "B · small on bottom": a tall pane on the left, a square over a short one on the right.
export const WorkspaceIcon = (props) => <Svg {...props}><rect x="3.5" y="3" width="6.5" height="18" rx="2.5" /><rect x="14" y="3" width="6.5" height="10.5" rx="2.5" /><rect x="14" y="16.5" width="6.5" height="4.5" rx="2.25" /></Svg>;
export const SearchIcon = (props) => <Svg {...props}><circle cx="11" cy="11" r="7.5" /><path d="m21 21-4.5-4.5" /></Svg>;
export const ChevronDown = (props) => <Svg {...props}><path d="m6 9 6 6 6-6" /></Svg>;
export const ChevronRight = (props) => <Svg {...props}><path d="m9 18 6-6-6-6" /></Svg>;
export const LinkIcon = (props) => <Svg {...props}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></Svg>;
export const NoteIcon = (props) => <Svg {...props}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M9 13.5h6" /><path d="M9 17.5h6" /></Svg>;
export const FolderIcon = (props) => <Svg {...props}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></Svg>;
const STAR_PATH = 'M11.53 2.3a.53.53 0 0 1 .94 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.17.76a.53.53 0 0 1 .29.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.91l5.17-.75a2.12 2.12 0 0 0 1.6-1.16z';
export const StarIcon = ({ filled = false, ...props }) => <Svg {...props}><path d={STAR_PATH} fill={filled ? 'currentColor' : 'none'} /></Svg>;
export const CodeIcon = (props) => <Svg {...props}><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></Svg>;
// Eight square teeth round a ring, a hole in the middle (the picture's gear).
const GEAR_PATH = 'M10.25 4.5V1.95h3.5V4.5A7.7 7.7 0 0 1 16.06 5.46l1.81-1.8 2.47 2.47-1.8 1.81A7.7 7.7 0 0 1 19.5 10.25h2.55v3.5H19.5a7.7 7.7 0 0 1-.96 2.31l1.8 1.81-2.47 2.47-1.81-1.8a7.7 7.7 0 0 1-2.31.96v2.55h-3.5V19.5a7.7 7.7 0 0 1-2.31-.96l-1.81 1.8-2.47-2.47 1.8-1.81a7.7 7.7 0 0 1-.96-2.31H1.95v-3.5H4.5a7.7 7.7 0 0 1 .96-2.31l-1.8-1.81 2.47-2.47 1.81 1.8a7.7 7.7 0 0 1 2.31-.96z';
export const GearIcon = (props) => <Svg {...props}><path d={GEAR_PATH} /><circle cx="12" cy="12" r="3" /></Svg>;
export const PanelCloseIcon = (props) => <Svg {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></Svg>;
export const PanelOpenIcon = (props) => <Svg {...props}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m14 9 3 3-3 3" /></Svg>;
export const PlusIcon = (props) => <Svg {...props}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
export const CheckIcon = (props) => <Svg {...props}><path d="M20 6 9 17l-5-5" /></Svg>;
export const CloseIcon = (props) => <Svg {...props}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
export const MinusCircleIcon = (props) => <Svg {...props}><circle cx="12" cy="12" r="9.5" /><path d="M8 12h8" /></Svg>;
export const TrashIcon = (props) => <Svg {...props}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></Svg>;
export const ArchiveIcon = (props) => <Svg {...props}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></Svg>;
export const ChatIcon = (props) => <Svg {...props}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" /></Svg>;
export const PencilIcon = (props) => <Svg {...props}><path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" /><path d="m15 5 4 4" /></Svg>;
export const ExternalIcon = (props) => <Svg {...props}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>;

// The sticky (Iconography "Stickies"): a square with its lower right corner turned up. Shown, it is drawn whole; hidden,
// dotted (Iconography "Show/hide stickies").
export function StickyIcon({ hidden = false, ...props }) {
  const dash = hidden ? { strokeDasharray: '2.6 2.4' } : {};
  return <Svg {...props}><path d="M13 20.5 20.5 13" {...dash} /><path d="M13 20.5V14a1 1 0 0 1 1-1h6.5V5.5a2 2 0 0 0-2-2h-13a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" {...dash} /></Svg>;
}

/** The "More" mark (Linear's "··· More"): three dots, filled. */
export const DotsIcon = ({ size = 16, style }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flex: 'none', display: 'block', ...style }}><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
);
