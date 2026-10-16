'use strict';

// Recent projects from the person's ChatGPT or Claude (2026-10-16, docs/onboarding-beta-10-16.md D1-D4, Hudson's
// Onboarding note, Backend ▸ Projects): the Obsidian and Zotero fallback gone (D1); with no project from Claude Code or
// Codex, the same question asked of ChatGPT and Claude in a hidden window, answered from their memory, with `null` as the
// escape, only with the person's leave to use their browser's sign-ins (D2); nobody knowing of a project is done with
// `reason: 'no-context'`, a route that broke is 'failed' (D3); Safari's history read only with Full Disk Access (D4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDiscovery, toolEvidence } = require('../src/main/onboarding/discover.cjs');
const { projectDigest, digestEmpty } = require('../src/main/onboarding/digest.cjs');
const prompts = require('../src/main/onboarding/prompts.cjs');
const prefs = require('../src/main/onboarding/prefs.cjs');
const { SITES } = require('../src/shared/import-flow.cjs');
const { createAssistantProjects, readAnswer, answerIn, mergeProjects, atSignIn, FIND_COMPOSER, SIGNED_IN, NEW_CHAT } = require('../src/main/onboarding/assistant-projects.cjs');

const temp = (prefix = 'eb-assistant-projects-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const until = async (read, ok, what, ms = 5000) => {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
};

const PROJECTS = { projects: [{ title: 'Help-seeking study', description: 'An RCT on how novices ask for help.', recent: 'This week', evidence: 'our chats about it' }] };
const QUESTION = prompts.assistantProjectsPrompt('2026-10-16');
const CHATGPT_ID = '68eb1c2a-0c4e-8003-9a51-6f1d2c3b4a59';
const CLAUDE_ID = '0b8f3c1e-5d2a-4f6b-9c7e-1a2b3c4d5e6f';

/* ------------------------------------------------------------------------------------------------------ the prompt */

test('the assistants get the same projects prompt as the CLIs (task, rules, JSON), from memory, with the null escape', () => {
  const cli = prompts.PROJECTS_SYSTEM_PROMPT;
  const asked = QUESTION;
  // The same rules and the same JSON shape, word for word.
  const rules = cli.slice(cli.indexOf('Name 1 to 5 projects'), cli.indexOf('If nothing in <recent_work>'));
  assert.ok(rules.length > 500);
  assert.ok(asked.includes(rules.trim()), 'the rules are the CLIs\' own');
  assert.ok(asked.includes('{"projects":[{"title":"...","description":"...","recent":"...","folder":"...","evidence":"..."}]}'));
  assert.ok(asked.startsWith(cli.slice(0, cli.indexOf('\n'))), 'the same task');
  // The escape: exactly null when it has no memory of the person.
  assert.match(asked, /If you have no memory of me or of my work[^\n]*reply with exactly null/);
  assert.match(asked, /saved memories of me and our past conversations/);
  assert.match(asked, /do not search the web/);
  assert.match(asked, /Today is 2026-10-16\./);
  assert.doesNotMatch(asked, /<recent_work>/, 'no digest is given to the assistant');
  // D1: the CLIs' prompt no longer mentions Obsidian or Zotero.
  assert.doesNotMatch(cli, /Obsidian|Zotero/);
  assert.match(cli, /reply with exactly null/);
});

/* ------------------------------------------------------------------------------------------------------ the digest */

test('D1: the digest is Claude Code and Codex sessions and repositories only; Obsidian notes and Zotero are not evidence', () => {
  const home = temp();
  // An Obsidian vault with a fresh note, registered as Obsidian does: not read any more.
  const vault = path.join(home, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Thesis plan.md'), '# Thesis plan\n');
  const config = path.join(home, 'Library', 'Application Support', 'obsidian');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: vault, ts: Date.now(), open: true } } }));
  const digest = projectDigest({ homeDir: home, env: {}, existing: ['Memex'] });
  assert.deepEqual(Object.keys(digest).sort(), ['folders', 'projects', 'repos']);
  assert.equal(digestEmpty(digest), true, 'a vault alone is nothing to name projects from');
  assert.equal(digestEmpty({ folders: [], repos: [], vaults: [{ notes: [{ title: 'x' }] }], zotero: [{ name: 'Papers' }] }), true);
  assert.equal(digestEmpty({ folders: [{ shown: '~/study' }], repos: [] }), false);
});

