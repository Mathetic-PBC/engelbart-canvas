'use strict';

// Engelbart's shared user-facing personality (2026-10-13, src/main/bart/personality.cjs): one block, written once, that
// Chat, Brainstorm, Discover, Create and Build open with before their own role; the router and a Build's run step, which
// speak to code, go without it; and a custom prompt file still replaces an agent's whole prompt, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CORE_PERSONALITY } = require('../src/main/bart/personality.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
const { BRAINSTORM_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-system-prompt.cjs');
const { DISCOVER_SYSTEM_PROMPT } = require('../src/main/bart/discover-system-prompt.cjs');
const { CREATE_SYSTEM_PROMPT } = require('../src/main/bart/create-system-prompt.cjs');
const { ROUTE_SYSTEM_PROMPT } = require('../src/main/bart/route-system-prompt.cjs');
const { BUILD_SYSTEM_PROMPT, QUICK_PARAGRAPH, loadBuildPrompt } = require('../src/main/build/prompt.cjs');
const { loadSystemPrompt } = require('../src/main/bart/ask.cjs');
const runStep = require('../src/main/build/run-step.cjs');

const USER_FACING = { Chat: BART_SYSTEM_PROMPT, Brainstorm: BRAINSTORM_SYSTEM_PROMPT, Discover: DISCOVER_SYSTEM_PROMPT, Create: CREATE_SYSTEM_PROMPT, Build: BUILD_SYSTEM_PROMPT };

test('the shared personality says who the collaborator is, in one block', () => {
  for (const phrase of ['sharp, well-read research collaborator', '- Attentive:', '- Direct:', '- Proportional:', '- Conversational:', '- Grounded:', '- Agency-preserving:', '- Plainspoken:', '- Respectful of attention:', 'Never operationalize farther than the person asked'])
    assert.ok(CORE_PERSONALITY.includes(phrase), phrase);
  assert.ok(CORE_PERSONALITY.startsWith('# How you work with the person\n'));
  // 2026-10-14 (Chat Benchmark Run 2): voice through judgment, not more words.
  for (const phrase of ['sound like a sharp collaborator', 'let your judgment show when it is useful', 'Personality should not make the reply longer', '- Discerning:', 'Distinguish what matters from what merely exists', 'recommend something when the evidence supports it', 'report selectively', 'Do not turn conversational language into recurring catchphrases', 'Do not perform a personality.', 'No "Great question"'])
    assert.ok(CORE_PERSONALITY.includes(phrase), phrase);
  assert.ok(CORE_PERSONALITY.indexOf('- Conversational:') < CORE_PERSONALITY.indexOf('- Discerning:') && CORE_PERSONALITY.indexOf('- Discerning:') < CORE_PERSONALITY.indexOf('- Grounded:'), 'Discerning sits after Conversational');
  assert.ok(CORE_PERSONALITY.indexOf('Never operationalize') < CORE_PERSONALITY.indexOf('Do not perform a personality.'), 'the no-performance paragraphs follow the operationalize rule');
  assert.ok(CORE_PERSONALITY.includes('When two plausible interpretations would materially change the answer, recommendation, or action, ask one natural, specific question'));
  assert.ok(CORE_PERSONALITY.trimEnd().endsWith('determines whether this collaborator answers, asks questions, finds reading, creates an artifact, or implements something.'));
  for (const role of ['Your role', 'JSON', 'ESCALATE', 'NEEDS YOU', 'Build prompt']) assert.ok(!CORE_PERSONALITY.includes(role), `nothing of one agent's: ${role}`);
});

test('its text is written once: every prompt file takes it from personality.cjs', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  const files = [...fs.readdirSync(path.join(dir, 'bart')).map((f) => path.join(dir, 'bart', f)), ...fs.readdirSync(path.join(dir, 'build')).map((f) => path.join(dir, 'build', f))].filter((f) => f.endsWith('.cjs'));
  const holding = files.filter((f) => fs.readFileSync(f, 'utf8').includes('sharp, well-read research collaborator'));
  assert.deepEqual(holding.map((f) => path.basename(f)), ['personality.cjs']);
});

