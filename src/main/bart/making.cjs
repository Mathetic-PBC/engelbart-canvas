'use strict';

// What a Create run is making, in one line (2026-10-15, David): shown above its row a second or two after it starts, and
// the answer's text once it is done ("Creating a diagram of …" while it works, "Created a diagram of …" after). Opus
// thinks before it says anything, often for tens of seconds, so the line is not its own: one short run on the provider's lowest model at low effort (./name-chat.cjs
// namingStep and createQuickRun: Haiku on Claude Code, Luna on Codex), given the request and the end of the documents it
// is asked from, while Create works. Whatever goes wrong, the line is the request as a sentence (./create.cjs
// requestSentence).

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { namingStep, createQuickRun } = require('./name-chat.cjs');
const { requestSentence } = require('./create.cjs');

const MAKING_PROMPT = 'Someone asked for something to be made. In one line, say what is being made: the kind of thing and what it covers, drawn from their workspace. Start with the kind of thing ("A diagram of …", "An HTML page on …", "A chart of …"). At most 25 words, plain words, no quotes, no markdown, ending with a period. Do not make it.';
const MAKING_TIMEOUT_MS = 15_000;
// The documents as the model is shown them: their last this many characters, where the request is asked from.
const MAX_DOCUMENTS = 20_000;
const MAX_REQUEST = 4000;
// A line longer than this is not one.
const MAX_WORDS = 40;
const MAX_CHARS = 260;

/** What the model said, as the line shows it: its first line, quotes and markdown off, a capital and a full stop; '' when nothing usable is left. */
function cleanMaking(raw) {
  let s = String(raw == null ? '' : raw).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  s = s.replace(/^(?:line|making)\s*:\s*/i, '').replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2').replace(/[*`#]/g, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > MAX_CHARS || s.split(' ').length > MAX_WORDS || /^ESCALATE:/i.test(s)) return '';
  s = `${s[0].toUpperCase()}${s.slice(1)}`;
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

/**
 * → making({ request, documents, provider }) → { line, named, ms }. `request`: what the line asks to be made; `documents`:
 * the run's documents as ./context.cjs reads them. `named` is false when the line is the fallback. Never throws.
 */
function createMaking({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-making-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-making'), codexAuthFile, run = execFile, tools = null, timeoutMs = MAKING_TIMEOUT_MS } = {}) {
  const quickRun = createQuickRun({ environment, runDirectory, codexHome, codexAuthFile, run, tools, timeoutMs, prefix: 'making' });
  return async function making({ request, documents = '', provider }) {
    const started = Date.now();
    const asked = String(request || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST);
    const fallback = { line: requestSentence(asked), named: false };
    if (!asked) return { ...fallback, ms: 0 };
    const shown = String(documents || '').slice(-MAX_DOCUMENTS);
    const input = `${shown ? `<documents>\n${shown}\n</documents>\n\n` : ''}<request>\n${asked}\n</request>\n\n${MAKING_PROMPT} Reply with the line alone.`;
    const line = cleanMaking(await quickRun(namingStep(readModels(), provider), MAKING_PROMPT, input));
    return line ? { line, named: true, ms: Date.now() - started } : { ...fallback, ms: Date.now() - started };
  };
}

/**
 * The line as the answer says it once the files are made (2026-10-15, David): "A diagram of …." → "Created a diagram of
 * …." (the running row says "Creating …": DocEditor creatingLine). An acronym's capital stays ("An HTML page" → "Created
 * an HTML page"); '' stays ''.
 */
function createdLine(line) {
  const text = String(line || '').trim();
  if (!text) return '';
  if (/^creat(?:ed|ing)\b/i.test(text)) return text.replace(/^creating\b/i, 'Created').replace(/…$/, '.');
  return `Created ${/^[A-Z](?:[a-z]|\s)/.test(text) ? `${text[0].toLowerCase()}${text.slice(1)}` : text}`;
}

module.exports = { MAKING_PROMPT, MAKING_TIMEOUT_MS, MAX_DOCUMENTS, cleanMaking, createdLine, createMaking };