/* ---------------------------------------------------------------------------------------------------- the answers */

test('an answer is read as projects, none (null, {"projects": null}, no projects), empty, or malformed', () => {
  assert.equal(readAnswer('null').kind, 'none');
  assert.equal(readAnswer(' `null`. ').kind, 'none');
  assert.equal(readAnswer('```json\nnull\n```').kind, 'none');
  assert.equal(readAnswer('{"projects": null}').kind, 'none');
  assert.equal(readAnswer('{"projects": []}').kind, 'none');
  const found = readAnswer(`\`\`\`json\n${JSON.stringify(PROJECTS)}\n\`\`\``);
  assert.equal(found.kind, 'projects');
  assert.equal(found.projects[0].title, 'Help-seeking study');
  assert.equal(readAnswer('').kind, 'empty');
  assert.equal(readAnswer('I don\'t have any memories about you yet.').kind, 'malformed');
  assert.equal(readAnswer('{"tools": []}').kind, 'malformed');
  assert.equal(readAnswer('{"projects": [{"description": "no title"}]}').kind, 'malformed');
  assert.equal(readAnswer('{"projects": [{"title": "A"').kind, 'malformed', 'cut off');
});

test('the answer is the assistant\'s last turn after the question; projects merged one per title, the existing left out', () => {
  const chat = { turns: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'old' }, { role: 'user', text: QUESTION }, { role: 'assistant', text: 'Let me look.' }, { role: 'assistant', text: 'null' }] };
  assert.equal(answerIn(chat, QUESTION), 'null');
  assert.equal(answerIn({ turns: [{ role: 'user', text: QUESTION }] }, QUESTION), '');
  const merged = mergeProjects([[{ id: 'memex', title: 'Memex' }, { id: 'help', title: 'Help-seeking study' }], [{ id: 'help', title: 'Help seeking study' }, { id: 'help', title: 'Tutor' }]], { existing: ['Memex'] });
  assert.deepEqual(merged.map((one) => [one.id, one.title]), [['help', 'Help-seeking study'], ['help-2', 'Tutor']]);
  assert.deepEqual(mergeProjects([[{ id: 'memex', title: 'Memex' }]], { existing: ['Memex'] }).map((one) => one.title), ['Memex'], 'the only one is kept');
});

/* --------------------------------------------------------------------------------------- asking in a hidden window */

/**
 * Engelbart's browser for one assistant: the new-chat page; the message box found; sending moves it to the chat's
 * address; the conversation endpoint answers `answer` (a function of how many reads, or a string); Delete is recorded.
 */
function fakeBrowser({ answer = JSON.stringify(PROJECTS), signedIn = true, composer = true, sends = true, sendButton = true, lands = null } = {}) {
  const made = [];
  const browser = {
    made,
    closed: [],
    show: () => { throw new Error('a window was shown'); },
    tools: (job) => {
      const page = { job, at: 'about:blank', typed: [], clicked: [], pressed: [], deleted: [], reads: 0, opened: [] };
      const app = job.sites.includes('chatgpt.com') ? 'ChatGPT' : 'Claude';
      const id = app === 'ChatGPT' ? CHATGPT_ID : CLAUDE_ID;
      const chatUrl = app === 'ChatGPT' ? `https://chatgpt.com/c/${id}` : `https://claude.ai/chat/${id}`;
      const send = () => { if (sends) page.at = chatUrl; };
      const conversation = () => {
        page.reads += 1;
        const text = typeof answer === 'function' ? answer(page.reads) : answer;
        const question = page.typed[0] || '';
        return app === 'ChatGPT'
          ? { signedIn: true, conversation: { title: 'Projects', current_node: 'b', mapping: { a: { parent: null, message: { author: { role: 'user' }, content: { parts: [question] } } }, ...(text ? { b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: [text] } } } } : {}) } } }
          : { signedIn: true, conversation: { name: 'Projects', chat_messages: [{ sender: 'human', text: question }, ...(text ? [{ sender: 'assistant', text }] : [])] } };
      };
      Object.assign(page, {
        url: () => page.at,
        open: async (url) => { page.opened.push(url); page.at = lands || url; return { url: page.at }; },
        ensure: async () => ({ url: page.at }),
        read: async () => ({ url: page.at, text: '', elements: sendButton ? [{ ref: 'e2', role: 'button', name: app === 'ChatGPT' ? 'Send prompt' : 'Send message' }] : [] }),
        type: async (ref, text) => { assert.equal(ref, 'e1'); assert.equal(text, job.sendOnly, 'only the question is typed'); page.typed.push(text); return { typed: text.length }; },
        click: async (ref) => { page.clicked.push(ref); send(); return { url: page.at }; },
        press: async (key) => { page.pressed.push(key); send(); return { url: page.at }; },
        evaluate: async (script) => {
          if (script === SIGNED_IN[app]) return { signedIn };
          if (script === FIND_COMPOSER) return composer ? { ref: 'e1', selector: '#prompt-textarea' } : { ref: null };
          if (/method: 'PATCH'|method: 'DELETE'/.test(script)) { page.deleted.push(id); return { signedIn: true, deleted: true }; }
          if (script.includes(JSON.stringify(id))) return conversation();
          if (/backend-api\/conversations\?|chat_conversations\?limit/.test(script)) return { signedIn: true, items: [] };
          throw new Error(`unexpected script: ${script.slice(0, 80)}`);
        },
      });
      made.push(page);
      return page;
    },
    close: (id) => browser.closed.push(id),
  };
  return browser;
}