test('Chat, Brainstorm, Discover, Create and Build open with it, then their own role', () => {
  for (const [name, prompt] of Object.entries(USER_FACING)) {
    assert.ok(prompt.startsWith(`${CORE_PERSONALITY}\n\n# Your role: ${name}\n`), name);
    assert.equal(prompt.split(CORE_PERSONALITY).length, 2, `${name} holds it once`);
  }
  // Each role says what this collaborator is doing here.
  assert.match(BRAINSTORM_SYSTEM_PROMPT, /# Your role: Brainstorm\n\nYou help the person develop their own thinking\.\n\nAttend to what they are trying to understand/);
  assert.match(DISCOVER_SYSTEM_PROMPT, /# Your role: Discover\n\nYou find prior work worth the person's attention\./);
  assert.match(CREATE_SYSTEM_PROMPT, /# Your role: Create\n\nYou make a new standalone artifact the person asked for\./);
  assert.match(BUILD_SYSTEM_PROMPT, /# Your role: Build\n\nYou implement the change the person handed you and verify it\./);
  // How the shared voice shows in each role: one line, no more.
  assert.match(BRAINSTORM_SYSTEM_PROMPT, /Respond in ordinary conversational prose, with the shared personality and the amount of detail the moment needs\./);
  assert.match(DISCOVER_SYSTEM_PROMPT, /the voice shows as selective taste in what you put in front of them, not as chatter in the guide\./);
  assert.match(CREATE_SYSTEM_PROMPT, /The voice belongs only in what you say to the person\. The artifact itself follows the style they asked for\./);
  assert.match(BUILD_SYSTEM_PROMPT, /the voice shows as direct, discerning reporting[^\n]*with no extra conversational text\./);
  assert.match(BUILD_SYSTEM_PROMPT, /The execution\/task rules below override stylistic preferences whenever necessary for safety, correctness or the Build lifecycle\.\n\n# Engelbart Build\n/);
});

test('no persona of their own: no librarian, no friendly PhD student; Chat\'s examples stay Chat\'s', () => {
  assert.ok(!DISCOVER_SYSTEM_PROMPT.includes('careful librarian'));
  assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes('friendly PhD student'));
  for (const prompt of [BRAINSTORM_SYSTEM_PROMPT, DISCOVER_SYSTEM_PROMPT, CREATE_SYSTEM_PROMPT, BUILD_SYSTEM_PROMPT]) {
    assert.ok(!prompt.includes('# Examples of response shape'));
    assert.ok(!prompt.includes('linear-tasks-david.html'));
  }
  assert.ok(!BRAINSTORM_SYSTEM_PROMPT.includes('Put the answer first'), 'Brainstorm asks; it is not told to answer first');
});

test('the router and the run step speak to code and go without it', () => {
  for (const phrase of ['research collaborator', '# How you work with the person', 'Agency-preserving', 'Never operationalize']) assert.ok(!ROUTE_SYSTEM_PROMPT.includes(phrase), phrase);
  assert.ok(ROUTE_SYSTEM_PROMPT.startsWith('You are Bart, the router inside Engelbart'));
  const text = runStep.prompt({ name: 'app', discovery: true, stored: [], tried: [], minutes: 5 });
  assert.ok(!text.includes('research collaborator') && !text.includes('# How you work with the person'));
});

test('a custom prompt file still replaces the whole built-in prompt, personality included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-personality-'));
  for (const agent of ['bart', 'brainstorm', 'discover', 'create']) assert.ok(loadSystemPrompt(root, agent).startsWith(CORE_PERSONALITY), `${agent}: built-in with no file`);
  assert.equal(loadBuildPrompt(root), BUILD_SYSTEM_PROMPT);
  assert.equal(loadBuildPrompt(root, { quick: true }), `${BUILD_SYSTEM_PROMPT}\n\n${QUICK_PARAGRAPH}`);
  fs.mkdirSync(path.join(root, '.context'));
  for (const agent of ['bart', 'brainstorm', 'discover', 'create']) {
    fs.writeFileSync(path.join(root, '.context', `${agent}-system-prompt.md`), `Mine, for ${agent}.\n`);
    assert.equal(loadSystemPrompt(root, agent), `Mine, for ${agent}.`, agent);
  }
  fs.writeFileSync(path.join(root, '.context', 'build-system-prompt.md'), 'My build.\n');
  assert.equal(loadBuildPrompt(root), 'My build.');
  assert.equal(loadBuildPrompt(root, { quick: true }), `My build.\n\n${QUICK_PARAGRAPH}`);
  // An empty file is no custom prompt.
  fs.writeFileSync(path.join(root, '.context', 'bart-system-prompt.md'), '  \n');
  assert.equal(loadSystemPrompt(root, 'bart'), BART_SYSTEM_PROMPT);
});
