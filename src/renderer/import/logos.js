// Import your context's pictures (2026-10-13): the apps' logos (design/assets/logos, the mockup's own), the supported
// browsers' icons (taken from the mockup, design/assets/logos/browsers) and Engelbart's icon. A file loader in the app's
// build (scripts/build.mjs) and data URLs in the standalone page's (scripts/build-import-mockup.mjs).
import obsidian from '../../../design/assets/logos/obsidian.svg';
import notion from '../../../design/assets/logos/notion.svg';
import apple from '../../../design/assets/logos/apple.svg';
import onenote from '../../../design/assets/logos/microsoft-onenote.svg';
import googledrive from '../../../design/assets/logos/google-drive.svg';
import googledocs from '../../../design/assets/logos/googledocs.svg';
import evernote from '../../../design/assets/logos/evernote.svg';
import granola from '../../../design/assets/logos/granola-light.svg';
import meet from '../../../design/assets/logos/google-meet.svg';
import zoom from '../../../design/assets/logos/zoom.svg';
import gmail from '../../../design/assets/logos/gmail.svg';
import openai from '../../../design/assets/logos/openai.svg';
import codex from '../../../design/assets/logos/codex_light.svg';
import claude from '../../../design/assets/logos/claude-ai-icon.svg';
import grok from '../../../design/assets/logos/grok-light.svg';
import gemini from '../../../design/assets/logos/gemini.svg';
import perplexity from '../../../design/assets/logos/perplexity.svg';
import cursor from '../../../design/assets/logos/cursor_light.svg';
import zotero from '../../../design/assets/logos/zotero.svg';
import overleaf from '../../../design/assets/logos/overleaf.svg';
import github from '../../../design/assets/logos/github.svg';
// Linear's mark (2026-10-16): Simple Icons' linear.svg (simple-icons 13.21.0, CC0), in Linear's indigo #5E6AD2.
import linear from '../../../design/assets/logos/linear.svg';
import safari from '../../../design/assets/logos/browsers/safari.png';
import chrome from '../../../design/assets/logos/browsers/chrome.png';
import brave from '../../../design/assets/logos/browsers/brave.png';
import firefox from '../../../design/assets/logos/browsers/firefox.png';
import arc from '../../../design/assets/logos/browsers/arc.png';
import edge from '../../../design/assets/logos/browsers/edge.png';
import opera from '../../../design/assets/logos/browsers/opera.png';
import chromium from '../../../design/assets/logos/browsers/chromium.png';
import comet from '../../../design/assets/logos/browsers/comet.png';
import appIcon from '../../../design/assets/app-icon.png';

/** A catalog tool's logo (shared/import-flow.cjs CATALOG ids), or undefined for a folder or the browser history. */
export const TOOL_LOGOS = {
  Obsidian: obsidian, Notion: notion, 'Apple Notes': apple, OneNote: onenote, 'Google Docs': googledrive, Evernote: evernote,
  Granola: granola, 'Google Meet': meet, Zoom: zoom, Gmail: gmail,
  ChatGPT: openai, Codex: codex, Claude: claude, 'Claude Code': claude, Grok: grok, Gemini: gemini, Perplexity: perplexity, Cursor: cursor,
  Zotero: zotero, Overleaf: overleaf, GitHub: github, Linear: linear,
};

/** The intro's row of logos (the mockup's WORKS), then "+12". */
export const WORKS = [['Zotero', zotero], ['Overleaf', overleaf], ['Obsidian', obsidian], ['Google Docs', googledocs], ['ChatGPT', openai], ['Claude', claude], ['Codex', codex], ['GitHub', github]];

export const BROWSER_LOGOS = { safari, chrome, brave, firefox, arc, edge, opera, chromium, comet };
export const PROVIDER_LOGOS = { anthropic: claude, openai: codex };
export const APP_ICON = appIcon;