const signIns = (signedIn = { ChatGPT: true, Claude: true }) => {
  const asked = [];
  return { asked, signInQuiet: async (app) => { asked.push(app); return { signedIn: !!signedIn[app] }; } };
};
const fast = { sleep: async () => {}, pollMs: 1, sentWaitMs: 30, askTimeoutMs: 3000, signInTimeoutMs: 1000 };

test('D2: an assistant is asked in a hidden window: the question typed and sent once, the answer read, the chat deleted', async () => {
  const browser = fakeBrowser();
  const webSignIn = signIns();
  const logged = [];
  const assistants = createAssistantProjects({ webSignIn, agentBrowser: browser, log: (text) => logged.push(text), ...fast });
  const out = await assistants.ask({ apps: ['ChatGPT', 'Claude'], question: QUESTION });
  assert.deepEqual(out.map((one) => [one.app, one.outcome]), [['ChatGPT', 'found'], ['Claude', 'found']]);
  assert.equal(out[0].projects[0].title, 'Help-seeking study');
  assert.equal(out[0].projects[0].folder, '', 'an assistant names no folder on this Mac');
  assert.deepEqual(webSignIn.asked.sort(), ['ChatGPT', 'Claude'], 'their sign-ins copied from the chosen browser first');
  for (const page of browser.made) {
    assert.equal(page.job.sendOnly, QUESTION, 'the window allows the question alone');
    assert.deepEqual(page.typed, [QUESTION]);
    assert.equal(page.clicked.length + page.pressed.length, 1, 'sent once');
    assert.equal(page.deleted.length, 1, 'the chat it opened is deleted');
  }
  assert.deepEqual(browser.made.map((page) => page.opened[0]), [NEW_CHAT.ChatGPT, NEW_CHAT.Claude]);
  assert.equal(browser.closed.length, 2, 'every window closed');
  assert.ok(logged.some((line) => /Deleted the question from ChatGPT/.test(line)));
});

test('D2: null is "nothing known"; a reply in words is "broke" once it stands; no send button, Enter sends', async () => {
  const enter = fakeBrowser({ answer: 'null', sendButton: false });
  const none = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: enter, ...fast }).ask({ apps: ['Claude'], question: QUESTION });
  assert.deepEqual(none.map((one) => one.outcome), ['none']);
  assert.deepEqual([enter.made[0].pressed, enter.made[0].clicked], [['Enter'], []]);
  assert.equal(enter.made[0].deleted.length, 1);
  const words = fakeBrowser({ answer: 'I don\'t have any saved memories about you.' });
  const broke = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: words, ...fast }).ask({ apps: ['ChatGPT'], question: QUESTION });
  assert.equal(broke[0].outcome, 'broke');
  assert.match(broke[0].error, /did not answer as asked/);
  assert.equal(words.made[0].deleted.length, 1, 'deleted all the same');
  // Claude writes a line before it looks in its memory: the line is waited past, the JSON read.
  const later = fakeBrowser({ answer: (n) => (n < 4 ? 'Let me check what I remember.' : JSON.stringify(PROJECTS)) });
  const found = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: later, ...fast }).ask({ apps: ['Claude'], question: QUESTION });
  assert.equal(found[0].outcome, 'found');
});

