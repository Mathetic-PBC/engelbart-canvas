'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

test('an ask\'s pending line gives way to its answer or its Build\'s line, where it stood; nowhere when it is gone (2026-10-02)', async () => {
  const { placeAnswer, buildLine } = await load();
  const doc = 'Plan.\n@bart --build add a hello comment\nbart~> ab12\nAfter.';
  assert.equal(placeAnswer(doc, 'ab12', [buildLine('0123456789')]), 'Plan.\n@bart --build add a hello comment\nbuild> 0123456789\nAfter.');
  assert.equal(placeAnswer('@bart --build\nbart~> ab12', 'ab12', ['bart> **No Build.** Write what to build after --build.']), '@bart --build\nbart> **No Build.** Write what to build after --build.');
  assert.equal(placeAnswer(doc, 'ab12', []), 'Plan.\n@bart --build add a hello comment\nAfter.', 'a stopped ask leaves nothing');
  assert.equal(placeAnswer('Plan.', 'ab12', ['x']), null);
});

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

test('@Task is plain text since it went (2026-09-29): a checkbox is typed as - [ ]', async () => {
  const { parseLine, canonicalLine } = await load();
  assert.deepEqual(parseLine('@Task write the paper'), { type: 'p', text: '@Task write the paper' });
  assert.deepEqual(parseLine('  @task nested'), { type: 'p', text: '  @task nested' });
  assert.equal(canonicalLine('@Task x'), '@Task x');
});

