'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

test('a task line is a checkbox; a bare dash is a bullet (2026-09-20)', async () => {
  const { parseLine } = await load();
  assert.deepEqual(parseLine('  - [x] a'), { type: 'todo', depth: 1, done: true, text: 'a' });
  assert.deepEqual(parseLine('- [ ] open'), { type: 'todo', depth: 0, done: false, text: 'open' });
  assert.deepEqual(parseLine('- []'), { type: 'todo', depth: 0, done: false, text: '' }, 'the short checkbox starts a task');
  assert.deepEqual(parseLine('- [] buy milk'), { type: 'todo', depth: 0, done: false, text: 'buy milk' });
  assert.deepEqual(parseLine('- []one'), { type: 'list', depth: 0, text: '[]one' }, 'the checkbox needs its space: nothing flips mid-word');
  assert.deepEqual(parseLine('- [x]done'), { type: 'list', depth: 0, text: '[x]done' });
  assert.deepEqual(parseLine('- plain dash'), { type: 'list', depth: 0, text: 'plain dash' });
  assert.equal(parseLine('                    - [ ] deep').depth, 8);
});

test('bullets are their own kind of line, nested by two spaces', async () => {
  const { parseLine, listLine } = await load();
  assert.deepEqual(parseLine('- one'), { type: 'list', depth: 0, text: 'one' });
  assert.deepEqual(parseLine('  - two'), { type: 'list', depth: 1, text: 'two' });
  assert.deepEqual(parseLine('* star'), { type: 'list', depth: 0, text: 'star' }, 'a star is a bullet too');
  assert.deepEqual(parseLine('- '), { type: 'list', depth: 0, text: '' });
  assert.deepEqual(parseLine('-no space'), { type: 'p', text: '-no space' });
  assert.equal(parseLine('                    - deep').depth, 8);
  assert.equal(listLine(2, 'x'), '    - x');
  assert.deepEqual(parseLine(listLine(3, 'round trip')), { type: 'list', depth: 3, text: 'round trip' });
});

test('@Task starts a task, in either case, only at the head of a line', async () => {
  const { parseLine } = await load();
  assert.deepEqual(parseLine('@Task write the paper'), { type: 'todo', depth: 0, done: false, text: 'write the paper' });
  assert.deepEqual(parseLine('@task write the paper'), { type: 'todo', depth: 0, done: false, text: 'write the paper' });
  assert.deepEqual(parseLine('@TASK '), { type: 'todo', depth: 0, done: false, text: '' }, 'the space is the trigger, as "- " used to be');
  assert.deepEqual(parseLine('  @Task nested'), { type: 'todo', depth: 1, done: false, text: 'nested' });
  assert.deepEqual(parseLine('@Task'), { type: 'p', text: '@Task' }, 'no space yet: still being typed');
  assert.deepEqual(parseLine('@taskforce meets'), { type: 'p', text: '@taskforce meets' });
  assert.deepEqual(parseLine('ask @Task about it'), { type: 'p', text: 'ask @Task about it' });
});

test('canonicalLine stores either task trigger as the checkbox line it makes', async () => {
  const { canonicalLine } = await load();
  assert.equal(canonicalLine('@Task x'), '- [ ] x');
  assert.equal(canonicalLine('  @task x'), '  - [ ] x');
  assert.equal(canonicalLine('@Task '), '- [ ] ');
  assert.equal(canonicalLine('- [] x'), '- [ ] x');
  assert.equal(canonicalLine('- [x] done'), '- [x] done');
  assert.equal(canonicalLine('* star'), '- star', 'one bullet marker is stored');
  assert.equal(canonicalLine('- plain dash'), '- plain dash');
  assert.equal(canonicalLine('hello'), 'hello');
});

