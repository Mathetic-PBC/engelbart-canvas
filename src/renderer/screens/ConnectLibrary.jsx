import React from 'react';
import { createPortal } from 'react-dom';
import { api, errorMessage } from '../api.js';
import GithubRepos from '../workspace/GithubRepos.jsx';
import { heldRow } from '../model/github.js';
import { rowOf } from '../model/tools.js';
import { markOpen } from '../ui/connect-open.js';
import { SOURCES, APPS, LOCAL_PDFS, LOCAL_REPOS, BROWSER_ROW, initialPicks, choicesOf, PERIODS, DEFAULT_PERIOD_DAYS, periodName, resumable, statusOf, workJobs, afterSignInWindowClosed, signInWindowClosed, runningFirst, workLine, needView, memoryLine, footLine, chatStatus, workRow, ticked, tickRow, tickRepo, tickGroup, tickAll, allPicked, groupState, localPicked, rowLabel, rowSub, rowTip, shownName, NEEDS_SIGN_IN, consentFor, permissionsOf, newlyTickedWeb, waitForYes, signInPanel, keychainOutcome, signInsToCheck, waitingWhile, placedLine, unsignedWeb, signInGate, shownSignIn, signInChain, signInWindows, opensSignIn, sharesSignIn, signsInViaBrowser, signInName, waitingIn, folderPanel, folderAccessLabel } from '../model/connect.js';
import obsidian from '../../../design/assets/logos/obsidian.svg';
import notion from '../../../design/assets/logos/notion.svg';
import apple from '../../../design/assets/logos/apple.svg';
import onenote from '../../../design/assets/logos/microsoft-onenote.svg';
import zotero from '../../../design/assets/logos/zotero.svg';
import overleaf from '../../../design/assets/logos/overleaf.svg';
import googledrive from '../../../design/assets/logos/google-drive.svg';
import evernote from '../../../design/assets/logos/evernote.svg';
import granola from '../../../design/assets/logos/granola-light.svg';
import meet from '../../../design/assets/logos/google-meet.svg';
import gmail from '../../../design/assets/logos/gmail.svg';
import zoom from '../../../design/assets/logos/zoom.svg';
import openai from '../../../design/assets/logos/openai.svg';
import codex from '../../../design/assets/logos/codex_light.svg';
import claude from '../../../design/assets/logos/claude-ai-icon.svg';
import grok from '../../../design/assets/logos/grok-light.svg';
import gemini from '../../../design/assets/logos/gemini.svg';
import perplexity from '../../../design/assets/logos/perplexity.svg';
import cursor from '../../../design/assets/logos/cursor_light.svg';
import github from '../../../design/assets/logos/github.svg';

// Connect your library (2026-10-07): port of Claude Design "Connect Library.dc.html" (design/connect-library/), a
// window in every library (test mode's only until 2026-10-08): a step of a new user's onboarding (in place of Add to
// your library and Custom instructions), and a one-time popup for someone who has projects (ui/ConnectDock.jsx).
// Choose: what should go in the library, by source and app, ticked where main found the app; GitHub through the same
// repository list as onboarding's; what the agents will do and the permissions they need, asked up front. Refine: one
// continuous chat with the librarian agent (src/main/connect), its questions drawn as cards with one option per line
// (single choice: a round mark, multiple: a square one, each option's why under it), its buttons sign in to a
// connector, ask macOS, or choose a folder. Each source it settles starts importing in the background while the chat
// goes on. When an agent meets something only the person can do (a sign-in, a code, a permission) it shows as "Needs
// you", with the button that does it. Import, at the lower right, lights up once the librarian has nothing more to ask;
// then the window shows every import and MEMORY.md, with Stop, and can be put away: the work goes on in the background,
// the dock and the sidebar's Inbox following it.
// 2026-10-08 ("Agent onboarding"): no growing strip of agents over the chat (one line under it says what the librarian
// does and goes through the subagents at work, as Claude Code lists its own), no activity log, no paragraphs of
// disclaimers on the choose screen, no account of what each import added; the imports still going come first; a Needs-you
// card is one Log in button and Skip, and Skip leaves that app out for the run.
// MATH-114 (2026-10-09): the choose screen reads as safe. The mockup's grouped list: each source a group with a tri-state
// header and a summary of what is ticked; every row says at its right how its app is reached and where it stands, and
// rows not found stay visible. Ticking is the consent: a connector's sign-in starts (no Sign in… button), Apple Notes asks
// macOS (no Allow…), a local app that was not found asks for its folder, and an assistant that remembers the person is
// asked only when ticked (they start unticked). One checkbox, naming the provider, lets the agents read the rest with the
// person's own subscription, over a box that says where it all goes. Code: GitHub, and the repositories on this Mac that
// Claude Code and Codex were run in (src/main/connect/scan.cjs localRepos).

// Keyed by app id: 'Google Docs' is the person's whole Drive (shown as Google Drive, connect-sources shownName), so its logo is Drive's.
export const LOGOS = { Obsidian: obsidian, Notion: notion, 'Apple Notes': apple, OneNote: onenote, Zotero: zotero, Overleaf: overleaf, 'Google Docs': googledrive, Evernote: evernote, Granola: granola, 'Google Meet': meet, Zoom: zoom, Gmail: gmail, ChatGPT: openai, Codex: codex, Claude: claude, 'Claude Code': claude, Grok: grok, Gemini: gemini, Perplexity: perplexity, Cursor: cursor, GitHub: github };
const EASE = 'cubic-bezier(.25,.1,.25,1)';
/** The choose screen's column in onboarding (2026-10-09); Onboarding.jsx lines Skip for now up with it. */
export const CHOOSE_WIDTH = 600;
// The design's classes (DocEditor's CARD_CSS, not mounted here) and @brainstorm's card (one option per line).
const CSS = '.bart-ic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#4d4d4d}.bart-ic:hover{background:#f2f2f2;color:#171717}'
  + '.bart-chip{transition:border-color 120ms}.bart-chip:hover{border-color:#c9c9c9!important}.bart-chip[data-connect-chip-primary]:hover{border-color:#171717!important;background:#171717!important}.bart-send{transition:background 120ms}.bart-send:hover{opacity:.86}'
  + '.bart-text{padding:4px 2px;border:0;background:transparent;color:#8f8f8f;font:500 12px/1.4 var(--font-sans);cursor:pointer}.bart-text:hover{color:#171717}'
  + '.bs-opt{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;margin:0;padding:9px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fff;text-align:left;cursor:pointer;font:14.5px/1.45 var(--font-sans);color:#171717;transition:border-color 120ms}'
  + '.bs-opt+.bs-opt{margin-top:6px}.bs-opt:hover{border-color:#c9c9c9}.bs-opt[aria-checked="true"]{border-color:#0070f3}.bs-opt:disabled{cursor:default;color:#8f8f8f}.bs-opt:disabled:hover{border-color:#eaeaea}'
  + '.bs-opt:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.bs-mark{flex:none;box-sizing:border-box;width:14px;height:14px;margin-top:3px;border:1.5px solid #c9c9c9;border-radius:50%;background:#fff}.bs-mark[data-square]{border-radius:4px}'
  + '[aria-checked="true"]>.bs-mark{border-color:#0070f3;background:#0070f3;box-shadow:inset 0 0 0 2.5px #fff}'
  + '.bs-why{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:#8f8f8f}'
  // Connect's compact options (2026-10-12): the label with its why after it, both wrapping rather than cut off. An option's
  // detail stays in its data but is not shown. Modifiers, so @brainstorm's cards stay as they are.
  + '.cx-opts{display:flex;flex-direction:column;gap:4px}.cx-opt-row{position:relative}'
  + '.bs-opt.cx-opt{align-items:flex-start;padding:7px 12px;font:14px/1.4 var(--font-sans)}.cx-opt>.bs-mark{margin-top:3px}'
  + '.cx-opt-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}'
  + '.cx-opt-line{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:8px;row-gap:1px}'
  + '.cx-opt-label{min-width:0;overflow-wrap:anywhere}'
  + '.cx-opt-why{min-width:0;overflow-wrap:anywhere;font-size:12.5px;color:#8f8f8f}'
  // A ticked option is outlined black (2026-10-16, Hudson: "this should be black outline, not blue … the button should stay
  // blue tho"), at the 1.5px every selected row has; @brainstorm's cards keep theirs.
  + '.bs-opt.cx-opt[aria-checked="true"]{border-color:#171717;box-shadow:inset 0 0 0 .5px #171717}'
  // Words that move while work goes on, in place of dots (2026-10-16: "Get rid of these weird dots … and just have the text
  // gradient"; "make this gradient and get rid of the blue dot"). Still for anyone who asked for less motion.
  + '.cx-shimmer{background:linear-gradient(90deg,#a3a3a3 0%,#171717 35%,#a3a3a3 70%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:cx-shimmer 1.8s linear infinite}'
  + '@keyframes cx-shimmer{from{background-position:110% 0}to{background-position:-110% 0}}'
  + '@media (prefers-reduced-motion: reduce){.cx-shimmer{animation:none;color:#4d4d4d;background:none}}'
  // The grant (2026-10-16): the add to library page's rows in a message, a circle at the right that fills blue once ticked.
  + '.cx-grant-row{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid transparent;border-radius:8px;background:#fff;cursor:pointer;text-align:left;font:14.5px/1.4 var(--font-sans);color:#171717}'
  + '.cx-grant-row:hover{background:#fafafa}.cx-grant-row[aria-checked="true"]{border-color:#171717;box-shadow:inset 0 0 0 .5px #171717;background:#fafafa}.cx-grant-row:disabled{cursor:default}'
  + '.cx-grant-row:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.cx-circle{flex:none;box-sizing:border-box;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:1.5px solid #c9c9c9;border-radius:50%;background:#fff;color:#fff}'
  + '[aria-checked="true"]>.cx-circle{border-color:#0070f3;background:#0070f3}'
  + '.bs-field{display:block;width:100%;box-sizing:border-box;margin:0;padding:8px 10px;border:1px solid #eaeaea;border-radius:8px;background:#fff;outline:none;resize:none;font:14px/1.5 var(--font-sans);color:#171717}.bs-field:focus{border-color:#c9c9c9}.bs-field::placeholder{color:#8f8f8f}'
  + '.bs-submit{padding:8px 14px;border:0;border-radius:8px;background:#0070f3;color:#fff;font:500 13px/1 var(--font-sans);cursor:pointer;transition:opacity 120ms}.bs-submit:hover{opacity:.86}.bs-submit:disabled{background:#eaeaea;color:#8f8f8f;cursor:default;opacity:1}'
  + '.cx-btn{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border:1px solid #171717;border-radius:8px;background:#171717;color:#fff;cursor:pointer;font:500 12.5px/1 var(--font-sans);white-space:nowrap}.cx-btn:hover{opacity:.88}.cx-btn:disabled{opacity:.5;cursor:default}'
  + '.cx-ghost{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid #eaeaea;border-radius:8px;background:#fff;color:#171717;cursor:pointer;font:500 12.5px/1 var(--font-sans);white-space:nowrap}.cx-ghost:hover{border-color:#c9c9c9}.cx-ghost:disabled{color:#8f8f8f;cursor:default}';

const Svg = ({ size = 12, width = 2, children }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const CARET_RIGHT = <Svg><path d="m9 18 6-6-6-6" /></Svg>;
const CARET_DOWN = <Svg><path d="m6 9 6 6 6-6" /></Svg>;
const PLUS = <Svg size={14} width={1.5}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
const FOLDER = <Svg size={14} width={1.5}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>;
const ARROW_UP = <Svg size={13} width={2.2}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Svg>;
const BACK = <Svg size={16} width={1.5}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></Svg>;
const DOWNLOAD = <Svg size={14} width={1.8}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Svg>;
const CHECK = <Svg size={12} width={2.5}><path d="M20 6 9 17l-5-5" /></Svg>;
const MINUS = <Svg size={16} width={1.6}><path d="M5 12h14" /></Svg>;
const CLOSE = <Svg size={15} width={1.6}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
const FILE = <Svg size={14} width={1.6}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 13h4" /><path d="M10 17h4" /></Svg>;
// The folder modal's tiles (MATH-110, David's mockup): a filled Finder-blue folder, and a cloud for iCloud Drive and the drives.
const FOLDER_FILLED = <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1.5 0.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" fill="#70a8f5" stroke="#5395ea" strokeWidth="0.8" /></svg>;
const CLOUD_FILLED = <svg width="15" height="11" viewBox="0 0 15 11" aria-hidden="true"><path d="M4 10.5a3.5 3.5 0 0 1-.5-6.96A4.5 4.5 0 0 1 12 4.1a3.2 3.2 0 0 1-.3 6.4z" fill="#70a8f5" stroke="#5395ea" strokeWidth="0.8" /></svg>;
const GLOBE = <Svg size={14} width={1.5}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></Svg>;
/** "a, b and c". */
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
/** The index of the chat's last turn (the librarian's or the person's): not the opening line, a notice or the apps' grant; -1. */
export function lastTurn(chat) {
  for (let i = (chat || []).length - 1; i >= 0; i -= 1) { const item = chat[i]; if (!item.opener && !item.notice && !item.grant) return i; }
  return -1;
}
const LOCK = <Svg size={13} width={1.8}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
const ALERT = <Svg size={14} width={1.8}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></Svg>;

const shown = (dir) => String(dir || '').replace(/^\/Users\/[^/]+/, '~');
const logoOf = (name) => (LOGOS[name] ? <span aria-hidden="true" style={{ flex: 'none', display: 'block', width: 14, height: 14, background: `url(${LOGOS[name]}) center / contain no-repeat` }} /> : null);

/**
 * A tick: on, off, or (a group's header with some of its rows ticked) `some`. Only a real tick is black (MATH-143,
 * 2026-10-11): `some` is the unticked box with a short grey bar in it, so a screen that opens partly ticked reads light.
 */
function Box({ on, some = false, size = 14, dim = false }) {
  const full = on && !some;
  const bar = size * 1.5 / 14;
  return (
    <span role="checkbox" aria-checked={some ? 'mixed' : on ? 'true' : 'false'} style={{ flex: 'none', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, boxSizing: 'border-box', background: full ? '#171717' : '#fff', border: full ? 0 : `1.5px solid ${dim ? '#e3e3e3' : '#c9c9c9'}`, color: '#fff', font: '600 9px/1 var(--font-sans)', cursor: 'pointer' }}>
      {some ? <span aria-hidden="true" data-connect-box-mixed="1" style={{ display: 'block', width: size / 2, height: bar, borderRadius: bar / 2, background: '#8f8f8f' }} /> : full ? '✓' : ''}
    </span>
  );
}

const subRow = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 30, padding: '5px 8px 5px 18px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left', boxSizing: 'border-box' };
const LABEL_COLOR = { muted: '#c9c9c9', busy: '#a35200', error: '#e70022', '': '#8f8f8f' };

/**
 * A row's name and, only when the person has to do something or would be surprised, one grey line under it (2026-10-09,
 * board "Now-3a-Fix"): "Needs sign-in", "macOS will ask", "Not found", or what is happening while it acts (busy and error
 * tones). The plain words (a folder, "signed in", "6 on this Mac") are the row's tooltip only. The right edge is only the
 * checkboxes. A row not found is dimmed whole (`dim`): only an app read from this Mac that is not on it, never one in the
 * cloud, which says "Needs sign-in" instead (MATH-144, model/connect.js rowLabel).
 */
function RowText({ name, on, sub, label, dim = false, tip: extra = '', onRetry = null, onAnother = null, onHere = null }) {
  const tone = (label && label.text && label.tone) || '';
  const shown = label && label.text && tone ? label.text : ''; // muted ("Needs sign-in", "Not found"), busy, error
  const line = [shown, sub].filter(Boolean).join(' · ');
  const color = dim ? '#c9c9c9' : tone === 'busy' || tone === 'error' ? LABEL_COLOR[tone] : '#8f8f8f';
  const tip = [label && label.text, sub, extra].filter(Boolean).join(' · ') || undefined;
  return (
    <span title={tip} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ font: '13px/1.2 var(--font-sans)', color: dim ? '#8f8f8f' : on ? '#171717' : '#4d4d4d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {line && (
        <span data-connect-row-label={shown ? tone : undefined} data-connect-row-sub={sub ? '1' : undefined} style={{ font: '11.5px/1.35 var(--font-sans)', color, overflowWrap: 'anywhere' }}>
          {line}
          {/* macOS refused a browser's sign-ins (2026-10-10): asks it again. A link in the row's button, not a button in it. */}
          {label && label.retry && onRetry && <> · <span role="link" tabIndex={0} data-connect-retry={name} onClick={(event) => { event.stopPropagation(); onRetry(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onRetry(); } }} style={{ color: '#171717', textDecoration: 'underline', cursor: 'pointer' }}>Try again</span></>}
          {/* Google's row waiting on the browser (2026-10-12): Google's add-an-account page there; the wait goes on. */}
          {label && label.another && onAnother && <> · <span role="link" tabIndex={0} data-connect-another={name} onClick={(event) => { event.stopPropagation(); onAnother(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onAnother(); } }} style={{ color: '#171717', textDecoration: 'underline', cursor: 'pointer' }}>Use another account</span></>}
          {/* Any row waiting on the browser (2026-10-12): ends that wait and signs in in Engelbart's own window instead. */}
          {label && label.here && onHere && <> · <span role="link" tabIndex={0} data-connect-here={name} onClick={(event) => { event.stopPropagation(); onHere(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onHere(); } }} style={{ color: '#171717', textDecoration: 'underline', cursor: 'pointer' }}>Sign in here instead</span></>}
        </span>
      )}
    </span>
  );
}

