'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActionTimeline, MAX_ACTIONS, MAX_CHARS } = require('../src/main/browser/recording-actions.cjs');
const { parseTitle, TITLE_PROMPT } = require('../src/main/browser/recording-titles.cjs');

const text = (id, value) => ({ id, type: 3, textContent: value });
const el = (id, tagName, attributes = {}, ...childNodes) => ({ id, type: 2, tagName, attributes, childNodes });
const snapshot = (children, timestamp = 1000) => ({ type: 2, timestamp, data: { node: { id: 1, type: 0, childNodes: [el(2, 'body', {}, ...children)] } } });
const event = (timestamp, source, data) => ({ type: 3, timestamp, data: { source, ...data } });
const click = (id, timestamp) => event(timestamp, 2, { id, type: 2 });
const change = (id, value, timestamp) => event(timestamp, 5, { id, text: value });
const mutation = (timestamp, data) => event(timestamp, 0, { adds: [], removes: [], attributes: [], texts: [], ...data });
const meta = (href, timestamp = 990) => ({ type: 4, timestamp, data: { href } });
const batch = (events, documentId = 'doc-a') => ({ documentId, events });
const run = (...batches) => { const timeline = createActionTimeline(); batches.forEach(timeline.batch); return timeline.result(); };

test('hundreds of noisy events become labeled clicks, one field edit, and explicit feedback', () => {
  const events = [meta('https://example.test/settings?private=secret#fragment'), snapshot([
    el(3, 'button', {}, el(4, 'span', {}, text(5, 'Settings'))),
    el(6, 'label', { for: 'project' }, text(7, 'Project name')),
    el(8, 'input', { id: 'project', value: 'Old private name' }),
    el(9, 'button', {}, text(10, 'Save')),
  ]), click(5, 2000), event(2050, 2, { id: 8, type: 5 })];
  for (let i = 0; i < 300; i++) events.push(event(2100 + i, i % 2 ? 1 : 3, { id: 2, x: i, y: i, positions: [] }));
  const value = 'private project name';
  for (let i = 1; i <= value.length; i++) events.push(change(8, value.slice(0, i), 3000 + i * 20));
  events.push(event(3900, 2, { id: 9, type: 1 }), event(3950, 2, { id: 9, type: 0 }), click(9, 4000));
  events.push(mutation(4100, { adds: [{ parentId: 2, node: el(11, 'div', { role: 'status' }, text(12, 'Settings saved')) }] }));
  const result = run(batch(events)), payload = JSON.stringify(result);
  assert.deepEqual(result.timeline.map(a => [a.action, a.target]), [['page', '/settings'], ['click', 'Settings'], ['edit', 'Project name'], ['click', 'Save'], ['feedback', 'Settings saved']]);
  assert.equal(result.timeline[2].updates, value.length);
  assert.ok(result.rawEvents > 300); assert.equal(result.actionCount, 5);
  assert.doesNotMatch(payload, /Old private name|private project name|private=secret|fragment|positions|mouse/i);
});

test('labels reflect mutations at event time; removed nodes and segment ID reuse cannot invent clicks', () => {
  const a = batch([snapshot([el(3, 'button', {}, text(4, 'Open settings'))]), click(3, 1100),
    mutation(1200, { texts: [{ id: 4, value: 'Close settings' }] }), click(3, 1300),
    mutation(1400, { removes: [{ parentId: 2, id: 3 }] }), click(4, 1500)]);
  const b = batch([snapshot([el(3, 'button', {}, text(4, 'Start trial'))], 2000), click(4, 2100)], 'doc-b');
  const c = batch([click(3, 2200)], 'doc-a');
  assert.deepEqual(run(a, b, c).timeline.map(a => a.target), ['Open settings', 'Close settings', 'Start trial']);
});

test('labelled-by, wrapping labels, iframe roots and shadow descendants retain useful names', () => {
  const frameDocument = { id: 20, type: 0, childNodes: [el(21, 'label', { for: 'name' }, text(22, 'Frame name')), el(23, 'input', { id: 'name' })] };
  const result = run(batch([snapshot([
    el(3, 'span', { id: 'title' }, text(4, 'Notifications')),
    el(5, 'button', { 'aria-labelledby': 'title' }),
    el(6, 'label', {}, text(7, 'Email address'), el(8, 'input')),
    el(9, 'label', { for: 'name' }, text(10, 'Main name')), el(11, 'input', { id: 'name' }),
    el(12, 'iframe', {}, frameDocument),
    el(13, 'custom-control', {}, { ...el(14, 'button', { 'aria-label': 'Shadow action' }), isShadow: true }),
  ]), click(5, 1100), change(8, 'person@example.test', 1200), change(23, 'private frame value', 1300), click(14, 1400)]));
  assert.deepEqual(result.timeline.map(a => a.target), ['Notifications', 'Email address', 'Frame name', 'Shadow action']);
});