test('canonicalLine stores a typed checkbox as the checkbox line it makes', async () => {
  const { canonicalLine } = await load();
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
  assert.equal(retypedRow(bullet, '@Task real work'), null, '@Task is no marker (2026-09-29)');
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

test('a workspace mention is one token that keeps its id and shows the @, the workspace icon, then the name (2026-09-29)', async () => {
  const { INLINE, WS_MENTION_RE, wsMention, tokShown, inlineHtml, parseLine, rawOffset } = await load();
  const id = '0a1b2c3d-0000-4000-8000-000000000000';
  const token = wsMention('Pulling [in] workspaces', id);
  assert.equal(token, `@[Pulling in workspaces](ws:${id})`, 'brackets would end the name early');
  assert.deepEqual(`see ${token} and @[Plan].`.split(INLINE).filter(Boolean), ['see ', token, ' and ', '@[Plan]', '.']);
  assert.deepEqual(token.match(WS_MENTION_RE).slice(1), ['Pulling in workspaces', id]);
  assert.deepEqual(tokShown(token), { shown: '@Pulling in workspaces', pre: 1 }, 'the icon is not text, so offsets count the @ and the name');
  const html = inlineHtml(token);
  assert.match(html, new RegExp(`data-mention="Pulling in workspaces" data-ws="${id}"`));
  assert.match(html, /">@<svg [^>]*>.*<\/svg>Pulling in workspaces<\/span>$/, 'the @, the icon right after it, then the name');
  assert.doesNotMatch(inlineHtml('@[Plan]'), /<svg/, 'a note mention has no icon');
  const p = parseLine(`- ${token} next`);
  assert.equal(rawOffset(p, '@Pulling in workspaces next'.length), `${token} next`.length, 'a click after the mention maps past the id');
  assert.equal(rawOffset(p, 2), 3, 'a click after the first letter of the name lands after it in the source');
});

test('the @ menu\'s query is the @ and what follows it up to the caret, on a line or in a follow-up field (2026-10-02)', async () => {
  const { mentionAt } = await load();
  assert.deepEqual(mentionAt('@', 1), { query: '', start: 0 }, 'a bare @ opens the whole menu');
  assert.deepEqual(mentionAt('compare with @pla', 17), { query: 'pla', start: 13 });
  assert.deepEqual(mentionAt('compare with @pla and more', 17), { query: 'pla', start: 13 }, 'only what stands before the caret counts');
  assert.deepEqual(mentionAt('mail@host', 9), { query: 'host', start: 4 }, 'as on a document line, no space is needed before it');
  assert.deepEqual(mentionAt('@@pl', 4), { query: 'pl', start: 1 }, 'the last @');
  assert.deepEqual(mentionAt(`@${'x'.repeat(30)}`, 31), { query: 'x'.repeat(30), start: 0 });
  for (const [text, caret] of [['', 0], ['plain', 5], ['@pla ', 5], ['@[Plan] ', 8], ['@[Pla', 5], ['@pla', 0], [`@${'x'.repeat(31)}`, 32]]) {
    assert.equal(mentionAt(text, caret), null, JSON.stringify([text, caret]));
  }
  assert.equal(mentionAt(null, 0), null);
});

test('a follow-up sent with a mention is an @bart line whose mention draws as one, under the same thread (2026-10-02)', async () => {
  const { parseLine, threads, inlineHtml, INLINE, wsMention } = await load();
  const ws = wsMention('Other place', '0a1b2c3d-0000-4000-8000-000000000000');
  const sent = `@bart --opus --high and @[Plan] with ${ws}?`; // sendFollow's line: the agent, the flags, the field's words
  assert.deepEqual(parseLine(sent), { type: 'bart', text: `--opus --high and @[Plan] with ${ws}?` });
  const tokens = sent.split(INLINE).filter(Boolean);
  assert.ok(tokens.includes('@[Plan]') && tokens.includes(ws));
  assert.match(inlineHtml('@[Plan]'), /^<span data-mention="Plan"/);
  const doc = ['@bart why?', 'bart> Because.', 'bart> *Sonnet · high · 3 s*', sent, 'bart~> a2', ''];
  assert.deepEqual(threads(doc).map((thread) => thread.turns.map((turn) => turn.q)), [[0, 3]], 'it joins the card it was asked under');
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

test('@brainstorm is an @bart line asked of another agent: with or without words, coloured as a token, one thread kind (2026-09-30)', async () => {
  const { parseLine, agentOf, threads, turnText, inlineHtml, INLINE } = await load();
  assert.deepEqual(parseLine('@brainstorm'), { type: 'bart', text: '', agent: 'brainstorm' });
  assert.deepEqual(parseLine('@Brainstorm what about retries?'), { type: 'bart', text: 'what about retries?', agent: 'brainstorm' }, 'what the @ menu writes');
  assert.deepEqual(parseLine('@brainstorm picked "The workspace"; note: soon'), { type: 'bart', text: 'picked "The workspace"; note: soon', agent: 'brainstorm' });
  assert.deepEqual([agentOf(parseLine('@bart q')), agentOf(parseLine('@brainstorm')), agentOf(parseLine('plain'))], ['bart', 'brainstorm', 'bart']);
  assert.equal(parseLine('@brainstorming').type, 'p');
  assert.deepEqual('@Brainstorm here'.split(INLINE).filter(Boolean), ['@Brainstorm', ' here']);
  assert.match(inlineHtml('@brainstorm here'), /<span style="color:#0070f3;font-weight:500">@brainstorm<\/span> here/);
  const doc = [
    '@brainstorm',                            // 0
    'bart> ```json',                          // 1
    'bart> {',                                // 2
    'bart>   "card": "focus"',                // 3
    'bart> }',                                // 4
    'bart> ```',                              // 5
    'bart>',                                  // 6
    'bart> *Sonnet · high · 3 s*',            // 7
    '@brainstorm picked "Retries"',           // 8
    'bart~> k2',                              // 9
    '',
  ];
  const [thread] = threads(doc);
  assert.deepEqual(thread.turns.map((turn) => [turn.q, turn.from, turn.to, turn.foot, turn.pending]), [[0, 1, 7, 7, null], [8, 9, 9, -1, 'k2']]);
  assert.deepEqual(turnText(doc, thread.turns[0]), { question: '', answer: '```json\n{\n  "card": "focus"\n}\n```' }, 'an empty line is still a turn; the card is its JSON');
  assert.deepEqual(threads(['@bart why?', 'bart> because', '@brainstorm', 'bart~> k3']).map((t) => [t.from, t.to, t.turns.length]), [[0, 1, 1], [2, 3, 1]], 'another agent\'s line starts a card of its own (2026-10-02)');
});

test('@discover is an @bart line asked of a third agent: with or without words, coloured as a token, one thread kind (2026-09-30)', async () => {
  const { parseLine, agentOf, threads, inlineHtml, INLINE, tokShown } = await load();
  assert.deepEqual(tokShown('**[A paper](https://x.org)**'), { shown: 'A paper', pre: 2 });
  assert.deepEqual(parseLine('@discover'), { type: 'bart', text: '', agent: 'discover' });
  assert.deepEqual(parseLine('@Discover why agents loop --deep'), { type: 'bart', text: 'why agents loop --deep', agent: 'discover' }, 'what the @ menu writes');
  assert.deepEqual([agentOf(parseLine('@discover x')), agentOf(parseLine('@discovery x'))], ['discover', 'bart']);
  assert.equal(parseLine('@discovery').type, 'p');
  assert.match(inlineHtml('@discover here'), /<span style="color:#0070f3;font-weight:500">@discover<\/span> here/);
  assert.deepEqual('@Discover `@bart` x'.split(INLINE).filter(Boolean), ['@Discover', ' ', '`@bart`', ' x']);
  assert.equal(inlineHtml('**[A paper](https://arxiv.org/abs/1)** · Ada'), '<strong style="font-weight:600"><a href="https://arxiv.org/abs/1" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">A paper</a></strong> · Ada', 'a guide\'s title: a link in bold');
  assert.match(inlineHtml('**@[Plan]** · Ada'), /^<strong style="font-weight:600"><span data-mention="Plan"[^>]*>@Plan<\/span><\/strong> · Ada$/, 'a library item in bold is still a mention');
  assert.deepEqual(threads(['@discover agents', 'bart> ## Start here', 'bart> *Opus · high · 90 s*', '@discover only after 2022', 'bart~> k4']).map((t) => t.turns.length), [2], 'a follow-up joins the guide\'s card');
});

test('the blank line a recap\'s Look for button puts before "@discover" keeps it out of the brainstorm thread (round 4)', async () => {
  const { threads, agentOf, parseLine } = await load();
  const recap = ['@brainstorm (skipped)', 'bart> Where you are: a', 'bart> Look for: retry loops'];
  const apart = threads([...recap, '', '@discover retry loops', 'bart~> d1', '']);
  assert.deepEqual(apart.map((t) => [t.from, t.to]), [[0, 2], [4, 5]]);
  assert.equal(agentOf(parseLine('@discover retry loops')), 'discover');
  assert.deepEqual(threads([...recap, '@discover retry loops', 'bart~> d1']).map((t) => [t.from, t.to]), [[0, 2], [3, 4]], 'without it the line is still a thread of its own: it asks another agent (2026-10-02)');
});

test('different agents never join one thread: a line for another agent starts its own card and reply field (2026-10-02)', async () => {
  const { threads, agentOf, parseLine } = await load();
  const card = ['bart> ```json', 'bart> {', 'bart>   "card": "focus"', 'bart> }', 'bart> ```', 'bart>', 'bart> *Sonnet · high · 3 s*'];
  const mixed = threads(['@brainstorm', ...card, '@discover retry loops', 'bart~> d1', '']);
  assert.deepEqual(mixed.map((t) => [t.from, t.to, t.turns.length]), [[0, 7, 1], [8, 9, 1]], 'a brainstorm answer followed directly by @discover gives two threads');
  const [brainstorm, discover] = mixed, end = brainstorm.turns[brainstorm.turns.length - 1];
  assert.deepEqual([end.q, end.answered, end.pending, end.folded], [0, true, null, false], 'the brainstorm card is its thread\'s last turn, so it stays live with its controls');
  assert.deepEqual([agentOf(parseLine('@brainstorm')), agentOf(parseLine('@discover retry loops'))], ['brainstorm', 'discover']);
  assert.equal(discover.turns[0].pending, 'd1');

  for (const agent of ['bart', 'brainstorm', 'discover']) {
    const doc = [`@${agent} first`, 'bart> one', 'bart> *Opus · high · 4 s*', `@${agent} again`, 'bart> two', 'bart> *Opus · high · 3 s*', `@${agent} once more`, `bart~> ${agent}3`];
    assert.deepEqual(threads(doc).map((t) => [t.from, t.to, t.turns.map((turn) => turn.q)]), [[0, 7, [0, 3, 6]]], `@${agent} still joins follow-ups from the same agent`);
  }

  const underBart = threads(['@bart why?', 'bart> because', 'bart> *Opus · high · 4 s*', '@discover agents that loop', 'bart~> d2']);
  assert.deepEqual(underBart.map((t) => [t.from, t.to, t.turns.length]), [[0, 2, 1], [3, 4, 1]], '@discover directly under a @bart answer gives two threads');
  assert.deepEqual(threads(['@bart a', 'bart> b', '@bart c', 'bart> d', '@discover e', 'bart~> f', '@bart g']).map((t) => t.turns.map((turn) => turn.q)), [[0, 2], [4], [6]], 'a thread ends at the first line from another agent, and the first agent\'s line after it starts again');
});

// Copy and cut (2026-10-02): what a selection copies is the document's markdown, so links keep their addresses.
const COPY_DOC = [
  '# Reading list',
  'See [the ROPE paper](https://github.com/mqo00/rope) and https://example.com/docs for setup.',
  '- first **bold** item',
  '- second item with [a link](https://openalex.org)',
  '- [ ] a task for @[Welcome!]',
  '@bart what is ROPE?',
  'bart> ## Short answer',
  'bart> - It is [ROPE](https://github.com/mqo00/rope), a tutor.',
  'bart> ',
  'bart> *Sol · medium · 1 s*',
  'A paragraph with an important word.',
];

test('a selection inside one line copies the text selected, links whole', async () => {
  const { selectionMarkdown, parseLine, rawOffset, tokShown, lineText, INLINE } = await load();
  // Where a click at the end of a rendered line lands in its source (the editor's caretInfo goes through rawOffset).
  const shownEnd = (line) => { const p = parseLine(line), text = lineText(p, line); return rawOffset(p, text.split(INLINE).filter(Boolean).reduce((n, tok) => n + tokShown(tok).shown.length, 0), p.type === 'list' ? undefined : line); };
  const at = (line, offset) => ({ line, offset });
  assert.equal(selectionMarkdown(COPY_DOC, at(1, 0), at(1, shownEnd(COPY_DOC[1]))), COPY_DOC[1], 'a bare address and a titled link both survive');
  assert.equal(shownEnd(COPY_DOC[3]), 24, 'the end of a rendered link lands before its `](url)`');
  assert.equal(selectionMarkdown(COPY_DOC, at(3, 0), at(3, 24)), 'second item with [a link](https://openalex.org)', 'and still copies the whole link; one line is its text, no mark');
  assert.equal(selectionMarkdown(COPY_DOC, at(10, 20), at(10, 29)), 'important', 'inside one word, that word');
  assert.equal(selectionMarkdown(COPY_DOC, at(1, 9), at(1, 13)), 'ROPE', 'a word picked out of a link\'s title is that word');
  assert.equal(selectionMarkdown(COPY_DOC, at(1, 21), at(1, 50)), 'https://github.com/mqo00/rope', 'the address of a link, selected in its source on the caret\'s line');
  assert.equal(selectionMarkdown(COPY_DOC, at(1, 13), at(1, 9)), 'ROPE', 'focus before anchor reads the same');
  assert.equal(selectionMarkdown(COPY_DOC, at(10, 4), at(10, 4)), '', 'nothing selected, nothing copied');
  assert.equal(selectionMarkdown(['ask @[Plan](ws:abc123) and @[Note] now'], at(0, 0), at(0, 8)), 'ask @[Plan](ws:abc123)', 'a mention cut by the selection is copied whole');
  assert.equal(selectionMarkdown(['ask @[Plan](ws:abc123) and @[Note] now'], at(0, 10), at(0, 38)), ' and @[Note] now', 'starting right after a mention takes none of it');
  assert.equal(selectionMarkdown(['```js', 'const a = [x](y);', '```'], at(1, 6), at(1, 14)), 'a = [x](', 'code is copied as typed');
});

test('a selection across lines keeps its marks and links; answers lose their prefixes and their closing line', async () => {
  const { selectionMarkdown } = await load();
  const at = (line, offset) => ({ line, offset });
  assert.equal(selectionMarkdown(COPY_DOC, at(0, 2), at(10, 35)), [
    '# Reading list', COPY_DOC[1], '- first **bold** item', '- second item with [a link](https://openalex.org)', '- [ ] a task for @[Welcome!]',
    '@bart what is ROPE?', '## Short answer', '- It is [ROPE](https://github.com/mqo00/rope), a tutor.', '', 'A paragraph with an important word.',
  ].join('\n'), 'from the start of a rendered heading: its `# ` comes too');
  assert.equal(selectionMarkdown(COPY_DOC, at(1, 9), at(3, 6)), '[ROPE paper](https://github.com/mqo00/rope) and https://example.com/docs for setup.\n- first **bold** item\n- second',
    'a link cut at the start is still a link; the last line keeps its mark');
  assert.equal(selectionMarkdown(COPY_DOC, at(2, 10), at(3, 6)), '**ld** item\n- second', 'bold cut at the start is still bold');
  assert.equal(selectionMarkdown(COPY_DOC, at(2, 0), at(3, 24)), '- first **bold** item\n- second item with [a link](https://openalex.org)', 'ending on a link\'s title takes the whole link');
  assert.equal(selectionMarkdown(COPY_DOC, at(3, 24), at(4, 6)), '\n- [ ] a task', 'starting right after a link at the end of a line takes none of it');
  assert.equal(selectionMarkdown(COPY_DOC, at(2, 0), at(3, 0)), '- first **bold** item\n', 'ending at the start of a line takes its line break only');
  assert.equal(selectionMarkdown(COPY_DOC, at(6, 0), at(9, 0)), '## Short answer\n- It is [ROPE](https://github.com/mqo00/rope), a tutor.\n', 'an answer\'s own heading and bullet marks stay');
  const doc = ['@bart q', 'bart+> one [x](https://x.y)', 'bart+> *Opus · 2 s*', 'build> 0123456789', '@bart again', 'bart~> k1', 'end'];
  assert.equal(selectionMarkdown(doc, at(0, 0), at(6, 3)), '@bart q\none [x](https://x.y)\n@bart again\nend', 'a folded answer loses `bart+> `; a Build\'s line and a run at work hold ids and are left out');
  assert.equal(selectionMarkdown(doc, at(6, 3), at(0, 0)), '@bart q\none [x](https://x.y)\n@bart again\nend');
  assert.equal(selectionMarkdown(['```js', 'const a = [x](y);', '```', 'after'], at(0, 0), at(3, 5)), '```js\nconst a = [x](y);\n```\nafter', 'code comes as typed, fences too');
  assert.equal(selectionMarkdown(['see @[Plan](ws:abc123) now', 'and @[Note]'], at(0, 4), at(1, 11)), '@[Plan](ws:abc123) now\nand @[Note]', 'mentions stay mentions, so they paste back as mentions');
});

test('the HTML a copy carries: links to click, bold and italic, names for mentions, no attachments', async () => {
  const { selectionHtml } = await load();
  assert.equal(selectionHtml('See [a](https://a.b) and https://c.d/e, **bold [L](https://l.m)** *it* `c<d>` @[Plan] @[Space](ws:w1) ![Attachment 1](img:abc)'),
    'See <a href="https://a.b">a</a> and <a href="https://c.d/e">https://c.d/e</a>, <strong>bold <a href="https://l.m">L</a></strong> <em>it</em> <code>c&lt;d&gt;</code> Plan Space ');
  assert.equal(selectionHtml('# Head\n- one\n  - [x] two\n- [ ] three\n\n```\n  code <b>\n```\n![pic](https://x.y/p.png)\n![Attachment 2](img:def)\n> quoted'),
    '<strong>Head</strong><br>• one<br>&nbsp;&nbsp;&nbsp;&nbsp;☑ two<br>☐ three<br><br><code>&nbsp;&nbsp;code &lt;b&gt;</code><br><a href="https://x.y/p.png">pic</a><br>&gt; quoted', 'one line per line; fences and attached images go');
  assert.equal(selectionHtml('[click](javascript:alert) [x](ws:abc) [m](mailto:a@b.c)'), 'click x <a href="mailto:a@b.c">m</a>', 'only web and mail addresses become links');
  assert.equal(selectionHtml('[q](https://a.b/?q="x"&y=1)'), '<a href="https://a.b/?q=&quot;x&quot;&amp;y=1">q</a>');
  assert.doesNotMatch(selectionHtml('[a](https://a.b) @[Plan] `x`'), /style=/, 'no inline styles or chips');
});

test('text pasted from a web page gets its links back from the page\'s HTML', async () => {
  const { withLinks } = await load();
  const a = (text, href) => ({ text, href });
  assert.equal(withLinks('Read the OpenAlex docs and the ROPE repo.', [a('OpenAlex docs', 'https://docs.openalex.org/'), a('ROPE repo', 'https://github.com/mqo00/rope')]),
    'Read the [OpenAlex docs](https://docs.openalex.org/) and the [ROPE repo](https://github.com/mqo00/rope).');
  assert.equal(withLinks('here and here', [a('here', 'https://a.b'), a('here', 'https://c.d')]), '[here](https://a.b) and [here](https://c.d)', 'in order: each title where it next stands');
  assert.equal(withLinks('a cat sat', [a('at', 'https://a.b')]), 'a cat sat', 'a title is found as words of its own, not inside one');
  assert.equal(withLinks('see Python (programming language).', [a('Python (programming language)', 'https://en.wikipedia.org/wiki/Python_(programming_language)')]),
    'see [Python (programming language)](https://en.wikipedia.org/wiki/Python_%28programming_language%29).', 'parentheses in the address are encoded, so the link still reads as one');
  assert.equal(withLinks('OpenAlex\ndocs', [a('OpenAlex\n  docs', 'https://x.y')]), 'OpenAlex\ndocs', 'a title the plain text breaks differently is left alone');
  assert.equal(withLinks('the OpenAlex docs', [a('OpenAlex\n  docs', 'https://x.y')]), 'the [OpenAlex docs](https://x.y)', 'the HTML\'s spacing is read as the page shows it');
  const plain = 'https://x.y/ and [1] and mail and wiki and gone';
  assert.equal(withLinks(plain, [a('https://x.y/', 'https://x.y'), a('[1]', 'https://x.y/#1'), a('mail', 'mailto:a@b.c'), a('wiki', '/wiki/X'), a('', 'https://img.y'), a('missing', 'https://m.y')]), plain,
    'a link that is its own address, a title with brackets, an address that is not the web, an image link and a title not in the text are left as they are');
  assert.equal(withLinks('plain', []), 'plain');
});

test('flattenPaste: several pasted lines become one question line, one space at each break (2026-10-02)', async () => {
  const { flattenPaste, parseLine, agentOf } = await load();
  assert.equal(flattenPaste('one\ntwo\nthree'), 'one two three');
  assert.equal(flattenPaste('one\n\ntwo\n\n\n\nthree'), 'one two three', 'blank lines make one space, not many');
  assert.equal(flattenPaste('one\r\ntwo\r\n\r\nthree'), 'one two three', 'Windows line breaks');
  assert.equal(flattenPaste('one\rtwo'), 'one two', 'a lone carriage return is a break too');
  assert.equal(flattenPaste('  \n one\ntwo  \n\n'), 'one two', 'the ends are trimmed');
  assert.equal(flattenPaste('one  \n   two'), 'one two', 'spaces around a break go with it');
  assert.equal(flattenPaste('def f():\n\treturn 1\n\t\tdone'), 'def f(): return 1 done', 'tabs that indent a line go with the break');
  assert.equal(flattenPaste('\tone\ttwo\t\n'), 'one\ttwo', 'a tab inside a line is kept, as a one-line paste keeps it');
  assert.equal(flattenPaste('a  b\nc'), 'a  b c', 'spacing inside a line is kept');
  assert.equal(flattenPaste('\n\n \t\n'), '');
  assert.equal(flattenPaste(''), '');
  for (const line of ['@bart ', '@brainstorm ', '@discover ', '@bart --build ']) {
    const p = parseLine(line + flattenPaste('first\n\nsecond\nthird'));
    assert.equal(p.type, 'bart', `${line.trim()} is a question line`);
    assert.equal(p.text, (line.slice(line.indexOf(' ') + 1) + 'first second third'), 'the whole paste is the question');
    assert.equal(agentOf(p), line.slice(1, line.indexOf(' ')));
  }
});