test('a marker typed into a row that already draws one re-types the row', async () => {
  const { parseLine, retypedRow } = await load();
  const bullet = parseLine('- ');
  assert.deepEqual(retypedRow(bullet, '- [ ] real work'), { line: '- [ ] real work', ate: 6 });
  assert.deepEqual(retypedRow(bullet, '@Task real work'), { line: '- [ ] real work', ate: 6 });
  assert.deepEqual(retypedRow(bullet, '- nested?'), { line: '- nested?', ate: 2 }, 'no literal "- " inside a bullet');
  assert.deepEqual(retypedRow(bullet, '- []'), { line: '- [ ] ', ate: 4 }, 'the checkbox alone starts the task');
  assert.deepEqual(retypedRow(bullet, '- []one'), { line: '- []one', ate: 2 }, 'half a checkbox: the bullet marker is absorbed, the rest is text');
  const task = parseLine('- [ ] ');
  assert.deepEqual(retypedRow(task, '- []one'), { line: '- []one', ate: 2 }, 'the marker typed wins: a task takes the bullet it was given');
  assert.equal(retypedRow(task, 'plain'), null);
  assert.equal(retypedRow(bullet, 'plain text'), null);
  const nested = parseLine('  - [ ] ');
  assert.deepEqual(retypedRow(nested, '- [x] done'), { line: '  - [x] done', ate: 6 });
  assert.deepEqual(retypedRow(nested, '- a bullet'), { line: '  - a bullet', ate: 2 }, 'an empty task takes the bullet marker');
});

test('parseLine classifies headings, bart, quote, image and paragraphs', async () => {
  const { parseLine } = await load();
  assert.deepEqual(parseLine('## Title'), { type: 'h', level: 2, text: 'Title' });
  assert.deepEqual(parseLine('#### not a heading'), { type: 'p', text: '#### not a heading' });
  assert.deepEqual(parseLine('@bart hi there'), { type: 'bart', text: 'hi there' });
  assert.deepEqual(parseLine('@bart'), { type: 'bart', text: '' });
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
  assert.deepEqual('@bart hi'.split(INLINE).filter(Boolean), ['@bart', ' hi']);
  assert.deepEqual('@bartty'.split(INLINE).filter(Boolean), ['@bartty']);
  assert.deepEqual('*i* `c`'.split(INLINE).filter(Boolean), ['*i*', ' ', '`c`']);
});

test('tokShown reports the shown text and the source prefix length', async () => {
  const { tokShown } = await load();
  assert.deepEqual(tokShown('**bold**'), { shown: 'bold', pre: 2 });
  assert.deepEqual(tokShown('*it*'), { shown: 'it', pre: 1 });
  assert.deepEqual(tokShown('`c`'), { shown: 'c', pre: 1 });
  assert.deepEqual(tokShown('@[hypocompass]'), { shown: '@hypocompass', pre: 1 });
  assert.deepEqual(tokShown('@[bart:x]'), { shown: '@bart', pre: 1 });
  assert.deepEqual(tokShown('[text](https://a.b)'), { shown: 'text', pre: 1 });
  assert.deepEqual(tokShown('plain'), { shown: 'plain', pre: 0 });
  assert.deepEqual(tokShown('@bart'), { shown: '@bart', pre: 0 });
});