test('D2: not signed in is "unavailable" (no window, or nothing typed); a missing message box or no send is "broke"', async () => {
  const browser = fakeBrowser();
  const out = await createAssistantProjects({ webSignIn: signIns({ ChatGPT: false, Claude: false }), agentBrowser: browser, ...fast }).ask({ apps: ['ChatGPT', 'Claude'], question: QUESTION });
  assert.deepEqual(out.map((one) => one.outcome), ['unavailable', 'unavailable']);
  assert.equal(browser.made.length, 0, 'no window opened');
  const signedOut = fakeBrowser({ signedIn: false });
  const there = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: signedOut, ...fast }).ask({ apps: ['ChatGPT'], question: QUESTION });
  assert.equal(there[0].outcome, 'unavailable', 'the site says signed out: nothing typed');
  assert.deepEqual(signedOut.made[0].typed, []);
  // Sent to the sign-in page (claude.ai signed out, 2026-10-16: /new → /logout → /login, and a 403 from its API): unavailable.
  const login = fakeBrowser({ lands: 'https://claude.ai/login?from=logout&reauth=1', signedIn: null });
  const toLogin = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: login, ...fast }).ask({ apps: ['Claude'], question: QUESTION });
  assert.equal(toLogin[0].outcome, 'unavailable');
  assert.deepEqual(login.made[0].typed, []);
  assert.deepEqual([atSignIn('https://auth.openai.com/log-in'), atSignIn('https://claude.ai/logout?involuntary=1'), atSignIn('https://claude.ai/new'), atSignIn('https://chatgpt.com/c/abc')], [true, true, false, false]);
  const noBox = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: fakeBrowser({ composer: false }), ...fast }).ask({ apps: ['Claude'], question: QUESTION });
  assert.deepEqual([noBox[0].outcome, noBox[0].error], ['broke', 'Claude\'s message box wasn\'t found']);
  const unsent = fakeBrowser({ sends: false });
  const notSent = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: unsent, ...fast }).ask({ apps: ['ChatGPT'], question: QUESTION });
  assert.deepEqual([notSent[0].outcome, notSent[0].error], ['broke', 'The question wasn\'t sent to ChatGPT']);
  assert.equal(unsent.closed.length, 1);
  // No answer at all in time: broke, and the chat deleted.
  const silent = fakeBrowser({ answer: '' });
  const quiet = await createAssistantProjects({ webSignIn: signIns(), agentBrowser: silent, ...fast, askTimeoutMs: 40 }).ask({ apps: ['Claude'], question: QUESTION });
  assert.equal(quiet[0].outcome, 'broke');
  assert.match(quiet[0].error, /didn't answer/);
  assert.equal(silent.made[0].deleted.length, 1);
});

/* ------------------------------------------------------------------------------------------------- the discovery */