test('private nodes, revealed passwords, field values, and values echoed into feedback stay out of the payload', () => {
  const secret = 'Super-private account 123';
  const result = run(batch([snapshot([
    el(3, 'input', { 'aria-label': 'Account name', value: 'Existing secret' }),
    el(4, 'input', { type: 'text', 'data-rr-is-password': '', 'aria-label': 'Revealed password' }),
    el(5, 'div', { 'data-private': '' }, el(6, 'button', {}, text(7, 'Private button'))),
    el(8, 'div', { class: 'rr-mask' }, el(9, 'button', {}, text(10, 'Masked button'))),
    el(11, 'button', {}, text(12, 'Save')),
  ]), change(3, secret, 1100), change(4, 'password', 1200), click(6, 1300), click(9, 1400), click(11, 1500),
  mutation(1600, { adds: [{ parentId: 2, node: el(13, 'div', { role: 'status' }, text(14, `Saved ${secret}`)) }] })]));
  assert.deepEqual(result.timeline.map(a => a.target), ['Account name', 'Save', 'Saved [value]']);
  assert.doesNotMatch(JSON.stringify(result), /Super-private|Existing secret|Private button|Masked button|Revealed password/);
});

test('contenteditable changes become edits only after focus, with no rich-text contents', () => {
  const result = run(batch([snapshot([el(3, 'div', { contenteditable: 'true', 'aria-label': 'Description' }, text(4, 'Initial private contents'))]),
    event(1100, 2, { type: 5, id: 3 }), mutation(1200, { texts: [{ id: 4, value: 'New private contents' }] }),
    mutation(1300, { texts: [{ id: 4, value: 'More private contents' }] })]));
  assert.equal(result.timeline.length, 1); assert.equal(result.timeline[0].target, 'Description'); assert.equal(result.timeline[0].updates, 2);
  assert.doesNotMatch(JSON.stringify(result), /private contents/);
});

test('a successful save is never inferred from a click and unrelated background alerts are omitted', () => {
  const result = run(batch([snapshot([el(3, 'button', {}, text(4, 'Save'))]), click(3, 2000),
    mutation(12000, { adds: [{ parentId: 2, node: el(5, 'div', { role: 'status' }, text(6, 'Unrelated background update')) }] })]));
  assert.deepEqual(result.timeline.map(a => a.action), ['click']);
  assert.match(TITLE_PROMPT, /click is not proof of success/);
});

test('inline validation between keystrokes still yields one edit and bounded feedback', () => {
  const events = [snapshot([el(3, 'input', { 'aria-label': 'Project name' }), el(4, 'div', { role: 'status' }, text(5, ''))])];
  for (let i = 0; i < 30; i++) events.push(change(3, `private name ${i}`, 2000 + i * 20), mutation(2010 + i * 20, { texts: [{ id: 5, value: `Validation step ${i}` }] }));
  const result = run(batch(events));
  assert.deepEqual(result.timeline.map(a => a.action), ['edit', 'feedback']);
  assert.equal(result.timeline[0].updates, 30); assert.equal(result.timeline[1].target, 'Validation step 29');
});

test('long recordings spanning many reloads keep earlier action labels without retaining every DOM', () => {
  const batches = Array.from({ length: 10 }, (_, i) => batch([snapshot([el(3, 'button', { 'aria-label': `Page action ${i}` })], 1000 + i * 2000), click(3, 1100 + i * 2000)], `document-${i}`));
  const result = run(...batches);
  assert.equal(result.limited, false); assert.equal(result.timeline.length, 10);
  assert.equal(result.timeline[0].target, 'Page action 0'); assert.equal(result.timeline.at(-1).target, 'Page action 9');
});

test('long sessions have hard action/character budgets, retain endpoints, and report omissions', () => {
  const events = [snapshot([el(3, 'button', { 'aria-label': 'Action 0' })])];
  for (let i = 0; i < 2000; i++) {
    events.push(mutation(2000 + i * 1000, { attributes: [{ id: 3, attributes: { 'aria-label': `Action ${i}` } }] }), click(3, 2100 + i * 1000));
  }
  const result = run(batch(events));
  assert.ok(result.timeline.length <= MAX_ACTIONS); assert.ok(JSON.stringify(result).length <= MAX_CHARS);
  assert.equal(result.timeline[0].target, 'Action 0'); assert.equal(result.timeline.at(-1).target, 'Action 1999');
  assert.equal(result.omittedActions + result.timeline.length, result.actionCount);
  assert.ok(result.timeline.some(a => a.seconds > 700 && a.seconds < 1300));
  assert.ok(result.timeline.every((a, i) => !i || a.seconds >= result.timeline[i - 1].seconds));
});

test('plain text clicks and canvas pixels do not become invented semantic activity', () => {
  const result = run({ ...batch([snapshot([el(3, 'p', {}, text(4, 'A whole page of unrelated content')), el(5, 'canvas')]), click(4, 1100), click(5, 1200)]), canvas: [{ dataUrl: 'private-image-bytes' }], assets: [{ dataUrl: 'private-asset-bytes' }] });
  assert.equal(result.namedInteractions, 0);
  assert.deepEqual(result.timeline.map(a => a.target), ['canvas (contents unknown)']);
  assert.doesNotMatch(JSON.stringify(result), /private-image|private-asset|unrelated content/);
});

test('model output is a bounded title or an explicit evidence fallback', () => {
  assert.equal(parseTitle('{"title":"Changing the workspace theme"}'), 'Changing the workspace theme');
  assert.equal(parseTitle('```json\n{"title":null}\n```'), null);
  for (const raw of ['A guessed title', '{}', '{"title":""}', JSON.stringify({ title: 'x'.repeat(81) }), '{"title":"<script>run</script>"}']) assert.throws(() => parseTitle(raw));
});
