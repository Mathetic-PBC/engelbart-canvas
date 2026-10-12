'use strict';

// The memory question deleted once its answer is kept (2026-10-12, second test run of onboarding): asking ChatGPT or
// Claude what it remembers left a "Research profile" chat in the person's account. src/main/connect/tools.cjs notes the
// chat the question opened (its id from the page's address once it is sent) and, after save_memory keeps the answer,
// deletes that one chat itself (src/main/connect/web-chats.cjs deleteWebChat): only its id, only when its first message is
// the question; a failure is logged and nothing else, the answer kept either way. Here on a fake page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createImportTools } = require('../src/main/connect/tools.cjs');
const { chatIdOf, deleteWebChat, CHATGPT_DELETE, CLAUDE_DELETE } = require('../src/main/connect/web-chats.cjs');
const prompts = require('../src/main/connect/prompts.cjs');

const CHAT_ID = '68eb1c2a-0c4e-8003-9a51-6f1d2c3b4a59';
const CLAUDE_ID = '0b8f3c1e-5d2a-4f6b-9c7e-1a2b3c4d5e6f';
const OTHER_ID = '68e00000-0000-8000-8000-000000000001';
const ANSWER = '# Research profile\n\nStudies how novices ask for help [stated].';

/** A recall's browser on `app`: the composer at `start`; sending moves it to `then`. evaluate answers by script. */
function fakePage({ start, then, firstMessage = prompts.RECALL_PROMPT, deleteAnswer = { signedIn: true, deleted: true } }) {
  const page = { at: start, scripts: [], deleted: [] };
  Object.assign(page, {
    url: () => page.at,
    ensure: async () => ({ url: page.at }),
    open: async (url) => { page.at = url; return { url }; },
    read: async () => ({ url: page.at, text: 'Research profile …', elements: [] }),
    click: async () => ({ url: page.at }),
    type: async (ref, text, { submit = false } = {}) => { if (submit) page.at = then; return { typed: true }; },
    press: async () => ({ url: page.at }),
    wait: async () => ({ waited: 1 }),
    evaluate: async (script) => {
      page.scripts.push(script);
      if (/method: 'PATCH'|method: 'DELETE'/.test(script)) { page.deleted.push(script); return deleteAnswer; }
      if (/\/backend-api\/conversation\//.test(script)) return { signedIn: true, conversation: { title: 'Research profile', current_node: 'b', mapping: { a: { parent: null, message: { author: { role: 'user' }, content: { parts: [firstMessage] }, create_time: 1 } }, b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: [ANSWER] }, create_time: 2 } } } } };
      if (/chat_conversations\//.test(script)) return { signedIn: true, conversation: { name: 'Research profile', chat_messages: [{ sender: 'human', text: firstMessage }, { sender: 'assistant', text: ANSWER }] } };
      return { signedIn: true };
    },
  });
  return page;
}

function recallTools(page, { recall } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-recall-delete-'));
  const kept = [];
  const logged = [];
  const asked = [];
  const call = createImportTools({
    session: { dataRoot, homeDir: dataRoot, dir: path.join(dataRoot, '.connect', 'recall'), projectId: () => null },
    context: async () => { throw new Error('no library here'); },
    kind: 'recall', page, question: prompts.RECALL_PROMPT,
    recall: recall || ((app, text) => { kept.push([app, text]); }),
    asked: (app, id) => asked.push({ app, id }),
    log: (line) => logged.push(line),
  });
  return { call, kept, logged, asked };
}

/** What a recall agent does: the new-chat page, the prompt typed and sent, the answer waited for and read, then kept. */
async function ask(call, app) {
  await call('browser_open', { url: app === 'ChatGPT' ? 'https://chatgpt.com/' : 'https://claude.ai/new' });
  await call('browser_read', {});
  await call('browser_type', { ref: 'e1', text: prompts.RECALL_PROMPT, submit: true });
  await call('browser_wait', { stable: true, seconds: 60 });
  await call('browser_read', {});
  return call('save_memory', { app, text: ANSWER });
}

test('a chat\'s id from its address: ChatGPT\'s /c/<id> (in a GPT or project too), Claude\'s /chat/<uuid>; a new-chat page, none', () => {
  assert.equal(chatIdOf('ChatGPT', `https://chatgpt.com/c/${CHAT_ID}`), CHAT_ID);
  assert.equal(chatIdOf('ChatGPT', `https://chatgpt.com/g/g-p-abc123/c/${CHAT_ID}?model=x`), CHAT_ID);
  assert.equal(chatIdOf('ChatGPT', 'https://chatgpt.com/'), null);
  assert.equal(chatIdOf('ChatGPT', `https://evil.example/c/${CHAT_ID}`), null);
  assert.equal(chatIdOf('Claude', `https://claude.ai/chat/${CLAUDE_ID}`), CLAUDE_ID);
  assert.equal(chatIdOf('Claude', 'https://claude.ai/new'), null);
  assert.equal(chatIdOf('Claude', `https://chatgpt.com/c/${CHAT_ID}`), null, 'another app\'s address');
  assert.equal(chatIdOf('Gemini', 'https://gemini.google.com/app/abc123'), null, 'only ChatGPT and Claude');
});

test('ChatGPT: the answer kept, then the question\'s one chat hidden as ChatGPT\'s own Delete does (PATCH is_visible false, the page\'s token), logged', async () => {
  const page = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${CHAT_ID}` });
  const { call, kept, logged, asked } = recallTools(page);
  assert.deepEqual(await ask(call, 'ChatGPT'), { saved: true, chars: ANSWER.length }, 'save_memory answers as before');
  assert.deepEqual(kept, [['ChatGPT', ANSWER]], 'the answer kept, untouched');
  assert.deepEqual(asked, [{ app: 'ChatGPT', id: CHAT_ID }], 'the id kept on the job once the question was sent');
  assert.equal(page.deleted.length, 1, 'one delete');
  assert.equal(page.deleted[0], CHATGPT_DELETE(CHAT_ID), 'with the job\'s own id only');
  assert.match(page.deleted[0], /fetch\('\/api\/auth\/session'/);
  assert.match(page.deleted[0], /'\/backend-api\/conversation\/' \+ "68eb1c2a-0c4e-8003-9a51-6f1d2c3b4a59", \{ method: 'PATCH', headers: \{ Authorization: 'Bearer ' \+ session\.accessToken/);
  assert.match(page.deleted[0], /body: JSON\.stringify\(\{ is_visible: false \}\)/);
  assert.ok(page.scripts.every((script) => !script.includes(OTHER_ID)));
  assert.ok(logged.includes('Kept what ChatGPT remembers (' + ANSWER.length + ' characters)'));
  assert.ok(logged.includes('Deleted the question from ChatGPT\'s chats'));
  assert.ok(logged.indexOf('Kept what ChatGPT remembers (' + ANSWER.length + ' characters)') < logged.indexOf('Deleted the question from ChatGPT\'s chats'), 'after the answer is kept');
});

test('Claude: DELETE on the organization\'s chat_conversations/<uuid>, the organization from /api/organizations', async () => {
  const page = fakePage({ start: 'https://claude.ai/new', then: `https://claude.ai/chat/${CLAUDE_ID}` });
  const { call, kept, logged } = recallTools(page);
  await ask(call, 'Claude');
  assert.deepEqual(kept, [['Claude', ANSWER]]);
  assert.deepEqual(page.deleted, [CLAUDE_DELETE(CLAUDE_ID)]);
  assert.match(page.deleted[0], /fetch\('\/api\/organizations', \{ credentials: 'include' \}\)/);
  assert.match(page.deleted[0], /'\/api\/organizations\/' \+ org\.uuid \+ '\/chat_conversations\/' \+ "0b8f3c1e-5d2a-4f6b-9c7e-1a2b3c4d5e6f", \{ method: 'DELETE'/);
  assert.ok(logged.includes('Deleted the question from Claude\'s chats'));
});

test('the delete failing: logged, and nothing else; the answer is kept and save_memory answers as ever', async () => {
  const page = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${CHAT_ID}`, deleteAnswer: { signedIn: true, error: 'ChatGPT answered 500' } });
  const { call, kept, logged } = recallTools(page);
  assert.deepEqual(await ask(call, 'ChatGPT'), { saved: true, chars: ANSWER.length });
  assert.deepEqual(kept, [['ChatGPT', ANSWER]]);
  assert.ok(logged.includes('Couldn\'t delete the question from ChatGPT\'s chats: ChatGPT answered 500'), logged.join('\n'));
  // A page that throws: the same.
  const broken = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${CHAT_ID}` });
  broken.evaluate = async () => { throw new Error('The page took longer than 60 s'); };
  const again = recallTools(broken);
  assert.deepEqual(await ask(again.call, 'ChatGPT'), { saved: true, chars: ANSWER.length });
  assert.deepEqual(again.kept, [['ChatGPT', ANSWER]]);
  assert.ok(again.logged.some((line) => /^Couldn't delete the question from ChatGPT's chats: /.test(line)));
});

test('never another chat: one whose first message is not the question is left as it is', async () => {
  const page = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${OTHER_ID}`, firstMessage: 'Help me plan my thesis chapters' });
  const { call, kept, logged } = recallTools(page);
  await ask(call, 'ChatGPT');
  assert.deepEqual(kept, [['ChatGPT', ANSWER]]);
  assert.deepEqual(page.deleted, [], 'nothing deleted');
  assert.ok(logged.some((line) => /^Couldn't delete the question from ChatGPT's chats: that chat is not the question Engelbart sent/.test(line)));
  await assert.rejects(deleteWebChat(page, 'ChatGPT', OTHER_ID, { question: '' }), /not the question/, 'no question to match: nothing deleted');
  await assert.rejects(deleteWebChat(page, 'ChatGPT', '../conversations', { question: prompts.RECALL_PROMPT }), /Not a conversation id/);
  assert.deepEqual(page.deleted, []);
});

test('nothing sent, or the answer not kept: nothing deleted', async () => {
  // The agent opened a chat already there and saved from it without sending anything: no question of Engelbart's to delete.
  const page = fakePage({ start: `https://chatgpt.com/c/${OTHER_ID}`, then: `https://chatgpt.com/c/${OTHER_ID}` });
  const { call, logged, asked } = recallTools(page);
  await call('browser_read', {});
  await call('save_memory', { app: 'ChatGPT', text: ANSWER });
  assert.deepEqual(asked, []);
  assert.deepEqual(page.deleted, []);
  assert.ok(!logged.some((line) => /delete/i.test(line)));
  // The answer could not be kept: the question stays (it is all the person has of it).
  const sent = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${CHAT_ID}` });
  const failing = recallTools(sent, { recall: () => { throw new Error('disk full'); } });
  await assert.rejects(ask(failing.call, 'ChatGPT'), /disk full/);
  assert.deepEqual(sent.deleted, []);
});

test('deleted once: a second save_memory deletes nothing more', async () => {
  const page = fakePage({ start: 'https://chatgpt.com/', then: `https://chatgpt.com/c/${CHAT_ID}` });
  const { call } = recallTools(page);
  await ask(call, 'ChatGPT');
  await call('save_memory', { app: 'ChatGPT', text: ANSWER });
  assert.equal(page.deleted.length, 1);
});

test('the recall agent is told never to delete or change anything in the account, this chat included', () => {
  assert.match(prompts.RECALL_SYSTEM_PROMPT, /Never delete, rename, archive or change anything in the account \(not this chat either: Engelbart deletes it itself once its answer is saved\)/);
  assert.doesNotMatch(prompts.RECALL_SYSTEM_PROMPT, /delete the chat or/);
});