function discoveryOn({ cli = 'none', reply = JSON.stringify(PROJECTS), fail = null, keychain = 'allowed', answers = null, provider = 'anthropic', keychainWaitMs = 2000 } = {}) {
  const home = temp();
  if (cli === 'evidence') {
    fs.mkdirSync(path.join(home, 'help-seeking', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, 'help-seeking', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }
  const dataRoot = path.join(home, 'root');
  if (keychain) prefs.set(dataRoot, { keychain });
  const turns = [];
  const agents = { turn: async (input) => { turns.push(input); if (fail) throw fail; return { text: reply }; } };
  const providers = { status: async () => ({ providers: [{ id: provider, installed: true, signedIn: true }], decision: { pick: provider } }) };
  const asked = [];
  const assistants = { ask: async (input) => { asked.push(input); return (answers || [{ app: 'Claude', outcome: 'none' }, { app: 'ChatGPT', outcome: 'none' }]); } };
  let last = null;
  const discovery = createDiscovery({ agents, context: async () => ({ dataRoot }), homeDir: home, providers, notify: (state) => { last = state; }, assistants, keychainWaitMs, keychainPollMs: 5 });
  const settled = () => until(() => last, (state) => state && state.projects.status !== 'running', 'the project search');
  return { discovery, dataRoot, turns, asked, settled, last: () => last };
}

test('D2/D3: Claude Code or Codex names projects from the sessions: the assistants are never asked', async () => {
  const d = discoveryOn({ cli: 'evidence' });
  await d.discovery.startProjects({ provider: 'anthropic' });
  const out = (await d.settled()).projects;
  assert.deepEqual([out.status, out.projects.map((one) => one.title), out.from], ['done', ['Help-seeking study'], ['Claude Code']]);
  assert.equal(d.turns.length, 1);
  assert.equal(d.asked.length, 0);
});

test('D2: no CLI evidence: no model on the digest, the assistants asked (the provider\'s first) with the escape; their projects shown', async () => {
  const d = discoveryOn({ answers: [{ app: 'ChatGPT', outcome: 'found', projects: [{ id: 'memex', title: 'Memex history', description: 'x', recent: 'Earlier', folder: '', evidence: 'From ChatGPT\'s memory' }] }, { app: 'Claude', outcome: 'none' }], provider: 'openai' });
  await d.discovery.startProjects({ provider: 'openai' });
  const out = (await d.settled()).projects;
  assert.equal(d.turns.length, 0, 'nothing on this Mac: no model asked about it');
  assert.equal(d.asked.length, 1);
  assert.deepEqual(d.asked[0].apps, ['ChatGPT', 'Claude'], 'Codex runs: ChatGPT first');
  assert.match(d.asked[0].question, /reply with exactly null/);
  assert.deepEqual([out.status, out.projects.map((one) => one.title), out.from, out.empty], ['done', ['Memex history'], ['ChatGPT'], undefined]);
});

test('D3: every route ran and none knew of a project: done, empty, reason no-context (not a failure)', async () => {
  const d = discoveryOn();
  await d.discovery.startProjects({ provider: 'anthropic' });
  const out = (await d.settled()).projects;
  assert.deepEqual(d.asked[0].apps, ['Claude', 'ChatGPT']);
  assert.deepEqual([out.status, out.empty, out.reason, out.error], ['done', true, 'no-context', undefined]);
  assert.deepEqual(out.projects, []);
  // The CLI saw sessions but named none (null): the assistants next, and still no-context.
  const named = discoveryOn({ cli: 'evidence', reply: 'null' });
  await named.discovery.startProjects({ provider: 'anthropic' });
  const none = (await named.settled()).projects;
  assert.equal(named.turns.length, 1);
  assert.equal(named.asked.length, 1);
  assert.deepEqual([none.status, none.reason], ['done', 'no-context']);
  // An assistant not signed in counts as knowing nothing.
  const out2 = discoveryOn({ answers: [{ app: 'Claude', outcome: 'unavailable' }, { app: 'ChatGPT', outcome: 'none' }] });
  await out2.discovery.startProjects({ provider: 'anthropic' });
  assert.deepEqual([(await out2.settled()).projects.status, (await out2.settled()).projects.reason], ['done', 'no-context']);
});

test('D3: a route that broke while none found anything: failed, with its error (Try again)', async () => {
  const gui = discoveryOn({ answers: [{ app: 'Claude', outcome: 'broke', error: 'Claude didn\'t answer in 150 seconds' }, { app: 'ChatGPT', outcome: 'none' }] });
  await gui.discovery.startProjects({ provider: 'anthropic' });
  const out = (await gui.settled()).projects;
  assert.deepEqual([out.status, out.error, out.empty, out.reason], ['failed', 'Claude didn\'t answer in 150 seconds', undefined, undefined]);
  // The CLI's agent broke and the assistants knew nothing: the CLI's own failure (its `connect` too when it needs one).
  const cli = discoveryOn({ cli: 'evidence', fail: Object.assign(new Error('The model returned no text.'), { kind: 'failed' }) });
  await cli.discovery.startProjects({ provider: 'anthropic' });
  const failed = (await cli.settled()).projects;
  assert.deepEqual([failed.status, failed.error], ['failed', 'The model returned no text.']);
  assert.equal(cli.asked.length, 1, 'the assistants were still asked');
  // A CLI answer that is not the JSON broke too.
  const garbled = discoveryOn({ cli: 'evidence', reply: 'Here are some projects!' });
  await garbled.discovery.startProjects({ provider: 'anthropic' });
  assert.deepEqual([(await garbled.settled()).projects.status, (await garbled.settled()).projects.error], ['failed', 'The agent did not answer as asked.']);
  // A broken CLI with an assistant that knew: done with the assistant's projects.
  const saved = discoveryOn({ cli: 'evidence', fail: new Error('boom'), answers: [{ app: 'Claude', outcome: 'found', projects: [{ id: 'a', title: 'A study' }] }] });
  await saved.discovery.startProjects({ provider: 'anthropic' });
  assert.deepEqual((await saved.settled()).projects.projects.map((one) => one.title), ['A study']);
});

test('D2: the browser\'s sign-ins kept (declined) or never answered: no assistant is asked; unanswered is waited for', async () => {
  const declined = discoveryOn({ keychain: 'declined' });
  await declined.discovery.startProjects({ provider: 'anthropic' });
  const out = (await declined.settled()).projects;
  assert.equal(declined.asked.length, 0);
  assert.deepEqual([out.status, out.reason], ['done', 'no-context']);
  // Not answered yet: waited for (the screen still says it is looking), asked once allowed.
  const later = discoveryOn({ keychain: null });
  await later.discovery.startProjects({ provider: 'anthropic' });
  const waiting = await until(() => later.last(), (state) => state && state.projects.waiting === 'keychain', 'the wait for the Keychain answer');
  assert.equal(waiting.projects.status, 'running');
  assert.equal(later.asked.length, 0);
  prefs.set(later.dataRoot, { keychain: 'allowed' });
  await later.settled();
  assert.equal(later.asked.length, 1);
  // Never answered within the wait: not asked, not a failure.
  const never = discoveryOn({ keychain: null, keychainWaitMs: 30 });
  await never.discovery.startProjects({ provider: 'anthropic' });
  const gave = (await never.settled()).projects;
  assert.equal(never.asked.length, 0);
  assert.deepEqual([gave.status, gave.reason], ['done', 'no-context']);
});

test('wired: the assistants are made from Engelbart\'s browser and the sign-ins; one not signed in is not asked', async () => {
  const home = temp();
  const dataRoot = path.join(home, 'root');
  prefs.set(dataRoot, { keychain: 'allowed' });
  let last = null;
  const providers = { status: async () => ({ providers: [{ id: 'anthropic', installed: true, signedIn: true }], decision: { pick: 'anthropic' } }) };
  const browser = fakeBrowser({ answer: 'null' });
  const discovery = createDiscovery({ agents: { turn: async () => ({ text: 'null' }) }, context: async () => ({ dataRoot }), homeDir: home, providers, notify: (state) => { last = state; }, webSignIn: signIns({ Claude: true }), agentBrowser: browser });
  await discovery.startProjects({ provider: 'anthropic' });
  const out = await until(() => last, (state) => state && state.projects.status !== 'running', 'the search', 20000);
  assert.deepEqual([out.projects.status, out.projects.reason], ['done', 'no-context']);
  assert.equal(browser.made.length, 1, 'Claude asked (ChatGPT not signed in)');
  assert.match(browser.made[0].typed[0], /reply with exactly null/);
  assert.deepEqual(out.projects.asked, [{ app: 'Claude', outcome: 'none' }, { app: 'ChatGPT', outcome: 'unavailable' }]);
});

/* ------------------------------------------------------------------------------------------------ Safari's history */

test('D4: Safari\'s history is read only with Full Disk Access; without it the tools screen hears why, not "none found"', async () => {
  const home = temp();
  fs.mkdirSync(path.join(home, 'Library', 'Safari'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Library', 'Safari', 'History.db'), '');
  let reads = 0;
  const run = (cmd, args, opts, cb) => { reads += 1; const done = typeof opts === 'function' ? opts : cb; done(null, JSON.stringify([{ url: 'https://www.notion.so/x', visits: 9 }]), ''); };
  const denied = await toolEvidence({ homeDir: home, browserId: 'safari', run, detected: { apps: {}, localRepos: [] }, applications: [], diskAccess: async () => false });
  assert.equal(reads, 0, 'the file was not touched');
  assert.equal(denied.history, 'needs-disk-access');
  assert.equal(denied.evidence[SITES].evidence, 'Safari history needs Full Disk Access');
  const granted = await toolEvidence({ homeDir: home, browserId: 'safari', run, detected: { apps: {}, localRepos: [] }, applications: [], diskAccess: async () => true });
  assert.equal(reads, 1);
  assert.equal(granted.history, undefined);
  assert.equal(granted.evidence.Notion.used, true, JSON.stringify(granted.evidence.Notion));
  // Another browser never asks about Full Disk Access.
  const chrome = await toolEvidence({ homeDir: home, browserId: 'chrome', run, detected: { apps: {}, localRepos: [] }, applications: [], diskAccess: async () => { throw new Error('asked'); } });
  assert.equal(chrome.history, undefined);
});