/** An on/off switch (2026-10-11, David's mockup: the consent card's, at the top of the choose screen). */
function Toggle({ on }) {
  return (
    <span aria-hidden="true" style={{ flex: 'none', position: 'relative', width: 32, height: 18, borderRadius: 9, background: on ? '#171717' : '#d9d9d9', transition: `background 140ms ${EASE}` }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)', transition: `left 140ms ${EASE}` }} />
    </span>
  );
}

// A row dimmed: rowLabel says "Not found" only for an app read from this Mac that is not on it (Cursor, Codex, a folder
// app), or for Websites with no browser and Local repos with none; a web app or Zotero is "Needs sign-in" (MATH-144).
const notFound = (label) => !!label && label.text === 'Not found';

// `name` is the app's id (its logo, data-connect-app); the row shows the name the person knows it by (shownName). A
// repository's row (`data` its own) shows the repository's name as it is.
function AppRow({ name, on, onToggle, label, sub = '', tip = '', icon = null, data = name, onRetry = null, onSignIn = null, onAnother = null, onHere = null }) {
  const dim = notFound(label);
  const text = data === name ? shownName(name) : name;
  const signIn = !!(label && label.signIn && onSignIn);
  const press = (event) => { event.stopPropagation(); onSignIn(); };
  return (
    <button type="button" className="hov-wash" data-connect-app={data} data-connect-not-found={dim ? '1' : undefined} onClick={onToggle} style={subRow}>
      <span style={{ margin: '0 1px', display: 'flex', color: '#4d4d4d', opacity: dim ? 0.45 : 1 }}>{icon || logoOf(name) || (name === LOCAL_PDFS ? FOLDER : <span style={{ width: 14 }} />)}</span>
      <RowText name={text} on={on} sub={sub} label={label} dim={dim} tip={tip} onRetry={onRetry} onAnother={onAnother} onHere={onHere} />
      {/* No browser of the person's could sign the app in (2026-10-11), or they turned its sign-ins down: its sign-in page in Engelbart's own browser. A link in the row's button, as Try again is. */}
      {signIn && <span role="button" tabIndex={0} data-connect-signin={name} onClick={press} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); press(event); } }} style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f', textDecoration: 'underline', cursor: 'pointer' }}>Sign in</span>}
      <Box on={on} dim={dim} />
    </button>
  );
}

/** A row that opens to more rows (Code's GitHub and Local repos): its caret opens it, the rest of it ticks it. */
function ExpandRow({ name, on, some = false, open, onOpen, onToggle, label, icon }) {
  return (
    <div className="hov-wash" data-connect-app={name} style={{ ...subRow, padding: '5px 8px 5px 4px', cursor: 'default' }}>
      <button type="button" data-connect-row-open={name} aria-expanded={open ? 'true' : 'false'} aria-label={open ? `Close ${shownName(name)}` : `Open ${shownName(name)}`} onClick={onOpen} style={{ flex: 'none', width: 12, display: 'flex', justifyContent: 'center', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform 140ms' }}>{CARET_RIGHT}</button>
      <button type="button" onClick={onToggle} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ margin: '0 1px', display: 'flex', color: '#4d4d4d', opacity: notFound(label) ? 0.45 : 1 }}>{icon || logoOf(name)}</span>
        <RowText name={shownName(name)} on={on || some} label={label} dim={notFound(label)} />
        <Box on={on} some={some} dim={notFound(label)} />
      </button>
    </div>
  );
}