test('tokensOf keeps heading and quote prefixes as their own first token', async () => {
  const { tokensOf, parseLine } = await load();
  assert.deepEqual(tokensOf(parseLine('## A **b**'), '## A **b**'), ['## ', 'A ', '**b**']);
  assert.deepEqual(tokensOf(parseLine('> q *i*'), '> q *i*'), ['> ', 'q ', '*i*']);
  assert.deepEqual(tokensOf(parseLine('>q'), '>q'), ['>', 'q']);
  assert.deepEqual(tokensOf(parseLine('- [ ] t @[x]'), '- [ ] t @[x]'), ['t ', '@[x]']);
  assert.deepEqual(tokensOf(parseLine('- t @[x]'), '- t @[x]'), ['t ', '@[x]'], 'a bullet marker is drawn, never typed');
  assert.deepEqual(tokensOf(parseLine('@bart hi'), '@bart hi'), ['@bart', ' hi']);
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

test('rawOffset with the line uses the real quote prefix and whole bart/paragraph lines', async () => {
  const { rawOffset, parseLine } = await load();
  assert.equal(rawOffset(parseLine('>q'), 1, '>q'), 2);
  assert.equal(rawOffset(parseLine('> q'), 1, '> q'), 3);
  assert.equal(rawOffset(parseLine('@bart hello'), 8, '@bart hello'), 8);
  assert.equal(rawOffset(parseLine('- [ ] a **b**'), 2, '- [ ] a **b**'), 2); // todo offsets stay relative to p.text; a boundary belongs to the preceding token
  assert.equal(rawOffset(parseLine('- a **b**'), 2, '- a **b**'), 2); // a bullet's offsets are relative to p.text too
});

test('inlineHtml renders markup and escapes text', async () => {
  const { inlineHtml } = await load();
  assert.equal(inlineHtml('a **b** c'), 'a <strong style="font-weight:600">b</strong> c');
  assert.equal(inlineHtml('*i*'), '<em>i</em>');
  assert.equal(inlineHtml('`c`'), '<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">c</code>');
  assert.equal(inlineHtml('@bart go'), '<span style="color:#0070f3;font-weight:500">@bart</span> go');
  assert.match(inlineHtml('@[hypocompass]'), /^<span data-mention="hypocompass"[^>]*>@hypocompass<\/span>$/);
  assert.match(inlineHtml('[t](https://a.b)'), /^<a href="https:\/\/a\.b" data-link="1"[^>]*>t<\/a>$/);
  assert.equal(inlineHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('esc escapes the four HTML-significant characters', async () => {
  const { esc } = await load();
  assert.equal(esc('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
  assert.equal(esc(5), '5');
});

test('a pasted image is an inline token that reads [Attachment n]; alone on a line it is an image', async () => {
  const { INLINE, tokShown, inlineHtml, parseLine, rawOffset } = await load();
  const token = '![Attachment 1](img:0a1b2c3d-0000-4000-8000-000000000000)';
  assert.deepEqual(`fix ${token} now`.split(INLINE).filter(Boolean), ['fix ', token, ' now']);
  assert.deepEqual(tokShown(token), { shown: '[Attachment 1]', pre: 1 });
  assert.match(inlineHtml(`fix ${token}`), /data-attachment="0a1b2c3d-0000-4000-8000-000000000000"[^>]*>\[Attachment 1\]</);
  assert.equal(parseLine(token).type, 'img');
  const todo = parseLine(`- [ ] fix ${token} now`);
  assert.equal(todo.type, 'todo');
  assert.equal(rawOffset(todo, 'fix [Attachment 1] now'.length), `fix ${token} now`.length, 'a click after the chip maps past the whole token');
});

test('a bare address is a link as it stands; closing punctuation, markdown links and code are left alone', async () => {
  const { INLINE, tokShown, inlineHtml, parseLine, rawOffset } = await load();
  assert.deepEqual('see https://example.com/a_b?q=1#x, then'.split(INLINE).filter(Boolean), ['see ', 'https://example.com/a_b?q=1#x', ', then']);
  assert.deepEqual('read https://example.com/paper.pdf.'.split(INLINE).filter(Boolean), ['read ', 'https://example.com/paper.pdf', '.']);
  assert.deepEqual('(https://example.com)'.split(INLINE).filter(Boolean), ['(', 'https://example.com', ')']);
  assert.deepEqual(tokShown('https://example.com'), { shown: 'https://example.com', pre: 0 });
  assert.match(inlineHtml('go to https://example.com/?a=1&b=2 now'), /^go to <a href="https:\/\/example\.com\/\?a=1&amp;b=2" data-link="1"[^>]*>https:\/\/example\.com\/\?a=1&amp;b=2<\/a> now$/);
  assert.equal((inlineHtml('[site](https://example.com)').match(/<a /g) || []).length, 1, 'a markdown link stays one link');
  assert.doesNotMatch(inlineHtml('`curl https://example.com`'), /<a /);
  assert.match(inlineHtml(parseLine('bart> source: https://example.com/x').text), /<a href="https:\/\/example\.com\/x"/, 'an answer line links too');
  const todo = parseLine('- [ ] open https://example.com today');
  assert.equal(rawOffset(todo, 'open https://example.com today'.length), todo.text.length, 'offsets are unchanged: the address shows as typed');
});

/* ------------------------------------------------------------- @bart cards (Answer Card, 2026-09-21) */

test('an answer line is a drawn-prefix line: its text is edited, its prefix and its fold are kept', async () => {
  const { parseLine, lineText, sameLine, replyLine, tokensOf, rawOffset, replyRawOffset, isDrawn, isMarked } = await load();
  const open = parseLine('bart> It **is** so'), folded = parseLine('bart+> It **is** so');
  assert.deepEqual([open.folded, folded.folded, open.text, folded.text], [false, true, 'It **is** so', 'It **is** so']);
  assert.ok(isDrawn('reply') && !isMarked('reply'), 'drawn like a bullet, but not a row of a list: no nesting, no stepping out');
  assert.equal(lineText(open, 'bart> It **is** so'), 'It **is** so');
  assert.equal(sameLine(open, 'It was'), 'bart> It was');
  assert.equal(sameLine(folded, 'It was'), 'bart+> It was');
  assert.equal(sameLine(open, 'word '), 'bart> word ', 'a space typed at the end survives, or no second word could follow');
  assert.deepEqual(parseLine(replyLine('', false)), { type: 'reply', text: '', folded: false });
  assert.deepEqual(tokensOf(open, 'bart> It **is** so'), ['It ', '**is**', ' so']);
  assert.equal(rawOffset(open, 5, 'bart> It **is** so'), 7, 'offsets are in the text, not the line');
  // A rendered answer line shows its own markdown drawn: no `## `, and a • (one character) where `- ` stands.
  assert.equal(replyRawOffset(parseLine('bart> ## Seen'), 2), 5);
  assert.equal(replyRawOffset(parseLine('bart> - **230** characters'), 1), 2);
  assert.equal(replyRawOffset(parseLine('bart> - **230** characters'), 4), 7, 'the end of a bold run is inside its closing marks, as on any line');
  assert.equal(replyRawOffset(parseLine('bart>   - nested'), 3), 6);
  assert.equal(replyRawOffset(parseLine('bart> plain **bold**'), 8), 10);
});

test('threads: a question, what stands under it, and the follow-ups asked right after', async () => {
  const { threads, turnText } = await load();
  const doc = [
    'intro',                          // 0
    '@bart --opus why?',              // 1
    'bart> Because.',                 // 2
    'bart>',                          // 3
    'bart> *Opus · high · 12 s*',     // 4
    '@bart and then?',                // 5
    'bart+> Then this.',              // 6
    'bart+> *Opus · high · 4 s*',     // 7
    '@bart a third',                  // 8
    'bart~> k9-x',                    // 9
    '',                               // 10
    '@bart typed, not sent',          // 11
    '@bart another, right under it',  // 12
    'bart> **No answer.** Codex was not found', // 13
  ];
  const found = threads(doc);
  assert.deepEqual(found.map((thread) => [thread.from, thread.to, thread.turns.length]), [[1, 9, 3], [11, 11, 1], [12, 13, 1]], 'a question with nothing under it does not take the next one into its card');
  assert.deepEqual(found[0].turns.map((turn) => [turn.q, turn.from, turn.to, turn.answered, turn.pending, turn.foot, turn.folded]), [[1, 2, 4, true, null, 4, false], [5, 6, 7, true, null, 7, true], [8, 9, 9, true, 'k9-x', -1, false]]);
  assert.deepEqual(turnText(doc, found[0].turns[0]), { question: '--opus why?', answer: 'Because.' }, 'the closing line and the gap before it are not the answer');
  assert.deepEqual(turnText(doc, found[0].turns[1]), { question: 'and then?', answer: 'Then this.' }, 'a folded answer is still what was said');
  assert.deepEqual([found[2].turns[0].foot, turnText(doc, found[2].turns[0]).answer], [-1, '**No answer.** Codex was not found'], 'a run that failed has no closing line');
  assert.deepEqual(threads(['bart> orphaned', 'text']), []);
});

test('fenced code blocks: a closed fence makes a block, and every line inside it is code (2026-09-22)', async () => {
  const { codeBlocks, parseLines, parseLine, fenceShown, threads } = await load();
  const doc = [
    'intro',          // 0
    '```json',        // 1
    '{',              // 2
    '  # not a heading', // 3
    '- not a bullet', // 4
    '@bart not a question', // 5
    '```',            // 6
    '# a heading',    // 7
    '~~~',            // 8
    'tilde body',     // 9
    '```',            // 10 a backtick fence does not close a tilde one
    '~~~~',           // 11
    '```python',      // 12 still being typed: no closing fence below it, so no block
    'x = 1',          // 13
  ];
  assert.deepEqual(codeBlocks(doc).map((b) => [b.open, b.close, b.lang, b.fence]), [[1, 6, 'json', '```'], [8, 11, '', '~~~']]);
  const ps = parseLines(doc);
  assert.deepEqual(ps.map((p) => p.type), ['p', 'fence', 'code', 'code', 'code', 'code', 'fence', 'h', 'fence', 'code', 'code', 'fence', 'p', 'p']);
  assert.equal(ps[1].open, true); assert.equal(ps[6].open, false);
  assert.equal(ps[3].text, '  # not a heading', 'a code line keeps its whole source');
  assert.deepEqual(ps[7], parseLine('# a heading'), 'outside a block a line reads as it always did');
  assert.equal(fenceShown(ps[1]), 'json'); assert.equal(fenceShown(ps[6]), '');
  assert.deepEqual(threads(doc), [], '@bart inside a block is not a question');
  assert.deepEqual(codeBlocks(['```js title', 'a', '````']).map((b) => [b.lang, b.close]), [['js', 2]], 'a longer closing fence closes; the language is the first word');
  assert.deepEqual(codeBlocks(['````', '```', 'x']), [], 'a shorter fence does not close a longer one');
  assert.deepEqual(codeBlocks(['use ```json``` inline', 'x', '```']), [], 'backticks inside a line are not a fence');
  assert.deepEqual(codeBlocks(['    ```', 'x', '```']), [], 'four spaces of indent is not a fence');
});

test('highlight: JSON is coloured without changing a character; other languages are escaped text', async () => {
  const { highlight } = await load();
  const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const samples = ['  "name": "Engelbart", "n": -1.5e3, "ok": true, "none": null,', '{"a":[1,2,{"b":"<x> & \\"y\\""}]}', '  // a jsonc comment', '"unterminated'];
  for (const line of samples) assert.equal(plain(highlight(line, 'json')), line);
  const html = highlight('  "name": "Engelbart",', 'JSON');
  assert.match(html, /<span style="color:#171717">&quot;name&quot;<\/span><span style="color:#8f8f8f">:<\/span> <span style="color:#0761d1">&quot;Engelbart&quot;<\/span>/);
  assert.match(highlight('"n": 12', 'json'), /<span style="color:#4d4d4d">12<\/span>/);
  assert.equal(highlight('const a = "<b>";', 'js'), 'const a = &quot;&lt;b&gt;&quot;;');
  assert.equal(highlight('x', ''), 'x');
});

test('code blocks inside an @bart answer: the lines stay answer lines and say which part of the block they are (2026-09-22)', async () => {
  const { parseLines, threads, turnText, isFence, isCode, fenceShown } = await load();
  const doc = [
    '@bart how?',          // 0
    'bart> Like this:',    // 1
    'bart> ```json',       // 2
    'bart> {',             // 3
    'bart>   "a": 1',      // 4
    'bart>',               // 5
    'bart> }',             // 6
    'bart> ```',           // 7
    'bart>',               // 8
    'bart> *Sol · medium · 3 s*', // 9
    '@bart and ```?',      // 10 a fence inside a question is not one
    'bart> ```',           // 11 an answer's lone fence opens nothing
    'bart> *Sol · medium · 2 s*', // 12
  ];
  const ps = parseLines(doc);
  assert.deepEqual(ps.map((p) => p.code || p.type), ['bart', 'reply', 'open', 'body', 'body', 'body', 'body', 'close', 'reply', 'reply', 'bart', 'reply', 'reply']);
  assert.ok(ps.slice(2, 8).every((p) => p.type === 'reply'), 'still answer lines: the card folds, deletes and copies them');
  assert.deepEqual([ps[2].block.open, ps[2].block.close, ps[2].lang], [2, 7, 'json'], 'block indexes are document lines');
  assert.equal(ps[4].text, '  "a": 1', 'indent kept');
  assert.equal(fenceShown(ps[2]), 'json');
  assert.ok(isFence(ps[2]) && isFence(ps[7]) && isCode(ps[4]) && !isCode(ps[1]) && !isFence(ps[11]));
  const [thread] = threads(doc);
  assert.deepEqual(thread.turns.map((turn) => [turn.q, turn.from, turn.to, turn.foot]), [[0, 1, 9, 9], [10, 11, 12, 12]]);
  assert.equal(turnText(doc, thread.turns[0]).answer, 'Like this:\n```json\n{\n  "a": 1\n\n}\n```', 'a follow-up sends the block back as markdown');
});

test('JSON block selection uses whole lines in either direction, excluding an untouched next line', async () => {
  const { selectedLineRange } = await load();
  const start = { line: 1, offset: 2 }, end = { line: 4, offset: 0 };
  assert.deepEqual(selectedLineRange({ anchor: start, focus: end }), { from: 1, to: 3 });
  assert.deepEqual(selectedLineRange({ anchor: end, focus: start }), { from: 1, to: 3 });
  assert.deepEqual(selectedLineRange({ anchor: start, focus: { ...end, offset: 1 } }), { from: 1, to: 4 });
  assert.deepEqual(selectedLineRange({ anchor: start, focus: start }), { from: 1, to: 1 });
});

test('JSON block formatting keeps every selected character and surrounding prose', async () => {
  const { jsonBlockEdit, parseLines } = await load();
  const doc = ['Before', '{', '\t"quoted": "<x> & `literal`",  ', '', '  "unfinished": ', '}', 'After'];
  const edit = jsonBlockEdit(doc, 1, 5);
  assert.deepEqual(edit.lines, ['Before', '```json', ...doc.slice(1, 6), '```', 'After']);
  assert.deepEqual(edit.body, { from: 2, to: 6 });
  assert.deepEqual(edit.insertions, [{ at: 1, count: 1 }, { at: 7, count: 1 }]);
  assert.ok(parseLines(edit.lines).slice(2, 7).every((p) => p.type === 'code' && p.lang === 'json'));
  assert.equal(doc[1], '{', 'the input array was not mutated');
  assert.deepEqual(jsonBlockEdit(['{"ok":true}'], 0, 0).lines, ['```json', '{"ok":true}', '```', ''], 'the trailing editor line belongs to the same edit');
  assert.deepEqual(jsonBlockEdit([''], 0, 0).lines, ['```json', '', '```', ''], 'an empty line makes a block to type into');
});

test('JSON formatting relabels an existing block and is idempotent', async () => {
  const { jsonBlockEdit } = await load();
  const doc = ['Before', '  ~~~text title', '{"ok":true}', '  ~~~~', 'After'];
  const edit = jsonBlockEdit(doc, 2, 2);
  assert.deepEqual(edit.lines, ['Before', '  ~~~json title', '{"ok":true}', '  ~~~~', 'After']);
  assert.deepEqual(edit.insertions, []);
  assert.deepEqual(edit.body, { from: 2, to: 2 });
  assert.deepEqual(jsonBlockEdit(edit.lines, 1, 3).lines, edit.lines, 'no nested fences on a second shortcut');
  const padded = ['', '```text', '{"ok":true}', '```', ''];
  const all = jsonBlockEdit(padded, 0, 4);
  assert.deepEqual(all.lines, ['', '```json', '{"ok":true}', '```', ''], 'select-all includes the trailing blank, but still relabels');
  assert.deepEqual(jsonBlockEdit(all.lines, 0, 4).lines, all.lines);
  const empty = jsonBlockEdit(['```', '```', 'after'], 0, 1);
  assert.deepEqual(empty.lines, ['```json', '', '```', 'after']);
  assert.deepEqual(empty.body, { from: 1, to: 1 });
  assert.deepEqual(empty.insertions, [{ at: 1, count: 1 }]);
});

test('JSON wrapping cannot be closed early by backticks in the content or split an existing block', async () => {
  const { jsonBlockEdit, codeBlocks } = await load();
  const doc = ['Before', '```text', '``` nested', 'value', '```', 'After'];
  const edit = jsonBlockEdit(doc, 0, 3);
  assert.deepEqual([edit.from, edit.to], [0, 4]);
  assert.equal(edit.lines[0], '````json');
  assert.deepEqual(edit.lines.slice(1, 6), doc.slice(0, 5));
  assert.deepEqual(codeBlocks(edit.lines).map((b) => [b.open, b.close, b.lang]), [[0, 6, 'json']]);
  assert.equal(edit.lines[7], 'After');
  const crossingStart = jsonBlockEdit(doc, 3, 5);
  assert.deepEqual([crossingStart.from, crossingStart.to], [1, 5]);
  assert.equal(crossingStart.lines[0], 'Before');
});

test('JSON blocks inside answer text retain the answer prefixes and cannot swallow a card boundary', async () => {
  const { jsonBlockEdit, parseLines } = await load();
  const doc = ['@bart example?', 'bart> {', 'bart>   "ok": true', 'bart> }', 'bart> *Model · 1 s*', ''];
  const edit = jsonBlockEdit(doc, 1, 3);
  assert.deepEqual(edit.lines, [doc[0], 'bart> ```json', ...doc.slice(1, 4), 'bart> ```', ...doc.slice(4)]);
  assert.ok(parseLines(edit.lines).slice(2, 5).every((p) => p.type === 'reply' && p.code === 'body'));
  assert.deepEqual(jsonBlockEdit(edit.lines, 2, 4).lines, edit.lines);
  assert.equal(jsonBlockEdit(doc, 0, 3), null);
  assert.equal(jsonBlockEdit(['plain', 'bart~> pending', ''], 0, 1), null);
  assert.equal(jsonBlockEdit(doc, -1, 1), null);
  assert.equal(jsonBlockEdit(doc, 2, 1), null);
});

test('a workspace mention is one token that keeps its id and shows the workspace icon in place of the @, then the name (2026-09-25)', async () => {
  const { INLINE, WS_MENTION_RE, wsMention, tokShown, inlineHtml, parseLine, rawOffset } = await load();
  const id = '0a1b2c3d-0000-4000-8000-000000000000';
  const token = wsMention('Pulling [in] workspaces', id);
  assert.equal(token, `@[Pulling in workspaces](ws:${id})`, 'brackets would end the name early');
  assert.deepEqual(`see ${token} and @[Plan].`.split(INLINE).filter(Boolean), ['see ', token, ' and ', '@[Plan]', '.']);
  assert.deepEqual(token.match(WS_MENTION_RE).slice(1), ['Pulling in workspaces', id]);
  assert.deepEqual(tokShown(token), { shown: 'Pulling in workspaces', pre: 2 }, 'the icon is not text, so offsets count the name alone');
  const html = inlineHtml(token);
  assert.match(html, new RegExp(`data-mention="Pulling in workspaces" data-ws="${id}"`));
  assert.match(html, /"><svg [^>]*>.*<\/svg>Pulling in workspaces<\/span>$/, 'the icon, then the name: no @');
  assert.doesNotMatch(inlineHtml('@[Plan]'), /<svg/, 'a note mention has no icon');
  const p = parseLine(`- ${token} next`);
  assert.equal(rawOffset(p, 'Pulling in workspaces next'.length), `${token} next`.length, 'a click after the mention maps past the id');
  assert.equal(rawOffset(p, 1), 3, 'a click after the first letter of the name lands after it in the source');
});

test('a Build\'s line holds its id alone; it is its own kind of line, and it ends an @bart card (2026-09-25)', async () => {
  const { parseLine, parseLines, threads, buildLine, BUILD_RE } = await load();
  assert.equal(buildLine('0123456789'), 'build> 0123456789');
  assert.deepEqual(parseLine('build> 0123456789'), { type: 'build', id: '0123456789', text: '' });
  assert.equal(parseLine('build> not-an-id').type, 'p', 'only a Build id makes the line a card');
  assert.equal(parseLine('build>0123456789').type, 'p');
  assert.ok(BUILD_RE.test('build> abcdef0123'));
  const lines = ['@bart why?', 'bart> because', 'build> 0123456789', '@bart and?'];
  assert.deepEqual(threads(lines).map((t) => [t.from, t.to]), [[0, 1], [3, 3]], 'a Build between two questions keeps them apart');
  assert.equal(parseLines(['```', 'build> 0123456789', '```'])[1].type, 'code', 'inside a code block it is code');
});
