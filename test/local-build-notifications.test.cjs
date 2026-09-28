'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseBuildProposal, PREFIX } = require('../src/main/bart/build-proposal.cjs');
const { createFeed } = require('../src/main/bart/activity.cjs');
const { setTimeout: delay } = require('node:timers/promises');
let model;
test.before(async () => { model = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/local-build-notifications.js')).href); });

test('a structured build proposal is not an ordinary answer, quoted text, or automatic consent', () => {
  const raw = PREFIX + ' {"name":"Chart","request":"A sourced CHI submission chart interface"}';
  assert.equal(parseBuildProposal(raw).name, 'Chart');
  for (const text of ['You could build it like this.', 'How would you build it?', '`' + raw + '`', 'Here is an example:\n' + raw]) assert.equal(parseBuildProposal(text), null);
  assert.throws(() => parseBuildProposal(PREFIX + ' broken'), /valid build proposal/);
  assert.throws(() => parseBuildProposal(PREFIX + ' {"name":"Chart"}'), /incomplete/);
});

test('proposal protocol never leaks into streamed Bart prose, including partial prefixes', async () => {
  const updates = [], feed = createFeed({ intervalMs: 0, onProgress: value => updates.push(value) });
  for (const delta of ['ENGE', 'LBART_BUILD_', 'PROPOSAL:', ' {"name":"Chart","request":"Create it"}']) { feed.take({ delta }); await delay(3); }
  assert.ok(!updates.some(update => update.lines?.length));
  feed.reset(); feed.take({ text: 'A chart could show the trend.' }); await delay(5);
  assert.ok(updates.some(update => update.lines?.join('').includes('A chart')));
  feed.end();
});

test('local notifications restore snapshots, resist snapshot races and isolate data roots', () => {
  const { localNotificationState, localNotificationReducer: reduce, localBuildKey, visibleLocalNotifications } = model;
  const preview = { id: 'workspace', runId: 'run', status: 'planning' };
  let state = reduce(localNotificationState('root'), { type: 'progress', dataRoot: 'root', preview });
  assert.equal(visibleLocalNotifications(state).length, 1);
  state = reduce(state, { type: 'progress', dataRoot: 'root', preview: { ...preview, status: 'confirming', approval: { id: 'approval' } } });
  const readyToApprove = state;
  assert.equal(reduce(state, { type: 'progress', dataRoot: 'root', preview, snapshot: true }), state);
  assert.equal(reduce(state, { type: 'progress', dataRoot: 'other', preview }), state);
  const key = localBuildKey(state.previews.workspace);
  state = reduce(state, { type: 'read', keys: [key] });
  state = reduce(state, { type: 'dismiss', keys: [key] });
  assert.equal(visibleLocalNotifications(state).length, 0);
  state = reduce(state, { type: 'reveal', id: 'workspace' });
  assert.equal(visibleLocalNotifications(state).length, 1);
  state = reduce(state, { type: 'dismiss', keys: [key] });
  state = reduce(state, { type: 'progress', dataRoot: 'root', preview: { ...preview, status: 'ready' } });
  assert.equal(visibleLocalNotifications(state).length, 1, 'completion reappears after dismissing approval');
  assert.ok(!state.read.includes(localBuildKey(state.previews.workspace)));
  const restored = reduce(localNotificationState('root'), { type: 'progress', dataRoot: 'root', preview: readyToApprove.previews.workspace, snapshot: true });
  assert.equal(restored.previews.workspace.approval.id, 'approval');
});