function FolderRow({ path, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 8px 0 18px', color: '#171717' }}>
      {FOLDER}
      <span style={{ flex: 1, minWidth: 0, font: '12px/1 var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown(path)}</span>
      <button type="button" className="hov-ink" onClick={onRemove} aria-label="Remove folder" style={{ display: 'inline-flex', padding: '0 2px', border: 0, background: 'transparent', cursor: 'pointer', color: '#8f8f8f', font: '14px/1 var(--font-sans)' }}>×</button>
    </div>
  );
}

function AddRow({ label, hint, onClick, data }) {
  return (
    <button type="button" className="hov-wash" data-connect-add={data} onClick={onClick} style={{ ...subRow, color: '#8f8f8f' }}>
      {PLUS}
      <span style={{ flex: 1, minWidth: 0, font: '13px/1 var(--font-sans)' }}>{label}</span>
      {hint && <span style={{ font: '12px/1 var(--font-sans)', color: '#c9c9c9' }}>{hint}</span>}
    </button>
  );
}

/**
 * The provider chip: "Refine with Claude Code ⌄ · Sonnet High | ↑". Only the provider is chosen (2026-10-07: "do not
 * even allow me to change model or effort, only provider"); its model is the pinned one, shown, not offered.
 */
function ProviderChip({ lead = '', providers, provider, fallback = null, onPick, onSend, sendOn, sendLabel, style }) {
  const [open, setOpen] = React.useState(false);
  const current = (providers || []).find((entry) => entry.provider === provider) || fallback;
  const usable = (providers || []).filter((entry) => entry.ready);
  // With a lead ("Refine with"), the button that starts the run (2026-10-09: "make this button look better and stand out
  // more", then "slightly less pronounced"): filled dark, its arrow blue; dimmed until there is something to refine. Without, the chat's quiet chip.
  const primary = !!lead;
  const lit = primary && sendOn;
  const quiet = primary ? 'rgba(255,255,255,.62)' : '#8f8f8f';
  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex', ...style }}>
      <span className="bart-chip" role="button" data-connect-chip="1" data-connect-chip-primary={primary ? '1' : undefined} onClick={() => setOpen((now) => !now)} title="Choose Claude Code or Codex" style={primary
        ? { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 5px 5px 15px', border: '1px solid #2b2b2b', borderRadius: 999, background: '#2b2b2b', boxShadow: lit ? '0 2px 8px rgba(0,0,0,.10)' : 'none', opacity: lit ? 1 : 0.45, cursor: 'pointer', font: '500 13.5px/1 var(--font-sans)', color: '#fff', whiteSpace: 'nowrap', transition: `opacity 160ms ${EASE}, box-shadow 160ms ${EASE}` }
        : { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}>
        {lead && <span style={{ fontWeight: 400, color: quiet }}>{lead}</span>}
        <span data-connect-provider={provider || ''}>{current ? current.name : 'No agent'}</span>
        {current && <span style={{ fontWeight: 400, color: quiet }}>{`${current.modelName} · ${current.effort === 'xhigh' ? 'Extra high' : current.effort.charAt(0).toUpperCase() + current.effort.slice(1)}`}</span>}
        {usable.length > 1 && <span style={{ display: 'inline-flex', color: quiet }}>{CARET_DOWN}</span>}
        <span style={{ width: 1, height: primary ? 16 : 14, background: primary ? 'rgba(255,255,255,.2)' : '#eaeaea', margin: primary ? '0 3px 0 4px' : '0 2px' }} />
        <button type="button" className="bart-send" data-connect-send="1" aria-label={sendLabel} onClick={(event) => { event.stopPropagation(); onSend(); }} style={primary
          ? { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: '50%', background: '#0070f3', color: '#fff', cursor: sendOn ? 'pointer' : 'default' }
          : { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, border: 0, borderRadius: '50%', background: sendOn ? '#0070f3' : '#f2f2f2', color: sendOn ? '#fff' : '#8f8f8f', cursor: sendOn ? 'pointer' : 'default' }}>{ARROW_UP}</button>
      </span>
      {open && <ProviderMenu providers={providers} provider={provider} onPick={(next) => { setOpen(false); onPick(next); }} at={{ right: 0, bottom: 'calc(100% + 6px)' }} />}
    </span>
  );
}

/** Claude Code or Codex, each with its pinned model and effort; one not signed in is greyed. `at` where it hangs. */
function ProviderMenu({ providers, provider, onPick, at }) {
  return (
    <div data-overlay="1" data-connect-providers="1" style={{ position: 'absolute', ...at, zIndex: 5, width: 250, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 140ms ${EASE}` }}>
      {(providers || []).map((entry) => (
        <button key={entry.provider} type="button" className="hov-wash" disabled={!entry.ready} data-connect-provider-option={entry.provider} onClick={(event) => { event.stopPropagation(); onPick(entry.provider); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: entry.ready ? 'pointer' : 'default', textAlign: 'left' }}>
          <span style={{ width: 12, color: '#0070f3', display: 'flex' }}>{entry.provider === provider ? CHECK : null}</span>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: '13px/1.3 var(--font-sans)', color: entry.ready ? '#171717' : '#8f8f8f' }}>{entry.name}</span>
            <span style={{ font: '11.5px/1.3 var(--font-sans)', color: '#8f8f8f' }}>{entry.ready ? `${entry.modelName} · ${entry.effort}` : 'not signed in'}</span>
          </span>
        </button>
      ))}
      <div style={{ padding: '6px 10px 4px', font: '11.5px/1.45 var(--font-sans)', color: '#8f8f8f' }}>Every agent here runs on this model and effort.</div>
    </div>
  );
}

/**
 * The agent named inside the consent line, "Use my [Claude Code ⌄] subscription to read these" (2026-10-09, David's
 * mockup): a quiet box that opens the same menu as the chat's chip, under it, or above it with `up` (the consent card at the
 * foot of onboarding's page, 2026-10-12).
 */
function ProviderPick({ providers, provider, onPick, up = false }) {
  const [open, setOpen] = React.useState(false);
  const current = (providers || []).find((entry) => entry.provider === provider) || null;
  const usable = (providers || []).filter((entry) => entry.ready);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'baseline' }}>
      <button type="button" className="hov-wash" data-connect-pick-provider={provider || ''} disabled={usable.length < 2} onClick={(event) => { event.stopPropagation(); setOpen((now) => !now); }} title="Choose Claude Code or Codex"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, margin: '-2px 1px', padding: '1px 6px 1px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', cursor: usable.length < 2 ? 'default' : 'pointer', font: 'inherit', color: '#171717' }}>
        <span data-connect-provider={provider || ''}>{current ? current.name : 'Claude Code'}</span>
        {usable.length > 1 && <span style={{ display: 'inline-flex', color: '#8f8f8f' }}>{CARET_DOWN}</span>}
      </button>
      {open && <ProviderMenu providers={providers} provider={provider} onPick={(next) => { setOpen(false); onPick(next); }} at={up ? { left: 0, bottom: 'calc(100% + 6px)' } : { left: 0, top: 'calc(100% + 6px)' }} />}
    </span>
  );
}

/**
 * How far back the import looks, named inside the words "From [the past year ⌄]" in the sources' header (2026-10-10):
 * the past 6 months, the past year or all time. Built like ProviderPick; a click outside closes it.
 */
function PeriodPick({ days, onPick }) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (box.current && !box.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span ref={box} style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'baseline' }}>
      <button type="button" className="hov-wash" data-connect-period={days || 'all'} onClick={(event) => { event.stopPropagation(); setOpen((now) => !now); }} title="How far back to look"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, margin: '-2px 1px', padding: '1px 6px 1px 8px', border: '1px solid #eaeaea', borderRadius: 6, background: '#fff', cursor: 'pointer', font: 'inherit', color: '#171717' }}>
        <span>{periodName(days)}</span>
        <span style={{ display: 'inline-flex', color: '#8f8f8f' }}>{CARET_DOWN}</span>
      </button>
      {open && (
        <div data-overlay="1" data-connect-periods="1" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 5, width: 180, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 140ms ${EASE}` }}>
          {PERIODS.map((period) => (
            <button key={period.label} type="button" className="hov-wash" data-connect-period-option={period.days || 'all'} onClick={(event) => { event.stopPropagation(); setOpen(false); onPick(period.days); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ width: 12, color: '#0070f3', display: 'flex' }}>{period.days === days ? CHECK : null}</span>
              <span style={{ font: '13px/1.3 var(--font-sans)', color: '#171717' }}>{period.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Three dots in a row, pulsing: the chat's "the librarian is at it" (the mockup's "••• Looking at your Overleaf projects…"). */
function Dots() {
  return (
    <span aria-hidden="true" style={{ flex: 'none', display: 'inline-flex', gap: 3 }}>
      <style>{'@keyframes eng-pulse{0%,70%,100%{opacity:.15}35%{opacity:1}}'}</style>
      {[0, 1, 2].map((i) => <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: '#4d4d4d', opacity: 0.15, animation: 'eng-pulse 1.1s ease-in-out infinite', animationDelay: `${i * 140}ms` }} />)}
    </span>
  );
}

const KEY = <Svg size={18} width={1.8}><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></Svg>;
const KEYCHAIN_TONES = {
  ask: { background: '#f2f2f2', color: '#171717' },
  busy: { background: '#f2f2f2', color: '#171717' },
  ok: { background: '#e8f6ee', color: '#1f9d55' },
  warn: { background: '#fff4e0', color: '#a35200' },
  refused: { background: '#fff4e0', color: '#a35200' },
};

// A profile to pick, in the Keychain modal: ImportSignins' profile-step row.
const PROFILE_ROW = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', textAlign: 'left', font: '13.5px/1.4 var(--font-sans)', color: '#171717', transition: 'border-color 120ms' };

/**
 * Before macOS asks for a browser's sign-ins (2026-10-11, David: the inline panel under the sources was easy to miss, and
 * the macOS prompt then came out of nowhere): a modal over everything, at most once a browser, since one Allow
 * covers every app from it. `panel` (signInPanel's) asks: Continue checks the apps, Not now leaves them ticked with Sign in
 * on their rows, which signs in in Engelbart's own window (2026-10-12). After Continue,
 * `outcome` (keychainOutcome's) says how it went: waiting while macOS asks, then signed in, or not and why. Escape is Not
 * now while it asks, and closes it after. In a portal: the window's own rise animation would hold a fixed layer inside it.
 */
function KeychainModal({ panel, outcome, onContinue, onNotNow, onClose, onChoose }) {
  const phase = outcome ? (outcome.done ? 'done' : 'waiting') : 'ask';
  const primary = React.useRef(null);
  React.useEffect(() => { if (primary.current) primary.current.focus(); }, [phase]);
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (phase === 'ask') onNotNow(); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, onNotNow, onClose]);
  const tone = KEYCHAIN_TONES[phase === 'ask' ? 'ask' : outcome.tone] || KEYCHAIN_TONES.busy;
  const title = phase === 'ask' ? panel.title : outcome.title;
  const icon = phase === 'done' && outcome.tone === 'ok' ? <Svg size={18} width={2.4}><path d="M20 6 9 17l-5-5" /></Svg> : KEY;
  return createPortal(
    <div data-overlay="1" data-cover="1" data-connect-keychain={phase} style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(23,23,23,.28)' }}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(420px, 100%)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '22px 22px 18px', background: '#fff', borderRadius: 12, boxShadow: '0 16px 48px #00000029', animation: `rise 160ms ${EASE}` }}>
        <span aria-hidden="true" style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', ...tone }}>{icon}</span>
        <span style={{ font: '600 16px/1.35 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{title}</span>
        {phase === 'ask' && panel.lead && <span data-connect-keychain-lead="1" style={{ font: '600 13.5px/1.5 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{panel.lead}</span>}
        {(phase === 'ask' ? panel.body : outcome.lines).map((text) => <span key={text} style={{ font: '13px/1.5 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{text}</span>)}
        {phase === 'ask' && panel.profiles && panel.profiles.length > 1 && (
          // Which profile (2026-10-12): as ImportSignins' profile step lists them, the one chosen marked.
          <span role="radiogroup" aria-label="Profile" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {panel.profiles.map((profile, index) => {
              const on = index === panel.chosen;
              return (
                <button key={`${profile.browserId}/${profile.profileId}`} type="button" role="radio" aria-checked={on} className="hov-bd2" data-connect-signin-profile={profile.profileId} data-chosen={on ? '1' : undefined} onClick={() => onChoose && onChoose(index)} style={{ ...PROFILE_ROW, borderColor: on ? '#171717' : '#eaeaea' }}>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span>{panel.profiles.some((other) => other.browser !== profile.browser) ? `${profile.browser} · ${profile.name}` : profile.name}</span>
                    {profile.email && <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.email}</span>}
                  </span>
                  <span style={{ color: on ? '#171717' : '#c9c9c9' }}>{on ? '✓' : ''}</span>
                </button>
              );
            })}
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, paddingTop: 8 }}>
          {phase === 'ask' && <>
            <button type="button" className="hov-ink" data-connect-signin-not-now={panel.browser} onClick={onNotNow} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Not now</button>
            <button type="button" ref={primary} data-connect-signin-continue={panel.browser} onClick={onContinue} style={{ padding: '9px 16px', border: 0, borderRadius: 8, background: '#171717', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#fff' }}>Continue</button>
          </>}
          {phase === 'waiting' && <>
            <span style={{ flex: 1, display: 'flex', alignItems: 'center' }}><Dots /></span>
            <button type="button" className="hov-ink" data-connect-keychain-hide="1" onClick={onClose} title="Close this; the row still says how it goes" style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Hide</button>
          </>}
          {phase === 'done' && <button type="button" ref={primary} data-connect-keychain-done="1" onClick={onClose} style={{ padding: '9px 16px', border: 0, borderRadius: 8, background: '#171717', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#fff' }}>Done</button>}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Before macOS asks to let Engelbart read its protected folders (MATH-110): one modal naming them all, so the prompts that
 * follow are expected, and come before the run instead of in the middle of it. Ask macOS reads each folder in turn (macOS
 * asks about each); Not now leaves them out of this run, the row still ticked. Escape is Not now. In a portal, as
 * KeychainModal is.
 */
function FolderAccessModal({ panel, onContinue, onNotNow }) {
  const primary = React.useRef(null);
  React.useEffect(() => { if (primary.current) primary.current.focus(); }, []);
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onNotNow();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onNotNow]);
  return createPortal(
    <div data-overlay="1" data-cover="1" data-connect-folders="ask" style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(23,23,23,.28)' }}>
      <div role="dialog" aria-modal="true" aria-label={panel.title} style={{ width: 'min(490px, 100%)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', padding: '23px 26px 26px', background: '#fff', borderRadius: 12, boxShadow: '0 16px 48px #00000029', animation: `rise 160ms ${EASE}` }}>
        <span style={{ font: '600 19px/24px var(--font-sans)', letterSpacing: -0.2, color: '#171717', textWrap: 'pretty' }}>{panel.title}</span>
        <span data-connect-folders-lead="1" style={{ marginTop: 19, font: '16px/23.5px var(--font-sans)', letterSpacing: -0.25, color: '#6b6f76' }}>{panel.lead}</span>
        <span data-connect-folders-names="1" style={{ marginTop: 17, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {panel.names.map((name) => (
            <span key={name} data-connect-folders-name={name} style={{ minWidth: 0, height: 36, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px 0 13px', border: '1px solid #eaeaea', borderRadius: 8 }}>
              <span aria-hidden="true" style={{ flex: 'none', display: 'flex' }}>{/drive/i.test(name) || /^(Dropbox|OneDrive|Box)/.test(name) ? CLOUD_FILLED : FOLDER_FILLED}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 15px/1 var(--font-sans)', color: '#171717' }}>{name}</span>
            </span>
          ))}
        </span>
        <span data-connect-folders-tip="1" title={panel.tip} style={{ marginTop: 18, font: '15px/22px var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}><b style={{ fontWeight: 600, color: '#171717' }}>{panel.note}</b> {panel.ask}</span>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 22, marginTop: 22 }}>
          <button type="button" className="hov-ink" data-connect-folders-not-now="1" onClick={onNotNow} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 15px/1 var(--font-sans)', color: '#8f8f8f' }}>Not now</button>
          <button type="button" ref={primary} data-connect-folders-continue="1" onClick={onContinue} style={{ height: 37, padding: '0 17px', border: 0, borderRadius: 8, background: '#171717', cursor: 'pointer', font: '600 15px/1 var(--font-sans)', color: '#fff' }}>Ask macOS</button>
        </span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Bring these in with ticked web apps no browser could sign in (2026-10-11): one modal, the apps grouped by the sign-in
 * they share. Sign in opens the first one's sign-in page in Engelbart's own browser (Google's in the person's browser,
 * `waiting` saying so, 2026-10-12, the "Sign in opens …" sentence hidden meanwhile); once every app is signed in, the run starts. Leave them out unticks them and starts.
 * Escape closes it, starting nothing. In a portal, as KeychainModal is.
 */
function SignInGateModal({ gate, signing, waiting = '', canSignIn = true, onSignIn, onLeave, onClose }) {
  const primary = React.useRef(null);
  React.useEffect(() => { if (primary.current && !signing) primary.current.focus(); }, [signing]);
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div data-overlay="1" data-cover="1" data-connect-signin-gate={signing ? 'signing' : 'ask'} style={{ position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(23,23,23,.28)' }}>
      <div role="dialog" aria-modal="true" aria-label={gate.title} style={{ width: 'min(420px, 100%)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '22px 22px 18px', background: '#fff', borderRadius: 12, boxShadow: '0 16px 48px #00000029', animation: `rise 160ms ${EASE}` }}>
        <span aria-hidden="true" style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', ...KEYCHAIN_TONES.ask }}>{KEY}</span>
        <span style={{ font: '600 16px/1.35 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{gate.title}</span>
        {gate.lines.map((text) => <span key={text} style={{ font: '13px/1.5 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{text}</span>)}
        {!waiting && <span data-connect-signin-gate-body="1" style={{ font: '13px/1.5 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{signing ? 'Finish signing in in the window that opened.' : gate.body}</span>}
        {waiting && <span data-connect-signin-waiting="1" style={{ font: '600 13px/1.5 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{waiting}</span>}
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, paddingTop: 8 }}>
          {(signing || waiting) && <span style={{ flex: 1, display: 'flex', alignItems: 'center' }}><Dots /></span>}
          <button type="button" className="hov-ink" data-connect-signin-leave="1" onClick={onLeave} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Leave {gate.groups.flat().length === 1 ? 'it' : 'them'} out</button>
          {(canSignIn || signing) && <button type="button" ref={primary} data-connect-signin-go="1" disabled={signing} onClick={onSignIn} style={{ padding: '9px 16px', border: 0, borderRadius: 8, background: '#171717', cursor: signing ? 'default' : 'pointer', opacity: signing ? 0.5 : 1, font: '500 13px/1 var(--font-sans)', color: '#fff' }}>{signing ? (waiting ? 'Waiting…' : 'Signing in…') : 'Sign in'}</button>}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A question already answered, folded to one line, "✓ Which Overleaf projects should come in?" (2026-10-09, David's
 * mockup): the answer is the bubble under it. A click opens the card as it was answered.
 */
export function AnsweredAsk({ ask, children }) {
  const [open, setOpen] = React.useState(false);
  if (open) return <div data-connect-answered="open" onDoubleClick={() => setOpen(false)}>{children}</div>;
  return (
    <button type="button" className="hov-wash" data-connect-answered="1" onClick={() => setOpen(true)} title="Show the question"
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', cursor: 'pointer', textAlign: 'left', font: '13px/1.4 var(--font-sans)', color: '#4d4d4d' }}>
      <span style={{ flex: 'none', display: 'flex', color: '#8f8f8f' }}>{CHECK}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ask.title}</span>
    </button>
  );
}

/**
 * The steps the agents handed the person, in the chat as one card (2026-10-09, David's mockup in place of the strip above
 * Reply): a row an app, Skip and its one button. What Skip means is no longer said under it (2026-10-16, "get rid of this
 * slop"), nor anything under a sign-in brought back (recover's card: Sign in inside Engelbart).
 */
function NeedsCard({ needs, onOpen, onSkip }) {
  if (!needs.length) return null;
  return (
    <div data-connect-needs="1" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '94%', animation: `rise 200ms ${EASE}` }}>
      <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff' }}>
        {needs.map((need) => {
          const view = needView(need);
          // No line under a step's name (no hint subtext), only the wait in their browser while it waits.
          const under = need.busy && need.browser && need.kind !== 'signin-here' ? waitingIn(signInName(need.app), need.browser) : '';
          return (
            <div key={need.id} data-connect-need={need.kind} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px 10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 'none', display: 'flex', color: '#8f8f8f' }}>{logoOf(need.app) || ALERT}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span title={view.title} style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>{need.kind === 'signin-here' ? view.title : shownName(need.app)}</span>
                  {under && <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{under}</span>}
                  {need.note && !need.error && <span data-connect-need-note="1" style={{ font: '12px/1.45 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{need.note}</span>}
                </span>
                <button type="button" className="bart-text" data-connect-need-skip="1" onClick={() => onSkip(need)}>Skip</button>
                <button type="button" className="cx-btn" data-connect-need-open="1" disabled={need.busy} onClick={() => onOpen(need)}>{need.busy ? 'Waiting…' : view.action}</button>
              </div>
              {need.error && <div style={{ paddingLeft: 24, font: '12px/1.5 var(--font-sans)', color: '#e70022' }}>{need.error}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The librarian's first message (2026-10-16, Hudson: "one message that has the icon, name, and a circular checkbox …
 * 'Allow Engelbart to access the following apps:' … every one should be unchecked by default, but there should be a
 * 'Select all' button that is next to the 'Grant access' button. 'Select all' should change to 'Deselect all' if all are
 * selected. I should not be able to press 'Grant access' unless I have selected at least one."). Answered, it folds to
 * one line of what was allowed. `live`: it may still be answered (open, the run neither stopped nor finished).
 */
export function GrantCard({ grant, live, onGrant }) {
  const [picks, setPicks] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const ids = grant.rows.map((row) => row.id);
  const all = ids.length > 0 && ids.every((id) => picks.includes(id));
  if (grant.answered) {
    const said = grant.answered.allowed.length ? `Allowed ${listOf(grant.answered.allowed)}` : 'Allowed none of them';
    return <div data-connect-grant="answered" style={{ display: 'flex', alignItems: 'center', gap: 8, font: '13px/1.5 var(--font-sans)', color: '#8f8f8f' }}><span style={{ display: 'flex', color: '#8f8f8f' }}>{CHECK}</span>{said}</div>;
  }
  const toggle = (id) => setPicks((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));
  const send = async () => {
    if (!picks.length || busy) return;
    setBusy(true);
    try { await onGrant(picks); } finally { setBusy(false); }
  };
  return (
    <div data-connect-grant={live ? 'live' : 'closed'} style={{ padding: '14px 16px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff', animation: `rise 260ms ${EASE}` }}>
      <div style={{ font: '600 15px/1.45 var(--font-sans)', color: '#171717' }}>Allow Engelbart to access the following apps:</div>
      <div role="group" aria-label="Apps Engelbart may access" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
        {grant.rows.map((row) => {
          const on = picks.includes(row.id);
          return (
            <button key={row.id} type="button" className="cx-grant-row" role="checkbox" aria-checked={on ? 'true' : 'false'} data-connect-grant-app={row.id} disabled={!live || busy} onClick={() => toggle(row.id)}>
              <span style={{ flex: 'none', width: 18, display: 'flex', justifyContent: 'center', color: '#8f8f8f' }}>{logoOf(row.id) || GLOBE}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
              <span className="cx-circle" aria-hidden="true">{on ? CHECK : null}</span>
            </button>
          );
        })}
      </div>
      {live && (
        <div data-connect-card-actions="1" style={{ ...CARD_ACTIONS, justifyContent: 'flex-end' }}>
          <button type="button" className="bart-text" data-connect-grant-all="1" disabled={busy} onClick={() => setPicks(all ? [] : ids)}>{all ? 'Deselect all' : 'Select all'}</button>
          <button type="button" className="bs-submit" data-connect-grant-go="1" disabled={!picks.length || busy} onClick={send}>Grant access</button>
        </div>
      )}
    </div>
  );
}

/** A line Engelbart says about the run (an app left out or skipped): quiet, and never in the way of a question. */
function Notice({ text }) {
  return <div data-connect-notice="1" style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{text}</div>;
}

/**
 * A live card's Skip and Submit (2026-10-11): pinned to the bottom of the chat's scroll area while the card runs past
 * it, on white with a hairline over it, so Submit is there without scrolling; at the card's end it sits under the last
 * option, never over it (the chat's scroll-padding keeps a focused option clear of it too).
 */
const CARD_ACTIONS = { position: 'sticky', bottom: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: 8, margin: '12px -16px -14px', padding: '10px 16px 14px', borderRadius: '0 0 10px 10px', background: '#fff' };

/**
 * The librarian asking which GitHub repositories: the GitHub list onboarding and the choose screen use, with its search
 * and sign-in (2026-10-08: "when asking me which repositories it should use our existing nice github ui"); Submit sends
 * the ticked ones as "owner/name".
 */
function ReposCard({ ask, live, onAnswer }) {
  const [picks, setPicks] = React.useState([]);
  const toggle = (repo) => setPicks((now) => (now.includes(repo.fullName) ? now.filter((x) => x !== repo.fullName) : [...now, repo.fullName]));
  return (
    <div data-connect-card={live ? 'live' : 'answered'} data-connect-card-kind="repos" style={{ padding: '14px 16px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff' }}>
      <div style={{ font: '600 15px/1.45 var(--font-sans)', color: '#171717' }}>{ask.title}</div>
      {live && (
        <>
          <div data-connect-repos="1" style={{ height: 340, display: 'flex', flexDirection: 'column', marginTop: 10 }}>
            <GithubRepos held={(repo) => picks.includes(repo.fullName)} onToggle={toggle} busyId="" />
          </div>
          <div data-connect-card-actions="1" style={CARD_ACTIONS}>
            <button type="button" className="bart-text" data-connect-skip="1" onClick={() => onAnswer({ skipped: true })} style={{ paddingLeft: 0 }}>Skip</button>
            <span style={{ flex: 1 }} />
            {picks.length > 0 && <span style={{ font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>{picks.length} selected</span>}
            <button type="button" className="bs-submit" data-connect-submit="1" disabled={!picks.length} onClick={() => onAnswer({ picked: picks })}>Submit</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One option (2026-10-12): its mark and its label with its why after it in grey, wrapping rather than cut off. `checked`
 * (the librarian's recommendation in a "multi") and `detail` (what the option covers) stay in its data but are not shown:
 * no detail line, no ⓘ, no popover and no "Recommended" tag.
 */
function ConnectOption({ option, many, on, live, onPick, onSubmitOne }) {
  return (
    <div className="cx-opt-row">
      <button type="button" className="bs-opt cx-opt" disabled={!live} data-connect-option={option.label} role={many ? 'checkbox' : 'radio'} aria-checked={on ? 'true' : 'false'} onClick={() => onPick(option.label)} onDoubleClick={() => { if (!many && live) onSubmitOne(option.label); }}>
        <span className="bs-mark" data-square={many ? '1' : undefined} />
        <span className="cx-opt-text">
          <span className="cx-opt-line">
            <span className="cx-opt-label">{option.label}</span>
            {option.why ? <span className="cx-opt-why" data-connect-option-why="1">{option.why}</span> : null}
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * The librarian's question as a card: one option per line (round mark: one; square: several), its why after it. Every
 * card starts with nothing ticked (2026-10-12, reversing MATH-122's pre-ticking), and Submit waits for a tick (or their own
 * words); Skip is always there. The options the librarian recommends (`checked`) are not marked out.
 */
export function QuestionCard({ ask, live, onAnswer }) {
  const many = ask.kind === 'multi';
  const [picks, setPicks] = React.useState([]);
  const [note, setNote] = React.useState('');
  const open = ask.kind === 'open';
  const ready = open ? !!note.trim() : picks.length > 0 || !!note.trim();
  const submit = (labels = picks) => { if (!live) return; if (open) { if (note.trim()) onAnswer({ text: note.trim() }); return; } if (labels.length) onAnswer({ picked: labels, ...(note.trim() ? { text: note.trim() } : {}) }); else if (note.trim()) onAnswer({ text: note.trim() }); };
  const pick = (label) => setPicks((now) => (many ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : now.includes(label) ? [] : [label]));
  return (
    <div data-connect-card={live ? 'live' : 'answered'} style={{ padding: '14px 16px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff' }}>
      <div style={{ font: '600 15px/1.45 var(--font-sans)', color: '#171717' }}>{ask.title}</div>
      {many && <div style={{ marginTop: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Select all that apply.</div>}
      {!open && ask.options.length > 0 && (
        <div role={many ? 'group' : 'radiogroup'} aria-label={ask.title} className="cx-opts" style={{ marginTop: 12 }}>
          {ask.options.map((option) => <ConnectOption key={option.label} option={option} many={many} on={picks.includes(option.label)} live={live} onPick={pick} onSubmitOne={(label) => submit([label])} />)}
        </div>
      )}
      {live && (open
        ? <textarea data-connect-card-field="1" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} rows={2} placeholder={ask.placeholder || 'In a sentence or two…'} className="bs-field" spellCheck={false} style={{ marginTop: 12 }} />
        : <input data-connect-card-field="1" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} placeholder="Or say it in your own words…" className="bs-field" spellCheck={false} style={{ marginTop: 10 }} />)}
      {live && (
        <div data-connect-card-actions="1" style={CARD_ACTIONS}>
          <button type="button" className="bart-text" data-connect-skip="1" onClick={() => onAnswer({ skipped: true })} style={{ paddingLeft: 0 }}>Skip</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="bs-submit" data-connect-submit="1" disabled={!ready} onClick={() => submit()}>Submit</button>
        </div>
      )}
    </div>
  );
}

/** A button the librarian offers: sign in to a connector or Engelbart's own sign-in, ask macOS, or choose a folder. */
function AuthorizeCard({ authorize, live, busy, onUse, onSkip, onCancel }) {
  return (
    <div data-connect-authorize={authorize.kind} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button type="button" className="cx-btn" data-connect-button={authorize.kind} disabled={!live || busy} onClick={() => onUse(authorize)}>
        {LOGOS[authorize.app] && <span aria-hidden="true" style={{ width: 14, height: 14, background: `url(${LOGOS[authorize.app]}) center / contain no-repeat`, filter: 'brightness(0) invert(1)' }} />}
        {busy ? (authorize.kind === 'connector' ? `Finish signing in to ${shownName(authorize.app)} in your browser…` : 'Waiting…') : authorize.label}
      </button>
      {live && busy && authorize.kind === 'connector' && <button type="button" className="bart-text" onClick={() => onCancel(authorize)}>Cancel</button>}
      {live && !busy && <button type="button" className="bart-text" data-connect-skip="1" onClick={onSkip}>Skip</button>}
    </div>
  );
}

/**
 * A step an agent handed the person: what it is, and at its right one button that does it, and Skip (for the whole run).
 * A web app's Log in opens its sign-in in the default browser (main's web-signin.cjs) and waits there, saying which.
 */
function NeedCard({ need, onOpen, onSkip }) {
  const view = needView(need);
  return (
    <div data-connect-need={need.kind} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px 10px 14px', border: '1px solid #f5c26b', borderRadius: 10, background: '#fffaf0', animation: `rise 200ms ${EASE}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 'none', display: 'flex', color: '#a35200' }}>{logoOf(need.app) || ALERT}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>{view.title}</span>
          {need.reason && need.reason !== view.title && <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{need.reason}</span>}
          {need.busy && need.browser
            ? <span data-connect-need-wait="1" style={{ font: '12px/1.45 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{waitingIn(signInName(need.app), need.browser)}</span>
            : need.note && !need.error && <span data-connect-need-note="1" style={{ font: '12px/1.45 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{need.note}</span>}
        </span>
        <button type="button" className="bart-text" data-connect-need-skip="1" onClick={() => onSkip(need)}>Skip</button>
        <button type="button" className="cx-btn" data-connect-need-open="1" disabled={need.busy} onClick={() => onOpen(need)}>{need.busy ? 'Waiting…' : view.action}</button>
      </div>
      {need.error && <div style={{ font: '12px/1.5 var(--font-sans)', color: '#e70022' }}>{need.error}</div>}
    </div>
  );
}

/** One import (or survey, or recall) in the progress list: its label, status, and Stop; what went wrong, if it failed. */
function JobRow({ job, onStop }) {
  const status = statusOf(job);
  return (
    <div data-connect-job={job.status} data-connect-job-kind={job.kind} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {logoOf(job.apps[0]) || <span style={{ width: 14 }} />}
        <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', color: status.done ? '#4d4d4d' : '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.label}</span>
        <span style={{ flex: 'none', font: '12.5px/1 var(--font-sans)', color: status.failed ? '#e70022' : status.waiting ? '#a35200' : status.done ? '#171717' : '#8f8f8f' }}>{status.text}</span>
        {!status.done && <button type="button" className="bart-text" data-connect-stop-job={job.id} onClick={() => onStop(job)} style={{ padding: '2px 0 2px 4px' }}>Stop</button>}
      </div>
      {job.error && <span style={{ paddingLeft: 24, font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{job.error}</span>}
    </div>
  );
}

/**
 * A row of onboarding's "Bringing everything in" (2026-10-09, David's mockup): the app's logo, what it reads and under it
 * what it brings in, and at its right where it stands; Stop shows on the row under the pointer while it works.
 */
function PageJob({ job, onStop }) {
  const [hover, setHover] = React.useState(false);
  const row = workRow(job);
  const stoppable = !row.status.done;
  return (
    <div data-connect-job={job.status} data-connect-job-kind={job.kind} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '11px 12px', borderRadius: 8, background: hover ? '#f5f5f5' : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#8f8f8f' }}>{logoOf(job.apps[0]) || (job.source === 'sites' ? GLOBE : FOLDER)}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span data-connect-job-title="1" style={{ font: '500 13.5px/1.35 var(--font-sans)', color: '#171717', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
          {row.sub && <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.sub}</span>}
        </span>
        <span data-connect-job-status="1" style={{ flex: 'none', font: '12.5px/1 var(--font-sans)', color: row.status.failed ? '#e70022' : row.status.waiting ? '#a35200' : row.status.going ? '#171717' : '#8f8f8f', fontVariantNumeric: 'tabular-nums' }}>{row.status.text}</span>
        {stoppable && <button type="button" className="bart-text" data-connect-stop-job={job.id} onClick={() => onStop(job)} style={{ padding: '2px 0 2px 2px', visibility: hover ? 'visible' : 'hidden', font: '500 12.5px/1 var(--font-sans)', color: '#171717' }}>Stop</button>}
      </div>
      {job.error && <span style={{ paddingLeft: 28, font: '12px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{job.error}</span>}
    </div>
  );
}

/**
 * Under the chat, one line that never grows (2026-10-08: "list the current action of the agent and cycle through the
 * subagents at the bottom, similar to how claude code lists subagents"): what the librarian is doing, then the subagents
 * at work, one at a time, every few seconds the next.
 */
function WorkLine({ session }) {
  const [tick, setTick] = React.useState(0);
  const busy = workJobs(session.jobs).filter((job) => job.status === 'running' || job.status === 'waiting').length;
  React.useEffect(() => {
    if (busy < 2) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 2600);
    return () => clearInterval(timer);
  }, [busy]);
  const view = workLine(session, tick);
  if (!view) return null;
  const { agent } = view;
  return (
    <div data-connect-workline="1" aria-live="polite" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 4px', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f', overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {view.lead && <span data-connect-thinking="1" className="cx-shimmer" style={{ flex: 'none', maxWidth: agent ? '45%' : '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{view.lead}</span>}
      {view.lead && agent && <span style={{ flex: 'none', color: '#c9c9c9' }}>·</span>}
      {agent && (
        <span key={agent.id} data-connect-subagent={agent.id} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, animation: `rise 220ms ${EASE}` }}>
          <span style={{ flex: 'none', color: '#4d4d4d' }}>{agent.label}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: agent.waiting ? '#a35200' : '#8f8f8f' }}>{agent.doing}</span>
          {agent.place && <span style={{ flex: 'none', color: '#c9c9c9', fontVariantNumeric: 'tabular-nums' }}>{agent.place}</span>}
        </span>
      )}
    </div>
  );
}

/** The page's main button, as onboarding's own Continue: filled black, a caret after its words. */
export const FOOT_BUTTON = { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, height: 36, padding: '0 14px 0 16px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13.5px/1 var(--font-sans)', whiteSpace: 'nowrap' };

/**
 * The chat's foot button (2026-10-11): while the librarian still has questions it reads "Skip the rest" and stays quiet,
 * as the popup's Import does (white, a hairline, grey words), so Submit is the loudest thing on the screen; once it
 * reads "Bring these in" it is the page's main button.
 */
export function importFootStyle(done) {
  return done ? FOOT_BUTTON : { ...FOOT_BUTTON, border: '1px solid #eaeaea', background: '#fff', color: '#4d4d4d' };
}

/** The foot of onboarding's page: something at the left, then onboarding's pager (`pager`, its dots and "2 of 3") and the one button. */
export function Foot({ left, pager, button }) {
  return (
    <div data-connect-foot="1" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0 0' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>{left}</div>
      {pager}
      {button}
    </div>
  );
}

/** "Bringing in Zotero papers and AI chats · Google Drive needs you" (model/connect.js footLine), moving while work goes on (no dot, 2026-10-16). */
function FootStatus({ session }) {
  const text = footLine(session);
  if (!text) return null;
  const going = workJobs(session.jobs).some((job) => !statusOf(job).done);
  return (
    <span data-connect-foot-status="1" aria-live="polite" style={{ display: 'flex', alignItems: 'center', minWidth: 0, font: '12.5px/1.3 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      <span className={going ? 'cx-shimmer' : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </span>
  );
}

/**
 * Until the librarian says something (2026-10-09: "make the loading icon better and have some status to it"): its words,
 * moving (2026-10-16: no dots). `compact`: under the apps' grant, a line rather than the middle of the chat.
 */
function Starting({ compact = false }) {
  return (
    <div data-connect-starting="1" role="status" aria-live="polite" style={compact ? { display: 'flex', animation: `rise 260ms ${EASE}` } : { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 40, animation: `rise 260ms ${EASE}` }}>
      <div className="cx-shimmer" style={{ font: compact ? '14px/1.5 var(--font-sans)' : '500 16px/1.3 var(--font-sans)', letterSpacing: '-0.1px' }}>Getting to know your library</div>
    </div>
  );
}

/** Claude Code and Codex, when neither can run yet: install or sign in here ("must be done before this step"). */
function AgentSetup({ snapshot }) {
  const [error, setError] = React.useState('');
  if (!snapshot || !snapshot.tools) return <div style={{ font: 'italic 12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Checking Claude Code and Codex…</div>;
  const act = (row) => {
    setError('');
    const run = row.action === 'install' ? api.toolsInstall([row.id]) : row.action === 'sign-in' ? api.toolsSignIn(row.id) : row.action === 'cancel' ? api.toolsCancelSignIn(row.id) : row.action === 'update' ? api.toolsUpdate(row.id) : api.toolsCheck();
    Promise.resolve(run).catch((failure) => setError(errorMessage(failure)));
  };
  return (
    <div data-connect-agent-setup="1" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fafafa' }}>
      <span style={{ font: '500 13px/1.4 var(--font-sans)', color: '#171717' }}>Sign in to Claude Code or Codex first</span>
      <span style={{ font: '12.5px/1.5 var(--font-sans)', color: '#4d4d4d' }}>The agents that bring your library in run on one of them, with your own subscription.</span>
      {['claude', 'codex'].filter((id) => snapshot.tools[id]).map((id) => {
        const row = rowOf(snapshot.tools[id]);
        return (
          <div key={id} data-tool-row={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <span style={{ flex: 1, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{row.name}</span>
            <span style={{ font: '12px/1.4 var(--font-mono)', color: row.tone === 'ok' ? '#171717' : '#8f8f8f' }}>{row.state}</span>
            {row.action && <button type="button" className="cx-ghost" data-tool-action={row.action} onClick={() => act(row)}>{{ install: 'Install', update: 'Update', 'sign-in': 'Sign in', retry: 'Try again', cancel: 'Cancel' }[row.action]}</button>}
          </div>
        );
      })}
      {error && <span style={{ font: '12px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
    </div>
  );
}

/** A sign-in of Engelbart's own (Zotero, GitHub), started, then waited for: true once connected, false when it stops waiting. */
function waitFor(begin, status, subscribe) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const settle = (value) => { off(); resolve(value); };
    let waiting = false; // a status that is neither connected nor waiting only ends it once the sign-in was waiting
    off = subscribe((next) => {
      if (!next) return;
      if (next.connected) settle(true);
      else if (next.pending) waiting = true;
      else if (waiting) settle(false);
    });
    begin().then((first) => {
      if (first && first.connected) settle(true);
      else if (first && first.pending) waiting = true;
      else if (first && first.error) settle(false);
    }).catch((error) => { off(); reject(error); });
    status().then((now) => { if (now && now.connected) settle(true); }).catch(() => {});
  });
}
export const engelbartSignIn = (app) => (app === 'Zotero' ? waitFor(api.zoteroConnect, api.zoteroStatus, api.onZotero).then(async (done) => { if (done) await api.zoteroSync().catch(() => {}); return done; }) : waitFor(api.githubConnect, api.githubStatus, api.onGithub));

/**
 * `mode` 'onboarding' (a step: `onContinue` moves on, the work going on in the background) or 'popup' (`onClose` puts it
 * away). `sessionId`: a session to show again (the dock's). `projectId`: the project an existing user's notes go into;
 * `workspaceId` the workspace open there, which what comes in joins too (2026-10-11).
 * `project` { name, description }: what the librarian is told the project is (onboarding sends it without an id, so its
 * session stays an onboarding one, picked up again after a quit).
 * `onSession(id)` when a session begins; `onAdded(row)` for a library row added here (a GitHub repository); `onSkip`: Skip
 * for now / Not now before anything began. `onBack`: the chat's back arrow, for a session Import your context started
 * (From Amitav, 2026-10-15): the session stops and that flow's tools screen comes back, not this window's choose screen.
 */
export default function ConnectLibrary({ mode = 'onboarding', sessionId = null, projectId = null, workspaceId = null, project = null, pager = null, onSession = () => {}, onContinue = () => {}, onClose = () => {}, onSkip = () => {}, onAdded = () => {}, onBack = null }) {
  const popup = mode === 'popup';
  const page = !popup; // onboarding: a page of the window, not a box on it
  const [found, setFound] = React.useState(null);
  const [view, setView] = React.useState(sessionId ? 'loading' : 'choose'); // choose | chat | working
  const [picks, setPicks] = React.useState(null); // { picks, apps, open }
  const [folders, setFolders] = React.useState({ papers: [], code: [] });
  const [consent, setConsent] = React.useState(true); // "Use my … subscription to read these": files and the browser
  const consentRef = React.useRef(consent); // read after an await: a check started before the consent went off stops there
  consentRef.current = consent;
  const [days, setDays] = React.useState(DEFAULT_PERIOD_DAYS); // how far back to look: 182, 365 or null (all time)
  const [appFolders, setAppFolders] = React.useState({}); // app → the folder picked for a local app not found
  const [extraRepos, setExtraRepos] = React.useState([]); // folders picked for Code that were not among the repositories found
  const [repoCount, setRepoCount] = React.useState(null); // GitHub's repositories, for its row
  const [openRows, setOpenRows] = React.useState({}); // Code's GitHub and Local repos rows, opened
  const [leaves, setLeaves] = React.useState(false); // "What leaves my Mac?" opened
  const [notesState, setNotesState] = React.useState(''); // '' | 'asking' | 'allowed' | <why not>
  const [connectorStatus, setConnectorStatus] = React.useState({}); // app → { connected, pending }
  const [signIns, setSignIns] = React.useState({}); // web app → its sign-in as checked when ticked: { status, browser }
  const [waitingYes, setWaitingYes] = React.useState({}); // browser → [{ id, app }] ticked, waiting on its modal's Continue
  const [profileChoice, setProfileChoice] = React.useState({}); // browser → the profile chosen in its modal's list (an index)
  const [keychainRun, setKeychainRun] = React.useState(null); // { browser, rows } after Continue: the modal says how it went
  const [gate, setGate] = React.useState(null); // Bring these in with apps not signed in: 'ask' | 'signing' | 'leave' (its modal), or null
  // MATH-110: macOS's folder access. folderAsk: the modal ({ folders, papers, then: 'start' | null }); folderRun: the folders
  // it named and macOS's answers ({ folders, asking, answers }), for the PDFs row; foldersDeclined: Not now, this screen.
  const [folderAsk, setFolderAsk] = React.useState(null);
  const [folderRun, setFolderRun] = React.useState(null);
  const foldersDeclined = React.useRef(false);
  const [providers, setProviders] = React.useState(null);
  const [provider, setProvider] = React.useState(null);
  const [toolSnap, setToolSnap] = React.useState(null);
  const [session, setSession] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState('');
  const [authorizing, setAuthorizing] = React.useState(false);
  const [library, setLibrary] = React.useState([]);
  const [busyRepo, setBusyRepo] = React.useState('');
  const addedRepos = React.useRef(new Set()); // library ids this window added (unticking takes them out again)
  const chatRef = React.useRef(null);
  const draftRef = React.useRef(null);
  const idRef = React.useRef(sessionId);

  const readLibrary = React.useCallback(() => api.library().then((rows) => { setLibrary(rows); return rows; }).catch(() => []), []);
  const readProviders = React.useCallback(() => api.connectProviders().then((list) => {
    setProviders(list);
    setProvider((now) => (now && list.some((entry) => entry.provider === now && entry.ready) ? now : (list.find((entry) => entry.ready) || {}).provider || null));
    return list;
  }).catch(() => []), []);

  React.useEffect(() => {
    const offs = [
      api.onConnect((snapshot) => { if (snapshot && snapshot.id === idRef.current) setSession(snapshot); }),
      api.onConnectors((status) => { if (status && status.app) setConnectorStatus((now) => ({ ...now, [status.app]: status })); }),
      api.onLibraryChanged(() => { readLibrary(); }),
      api.onTools((snapshot) => { if (snapshot && snapshot.tools) { setToolSnap(snapshot); readProviders(); } }),
    ];
    api.tools().then(setToolSnap).catch(() => {});
    readProviders();
    readLibrary();
    const show = (snapshot) => { idRef.current = snapshot.id; setSession(snapshot); setView(snapshot.finished ? 'working' : 'chat'); api.connectMinimize(snapshot.id, false).catch(() => {}); };
    const choose = () => {
      api.connectDetect().then((value) => { setFound(value); setPicks(initialPicks(value)); if (value && value.github && value.github.found) countRepos(); }).catch((failure) => { setError(errorMessage(failure)); setPicks(initialPicks(null)); });
      api.connectConnectors().then((list) => setConnectorStatus(Object.fromEntries((list || []).map((entry) => [entry.app, entry])))).catch(() => {});
    };
    if (sessionId) {
      api.connectState(sessionId).then(show).catch((failure) => { setError(errorMessage(failure)); setView('choose'); });
    } else if (!popup) {
      // Onboarding again after Engelbart closed in the middle of it: the session that picked up where it was (main's
      // resume) is shown, not a new one.
      api.connectList().then((list) => {
        const going = resumable(list);
        if (going) { show(going); onSession(going.id); } else choose();
      }).catch(choose);
    } else {
      choose();
    }
    return () => offs.forEach((off) => off && off());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // This window shows its session: the dock leaves it alone while it is open here (ui/connect-open.js).
  const shownId = session ? session.id : null;
  React.useEffect(() => { if (!shownId) return undefined; markOpen(shownId, true); return () => markOpen(shownId, false); }, [shownId]);

  // The chat follows its newest message, from its top (2026-10-08: "when a question comes in i see the bottom, not the
  // top"): to the end when the newest message and what is under it fit, else to where it begins.
  const length = session ? session.chat.length : 0;
  const thinking = !!(session && session.thinking);
  const needCount = session ? session.needs.length : 0;
  React.useEffect(() => {
    const el = chatRef.current;
    if (!el) return undefined;
    const timer = setTimeout(() => {
      const end = el.scrollHeight - el.clientHeight;
      const agents = el.querySelectorAll('[data-connect-agent]');
      const newest = agents[agents.length - 1];
      const answered = !session || !session.chat.length || session.chat[session.chat.length - 1].role !== 'agent';
      el.scrollTop = newest && !answered ? Math.min(end, Math.max(0, newest.offsetTop - 18)) : end;
    }, 40);
    return () => clearTimeout(timer);
  }, [length, thinking, view, needCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (snapshot) => { idRef.current = snapshot.id; setSession(snapshot); onSession(snapshot.id); };

  /* ------------------------------------------------------------------ the choose screen's actions */
  // Ticking is the consent (MATH-114): a connector's sign-in starts, Apple Notes asks macOS, a local app that was not found
  // asks for its folder. Rows ticked from the start sign in when the run does (its needs), never on load.
  const countRepos = () => api.githubRepos().then((value) => setRepoCount((value.repos || []).length)).catch(() => {});
  const localRepos = found && Array.isArray(found.localRepos) ? found.localRepos : [];
  const repoPaths = () => [...localRepos.map((repo) => repo.path), ...extraRepos];
  const setRow = (id, row, on) => setPicks((now) => tickRow(now, id, row, on, repoPaths()));
  const toggleGroup = (id) => { const next = tickGroup(picks, id, found); setPicks(next); checkTicked(newlyTickedWeb(picks, next)); };
  const toggleAll = (on) => { const next = tickAll(picks, found, on); setPicks(next); checkTicked(newlyTickedWeb(picks, next)); };
  const expand = (id) => setPicks((now) => ({ ...now, open: { ...now.open, [id]: !now.open[id] } }));
  const pickDir = () => window.terminalAPI.pickDirectory(undefined).catch(() => null);
  const toggleApp = async (id, app) => {
    const on = ticked(picks, id, app);
    const spec = APPS[app] || {};
    const seen = (found && found.apps && found.apps[app]) || {};
    setError('');
    if (on) {
      setRow(id, app, false);
      if (spec.reach === 'connector' && (connectorStatus[app] || {}).pending) api.connectConnectorCancel(app).catch(() => {});
      return;
    }
    if (spec.reach === 'local' && !seen.found && !appFolders[app]) {
      const chosen = await pickDir();
      if (!chosen) return;
      setAppFolders((now) => ({ ...now, [app]: chosen }));
      setRow(id, app, true);
      return;
    }
    setRow(id, app, true);
    if (spec.reach === 'connector' && !(connectorStatus[app] || {}).connected) { if (!await connectorSignIn(app)) setRow(id, app, false); }
    else if (spec.reach === 'automation' && notesState !== 'allowed') { if (!await allowNotes()) setRow(id, app, false); }
    else if (spec.reach === 'signin' && !seen.found) {
      const done = await engelbartSignIn(app).catch((failure) => { setError(errorMessage(failure)); return false; });
      if (done) setFound((now) => ({ ...now, apps: { ...now.apps, [app]: { ...((now.apps || {})[app] || {}), found: true, where: 'signed in' } } }));
      else setRow(id, app, false);
    }
    else if (spec.reach === 'web') checkTicked([{ id, app }]);
    // A web app not signed in opens its sign-in by itself once checked (checkSignIn, 2026-10-12): ticking is the consent.
    // Its popup closed without signing in, it is unticked; one a stopped chain skipped keeps its tick and Sign in, and Bring
    // these in asks for it before the run starts.
  };
  // A web app ticked (with "Use my … subscription" on): its sign-in is brought over from the person's browser now
  // (2026-10-10), and the row says how it went. When macOS would ask for that browser's sign-ins, a panel says so first and
  // the check waits for its Continue; otherwise it starts at once. Rows ticked from the start are checked when the run is.
  // `open` (2026-10-12): a row just ticked (checkTicked, and Continue after it) that no browser signs in, still ticked with
  // the consent on, gets its sign-in opened by itself, in the chain (turnedDown); Try again and the run's checks never do.
  const checkSignIn = ({ id, app }, { retry = false, open = false } = {}) => {
    setSignIns((now) => ({ ...now, [app]: { status: 'checking', browser: '' } }));
    return api.connectSignInCheck(app, retry).then((out) => {
      if (!out || !out.status) { setSignIns((now) => { const next = { ...now }; delete next[app]; return next; }); return; }
      setSignIns((now) => ({ ...now, [app]: out })); // macOS said no: still ticked, with Try again and Sign in (2026-10-12)
      // and its sign-in opens by itself (2026-10-12, second run), as it does for a row just ticked that is not signed in
      if (opensSignIn(out.status, { fresh: open, consent: consentRef.current, still: ticked(picksRef.current, id, app) })) void turnedDown([{ id, app }]);
    }).catch(() => { setSignIns((now) => { const next = { ...now }; delete next[app]; return next; }); });
  };
  const checkTicked = async (ticks) => {
    // One already signed in (by another app sharing its sign-in, or before it was unticked) is ✓ at once, not checked again;
    // one whose sign-in is open already (its window, or a wait in the browser) shows that wait instead.
    const rows = ticks.filter((row) => !['signed-in', 'signing', 'browser'].includes((signIns[row.app] || {}).status));
    if (!signInsToCheck(consent, rows).length) return;
    const said = await Promise.all(rows.map((row) => api.connectSignInNote(row.app).then((out) => ({ ...row, ...(out || {}) })).catch(() => ({ ...row, note: '' }))));
    if (!consentRef.current) return; // turned off meanwhile: no panel, no check
    const ask = said.filter(asksFirst);
    if (ask.length) setWaitingYes((now) => waitForYes(now, ask));
    said.filter((row) => !asksFirst(row)).forEach((row) => checkSignIn(row, { open: true }));
  };
  // The modal comes first when macOS will be asked, or when more than one profile holds the sign-in (2026-10-12).
  const asksFirst = (row) => !!((row.note && row.browser) || (row.browser && row.profiles && row.profiles.length > 1));
  // Continue: one macOS prompt for the browser (main asks once and remembers its answer); the apps waiting on it are checked.
  // The profile chosen in its list is remembered first (main tries it first from then on). Google's rows asked for from
  // Sign in (route 'browser', 2026-10-12) go on to its sign-in in the person's browser, the row saying so, not the modal.
  // A sign-in of the chain waiting on this modal (signInInBrowser) goes on with the answer: 'browser' once Google's page is
  // opening in the browser, 'declined' when macOS refused (that group's window comes next).
  const allowSignIns = async (browser) => {
    const panel = signInPanel(picks, browser, waitingYes[browser], profileChoice[browser] || 0);
    const waiting = waitingYes[browser] || [];
    setWaitingYes((now) => { const next = { ...now }; delete next[browser]; return next; });
    setProfileChoice((now) => { const next = { ...now }; delete next[browser]; return next; });
    if (!panel) { answerChain(waiting, 'dropped'); return; }
    const pick = panel.chosen >= 0 ? panel.profiles[panel.chosen] : null;
    if (pick) {
      const holds = (row) => (row.profiles || []).some((profile) => profile.browserId === pick.browserId && profile.profileId === pick.profileId);
      await Promise.all(panel.rows.filter(holds).map((row) => api.connectSignInPick(row.app, { browser: pick.browserId, profile: pick.profileId }).catch(() => false)));
    }
    const checked = panel.rows.filter((row) => row.route !== 'browser');
    const viaBrowser = panel.rows.filter((row) => row.route === 'browser');
    const from = pick ? pick.browser : browser;
    if (panel.lead && (checked.length || viaBrowser.length)) setKeychainRun({ browser: from, rows: [...checked, ...viaBrowser] });
    checked.forEach((row) => checkSignIn(row, { open: true }));
    if (!viaBrowser.length) return;
    // Google's Sign in (2026-10-12): macOS asked now, while the modal says why ("Waiting for macOS…"), not minutes later
    // when the sign-in shows up in the browser. Allowed: its page opens there, and the copy then asks nothing. Refused:
    // nothing opens; the rows stay ticked and say "macOS didn't allow it" with Try again and Sign in (Engelbart's window), as
    // a check's refusal does.
    if (panel.lead) {
      const first = viaBrowser[0];
      const group = sharesSignIn(first.app);
      setSignIns((now) => { const next = { ...now }; for (const other of group) next[other] = { status: 'checking', browser: '', was: now[other] && now[other].status !== 'checking' ? now[other] : (now[other] || {}).was }; return next; });
      const out = await api.connectSignInUnlock(first.app).catch(() => ({ status: 'allowed', browser: '' }));
      if (out && out.status === 'refused') {
        setSignIns((now) => { const next = { ...now }; for (const other of group) next[other] = { status: 'refused', browser: out.browser || from }; return next; });
        void turnedDown(viaBrowser);
        answerChain(viaBrowser, 'declined');
        return;
      }
      // Allowed: the modal leaves these rows to the row's own waiting line.
      setKeychainRun((now) => {
        if (!now) return now;
        const rows = now.rows.filter((row) => !viaBrowser.some((each) => each.app === row.app));
        return rows.length ? { ...now, rows } : null;
      });
    }
    viaBrowser.forEach((row) => { void browserSignIn(row.id, row.app, '', true); });
    answerChain(viaBrowser, 'browser');
  };
  // Use another account (2026-10-12): Google's add-an-account page in the browser the sign-in is waited for in; the wait goes
  // on, and copies whichever account signs in there.
  const anotherAccount = (app) => { api.connectSignInAnotherAccount(app).catch(() => {}); };
  // Not now (2026-10-12): the apps waiting on that browser stay ticked, each row offering Sign in, which signs in in
  // Engelbart's own window (Google's too): nothing is copied from that browser.
  const declineSignIns = (browser) => {
    const rows = waitingYes[browser] || [];
    setWaitingYes((now) => { const next = { ...now }; delete next[browser]; return next; });
    setProfileChoice((now) => { const next = { ...now }; delete next[browser]; return next; });
    setSignIns((now) => {
      const next = { ...now };
      for (const row of rows) for (const other of sharesSignIn(row.app)) if (!next[other] || next[other].status !== 'signed-in') next[other] = { status: 'declined', browser: '' };
      return next;
    });
    void turnedDown(rows);
    answerChain(rows, 'declined');
  };
  // The sign-in chain (turnedDown, 2026-10-12): a web app just ticked and not signed in (checkSignIn), and one turned down
  // (Not now, or Deny at macOS's prompt for a check or for Continue's unlock), gets its sign-in opened by itself, through
  // signInHere: Engelbart's window, or on the Mac Google's route (the Keychain modal first when macOS will be asked or
  // several profiles hold it, else its sign-in in the person's browser). One at a time, one per sign-in group (Gmail and
  // Google Drive share one): the chain waits for a window's answer and for a modal's, not for a sign-in waiting in the
  // browser. The person closing a window without signing in stops it there: that window's sign-in group is unticked
  // (signInWindowHere), and the rows still waiting their turn keep their tick and Sign in. Nothing opens while the consent
  // is off. Apps ticked or turned down while one is open wait their turn.
  const signInsRef = React.useRef(signIns);
  signInsRef.current = signIns;
  const picksRef = React.useRef(picks);
  picksRef.current = picks;
  const hereRef = React.useRef(null);
  const modalAnswer = React.useRef(null); // { group, resolve }: the chain's sign-in waiting on the Keychain modal
  const answerChain = (rows, out) => {
    const wait = modalAnswer.current;
    if (!wait || !(rows || []).some((row) => row && wait.group.includes(row.app))) return;
    modalAnswer.current = null;
    wait.resolve(out);
  };
  const chain = React.useRef(null);
  if (!chain.current) {
    // a tick before and after: the rows rendered, so signInHere and the next pick read them
    const rendered = () => new Promise((resolve) => setTimeout(resolve, 0));
    chain.current = signInWindows({
      pick: (rows) => signInChain(rows, { signIns: signInsRef.current, state: picksRef.current, consent: consentRef.current }),
      open: async (row) => { await rendered(); const out = await hereRef.current(row.id, row.app, true); await rendered(); return out; },
    });
  }
  const turnedDown = (rows) => chain.current(rows);
  // Try again: ticked again, and checked again only with the consent on (off, the run asks for its sign-in after it starts).
  // Google having turned the window's sign-in away, Try again is the window again.
  const retrySignIn = (id, app) => {
    if ((signIns[app] || {}).status === 'rejected') { void signInWindowHere(id, app); return; }
    setRow(id, app, true);
    const rows = signInsToCheck(consent, [{ id, app }]);
    // macOS refused it before, so it asks again: the modal follows it, as after Continue.
    const was = signIns[app];
    if (rows.length && was && was.status === 'refused' && was.browser) setKeychainRun({ browser: was.browser, rows });
    rows.forEach((row) => checkSignIn(row, { retry: true }));
  };
  // Sign in (2026-10-11): the app's sign-in page in Engelbart's own browser, for one no browser of the person's could sign
  // in. Google's first Sign in on the Mac (signsInViaBrowser, 2026-10-12) waits in the person's browser instead, until they
  // turn its sign-ins down (Not now, Deny) or there is no browser to read; off the Mac, every Sign in is the window.
  // `chained`: opened by the chain, which gets the answer of what holds it (signInInBrowser).
  const signInHere = (id, app, chained = false) => (signsInViaBrowser(app, signIns[app], found && found.platform) ? signInInBrowser(id, app, chained) : signInWindowHere(id, app));
  hereRef.current = signInHere;
  // Engelbart's sign-in window (2026-10-11). Signed in, the app and every app sharing that sign-in (Google Drive and Gmail)
  // read ✓, and its row is ticked; Google turning it away (2026-10-12), they read "Google refused this sign-in" with Try
  // again, still ticked; the person closing it first is a no (2026-10-12, third run): the row and every ticked row sharing
  // its sign-in are unticked, their sign-in put back with nothing stale (signInWindowClosed), and ticking one again starts
  // its sign-in again. A window replaced by another app's (one window at a time) was not a no: its row only gets its sign-in
  // back, still ticked. → 'signed-in' | 'rejected' | 'replaced' | 'closed'
  const lastWindow = React.useRef(null);
  const signInWindowHere = async (id, app) => {
    // A row that was waiting on the browser ("Sign in here instead") goes back to what it was before that wait, not to it.
    const before = (seen) => (seen && !['signing', 'browser'].includes(seen.status) ? seen : (seen || {}).was);
    setSignIns((now) => ({ ...now, [app]: { status: 'signing', browser: '', was: before(now[app]) } }));
    setRow(id, app, true);
    // Another open() for the same sign-in shares the window (and its answer); another app's replaces it.
    if (!(lastWindow.current && lastWindow.current.group.includes(app))) lastWindow.current = { group: sharesSignIn(app) };
    const ours = lastWindow.current;
    const out = await api.connectSignInWindow(app).catch(() => null);
    if (out && out.status === 'signed-in') {
      setSignIns((now) => { const next = { ...now }; for (const other of sharesSignIn(app)) next[other] = { status: 'signed-in', browser: '' }; return next; });
      return 'signed-in';
    }
    if (out && out.status === 'rejected') {
      setSignIns((now) => { const next = { ...now }; for (const other of sharesSignIn(app)) if (!next[other] || next[other].status !== 'signed-in') next[other] = { status: 'rejected', browser: '' }; return next; });
      return 'rejected';
    }
    if (lastWindow.current !== ours) {
      setSignIns((now) => { const next = { ...now }; const back = afterSignInWindowClosed((now[app] || {}).was); if (back) next[app] = back; else delete next[app]; return next; });
      return 'replaced';
    }
    setPicks((now) => signInWindowClosed(now, app).state);
    setSignIns((now) => signInWindowClosed(null, app, now).signIns);
    return 'closed';
  };
  // "Sign in here instead" (2026-10-12), beside a row waiting on the browser: that wait ends, and Engelbart's window opens.
  const hereInstead = (id, app) => {
    setSignIns((now) => { const next = { ...now }; for (const other of sharesSignIn(app)) if (other !== app && next[other] && next[other].status === 'browser') { if (next[other].was) next[other] = next[other].was; else delete next[other]; } return next; });
    api.connectSignInBrowserCancel(app).catch(() => {});
    return signInWindowHere(id, app);
  };
  // Google's Sign in (2026-10-12): its sign-in page opens in the person's browser and the sign-in is copied over once it is
  // made there, with no time limit. The modal first when macOS will be asked or more than one profile holds it (its
  // Continue comes back to browserSignIn). No browser Engelbart can read (Safari only): Engelbart's window at once, no
  // modal. → 'signed-in' | 'asked' | 'refused' | 'closed', and the window's answers. `chained` (the chain, 2026-10-12): the
  // modal is waited for (allowSignIns and declineSignIns answer it: 'browser' | 'declined', or 'dropped' when it goes
  // unanswered), and the wait in the browser is not ('browser').
  const signInInBrowser = async (id, app, chained = false) => {
    const said = (await api.connectSignInNote(app, 'browser').catch(() => null)) || {};
    if (!said.opens) return signInWindowHere(id, app);
    if (asksFirst(said)) {
      const answer = chained ? new Promise((resolve) => { modalAnswer.current = { group: sharesSignIn(app), resolve }; }) : 'asked';
      setRow(id, app, true);
      setWaitingYes((now) => waitForYes(now, [{ id, app, browser: said.browser, note: said.note, profiles: said.profiles, route: 'browser' }]));
      return answer;
    }
    if (!chained) return browserSignIn(id, app, said.opens || '');
    void browserSignIn(id, app, said.opens || '', true);
    return 'browser';
  };
  // Every ticked Google row waits on the one sign-in, and turns ✓ with it; one unticked meanwhile is left as it was.
  // `chained`: macOS refusing it sends the row to the chain, for Engelbart's window, as a check's refusal does.
  const browserSignIn = async (id, app, opens = '', chained = false) => {
    const group = sharesSignIn(app);
    if (!opens) opens = ((await api.connectSignInNote(app, 'browser').catch(() => null)) || {}).opens || '';
    setRow(id, app, true);
    setSignIns((now) => {
      const next = { ...now };
      for (const other of group) next[other] = { status: 'browser', browser: opens, was: now[other] && now[other].status !== 'browser' ? now[other] : (now[other] || {}).was };
      return next;
    });
    const out = await api.connectSignInBrowser(app).catch(() => null);
    const status = out && out.status;
    if (status === 'signed-in') {
      setSignIns((now) => { const next = { ...now }; for (const other of group) next[other] = { status: 'signed-in', browser: out.browser || '', ...(out.profile ? { profile: out.profile } : {}) }; return next; });
      return 'signed-in';
    }
    if (status === 'refused') {
      // macOS said no: still ticked, with Try again (as a check's refusal) and Sign in, Engelbart's window (2026-10-12).
      setSignIns((now) => { const next = { ...now }; for (const other of group) next[other] = { status: 'refused', browser: out.browser || '' }; return next; });
      if (chained) void turnedDown([{ id, app }]);
      return 'refused';
    }
    // None of the person's browsers could be read after all (Safari only): Engelbart's window at once.
    if (status === 'no-browser') {
      setSignIns((now) => { const next = { ...now }; for (const other of group) { if ((now[other] || {}).status !== 'browser') continue; const was = now[other].was; if (was) next[other] = was; else delete next[other]; } return next; });
      return signInWindowHere(id, app);
    }
    setSignIns((now) => { const next = { ...now }; for (const other of group) { if ((now[other] || {}).status !== 'browser') continue; const was = now[other].was; if (was) next[other] = was; else delete next[other]; } return next; });
    return 'closed';
  };
  // Every row of the apps sharing `app`'s sign-in → [{ id, app }].
  const groupRows = (app) => SOURCES.flatMap((source) => source.apps.filter((other) => sharesSignIn(app).includes(other)).map((other) => ({ id: source.id, app: other })));
  // The wait in the browser ends once no row of its sign-in is ticked (unticked, a group or Select all off, Leave out).
  // So does the chain's wait on a modal for a sign-in group no longer ticked.
  React.useEffect(() => {
    if (!picks) return;
    const waiting = Object.keys(signIns).filter((app) => signIns[app] && signIns[app].status === 'browser');
    for (const app of waiting) if (!groupRows(app).some((row) => ticked(picks, row.id, row.app))) api.connectSignInBrowserCancel(app).catch(() => {});
    const wait = modalAnswer.current;
    if (wait && !groupRows(wait.group[0]).some((row) => ticked(picks, row.id, row.app))) answerChain(groupRows(wait.group[0]), 'dropped');
  }, [picks]); // eslint-disable-line react-hooks/exhaustive-deps
  // The consent turned off: no sign-in is checked, and the panels waiting for a yes go (2026-10-11 review).
  const toggleConsent = () => {
    const on = !consent;
    setConsent(on);
    setWaitingYes((now) => waitingWhile(on, now));
    if (!on && modalAnswer.current) answerChain(groupRows(modalAnswer.current.group[0]), 'dropped');
  };
  const pickPapers = async () => {
    const chosen = await pickDir();
    if (!chosen) return;
    setFolders((now) => ({ ...now, papers: [chosen] }));
    setRow('papers', LOCAL_PDFS, true);
  };
  const pickRepo = async () => {
    const chosen = await pickDir();
    if (!chosen) return;
    if (!localRepos.some((repo) => repo.path === chosen)) setExtraRepos((now) => (now.includes(chosen) ? now : [...now, chosen]));
    setPicks((now) => tickRepo(now, chosen, true));
    setOpenRows((now) => ({ ...now, [LOCAL_REPOS]: true }));
  };
  const dropRepo = (dir) => { setExtraRepos((now) => now.filter((x) => x !== dir)); setPicks((now) => { const local = { ...now.local }; delete local[dir]; return tickRepo({ ...now, local }, dir, false); }); };
  // GitHub's repositories, as onboarding's step adds them: ticked is in the library now, unticked goes again if this added it.
  const heldRepo = (repo) => heldRow(repo, library);
  const toggleRepo = async (repo) => {
    const row = heldRepo(repo);
    setBusyRepo(repo.id);
    try {
      if (!row) {
        try { const added = await api.addLibraryItem(repo.url); addedRepos.current.add(added.id); onAdded(added); } catch (failure) { if (!/^Already/.test(errorMessage(failure))) setError(errorMessage(failure)); }
        setRow('code', 'GitHub', true);
      } else if (addedRepos.current.has(row.id) && await api.discardLibraryItem(row.id)) addedRepos.current.delete(row.id);
      await readLibrary();
    } finally { setBusyRepo(''); }
  };
  const reposTicked = () => library.filter((row) => addedRepos.current.has(row.id)).map((row) => row.name);
  const allowNotes = async () => {
    setNotesState('asking');
    const out = await api.connectNotesPermission().catch((failure) => ({ allowed: false, error: errorMessage(failure) }));
    setNotesState(out.allowed ? 'allowed' : out.error || 'macOS did not allow it');
    if (!out.allowed) setError(`Apple Notes: ${out.error || 'macOS did not allow it'}`);
    return !!out.allowed;
  };
  const connectorSignIn = async (app) => {
    setConnectorStatus((now) => ({ ...now, [app]: { ...(now[app] || {}), pending: true } }));
    try {
      const status = await api.connectConnectorSignIn(app);
      setConnectorStatus((now) => ({ ...now, [app]: status }));
      return !!(status && status.connected);
    } catch (failure) {
      setConnectorStatus((now) => ({ ...now, [app]: { ...(now[app] || {}), pending: false } }));
      setError(errorMessage(failure));
      return false;
    }
  };

  // The folders of each source the run gets, and the choices main is sent (connect-start, connect-folders-needed).
  const chosenOf = (state) => {
    const chosen = { papers: [...folders.papers], code: localPicked(state) };
    for (const source of SOURCES) for (const app of source.apps) if (appFolders[app] && ticked(state, source.id, app) && app !== LOCAL_PDFS) chosen[source.id] = [...(chosen[source.id] || []), appFolders[app]];
    if (!ticked(state, 'papers', LOCAL_PDFS)) chosen.papers = [];
    else if (appFolders[LOCAL_PDFS]) chosen.papers = [...new Set([...chosen.papers, appFolders[LOCAL_PDFS]])];
    return chosen;
  };
  // The folders chosen in the folder picker (MATH-110): macOS lets Engelbart read them, protected folder or not.
  const pickedDirs = () => [...folders.papers, ...Object.values(appFolders), ...extraRepos].filter(Boolean);
  const choicesFor = (state) => {
    const permissions = permissionsOf(state, { consent, notes: notesState === 'allowed' });
    return choicesOf({ picks: state.picks, apps: state.apps, folders: chosenOf(state), repos: reposTicked(), picked: pickedDirs(), permissions, provider, projectId, workspaceId, project, days });
  };
  // MATH-110: the protected folders (Desktop, Documents, Downloads, iCloud Drive, the drives) a run with these picks would
  // read and macOS was never asked about: one modal says so first. Not now, once, holds for this screen. → shown or not
  const askFolders = async (state, then = null) => {
    if (!state || foldersDeclined.current) return false;
    const list = await api.connectFoldersNeeded(choicesFor(state)).catch(() => []);
    if (!Array.isArray(list) || !list.length || foldersDeclined.current) return false;
    setFolderAsk({ folders: list, papers: ticked(state, 'papers', LOCAL_PDFS) && consent, then });
    return true;
  };
  // Continue: each folder read in turn, so macOS asks about them one after another; the PDFs row says how it went.
  const allowFolders = async () => {
    const asked = folderAsk;
    if (!asked) return;
    setFolderAsk(null);
    setFolderRun({ folders: asked.folders, asking: true, answers: null });
    const answers = await api.connectFoldersAsk(asked.folders.map((folder) => folder.id)).catch((failure) => { setError(errorMessage(failure)); return {}; });
    setFolderRun({ folders: asked.folders, asking: false, answers: answers || {} });
    if (asked.then === 'start') start({ foldersDone: true });
  };
  // Not now: the row stays ticked; the run reads only the PDF folders macOS does not guard (~/Papers, ~/Research…).
  const declineFolders = () => {
    const asked = folderAsk;
    foldersDeclined.current = true;
    setFolderAsk(null);
    if (asked && asked.then === 'start') start({ foldersDone: true });
  };
  // Ticking PDFs on this Mac (or a repository under a protected folder, or the consent that lets the agents read files)
  // shows the modal; rows ticked from the start wait for Bring these in, as sign-ins do.
  const folderKey = picks ? JSON.stringify([ticked(picks, 'papers', LOCAL_PDFS) && consent, localPicked(picks)]) : null;
  const lastFolderKey = React.useRef(undefined);
  React.useEffect(() => {
    if (folderKey === null || view !== 'choose') return;
    if (lastFolderKey.current === undefined) { lastFolderKey.current = folderKey; return; }
    if (lastFolderKey.current === folderKey) return;
    lastFolderKey.current = folderKey;
    if (!folderAsk && !(folderRun && folderRun.asking)) void askFolders(picks);
  }, [folderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring these in: ticked web apps not signed in yet get one modal first (2026-10-11), so the refine screen never shows
  // a sign-in card for an app the person picked. With the consent off, web apps are left out as before.
  const start = async ({ foldersDone = false } = {}) => {
    const anyOn = picks && SOURCES.some((source) => picks.picks[source.id]);
    if (!anyOn) { setError('Pick at least one source.'); return; }
    if (!provider) { setError('Sign in to Claude Code or Codex first.'); return; }
    // MATH-110: macOS's folder prompts come here, all together and explained, never in the middle of the run.
    if (!foldersDone && !folderRun?.asking && await askFolders(picks, 'start')) return;
    if (unsignedWeb(picks, signIns, found, consent).length) { setGate('ask'); return; }
    launch();
  };
  // The gate's Sign in: the first app still not signed in and not waited for in the person's browser already; once none
  // is left (the effect below), the run starts.
  const gateNext = () => unsignedWeb(picks, signIns, found, consent).find((row) => (signIns[row.app] || {}).status !== 'browser');
  const gateSignIn = async () => {
    const first = gateNext();
    if (!first) return;
    setGate('signing');
    await signInHere(first.id, first.app);
    setGate((now) => (now === 'signing' ? 'ask' : now));
  };
  // Leave them out: unticked, then the run starts (the effect below, once the picks are in).
  const gateLeave = () => {
    api.connectSignInWindowClose().catch(() => {});
    const rows = unsignedWeb(picks, signIns, found, consent);
    setPicks((now) => rows.reduce((next, row) => tickRow(next, row.id, row.app, false), now));
    setGate('leave');
  };
  React.useEffect(() => {
    if (!gate || gate === 'signing') return;
    if (gate === 'leave' || !unsignedWeb(picks, signIns, found, consent).length) { setGate(null); launch(); }
  }, [gate, picks, signIns]); // eslint-disable-line react-hooks/exhaustive-deps
  // The sign-in window goes with the choose screen, and so does a wait for a sign-in in the person's browser.
  React.useEffect(() => (view === 'choose' ? () => { api.connectSignInWindowClose().catch(() => {}); api.connectSignInBrowserCancel().catch(() => {}); } : undefined), [view]);
  const launch = async () => {
    const anyOn = picks && SOURCES.some((source) => picks.picks[source.id]);
    if (!anyOn) { setError('Pick at least one source.'); return; }
    if (!provider) { setError('Sign in to Claude Code or Codex first.'); return; }
    setError('');
    // No sign-in waits on the person here: the modals cover the screen until they are answered (2026-10-11), and checks
    // already going are waited for by main (signInsFirst).
    try {
      const snapshot = await api.connectStart(choicesFor(picks));
      begin(snapshot);
      setView('chat');
      setTimeout(() => draftRef.current && draftRef.current.focus(), 60);
    } catch (failure) { setError(errorMessage(failure)); }
  };

  /* ------------------------------------------------------------------ the chat's actions */
  const reply = async (input) => {
    if (!session || session.thinking) return;
    setError('');
    try { setSession(await api.connectAnswer(session.id, input)); setDraft(''); } catch (failure) { setError(errorMessage(failure)); }
  };
  const sendDraft = () => { const text = draft.trim(); if (text) reply({ text }); };
  const useAuthorize = async (authorize) => {
    setError('');
    setAuthorizing(true);
    try {
      if (authorize.kind === 'signin') {
        const done = await engelbartSignIn(authorize.app);
        if (!done) return;
        setSession(await api.connectAuthorize(session.id, { app: authorize.app, kind: 'signin' }));
      } else if (authorize.kind === 'folder') {
        const chosen = await window.terminalAPI.pickDirectory(undefined).catch(() => null);
        if (!chosen) return;
        setSession(await api.connectAuthorize(session.id, { app: authorize.app, kind: 'folder', path: chosen }));
      } else {
        setSession(await api.connectAuthorize(session.id, { app: authorize.app, kind: authorize.kind }));
      }
    } catch (failure) { setError(errorMessage(failure)); } finally { setAuthorizing(false); }
  };
  const cancelAuthorize = (authorize) => { api.connectCancelSignIn(session.id, authorize.app).catch(() => {}); };
  const openNeed = async (need) => {
    setError('');
    try {
      if (need.app === 'Zotero' || need.app === 'GitHub') { if (await engelbartSignIn(need.app)) setSession(await api.connectNeed(session.id, need.id, 'done')); return; }
      setSession(await api.connectNeed(session.id, need.id, 'open'));
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const needSkip = (need) => api.connectNeed(session.id, need.id, 'skip').then(setSession).catch((failure) => setError(errorMessage(failure)));
  // "Grant access" on the librarian's first message (2026-10-16): the apps ticked are allowed, the rest left out.
  const grantApps = (apps) => api.connectGrant(session.id, { apps }).then(setSession).catch((failure) => setError(errorMessage(failure)));
  const pickProvider = (next) => {
    setProvider(next);
    if (session) api.connectProvider(session.id, next).then(setSession).catch((failure) => setError(errorMessage(failure)));
  };
  const importNow = async () => {
    try { setSession(await api.connectImport(session.id)); setView('working'); } catch (failure) { setError(errorMessage(failure)); }
  };
  // "Finish in background" on the onboarding page (2026-10-16): Import, then straight on to the project, the work going on
  // behind it (no "Bringing everything in" page in between).
  const finishInBackground = async () => {
    try { setSession(await api.connectImport(session.id)); putAway(); } catch (failure) { setError(errorMessage(failure)); }
  };
  const back = () => {
    // Stopped and dismissed: a chat left with Back is over, never a chip or a popup later (2026-10-16).
    if (onBack) { if (session) api.connectStop(session.id).then(() => api.connectDismiss(session.id)).catch(() => {}); onBack(); return; }
    if (session) api.connectStop(session.id).catch(() => {});
    idRef.current = null;
    setSession(null);
    setView('choose');
    if (!picks) api.connectDetect().then((value) => { setFound(value); setPicks(initialPicks(value)); if (value && value.github && value.github.found) countRepos(); }).catch(() => setPicks(initialPicks(null)));
  };
  // Put away: the work goes on in the background, the dock showing it. Onboarding moves on.
  const putAway = () => {
    if (session) api.connectMinimize(session.id, true).catch(() => {});
    if (popup) onClose(); else onContinue();
  };
  const stopJob = (job) => api.connectStopJob(session.id, job.id).then(setSession).catch((failure) => setError(errorMessage(failure)));
  const stopAll = () => api.connectStop(session.id).then(setSession).catch((failure) => setError(errorMessage(failure)));

  if (view === 'loading' || (view === 'choose' && !picks)) return <div data-connect-library="loading" style={{ minHeight: 200 }} />;

  const current = (providers || []).find((entry) => entry.provider === (session ? session.provider : provider)) || null;
  const targetName = current ? current.name : 'Claude Code';
  const anyOn = picks ? SOURCES.some((source) => picks.picks[source.id]) : false;
  const allOn = picks ? allPicked(picks, found) : false;
  const ready = providers === null || providers.some((entry) => entry.ready); // unknown until the list comes: no flash of "sign in first"
  const jobs = session ? workJobs(session.jobs) : [];
  const needs = session ? session.needs.filter((need) => need.kind !== 'consent') : [];
  // The chat's last turn: the librarian's or the person's, never Engelbart's own lines (notices) or the apps' grant.
  const last = session ? lastTurn(session.chat) : -1;
  const spoke = !!(session && session.chat.some((item) => !item.opener && !item.grant && !item.notice));
  const running = jobs.filter((job) => !statusOf(job).done).length;
  const done = !!(session && session.done);
  const wide = view !== 'choose';
  // On the page the chat and the progress read in a column of their own width, centred; their scrollbars at the edge.
  const gutter = page ? 'max(20px, calc((100% - 760px) / 2))' : '20px';
  const header = (title, { backButton = false, lead = null } = {}) => (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: backButton ? '12px 12px 12px 12px' : '16px 14px 10px 20px' }}>
      {backButton && <button type="button" className="bart-ic" onClick={back} aria-label="Back" title="Back">{BACK}</button>}
      {lead}
      <div style={{ flex: 1, minWidth: 0, font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>{title}</div>
      {session && (done || session.finished) && <button type="button" className="bart-ic" data-connect-minimize="1" onClick={putAway} aria-label="Run in the background" title="Run in the background">{MINUS}</button>}
      {popup && <button type="button" className="bart-ic" data-connect-close="1" onClick={() => (session ? putAway() : onSkip())} aria-label="Close" title={session ? 'Close: it goes on in the background' : 'Not now'}>{CLOSE}</button>}
    </div>
  );

  const reads = picks ? consentFor(picks) : [];

  return (
    <div data-connect-library={view} role={page ? 'region' : 'dialog'} aria-label="Connect your library" style={page
      ? { position: 'relative', flex: '1 1 auto', minHeight: 0, width: 'min(1080px, 100%)', display: 'flex', flexDirection: 'column', background: '#fff', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }
      : { position: 'relative', flex: '0 1 auto', minHeight: 0, width: `min(${wide ? 640 : 560}px, calc(100% - 32px))`, height: wide ? 'min(700px, 100%)' : 'auto', maxHeight: 'min(760px, 100%)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }}>
      <style>{CSS}</style>

      {view === 'choose' && (() => {
        const signInOf = (id, app) => shownSignIn(picks, id, app, signIns);
        // A check is "Waiting for macOS…" only when the Keychain modal's Continue started it; otherwise "Checking…".
        const keychainApps = keychainRun ? keychainRun.rows.flatMap((row) => sharesSignIn(row.app)) : [];
        // MATH-110: while and after macOS is asked for the folders, the PDFs row says so.
        const accessLabel = folderRun && ticked(picks, 'papers', LOCAL_PDFS) ? folderAccessLabel(folderRun) : null;
        const label = (app, id = '') => (app === LOCAL_PDFS && accessLabel ? accessLabel : rowLabel(app, { found, connectors: connectorStatus, notes: notesState, signIn: id ? signInOf(id, app) : null, keychain: keychainApps.includes(app), folder: appFolders[app] ? shown(appFolders[app]) : app === LOCAL_PDFS && folders.papers.length ? shown(folders.papers[0]) : '' }));
        const shownYes = waitingWhile(consent, waitingYes); // none while the consent is off
        const gateNow = gate && gate !== 'leave' ? signInGate(unsignedWeb(picks, signIns, found, consent), signIns, found && found.platform) : null;
        const inBrowser = Object.keys(signIns).find((app) => signIns[app] && signIns[app].status === 'browser');
        // One browser's modal at a time: the one after Continue first, until it is closed, then the next asking.
        const asking = Object.keys(shownYes).map((browser) => signInPanel(picks, browser, shownYes[browser], profileChoice[browser] || 0)).find(Boolean) || null;
        const folderShown = folderAsk ? folderPanel(folderAsk.folders, { papers: folderAsk.papers }) : null;
        const keychainModal = folderShown
          ? <FolderAccessModal panel={folderShown} onContinue={allowFolders} onNotNow={declineFolders} />
          : keychainRun
          ? <KeychainModal outcome={keychainOutcome(keychainRun.browser, keychainRun.rows, signIns)} onClose={() => setKeychainRun(null)} onContinue={() => {}} onNotNow={() => setKeychainRun(null)} />
          : asking ? <KeychainModal panel={asking} onChoose={(index) => setProfileChoice((now) => ({ ...now, [asking.browser]: index }))} onContinue={() => { void allowSignIns(asking.browser); }} onNotNow={() => declineSignIns(asking.browser)} onClose={() => declineSignIns(asking.browser)} />
          : gateNow && <SignInGateModal gate={gateNow} signing={gate === 'signing'} waiting={inBrowser ? waitingIn(signInName(inBrowser), signIns[inBrowser].browser) : ''} canSignIn={gateNow.canSignIn && !!gateNext()} onSignIn={gateSignIn} onLeave={gateLeave} onClose={() => { api.connectSignInWindowClose().catch(() => {}); setGate(null); }} />;
        const github = (found && found.github) || {};
        const githubLabel = github.found ? { text: `${github.where || 'signed in'}${repoCount != null ? ` · ${repoCount} repo${repoCount === 1 ? '' : 's'}` : ''}`, tone: '' } : { text: NEEDS_SIGN_IN, tone: 'muted' };
        const reposOn = localPicked(picks).length;
        const reposAll = repoPaths().length;
        const toggleGithub = async () => {
          if (ticked(picks, 'code', 'GitHub')) { setRow('code', 'GitHub', false); return; }
          setRow('code', 'GitHub', true);
          if (github.found) return;
          setError('');
          const done = await engelbartSignIn('GitHub').catch((failure) => { setError(errorMessage(failure)); return false; });
          if (!done) { setRow('code', 'GitHub', false); return; }
          setFound((now) => ({ ...now, github: { found: true, where: 'signed in' } }));
          countRepos();
        };
        const toggleLocal = () => {
          if (reposOn) setPicks((now) => tickRow(now, 'code', LOCAL_REPOS, false));
          else if (reposAll) setPicks((now) => tickRow(now, 'code', LOCAL_REPOS, true, repoPaths()));
          else pickRepo();
        };
        const sourcesList = (
          <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', margin: '0 -8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>
              Sources<span style={{ fontSize: 9 }}>▾</span><span style={{ flex: 1 }} />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 }}>From <PeriodPick days={days} onPick={setDays} /></span>
              <button type="button" className="bart-text" data-connect-all="1" onClick={() => toggleAll(!allOn)}>{allOn ? 'Clear' : 'Select all'}</button>
            </div>
            {SOURCES.map((source) => {
              const state = groupState(picks, source.id);
              const open = !!picks.open[source.id];
              return (
                <React.Fragment key={source.id}>
                  <div className="hov-wash" data-connect-source={source.id} data-connect-group={state} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 8px 0 4px', borderRadius: 6 }}>
                    <button type="button" onClick={() => expand(source.id)} aria-expanded={open ? 'true' : 'false'} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                      <span style={{ flex: 'none', width: 12, display: 'flex', justifyContent: 'center', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform 140ms' }}>{CARET_RIGHT}</span>
                      <span style={{ flex: 'none', font: '13.5px/1 var(--font-sans)', color: '#171717' }}>{source.label}</span>
                      <span style={{ flex: 1 }} />
                    </button>
                    <span data-connect-group-box={source.id} onClick={(event) => { event.stopPropagation(); toggleGroup(source.id); }}><Box on={state === 'all'} some={state === 'some'} /></span>
                  </div>
                  {open && (
                    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1, padding: '1px 0 6px 26px' }}>
                      <span style={{ position: 'absolute', left: 33, top: 2, bottom: 8, width: 1, background: '#eaeaea' }} />
                      {source.apps.map((app) => <AppRow key={app} name={app} label={label(app, source.id)} sub={rowSub(app)} tip={rowTip(app)} on={ticked(picks, source.id, app)} onToggle={() => toggleApp(source.id, app)} onRetry={() => retrySignIn(source.id, app)} onSignIn={() => { void signInHere(source.id, app); }} onAnother={() => anotherAccount(app)} onHere={() => { void hereInstead(source.id, app); }} />)}
                      {source.id === 'sites' && <AppRow name={BROWSER_ROW} icon={GLOBE} label={found && found.sites && found.sites.found ? { text: found.sites.where, tone: '' } : { text: 'Not found', tone: 'muted' }} on={ticked(picks, 'sites', BROWSER_ROW)} onToggle={() => setRow('sites', BROWSER_ROW, !ticked(picks, 'sites', BROWSER_ROW))} />}
                      {source.id === 'papers' && (folders.papers.length
                        ? folders.papers.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => setFolders((now) => ({ ...now, papers: [] }))} />)
                        : <AddRow label="Select a folder of papers…" hint="optional" data="papers-folder" onClick={pickPapers} />)}
                      {source.id === 'code' && (
                        <>
                          <ExpandRow name="GitHub" on={ticked(picks, 'code', 'GitHub')} open={!!openRows.GitHub} onOpen={() => setOpenRows((now) => ({ ...now, GitHub: !now.GitHub }))} onToggle={toggleGithub} label={githubLabel} />
                          {openRows.GitHub && (
                            // Onboarding's own repository list, roomy: "make the ui better for selecting a repository, it is currently way too cramped"
                            <div data-connect-github="1" style={{ height: 320, display: 'flex', flexDirection: 'column', padding: '2px 8px 6px 34px' }}>
                              <GithubRepos held={heldRepo} onToggle={toggleRepo} busyId={busyRepo} />
                            </div>
                          )}
                          <ExpandRow name={LOCAL_REPOS} icon={FOLDER} on={reposAll > 0 && reposOn === reposAll} some={reposOn > 0 && reposOn < reposAll} open={!!openRows[LOCAL_REPOS]} onOpen={() => setOpenRows((now) => ({ ...now, [LOCAL_REPOS]: !now[LOCAL_REPOS] }))} onToggle={toggleLocal} label={localRepos.length ? { text: `${localRepos.length} on this Mac`, tone: '' } : { text: 'Not found', tone: 'muted' }} />
                          {openRows[LOCAL_REPOS] && (
                            <div data-connect-local-repos="1" style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 16 }}>
                              {localRepos.map((repo) => (
                                <AppRow key={repo.path} data={`repo:${repo.path}`} name={repo.name} icon={FOLDER} on={!!(picks.local && picks.local[repo.path])} onToggle={() => setPicks((now) => tickRepo(now, repo.path, !(now.local && now.local[repo.path])))}
                                  tip={`${repo.shown} · ${repo.sessions} session${repo.sessions === 1 ? '' : 's'}${repo.checked ? '' : ' · checked when you continue'}`} />
                              ))}
                              {extraRepos.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => dropRepo(dir)} />)}
                              <AddRow label="Select a folder…" hint="a repository" data="code-folder" onClick={pickRepo} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        );
        const company = current && current.provider === 'openai' ? 'OpenAI' : 'Anthropic';
        const leavesButton = <button type="button" className="hov-ink" data-connect-leaves="1" aria-expanded={leaves ? 'true' : 'false'} onClick={(event) => { event.stopPropagation(); setLeaves((now) => !now); }} style={{ padding: 0, border: 0, background: 'none', cursor: 'pointer', font: '500 12.5px/1.5 var(--font-sans)', color: '#171717' }}>What leaves my Mac?</button>;
        const reassure = (
          <span data-connect-reassure="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>
            Saved only on your Mac. {targetName} reads them through your account, and Mathetic never sees them. {leavesButton}
          </span>
        );
        const permissionsBox = (
          // One checkbox (MATH-114): the person's own subscription reads what is ticked. Connectors, Apple Notes and asking an
          // assistant what it remembers are consented to by ticking their rows, and are not named here. One card, the
          // checkbox and under it where things are kept (2026-10-09, David's mockup: one box, no separate info row).
          <div data-connect-permissions="1" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fafafa' }}>
            {reads.length > 0 ? (
              // The agent is chosen inside its words on the page (2026-10-09, David's mockup: "Use my [Claude Code ⌄]
              // subscription"); the popup keeps it on its Refine chip.
              <div role="checkbox" tabIndex={0} aria-checked={consent ? 'true' : 'false'} data-connect-permission="consent" onClick={toggleConsent} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggleConsent(); } }} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', boxSizing: 'border-box', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ paddingTop: 2.5 }}><Box on={consent} /></span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>Use my {page ? <ProviderPick providers={providers} provider={provider} onPick={pickProvider} /> : targetName} subscription to read these</span>
                  {reassure}
                </span>
              </div>
            ) : reassure}
            {/* Gmail ticked (2026-10-11): its threads hold what other people wrote, and the provider reads them. */}
            {leaves && <span data-connect-leaves-text="1" style={{ paddingLeft: reads.length > 0 ? 24 : 0, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>What the agents read is sent to {company} through your own {targetName} account, the way any {targetName} session is, to be turned into notes. The notes, and everything Engelbart keeps, stay in ~/.engelbart on this Mac. Nothing goes to Mathetic.</span>}
          </div>
        );
        // Onboarding's page asks for the consent (2026-10-11, David's mockup) in one card, directly under the Code row inside
        // the scrolling list since the second test run of 2026-10-12 (pinned above the foot before that): the agent's logo,
        // "Read with your [Claude Code ⌄] subscription" over what that means, and a switch. Why Engelbart asks, and where the
        // data goes, was the screen before (screens/ConnectIntro.jsx), so this says it in a line.
        const consentCard = (
          <div data-connect-permissions="1" style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff' }}>
            <div role="switch" tabIndex={0} aria-checked={consent ? 'true' : 'false'} data-connect-permission="consent" onClick={toggleConsent} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggleConsent(); } }} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
              <span aria-hidden="true" style={{ flex: 'none', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff' }}>
                <span style={{ width: 16, height: 16, background: `url(${LOGOS[current && current.provider === 'openai' ? 'Codex' : 'Claude Code']}) center / contain no-repeat` }} />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>Read with your <ProviderPick providers={providers} provider={provider} onPick={pickProvider} up /> subscription</span>
                <span data-connect-reassure="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>
                  Uses the plan you already have, so there's no API key to set up. Saved only on your Mac, and Mathetic never receives it. {leavesButton}
                </span>
              </span>
              <Toggle on={consent} />
            </div>
            {leaves && <span data-connect-leaves-text="1" style={{ paddingLeft: 44, font: '12.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>What the agents read is sent to {company} through your own {targetName} account, the way any {targetName} session is, to be turned into notes. The notes, and everything Engelbart keeps, stay in ~/.engelbart on this Mac. Nothing goes to Mathetic.</span>}
          </div>
        );
        const send = (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, ...(page ? { paddingTop: 4 } : { padding: '12px 20px' }) }}>
            {error && <span data-connect-error="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.4 var(--font-sans)', color: '#e70022' }}>{error}</span>}
            <ProviderChip lead="Refine with" providers={providers} provider={provider} onPick={pickProvider} onSend={start} sendOn={anyOn && !!provider} sendLabel="Refine" />
          </div>
        );
        // Onboarding draws it as a page of its own, one column stacked as David's mockup has it (2026-10-09, in place of the
        // side by side of 2026-10-08): the sources scrolling in their own box, the consent card the last thing in it, right
        // after the Code row (2026-10-12), then Skip for now, the pager and "Bring these in", which starts the run.
        // No custom instructions box.
        if (page) {
          const go = anyOn && !!provider;
          return (
            <div data-connect-column="1" style={{ flex: 1, minHeight: 0, width: `min(${CHOOSE_WIDTH}px, 100%)`, alignSelf: 'center', display: 'flex', flexDirection: 'column' }}>
              <h1 style={{ flex: 'none', margin: '40px 0 22px', textAlign: 'center', font: '500 28px/1.2 var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' }}>What should go in your library?</h1>
              <div data-connect-sources-box="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', padding: '0 8px 16px' }}>
                {sourcesList}
                <div data-connect-consent-at="after-code" style={{ flex: 'none', paddingTop: 10 }}>{consentCard}</div>
                {(keychainModal || !ready) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 18 }}>
                    {keychainModal}
                    {!ready && <AgentSetup snapshot={toolSnap} />}
                  </div>
                )}
              </div>
              {error && <span data-connect-error="1" style={{ flex: 'none', padding: '10px 8px 0', font: '12.5px/1.4 var(--font-sans)', color: '#e70022' }}>{error}</span>}
              <Foot pager={pager} left={<button type="button" className="hov-ink" data-onboarding-skip="1" onClick={onSkip} style={{ padding: '10px 12px', marginLeft: -12, border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', color: '#8f8f8f' }}>Skip for now</button>}
                button={<button type="button" data-connect-bring="1" data-ready={go ? '1' : '0'} onClick={() => { void start(); }} style={{ ...FOOT_BUTTON, opacity: go ? 1 : 0.4, cursor: go ? 'pointer' : 'default' }}>Bring these in<span style={{ display: 'inline-flex' }}>{CARET_RIGHT}</span></button>} />
            </div>
          );
        }
        return (
          <>
            {header('What should go in your library?')}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 20px 16px' }}>
              {sourcesList}
              {keychainModal}
              {permissionsBox}
              {!ready && <AgentSetup snapshot={toolSnap} />}
            </div>
            {send}
          </>
        );
      })()}

      {view === 'chat' && session && (
        <>
          {/* A run opened over a workspace by its id (a manual import from Import your context) has no choose screen of
              its own to go back to: the old one brought back Gmail and Engelbart's own sign-in window (2026-10-15). */}
          {header(`Refine with ${targetName}`, { backButton: !!onBack || !(popup && sessionId) })}
          <div ref={chatRef} data-connect-chat="1" style={{ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: `18px ${gutter}`, scrollPaddingBottom: 64 }}>
            {/* The opening line ("Found 2 Obsidian vaults…") is not shown (2026-10-09): until the librarian says something,
                the dots used everywhere else, in the middle. */}
            {!spoke && !session.error && !error && !session.chat.some((item) => item.grant) && (
              <Starting />
            )}
            {session.chat.map((item, i) => {
              if (item.opener) return null;
              if (item.grant) {
                return (
                  <React.Fragment key={`grant-${item.at}`}>
                    <GrantCard grant={item.grant} live={!item.grant.answered && !session.finished && !session.stopped} onGrant={grantApps} />
                    {!spoke && !session.error && !error && <Starting compact />}
                  </React.Fragment>
                );
              }
              if (item.notice) return <Notice key={i} text={item.text} />;
              if (item.role !== 'agent') return <div key={i} data-connect-user="1" style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 12, background: '#f2f2f2', font: '14.5px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', animation: `rise 160ms ${EASE}` }}>{item.text}</div>;
              // Live while it is the librarian's last word and nobody has answered it: a line Engelbart adds after it (an
              // app left out, a sign-in skipped) never closes it (2026-10-16).
              const live = i === last && !session.thinking && !session.finished && !session.stopped;
              return (
                <div key={i} data-connect-agent="1" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '94%', animation: `rise 260ms ${EASE}` }}>
                  {item.text && <div style={{ font: '14.5px/1.7 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', textWrap: 'pretty' }}>{item.text}</div>}
                  {item.ask && (() => {
                    const card = item.ask.kind === 'repos'
                      ? <ReposCard key={`${i}-${item.at}`} ask={item.ask} live={live} onAnswer={reply} />
                      : <QuestionCard key={`${i}-${item.at}`} ask={item.ask} live={live} onAnswer={reply} />;
                    return live ? card : <AnsweredAsk key={`${i}-${item.at}`} ask={item.ask}>{card}</AnsweredAsk>;
                  })()}
                  {item.authorize && (live || i === last) && <AuthorizeCard authorize={item.authorize} live={live} busy={authorizing && live} onUse={useAuthorize} onSkip={() => reply({ skipped: true })} onCancel={cancelAuthorize} />}
                </div>
              );
            })}
            <NeedsCard needs={needs} onOpen={openNeed} onSkip={needSkip} />
            {spoke && chatStatus(session) && (
              <div data-connect-waiting="1" aria-live="polite" className="cx-shimmer" style={{ font: '13px/1.5 var(--font-sans)' }}>{chatStatus(session)}</div>
            )}
            {(session.error || error) && (
              <div data-connect-error="1" style={{ display: 'flex', alignItems: 'baseline', gap: 10, font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>
                <span>{session.error || error}{session.error && !page ? ' Reply to try again.' : ''}</span>
                {session.error && page && <button type="button" className="bart-text" data-connect-retry="1" onClick={() => reply({ text: 'Try again.' })}>Try again</button>}
              </div>
            )}
          </div>
          {/* No Reply box on the onboarding page (2026-10-16, Hudson: "delete this in the manual library onboarding"): its
              questions are answered on their cards. The popup keeps it. */}
          {!page && <div style={{ flex: 'none', padding: '0 16px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px 12px 16px', background: '#fafafa', borderRadius: 10, marginTop: 8 }}>
              <textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} rows={1} data-connect-draft="1" placeholder="Reply…" spellCheck={false} style={{ flex: 1, minWidth: 0, display: 'block', minHeight: 24, margin: 0, padding: 0, border: 0, background: 'none', outline: 'none', resize: 'none', font: '15px/1.6 var(--font-sans)', color: '#171717' }} />
              <ProviderChip providers={providers} provider={session.provider} fallback={session.choice} onPick={pickProvider} onSend={sendDraft} sendOn={!!draft.trim() && !session.thinking} sendLabel="Send" style={{ marginTop: -3 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>{session.chat.some((item) => !item.opener) && <WorkLine session={session} />}</div>
              {/* "the import button should be in bottom right and should not be highlighted until the agent returns all questions have been asked" */}
              <button type="button" data-connect-import="1" data-ready={done ? '1' : '0'} onClick={importNow} title={done ? 'Bring in everything picked' : 'The librarian still has questions; Import now uses sensible defaults for the rest'} style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px 0 14px', border: `1px solid ${done ? '#0070f3' : '#eaeaea'}`, borderRadius: 8, background: done ? '#0070f3' : '#fff', color: done ? '#fff' : '#8f8f8f', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', whiteSpace: 'nowrap', transition: 'background 160ms, color 160ms, border-color 160ms' }}>{DOWNLOAD}Import</button>
            </div>
          </div>}
          {/* On the page (2026-10-09, David's mockup): how far the work is at the left, the pager and one button at the
              right, "Finish in background" (2026-10-16, Hudson: "should not have an arrow and should just say 'Finish in
              background'"): what is left comes in with sensible defaults (Import), and the work goes on behind the project. */}
          {page && (
            <div style={{ flex: 'none', padding: `0 ${gutter} 4px` }}>
              <Foot pager={pager} left={<FootStatus session={session} />}
                button={<button type="button" data-connect-import="1" data-ready={done ? '1' : '0'} onClick={finishInBackground} style={{ ...importFootStyle(done), padding: '0 16px' }}>Finish in background</button>} />
            </div>
          )}
        </>
      )}

      {view === 'working' && session && page && (() => {
        // Onboarding's page (2026-10-09, David's mockup "Bringing everything in"): a title with Stop all at its right, one
        // row per source being brought in (and anything still looking or asking), the summary of the library (MEMORY.md)
        // in a dashed box under them, then the pager and Continue.
        const going = !session.stopped && (running > 0 || (session.memory && !memoryLine(session.memory).done));
        const shown = runningFirst(jobs.filter((job) => job.kind === 'import' || !statusOf(job).done));
        const line = memoryLine(session.memory);
        const saved = session.memory && session.memory.status === 'saved';
        return (
          <div data-connect-column="1" data-connect-progress="1" style={{ flex: 1, minHeight: 0, width: `min(${CHOOSE_WIDTH}px, 100%)`, alignSelf: 'center', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '40px 12px 18px' }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h1 style={{ margin: 0, font: '600 22px/1.25 var(--font-sans)', letterSpacing: '-0.3px', color: '#171717' }}>{session.stopped ? 'Stopped' : going ? 'Bringing everything in' : 'Your library is connected'}</h1>
                <span style={{ font: '13px/1.5 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{session.stopped ? 'Everything was stopped. What came in stays in your library.' : 'Keeps going in the background. Your inbox says when it needs you or is done.'}</span>
              </div>
              {going && <button type="button" className="hov-ink" data-connect-stop-all="1" onClick={stopAll} style={{ flex: 'none', marginTop: 4, padding: '2px 0', border: 0, background: 'none', cursor: 'pointer', font: '500 13px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Stop all</button>}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '0 0 16px' }}>
              {needs.map((need) => <NeedCard key={need.id} need={need} onOpen={openNeed} onSkip={needSkip} />)}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {shown.map((job, i) => (
                  <React.Fragment key={job.id}>
                    {i > 0 && <div aria-hidden="true" style={{ height: 1, margin: '0 12px', background: '#f0f0f0' }} />}
                    <PageJob job={job} onStop={stopJob} />
                  </React.Fragment>
                ))}
                {!shown.length && <span style={{ padding: '11px 12px', font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing could be reached: sign in or allow it in the chat first.</span>}
              </div>
              <div data-connect-memory={session.memory ? session.memory.status : ''} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', border: '1px dashed #dcdcdc', borderRadius: 8 }}>
                <span style={{ flex: 'none', width: 16, display: 'flex', justifyContent: 'center', color: '#8f8f8f' }}>{FILE}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ font: '500 13.5px/1.35 var(--font-sans)', color: '#171717' }}>Summary of your library</span>
                  <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{saved ? 'Saved as MEMORY.md' : 'Written once everything’s in'}</span>
                </span>
                <span style={{ flex: 'none', font: '12.5px/1 var(--font-sans)', color: line.failed ? '#e70022' : '#8f8f8f' }}>{line.done || (session.memory && session.memory.status !== 'waiting') ? line.text : 'Waiting'}</span>
                {saved && <button type="button" className="bart-text" data-connect-memory-reveal="1" onClick={() => api.reveal(session.memory.path).catch(() => {})}>Show</button>}
                {session.memory && session.memory.status === 'failed' && <button type="button" className="bart-text" onClick={() => api.connectRetryMemory(session.id).then(setSession).catch((failure) => setError(errorMessage(failure)))}>Try again</button>}
              </div>
              {error && <span data-connect-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
            </div>
            <Foot pager={pager} left={null}
              button={<button type="button" data-connect-done="1" onClick={putAway} style={FOOT_BUTTON}>Continue<span style={{ display: 'inline-flex' }}>{CARET_RIGHT}</span></button>} />
          </div>
        );
      })()}

      {view === 'working' && session && !page && (
        <>
          {header(session.stopped ? 'Stopped' : running || (session.memory && !memoryLine(session.memory).done) ? 'Bringing everything in' : 'Your library is connected', { lead: <span style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: '#171717', color: '#fff' }}>{CHECK}</span> })}
          <div data-connect-progress="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: `14px ${gutter} 16px` }}>
            <span style={{ font: '12.5px/1.55 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{session.stopped ? 'Everything was stopped. What came in stays in your library.' : 'This keeps going in the background, and your Inbox says when it needs you or is done.'}</span>
            {placedLine(session) && <span data-connect-placed="1" style={{ font: '12.5px/1.55 var(--font-sans)', color: '#4d4d4d', textWrap: 'pretty' }}>{placedLine(session)}</span>}
            {needs.map((need) => <NeedCard key={need.id} need={need} onOpen={openNeed} onSkip={needSkip} />)}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {runningFirst(jobs).map((job) => <JobRow key={job.id} job={job} onStop={stopJob} />)}
              {!jobs.length && <span style={{ padding: '9px 0', font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing could be reached: sign in or allow it in the chat first.</span>}
              {(() => {
                const line = memoryLine(session.memory);
                return (
                  <div data-connect-memory={session.memory ? session.memory.status : ''} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0' }}>
                    <span style={{ width: 14, display: 'flex', color: '#8f8f8f' }}>{FILE}</span>
                    <span style={{ flex: 1, minWidth: 0, font: '13.5px/1.4 var(--font-sans)', color: '#171717' }}>MEMORY.md</span>
                    <span style={{ font: '12.5px/1 var(--font-sans)', color: line.failed ? '#e70022' : line.done ? '#171717' : '#8f8f8f' }}>{line.text}</span>
                    {session.memory && session.memory.status === 'saved' && <button type="button" className="bart-text" data-connect-memory-reveal="1" onClick={() => api.reveal(session.memory.path).catch(() => {})}>Show</button>}
                    {session.memory && session.memory.status === 'failed' && <button type="button" className="bart-text" onClick={() => api.connectRetryMemory(session.id).then(setSession).catch((failure) => setError(errorMessage(failure)))}>Try again</button>}
                  </div>
                );
              })()}
            </div>
            {error && <span data-connect-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022' }}>{error}</span>}
          </div>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: `12px ${gutter}` }}>
              {!session.stopped && (running > 0 || (session.memory && !memoryLine(session.memory).done)) && <button type="button" className="cx-ghost" data-connect-stop-all="1" onClick={stopAll}>Stop all</button>}
              <span style={{ flex: 1 }} />
              {/* "Run in background" while anything runs; once everything has ended, Done (2026-10-13: it stayed after all was imported) */}
              <button type="button" data-connect-done="1" onClick={putAway} style={{ flex: 'none', whiteSpace: 'nowrap', height: 34, padding: '0 16px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' }}>{running > 0 || (session.memory && !memoryLine(session.memory).done) || (session.needs || []).length ? 'Run in background' : 'Done'}</button>
            </div>
        </>
      )}
    </div>
  );
}

