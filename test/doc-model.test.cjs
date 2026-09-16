'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

test('parseLine classifies todo lines with depth and done state', async () => {
  const { parseLine } = await load();
  assert.deepEqual(parseLine('  - [x] a'), { type: 'todo', depth: 1, done: true, text: 'a' });
  assert.deepEqual(parseLine('- [ ] open'), { type: 'todo', depth: 0, done: false, text: 'open' });
  assert.deepEqual(parseLine('- plain dash'), { type: 'todo', depth: 0, done: false, text: 'plain dash' });
  assert.equal(parseLine('                    - [ ] deep').depth, 8);
});

test('parseLine classifies headings, chat, quote, image and paragraphs', async () => {
  const { parseLine } = await load();
  assert.deepEqual(parseLine('## Title'), { type: 'h', level: 2, text: 'Title' });
  assert.deepEqual(parseLine('#### not a heading'), { type: 'p', text: '#### not a heading' });
  assert.deepEqual(parseLine('@chat hi there'), { type: 'chat', text: 'hi there' });
  assert.deepEqual(parseLine('@chat'), { type: 'chat', text: '' });
  assert.deepEqual(parseLine('> quoted'), { type: 'quote', text: 'quoted' });
  assert.deepEqual(parseLine('>tight'), { type: 'quote', text: 'tight' });
  assert.deepEqual(parseLine('![alt](https://x.y/z.png)'), { type: 'img', text: 'alt', src: 'https://x.y/z.png' });
  assert.deepEqual(parseLine('hello'), { type: 'p', text: 'hello' });
  assert.deepEqual(parseLine(''), { type: 'p', text: '' });
});

test('todoLine serialises depth and done state', async () => {
  const { todoLine, parseLine } = await load();
  assert.equal(todoLine(2, false, 'x'), '    - [ ] x');
  assert.equal(todoLine(0, true, 'done'), '- [x] done');
  assert.deepEqual(parseLine(todoLine(3, true, 'round trip')), { type: 'todo', depth: 3, done: true, text: 'round trip' });
});

test('INLINE splits bold, mention and link tokens, keeping separators', async () => {
  const { INLINE } = await load();
  assert.deepEqual('a **b** @[n] [l](u)'.split(INLINE).filter(Boolean), ['a ', '**b**', ' ', '@[n]', ' ', '[l](u)']);
  assert.deepEqual('@chat hi'.split(INLINE).filter(Boolean), ['@chat', ' hi']);
  assert.deepEqual('@chatty'.split(INLINE).filter(Boolean), ['@chatty']);
  assert.deepEqual('*i* `c`'.split(INLINE).filter(Boolean), ['*i*', ' ', '`c`']);
});

test('tokShown reports the shown text and the source prefix length', async () => {
  const { tokShown } = await load();
  assert.deepEqual(tokShown('**bold**'), { shown: 'bold', pre: 2 });
  assert.deepEqual(tokShown('*it*'), { shown: 'it', pre: 1 });
  assert.deepEqual(tokShown('`c`'), { shown: 'c', pre: 1 });
  assert.deepEqual(tokShown('@[hypocompass]'), { shown: '@hypocompass', pre: 1 });
  assert.deepEqual(tokShown('@[chat:x]'), { shown: '@chat', pre: 1 });
  assert.deepEqual(tokShown('[text](https://a.b)'), { shown: 'text', pre: 1 });
  assert.deepEqual(tokShown('plain'), { shown: 'plain', pre: 0 });
  assert.deepEqual(tokShown('@chat'), { shown: '@chat', pre: 0 });
});

test('tokensOf keeps heading and quote prefixes as their own first token', async () => {
  const { tokensOf, parseLine } = await load();
  assert.deepEqual(tokensOf(parseLine('## A **b**'), '## A **b**'), ['## ', 'A ', '**b**']);
  assert.deepEqual(tokensOf(parseLine('> q *i*'), '> q *i*'), ['> ', 'q ', '*i*']);
  assert.deepEqual(tokensOf(parseLine('>q'), '>q'), ['>', 'q']);
  assert.deepEqual(tokensOf(parseLine('- [ ] t @[x]'), '- [ ] t @[x]'), ['t ', '@[x]']);
  assert.deepEqual(tokensOf(parseLine('@chat hi'), '@chat hi'), ['@chat', ' hi']);
});

test('rawOffset maps a display offset across a bold token', async () => {
  const { rawOffset, parseLine } = await load();
  const line = 'hello **world** x';
  const p = parseLine(line);
  assert.equal(rawOffset(p, 0), 0);
  assert.equal(rawOffset(p, 6), 6);            // right before "world" (display) → before "**" (raw)
  assert.equal(rawOffset(p, 8), 10);           // "hello wo|rld" → "hello **wo|rld**"
  assert.equal(rawOffset(p, 11), 13);          // display end of "world" → before the closing ** (design semantics)
  assert.equal(rawOffset(p, 13), 17);          // end of line
});

test('rawOffset adds the heading base and handles mentions', async () => {
  const { rawOffset, parseLine } = await load();
  assert.equal(rawOffset(parseLine('## Title'), 2), 5);          // "## Ti|tle"
  assert.equal(rawOffset(parseLine('## Title'), 0), 3);
  assert.equal(rawOffset(parseLine('see @[hypocompass] now'), 6), 7); // "see @h|ypocompass" → "see @[h|ypocompass]"
  assert.equal(rawOffset(parseLine('see @[hypocompass] now'), 4), 4); // before the mention
});

test('rawOffset with the line uses the real quote prefix and whole chat/paragraph lines', async () => {
  const { rawOffset, parseLine } = await load();
  assert.equal(rawOffset(parseLine('>q'), 1, '>q'), 2);
  assert.equal(rawOffset(parseLine('> q'), 1, '> q'), 3);
  assert.equal(rawOffset(parseLine('@chat hello'), 8, '@chat hello'), 8);
  assert.equal(rawOffset(parseLine('- [ ] a **b**'), 2, '- [ ] a **b**'), 2); // todo offsets stay relative to p.text; a boundary belongs to the preceding token
});

test('inlineHtml renders markup and escapes text', async () => {
  const { inlineHtml } = await load();
  assert.equal(inlineHtml('a **b** c'), 'a <strong style="font-weight:600">b</strong> c');
  assert.equal(inlineHtml('*i*'), '<em>i</em>');
  assert.equal(inlineHtml('`c`'), '<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">c</code>');
  assert.equal(inlineHtml('@chat go'), '<span style="color:#0070f3;font-weight:500">@chat</span> go');
  assert.match(inlineHtml('@[hypocompass]'), /^<span data-mention="hypocompass"[^>]*>@hypocompass<\/span>$/);
  assert.match(inlineHtml('[t](https://a.b)'), /^<a href="https:\/\/a\.b" data-link="1"[^>]*>t<\/a>$/);
  assert.equal(inlineHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('esc escapes the four HTML-significant characters', async () => {
  const { esc } = await load();
  assert.equal(esc('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
  assert.equal(esc(5), '5');
});
