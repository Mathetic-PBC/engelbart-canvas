import React from 'react';
import { api, errorMessage } from '../api.js';
import GithubRepos from '../workspace/GithubRepos.jsx';
import { heldRow } from '../model/github.js';
import { rowOf } from '../model/tools.js';
import { markOpen } from '../ui/connect-open.js';
import { SOURCES, initialPicks, subOf, choicesOf, statusOf, workJobs, runningFirst, workLine, needView, memoryLine, pickedApps, permissionsFor } from '../model/connect.js';
import obsidian from '../../../design/assets/logos/obsidian.svg';
import notion from '../../../design/assets/logos/notion.svg';
import apple from '../../../design/assets/logos/apple.svg';
import onenote from '../../../design/assets/logos/microsoft-onenote.svg';
import zotero from '../../../design/assets/logos/zotero.svg';
import overleaf from '../../../design/assets/logos/overleaf.svg';
import googledocs from '../../../design/assets/logos/googledocs.svg';
import evernote from '../../../design/assets/logos/evernote.svg';
import granola from '../../../design/assets/logos/granola-light.svg';
import meet from '../../../design/assets/logos/google-meet.svg';
import zoom from '../../../design/assets/logos/zoom.svg';
import openai from '../../../design/assets/logos/openai.svg';
import codex from '../../../design/assets/logos/codex_light.svg';
import claude from '../../../design/assets/logos/claude-ai-icon.svg';
import grok from '../../../design/assets/logos/grok-light.svg';
import gemini from '../../../design/assets/logos/gemini.svg';
import perplexity from '../../../design/assets/logos/perplexity.svg';
import cursor from '../../../design/assets/logos/cursor_light.svg';
import github from '../../../design/assets/logos/github.svg';

// Connect your library (2026-10-07): port of Claude Design "Connect Library.dc.html" (design/connect-library/), an
// experimental window, test mode only: a step of a new user's onboarding (in place of Add to your library and Custom
// instructions), and a one-time popup for someone who has projects (ui/ConnectDock.jsx). Choose: what should go in the
// library, by source and app, ticked where main found the app; GitHub through the same repository list as onboarding's;
// what the agents will do and the permissions they need, asked up front. Refine: one continuous chat with the librarian
// agent (src/main/connect), its questions drawn as cards with one option per line (single choice: a round mark, multiple:
// a square one, each option's why under it), its buttons sign in to a connector, ask macOS, or choose a folder. Each
// source it settles starts importing in the background while the chat goes on. When an agent meets something only the
// person can do (a sign-in, a code, a permission) it shows as "Needs you", with the button that does it. Import, at the
// lower right, lights up once the librarian has nothing more to ask; then the window shows every import and MEMORY.md,
// with Stop, and can be put away: the work goes on in the background, the dock and the sidebar's Inbox following it.
// 2026-10-08 ("Agent onboarding"): no growing strip of agents over the chat (one line under it says what the librarian
// does and goes through the subagents at work, as Claude Code lists its own), no activity log, no paragraphs of
// disclaimers on the choose screen, no account of what each import added; the imports still going come first; a Needs-you
// card is one Log in button and Skip, and Skip leaves that app out for the run.

const LOGOS = { Obsidian: obsidian, Notion: notion, 'Apple Notes': apple, OneNote: onenote, Zotero: zotero, Overleaf: overleaf, 'Google Docs': googledocs, Evernote: evernote, Granola: granola, 'Google Meet': meet, Zoom: zoom, ChatGPT: openai, Codex: codex, Claude: claude, 'Claude Code': claude, Grok: grok, Gemini: gemini, Perplexity: perplexity, Cursor: cursor, GitHub: github };
const EASE = 'cubic-bezier(.25,.1,.25,1)';
// The design's classes (DocEditor's CARD_CSS, not mounted here) and @brainstorm's card (one option per line).
const CSS = '.bart-ic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#4d4d4d}.bart-ic:hover{background:#f2f2f2;color:#171717}'
  + '.bart-chip{transition:border-color 120ms}.bart-chip:hover{border-color:#c9c9c9!important}.bart-send{transition:background 120ms}.bart-send:hover{opacity:.86}'
  + '.bart-text{padding:4px 2px;border:0;background:transparent;color:#8f8f8f;font:500 12px/1.4 var(--font-sans);cursor:pointer}.bart-text:hover{color:#171717}'
  + '.bs-opt{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;margin:0;padding:9px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fff;text-align:left;cursor:pointer;font:14.5px/1.45 var(--font-sans);color:#171717;transition:border-color 120ms}'
  + '.bs-opt+.bs-opt{margin-top:6px}.bs-opt:hover{border-color:#c9c9c9}.bs-opt[aria-checked="true"]{border-color:#0070f3}.bs-opt:disabled{cursor:default;color:#8f8f8f}.bs-opt:disabled:hover{border-color:#eaeaea}'
  + '.bs-opt:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.bs-mark{flex:none;box-sizing:border-box;width:14px;height:14px;margin-top:3px;border:1.5px solid #c9c9c9;border-radius:50%;background:#fff}.bs-mark[data-square]{border-radius:4px}'
  + '[aria-checked="true"]>.bs-mark{border-color:#0070f3;background:#0070f3;box-shadow:inset 0 0 0 2.5px #fff}'
  + '.bs-why{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:#8f8f8f}'
  + '.bs-field{display:block;width:100%;box-sizing:border-box;margin:0;padding:8px 10px;border:1px solid #eaeaea;border-radius:8px;background:#fff;outline:none;resize:none;font:14px/1.5 var(--font-sans);color:#171717}.bs-field:focus{border-color:#c9c9c9}.bs-field::placeholder{color:#8f8f8f}'
  + '.bs-submit{padding:8px 14px;border:0;border-radius:8px;background:#0070f3;color:#fff;font:500 13px/1 var(--font-sans);cursor:pointer;transition:opacity 120ms}.bs-submit:hover{opacity:.86}.bs-submit:disabled{background:#eaeaea;color:#8f8f8f;cursor:default;opacity:1}'
  + '.cx-btn{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border:1px solid #171717;border-radius:8px;background:#171717;color:#fff;cursor:pointer;font:500 12.5px/1 var(--font-sans);white-space:nowrap}.cx-btn:hover{opacity:.88}.cx-btn:disabled{opacity:.5;cursor:default}'
  + '.cx-cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr);column-gap:48px}.cx-cols>*{min-height:0;overflow-y:auto}'
  + '@media (max-width:820px){.cx-cols{grid-template-columns:minmax(0,1fr);grid-template-rows:none;overflow-y:auto}.cx-cols>*{overflow:visible}}'
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
const ALERT = <Svg size={14} width={1.8}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></Svg>;

const shown = (dir) => String(dir || '').replace(/^\/Users\/[^/]+/, '~');
const logoOf = (name) => (LOGOS[name] ? <span aria-hidden="true" style={{ flex: 'none', display: 'block', width: 14, height: 14, background: `url(${LOGOS[name]}) center / contain no-repeat` }} /> : null);

function Box({ on, size = 14 }) {
  return <span role="checkbox" aria-checked={on ? 'true' : 'false'} style={{ flex: 'none', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, boxSizing: 'border-box', background: on ? '#171717' : '#fff', border: on ? 0 : '1.5px solid #c9c9c9', color: '#fff', font: '600 9px/1 var(--font-sans)', cursor: 'pointer' }}>{on ? '✓' : ''}</span>;
}

const subRow = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 30, padding: '0 8px 0 18px', border: 0, borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' };

function AppRow({ name, on, onToggle, where }) {
  return (
    <button type="button" className="hov-wash" data-connect-app={name} onClick={onToggle} title={where || undefined} style={subRow}>
      <span style={{ margin: '0 1px', display: 'flex' }}>{logoOf(name) || <span style={{ width: 14 }} />}</span>
      <span style={{ flex: 1, minWidth: 0, font: '13px/1 var(--font-sans)', color: on ? '#171717' : '#4d4d4d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {where && <span style={{ flex: 'none', maxWidth: 170, font: '11.5px/1 var(--font-sans)', color: '#c9c9c9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{where}</span>}
      <Box on={on} />
    </button>
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
  return (
    <span style={{ position: 'relative', flex: 'none', display: 'inline-flex', ...style }}>
      <span className="bart-chip" role="button" data-connect-chip="1" onClick={() => setOpen((now) => !now)} title="Choose Claude Code or Codex" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', border: '1px solid #eaeaea', borderRadius: 999, background: '#fff', cursor: 'pointer', font: '13px/1 var(--font-sans)', color: '#171717', whiteSpace: 'nowrap' }}>
        {lead && <span>{lead}</span>}
        <span data-connect-provider={provider || ''}>{current ? current.name : 'No agent'}</span>
        {current && <span style={{ color: '#8f8f8f' }}>{`${current.modelName} · ${current.effort === 'xhigh' ? 'Extra high' : current.effort.charAt(0).toUpperCase() + current.effort.slice(1)}`}</span>}
        {usable.length > 1 && <span style={{ display: 'inline-flex', color: '#8f8f8f' }}>{CARET_DOWN}</span>}
        <span style={{ width: 1, height: 14, background: '#eaeaea', margin: '0 2px' }} />
        <button type="button" className="bart-send" data-connect-send="1" aria-label={sendLabel} onClick={(event) => { event.stopPropagation(); onSend(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, padding: 0, border: 0, borderRadius: '50%', background: sendOn ? '#0070f3' : '#f2f2f2', color: sendOn ? '#fff' : '#8f8f8f', cursor: sendOn ? 'pointer' : 'default' }}>{ARROW_UP}</button>
      </span>
      {open && (
        <div data-overlay="1" data-connect-providers="1" style={{ position: 'absolute', right: 0, bottom: 'calc(100% + 6px)', zIndex: 5, width: 250, padding: 4, background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,.08)', animation: `rise 140ms ${EASE}` }}>
          {(providers || []).map((entry) => (
            <button key={entry.provider} type="button" className="hov-wash" disabled={!entry.ready} data-connect-provider-option={entry.provider} onClick={() => { setOpen(false); onPick(entry.provider); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', cursor: entry.ready ? 'pointer' : 'default', textAlign: 'left' }}>
              <span style={{ width: 12, color: '#0070f3', display: 'flex' }}>{entry.provider === provider ? CHECK : null}</span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ font: '13px/1.3 var(--font-sans)', color: entry.ready ? '#171717' : '#8f8f8f' }}>{entry.name}</span>
                <span style={{ font: '11.5px/1.3 var(--font-sans)', color: '#8f8f8f' }}>{entry.ready ? `${entry.modelName} · ${entry.effort}` : 'not signed in'}</span>
              </span>
            </button>
          ))}
          <div style={{ padding: '6px 10px 4px', font: '11.5px/1.45 var(--font-sans)', color: '#8f8f8f' }}>Every agent here runs on this model and effort.</div>
        </div>
      )}
    </span>
  );
}

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
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

/** The librarian's question as a card: one option per line (round mark: one; square: several), its why under it. */
function QuestionCard({ ask, live, onAnswer }) {
  const [picks, setPicks] = React.useState([]);
  const [note, setNote] = React.useState('');
  const many = ask.kind === 'multi';
  const open = ask.kind === 'open';
  const ready = open ? !!note.trim() : picks.length > 0 || !!note.trim();
  const submit = (labels = picks) => { if (!live) return; if (open) { if (note.trim()) onAnswer({ text: note.trim() }); return; } if (labels.length) onAnswer({ picked: labels, ...(note.trim() ? { text: note.trim() } : {}) }); else if (note.trim()) onAnswer({ text: note.trim() }); };
  const pick = (label) => setPicks((now) => (many ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : now.includes(label) ? [] : [label]));
  return (
    <div data-connect-card={live ? 'live' : 'answered'} style={{ padding: '14px 16px 14px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fff' }}>
      <div style={{ font: '600 15px/1.45 var(--font-sans)', color: '#171717' }}>{ask.title}</div>
      {many && <div style={{ marginTop: 6, font: '13px/1.4 var(--font-sans)', color: '#8f8f8f' }}>Select all that apply.</div>}
      {!open && ask.options.length > 0 && (
        <div role={many ? 'group' : 'radiogroup'} aria-label={ask.title} style={{ marginTop: 12 }}>
          {ask.options.map((option) => {
            const on = picks.includes(option.label);
            return (
              <button key={option.label} type="button" className="bs-opt" disabled={!live} data-connect-option={option.label} role={many ? 'checkbox' : 'radio'} aria-checked={on ? 'true' : 'false'} onClick={() => pick(option.label)} onDoubleClick={() => { if (!many && live) submit([option.label]); }}>
                <span className="bs-mark" data-square={many ? '1' : undefined} />
                <span style={{ flex: 1, minWidth: 0 }}>{option.label}{option.why ? <span className="bs-why">{option.why}</span> : null}</span>
              </button>
            );
          })}
        </div>
      )}
      {live && (open
        ? <textarea data-connect-card-field="1" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} rows={2} placeholder={ask.placeholder || 'In a sentence or two…'} className="bs-field" spellCheck={false} style={{ marginTop: 12 }} />
        : <input data-connect-card-field="1" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} placeholder="Or say it in your own words…" className="bs-field" spellCheck={false} style={{ marginTop: 10 }} />)}
      {live && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
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
        {busy ? (authorize.kind === 'connector' ? `Finish signing in to ${authorize.app} in your browser…` : 'Waiting…') : authorize.label}
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
        </span>
        <button type="button" className="bart-text" data-connect-need-skip="1" onClick={() => onSkip(need)}>Skip</button>
        <button type="button" className="cx-btn" data-connect-need-open="1" disabled={need.busy} onClick={() => onOpen(need)}>{need.busy ? (need.browser ? `Finish in ${need.browser}…` : 'Waiting…') : view.action}</button>
      </div>
      {need.error && <div style={{ font: '12px/1.5 var(--font-sans)', color: '#e70022' }}>{need.error}</div>}
    </div>
  );
}

/** One import (or survey, or recall) in the progress list: its label, status, and Stop; what went wrong, if it failed. */
function JobRow({ job, onStop }) {
  const status = statusOf(job);
  return (
    <div data-connect-job={job.status} data-connect-job-kind={job.kind} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 0', borderBottom: '1px solid #f2f2f2' }}>
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
      <span aria-hidden="true" style={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', background: agent && agent.waiting && !view.lead ? '#e8a317' : '#0070f3', animation: 'github-wait 1.4s ease-in-out infinite' }} />
      {view.lead && <span data-connect-thinking="1" style={{ flex: 'none', maxWidth: agent ? '45%' : '100%', overflow: 'hidden', textOverflow: 'ellipsis', color: '#4d4d4d' }}>{view.lead}</span>}
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
const engelbartSignIn = (app) => (app === 'Zotero' ? waitFor(api.zoteroConnect, api.zoteroStatus, api.onZotero).then(async (done) => { if (done) await api.zoteroSync().catch(() => {}); return done; }) : waitFor(api.githubConnect, api.githubStatus, api.onGithub));

/**
 * `mode` 'onboarding' (a step: `onContinue` moves on, the work going on in the background) or 'popup' (`onClose` puts it
 * away). `sessionId`: a session to show again (the dock's). `projectId`: the project an existing user's notes go into.
 * `onSession(id)` when a session begins; `onAdded(row)` for a library row added here (a GitHub repository); `onSkip`: Skip
 * for now / Not now before anything began.
 */
export default function ConnectLibrary({ mode = 'onboarding', sessionId = null, projectId = null, onSession = () => {}, onContinue = () => {}, onClose = () => {}, onSkip = () => {}, onAdded = () => {} }) {
  const popup = mode === 'popup';
  const page = !popup; // onboarding: a page of the window, not a box on it
  const [found, setFound] = React.useState(null);
  const [view, setView] = React.useState(sessionId ? 'loading' : 'choose'); // choose | chat | working
  const [picks, setPicks] = React.useState(null); // { picks, apps, open }
  const [folders, setFolders] = React.useState({ papers: [], code: [] });
  const [permissions, setPermissions] = React.useState({ files: true, browser: true, recall: true, notes: false });
  const [notesState, setNotesState] = React.useState(''); // '' | 'asking' | 'allowed' | <why not>
  const [connectorStatus, setConnectorStatus] = React.useState({}); // app → { connected, pending }
  const [custom, setCustom] = React.useState('');
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
      api.connectDetect().then((value) => { setFound(value); setPicks(initialPicks(value)); }).catch((failure) => { setError(errorMessage(failure)); setPicks(initialPicks(null)); });
      api.connectConnectors().then((list) => setConnectorStatus(Object.fromEntries((list || []).map((entry) => [entry.app, entry])))).catch(() => {});
    };
    if (sessionId) {
      api.connectState(sessionId).then(show).catch((failure) => { setError(errorMessage(failure)); setView('choose'); });
    } else if (!popup) {
      // Onboarding again after Engelbart closed in the middle of it: the session that picked up where it was (main's
      // resume) is shown, not a new one.
      api.connectList().then((list) => {
        const going = (list || []).find((entry) => entry.mode === 'onboarding' && !entry.projectId && !entry.stopped && !entry.dismissed);
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
  const toggleSource = (id) => setPicks((now) => ({ ...now, picks: { ...now.picks, [id]: !now.picks[id] } }));
  const expand = (id) => (id === 'sites' ? toggleSource(id) : setPicks((now) => ({ ...now, open: { ...now.open, [id]: !now.open[id] } })));
  const toggleApp = (id, app) => setPicks((now) => {
    const was = !!now.picks[id] && !!(now.apps[id] && now.apps[id][app]);
    const apps = { ...now.apps, [id]: { ...now.apps[id], [app]: !was } };
    return { ...now, apps, picks: { ...now.picks, [id]: Object.values(apps[id]).some(Boolean) } };
  });
  const pickFolder = async (id) => {
    const chosen = await window.terminalAPI.pickDirectory(undefined).catch(() => null);
    if (!chosen) return;
    setFolders((now) => ({ ...now, [id]: id === 'papers' ? [chosen] : (now[id].includes(chosen) ? now[id] : [...now[id], chosen]) }));
    setPicks((now) => ({ ...now, picks: { ...now.picks, [id]: true } }));
  };
  // GitHub's repositories, as onboarding's step adds them: ticked is in the library now, unticked goes again if this added it.
  const heldRepo = (repo) => heldRow(repo, library);
  const toggleRepo = async (repo) => {
    const row = heldRepo(repo);
    setBusyRepo(repo.id);
    try {
      if (!row) {
        try { const added = await api.addLibraryItem(repo.url); addedRepos.current.add(added.id); onAdded(added); } catch (failure) { if (!/^Already/.test(errorMessage(failure))) setError(errorMessage(failure)); }
        setPicks((now) => ({ ...now, picks: { ...now.picks, code: true } }));
      } else if (addedRepos.current.has(row.id) && await api.discardLibraryItem(row.id)) addedRepos.current.delete(row.id);
      await readLibrary();
    } finally { setBusyRepo(''); }
  };
  const reposTicked = () => library.filter((row) => addedRepos.current.has(row.id)).map((row) => row.name);
  const allowNotes = async () => {
    setNotesState('asking');
    const out = await api.connectNotesPermission().catch((failure) => ({ allowed: false, error: errorMessage(failure) }));
    setNotesState(out.allowed ? 'allowed' : out.error || 'macOS did not allow it');
    setPermissions((now) => ({ ...now, notes: !!out.allowed }));
  };
  const connectorSignIn = async (app) => {
    setError('');
    setConnectorStatus((now) => ({ ...now, [app]: { ...(now[app] || {}), pending: true } }));
    try { const status = await api.connectConnectorSignIn(app); setConnectorStatus((now) => ({ ...now, [app]: status })); } catch (failure) { setConnectorStatus((now) => ({ ...now, [app]: { ...(now[app] || {}), pending: false } })); setError(errorMessage(failure)); }
  };

  const start = async () => {
    const anyOn = picks && SOURCES.some((source) => picks.picks[source.id]);
    if (!anyOn) { setError('Pick at least one source.'); return; }
    if (!provider) { setError('Sign in to Claude Code or Codex first.'); return; }
    setError('');
    try {
      const snapshot = await api.connectStart(choicesOf({ picks: picks.picks, apps: picks.apps, folders, repos: reposTicked(), custom, permissions, provider, projectId }));
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
  const pickProvider = (next) => {
    setProvider(next);
    if (session) api.connectProvider(session.id, next).then(setSession).catch((failure) => setError(errorMessage(failure)));
  };
  const importNow = async () => {
    try { setSession(await api.connectImport(session.id)); setView('working'); } catch (failure) { setError(errorMessage(failure)); }
  };
  const back = () => {
    if (session) api.connectStop(session.id).catch(() => {});
    idRef.current = null;
    setSession(null);
    setView('choose');
    if (!picks) api.connectDetect().then((value) => { setFound(value); setPicks(initialPicks(value)); }).catch(() => setPicks(initialPicks(null)));
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
  const allOn = picks ? SOURCES.every((source) => picks.picks[source.id]) : false;
  const ready = providers === null || providers.some((entry) => entry.ready); // unknown until the list comes: no flash of "sign in first"
  const jobs = session ? workJobs(session.jobs) : [];
  const needs = session ? session.needs : [];
  const last = session ? session.chat.length - 1 : -1;
  const running = jobs.filter((job) => !statusOf(job).done).length;
  const done = !!(session && session.done);
  const wide = view !== 'choose';
  // On the page the chat and the progress read in a column of their own width, centred; their scrollbars at the edge.
  const gutter = page ? 'max(20px, calc((100% - 760px) / 2))' : '20px';
  const header = (title, { backButton = false, lead = null } = {}) => (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: backButton ? '12px 12px 12px 12px' : '16px 14px 10px 20px', borderBottom: wide ? '1px solid #eaeaea' : 0 }}>
      {backButton && <button type="button" className="bart-ic" onClick={back} aria-label="Back" title="Back">{BACK}</button>}
      {lead}
      <div style={{ flex: 1, minWidth: 0, font: '500 15px/1.4 var(--font-sans)', color: '#171717' }}>{title}</div>
      {session && (done || session.finished) && <button type="button" className="bart-ic" data-connect-minimize="1" onClick={putAway} aria-label="Run in the background" title="Run in the background">{MINUS}</button>}
      {popup && <button type="button" className="bart-ic" data-connect-close="1" onClick={() => (session ? putAway() : onSkip())} aria-label="Close" title={session ? 'Close: it goes on in the background' : 'Not now'}>{CLOSE}</button>}
    </div>
  );

  const picked = picks ? pickedApps(picks.picks, picks.apps) : [];
  const asks = permissionsFor(picked);

  return (
    <div data-connect-library={view} role={page ? 'region' : 'dialog'} aria-label="Connect your library" style={page
      ? { position: 'relative', flex: '1 1 auto', minHeight: 0, width: 'min(1080px, 100%)', display: 'flex', flexDirection: 'column', background: '#fff', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }
      : { position: 'relative', flex: '0 1 auto', minHeight: 0, width: `min(${wide ? 640 : 560}px, calc(100% - 32px))`, height: wide ? 'min(700px, 100%)' : 'auto', maxHeight: 'min(760px, 100%)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #c9c9c9', borderRadius: 12, boxShadow: '0 12px 40px #0000001f', animation: `rise 160ms ${EASE}`, overflow: 'hidden' }}>
      <style>{CSS}</style>

      {view === 'choose' && (() => {
        const sourcesList = (
          <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', margin: '0 -8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', font: '12.5px/1 var(--font-sans)', color: '#8f8f8f' }}>
              Sources<span style={{ fontSize: 9 }}>▾</span><span style={{ flex: 1 }} />
              <button type="button" className="bart-text" data-connect-all="1" onClick={() => setPicks((now) => ({ ...now, picks: Object.fromEntries(SOURCES.map((source) => [source.id, !allOn])) }))}>{allOn ? 'Clear' : 'Select all'}</button>
            </div>
            {SOURCES.map((source) => {
              const on = !!picks.picks[source.id];
              const open = !!picks.open[source.id] && source.id !== 'sites';
              const sub = subOf(source.id, { on, apps: picks.apps, repos: reposTicked(), folders: folders[source.id] || [] });
              const where = source.id === 'sites' ? (found && found.sites && found.sites.where) : '';
              return (
                <React.Fragment key={source.id}>
                  <div className="hov-wash" data-connect-source={source.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 8px 0 4px', borderRadius: 6 }}>
                    <button type="button" onClick={() => expand(source.id)} aria-expanded={open ? 'true' : 'false'} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: on ? '#171717' : '#8f8f8f' }}>
                      <span style={{ flex: 'none', width: 12, display: 'flex', justifyContent: 'center', color: '#8f8f8f', transform: `rotate(${open ? 90 : 0}deg)`, transition: 'transform 140ms' }}>{source.id === 'sites' ? null : CARET_RIGHT}</span>
                      <span style={{ flex: 1, minWidth: 0, font: '13.5px/1 var(--font-sans)', color: '#171717' }}>{source.label}</span>
                      <span title={where || undefined} style={{ flex: 'none', font: '12px/1 var(--font-sans)', color: '#8f8f8f' }}>{sub || (where && on ? where : '')}</span>
                    </button>
                    <span onClick={(event) => { event.stopPropagation(); toggleSource(source.id); }}><Box on={on} /></span>
                  </div>
                  {open && (
                    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 1, padding: '1px 0 6px 26px' }}>
                      <span style={{ position: 'absolute', left: 33, top: 2, bottom: 8, width: 1, background: '#eaeaea' }} />
                      {source.apps.map((app) => <AppRow key={app} name={app} where={found && found.apps && found.apps[app] && found.apps[app].found ? found.apps[app].where : ''} on={on && !!(picks.apps[source.id] && picks.apps[source.id][app])} onToggle={() => toggleApp(source.id, app)} />)}
                      {source.id === 'papers' && (folders.papers.length
                        ? folders.papers.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => setFolders((now) => ({ ...now, papers: [] }))} />)
                        : <AddRow label="Select a folder of papers…" hint="optional" data="papers-folder" onClick={() => pickFolder('papers')} />)}
                      {source.id === 'code' && (
                        <>
                          {/* Onboarding's own repository list, roomy: "make the ui better for selecting a repository, it is currently way too cramped" */}
                          <div data-connect-github="1" style={{ height: 320, display: 'flex', flexDirection: 'column', padding: '2px 8px 6px 18px' }}>
                            <GithubRepos held={heldRepo} onToggle={toggleRepo} busyId={busyRepo} />
                          </div>
                          {folders.code.map((dir) => <FolderRow key={dir} path={dir} onRemove={() => setFolders((now) => ({ ...now, code: now.code.filter((x) => x !== dir) }))} />)}
                          <AddRow label="Select a folder…" hint="local repos" data="code-folder" onClick={() => pickFolder('code')} />
                        </>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        );
        const permissionsBox = (
          // What the agents will do, and the permissions they need: "add the permission requests … as well as a disclaimer
          // that the agents will do all of it automatically" (2026-10-08: each a line, no subtext under it).
          <div data-connect-permissions="1" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', border: '1px solid #eaeaea', borderRadius: 10, background: '#fafafa' }}>
            <div style={{ font: '500 13.5px/1.4 var(--font-sans)', color: '#171717' }}>Agents do all of this for you</div>
            {[
              { key: 'files', label: 'Read files on this Mac' },
              ...(asks.web.length ? [{ key: 'browser', label: 'Use my accounts in the background' }] : []),
              ...(asks.recall.length && permissions.browser ? [{ key: 'recall', label: `Ask ${asks.recall.join(' and ')} what ${asks.recall.length === 1 ? 'it remembers' : 'they remember'} about my research` }] : []),
            ].map((row) => (
              <button key={row.key} type="button" role="checkbox" aria-checked={permissions[row.key] ? 'true' : 'false'} data-connect-permission={row.key} onClick={() => setPermissions((now) => ({ ...now, [row.key]: !now[row.key] }))} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ paddingTop: 2.5 }}><Box on={!!permissions[row.key]} /></span>
                <span style={{ flex: 1, minWidth: 0, font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{row.label}</span>
              </button>
            ))}
            {asks.notes && (
              <div data-connect-notes-permission={notesState || 'ask'} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {logoOf('Apple Notes')}
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ font: '13px/1.4 var(--font-sans)', color: '#171717' }}>Let Engelbart read Apple Notes</span>
                  <span style={{ font: '12px/1.4 var(--font-sans)', color: notesState && notesState !== 'allowed' && notesState !== 'asking' ? '#e70022' : '#8f8f8f' }}>{notesState === 'allowed' ? 'Allowed' : notesState === 'asking' ? 'macOS is asking you…' : notesState || 'macOS asks you once'}</span>
                </span>
                {notesState !== 'allowed' && <button type="button" className="cx-ghost" disabled={notesState === 'asking'} onClick={allowNotes}>Allow…</button>}
              </div>
            )}
            {asks.connectors.map((app) => {
              const status = connectorStatus[app] || {};
              return (
                <div key={app} data-connect-connector={app} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {logoOf(app)}
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: '13px/1.4 var(--font-sans)', color: '#171717' }}>{status.connected ? `Connected to ${app}` : `Sign in to ${app}`}</span>
                    <span style={{ font: '12px/1.4 var(--font-sans)', color: '#8f8f8f' }}>{status.connected ? 'Through its own connector' : 'Opens in your browser'}</span>
                  </span>
                  {status.pending ? <button type="button" className="bart-text" onClick={() => api.connectConnectorCancel(app).catch(() => {})}>Cancel</button>
                    : !status.connected && <button type="button" className="cx-ghost" onClick={() => connectorSignIn(app)}>Sign in…</button>}
                </div>
              );
            })}
          </div>
        );
        const customBox = (
          <div className="focus-bd2" style={{ display: 'flex', padding: '10px 12px', border: '1px solid #eaeaea', borderRadius: 8, background: '#fff', transition: 'border-color 120ms' }}>
            <textarea value={custom} onChange={(event) => setCustom(event.target.value)} rows={2} spellCheck={false} data-connect-custom="1" placeholder="custom instructions… e.g. skip papers I only skimmed" style={{ all: 'unset', flex: 1, minHeight: 40, resize: 'none', font: '13px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} />
          </div>
        );
        const send = (
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, ...(page ? { paddingTop: 4 } : { padding: '12px 20px', borderTop: '1px solid #eaeaea' }) }}>
            {error && <span data-connect-error="1" style={{ flex: 1, minWidth: 0, font: '12.5px/1.4 var(--font-sans)', color: '#e70022' }}>{error}</span>}
            <ProviderChip lead="Refine with" providers={providers} provider={provider} onPick={pickProvider} onSend={start} sendOn={anyOn && !!provider} sendLabel="Refine" />
          </div>
        );
        // Onboarding draws it as a page of its own, side by side (2026-10-08: "make this general thing more horizontal right
        // now it looks sort of like a popup not a proper onboarding screen"): the sources on the left, what the agents do,
        // the instructions and Refine on the right. The popup keeps the one column.
        if (page) {
          return (
            <>
              <h1 style={{ flex: 'none', margin: '0 0 22px', font: '500 28px/1.2 var(--font-sans)', letterSpacing: '-0.4px', color: '#171717' }}>What should go in your library?</h1>
              <div className="cx-cols" style={{ flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', padding: '0 8px 16px' }}>{sourcesList}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '28px 2px 4px' }}>
                  {permissionsBox}
                  {customBox}
                  {!ready && <AgentSetup snapshot={toolSnap} />}
                  <span style={{ flex: 1 }} />
                  {send}
                </div>
              </div>
            </>
          );
        }
        return (
          <>
            {header('What should go in your library?')}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 20px 16px' }}>
              {sourcesList}
              {permissionsBox}
              {customBox}
              {!ready && <AgentSetup snapshot={toolSnap} />}
            </div>
            {send}
          </>
        );
      })()}

      {view === 'chat' && session && (
        <>
          {header(`Refine with ${targetName}`, { backButton: true })}
          <div ref={chatRef} data-connect-chat="1" style={{ position: 'relative', flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: `18px ${gutter}` }}>
            {session.chat.map((item, i) => {
              if (item.role !== 'agent') return <div key={i} data-connect-user="1" style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 12, background: '#f2f2f2', font: '14.5px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', animation: `rise 160ms ${EASE}` }}>{item.text}</div>;
              const live = i === last && !session.thinking && !session.finished && !session.stopped;
              return (
                <div key={i} data-connect-agent="1" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '94%', animation: `rise 260ms ${EASE}` }}>
                  {item.text && <div style={{ font: '14.5px/1.7 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', textWrap: 'pretty' }}>{item.text}</div>}
                  {item.ask && (item.ask.kind === 'repos'
                    ? <ReposCard key={`${i}-${item.at}`} ask={item.ask} live={live} onAnswer={reply} />
                    : <QuestionCard key={`${i}-${item.at}`} ask={item.ask} live={live} onAnswer={reply} />)}
                  {item.authorize && (live || i === last) && <AuthorizeCard authorize={item.authorize} live={live} busy={authorizing && live} onUse={useAuthorize} onSkip={() => reply({ skipped: true })} onCancel={cancelAuthorize} />}
                </div>
              );
            })}
            {!session.thinking && session.waiting && <div data-connect-waiting="1" style={{ font: 'italic 13.5px/1.5 var(--font-sans)', color: '#8f8f8f' }}>An agent is looking; the librarian goes on when it reports.</div>}
            {needs.map((need) => <NeedCard key={need.id} need={need} onOpen={openNeed} onSkip={needSkip} />)}
            {(session.error || error) && <div data-connect-error="1" style={{ font: '12.5px/1.5 var(--font-sans)', color: '#e70022', overflowWrap: 'anywhere' }}>{session.error || error}{session.error ? ' Reply to try again.' : ''}</div>}
          </div>
          <div style={{ flex: 'none', padding: `0 ${page ? gutter : '16px'} 12px` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px 12px 16px', background: '#fafafa', borderRadius: 10, marginTop: 8 }}>
              <textarea ref={draftRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendDraft(); } }} rows={1} data-connect-draft="1" placeholder="Reply…" spellCheck={false} style={{ flex: 1, minWidth: 0, display: 'block', minHeight: 24, margin: 0, padding: 0, border: 0, background: 'none', outline: 'none', resize: 'none', font: '15px/1.6 var(--font-sans)', color: '#171717' }} />
              <ProviderChip providers={providers} provider={session.provider} fallback={session.choice} onPick={pickProvider} onSend={sendDraft} sendOn={!!draft.trim() && !session.thinking} sendLabel="Send" style={{ marginTop: -3 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}><WorkLine session={session} /></div>
              {/* "the import button should be in bottom right and should not be highlighted until the agent returns all questions have been asked" */}
              <button type="button" data-connect-import="1" data-ready={done ? '1' : '0'} onClick={importNow} title={done ? 'Bring in everything picked' : 'The librarian still has questions; Import now uses sensible defaults for the rest'} style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px 0 14px', border: `1px solid ${done ? '#0070f3' : '#eaeaea'}`, borderRadius: 8, background: done ? '#0070f3' : '#fff', color: done ? '#fff' : '#8f8f8f', cursor: 'pointer', font: '500 13px/1 var(--font-sans)', whiteSpace: 'nowrap', transition: 'background 160ms, color 160ms, border-color 160ms' }}>{DOWNLOAD}Import</button>
            </div>
          </div>
        </>
      )}

      {view === 'working' && session && (
        <>
          {header(session.stopped ? 'Stopped' : running || (session.memory && !memoryLine(session.memory).done) ? 'Bringing everything in' : 'Your library is connected', { lead: <span style={{ flex: 'none', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: '#171717', color: '#fff' }}>{CHECK}</span> })}
          <div data-connect-progress="1" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: `14px ${gutter} 16px` }}>
            <span style={{ font: '12.5px/1.55 var(--font-sans)', color: '#8f8f8f', textWrap: 'pretty' }}>{session.stopped ? 'Everything was stopped. What came in stays in your library.' : 'This keeps going in the background, and your Inbox says when it needs you or is done.'}</span>
            {needs.map((need) => <NeedCard key={need.id} need={need} onOpen={openNeed} onSkip={needSkip} />)}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {runningFirst(jobs).map((job) => <JobRow key={job.id} job={job} onStop={stopJob} />)}
              {!jobs.length && <span style={{ padding: '9px 0', font: 'italic 13px/1.5 var(--font-sans)', color: '#8f8f8f' }}>Nothing could be reached: sign in or allow it in the chat first.</span>}
              {(() => {
                const line = memoryLine(session.memory);
                return (
                  <div data-connect-memory={session.memory ? session.memory.status : ''} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid #f2f2f2' }}>
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
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: `12px ${gutter}`, borderTop: '1px solid #eaeaea' }}>
            {!session.stopped && (running > 0 || (session.memory && !memoryLine(session.memory).done)) && <button type="button" className="cx-ghost" data-connect-stop-all="1" onClick={stopAll}>Stop all</button>}
            <span style={{ flex: 1 }} />
            <button type="button" data-connect-done="1" onClick={putAway} style={{ flex: 'none', whiteSpace: 'nowrap', height: 34, padding: '0 16px', border: '1px solid #171717', borderRadius: 8, background: '#171717', color: '#fff', cursor: 'pointer', font: '500 13px/1 var(--font-sans)' }}>{popup ? 'Run in background' : 'Continue'}</button>
          </div>
        </>
      )}

    </div>
  );
}

