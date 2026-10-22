'use strict';

// Chat's citations as drawn (src/renderer/model/cite.js, src/renderer/model/doc.js, DocEditor's answer lines; 2026-10-21):
// a `cite=` link is a grey numbered circle, numbered by the answer in the order it first cites each passage, the same
// number for the same words again; three or more side by side fold into the first and "…". The markdown keeps the link,
// a circle holds no text, and any other link is drawn as it was. The editor is a stand-in, as in doc-editor-answer-line.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { replyLines } = require('../src/main/bart/reply.cjs');

const citeModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/cite.js')).href);
const docModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);

const NOTE = '[You · Oct 12](/Users/me/Notes/My%20note.md#find=reading%20is%20slow%20when%20the%20figures%20come%20late&cite=you)';
const NOTE_AGAIN = '[You · Oct 14](/Users/me/Notes/My%20note.md#find=figures%20first%20then%20text&cite=you)';
const PAPER = '[Smith 2024](https://www.example.org/paper.pdf#find=readers%20skim%20figures%20before%20text&cite=source)';
const PAPER_SAME = '[Smith 2024](https://example.org/paper.pdf/#find=a%20second%20passage%20of%20it&cite=source)';
const AGAINST = '[Lee · Sep 2](/Users/me/Meetings/Standup.md#find=nobody%20looks%20at%20the%20figures&cite=other&counter=1)';
const PLAIN = '[a document link](https://example.org/doc#find=the%20first%20words)';

test('citationOf reads a cite= link, and nothing else', async () => {
  const { citationOf } = await citeModel();
  assert.deepEqual(citationOf(NOTE), { label: 'You · Oct 12', href: NOTE.slice(NOTE.indexOf('](') + 2, -1), address: '/Users/me/Notes/My note.md', key: '/Users/me/Notes/My note.md', find: 'reading is slow when the figures come late', cite: 'you', counter: false });
  assert.equal(citationOf(AGAINST).counter, true);
  assert.equal(citationOf(AGAINST).cite, 'other');
  assert.equal(citationOf(PLAIN), null, 'a passage link without cite= is a link');
  assert.equal(citationOf('[x](/a.md#find=b&cite=maybe)'), null, 'an unknown kind is no citation');
  assert.deepEqual(citationOf('[x](/a.md#cite=you)'), { label: 'x', href: '/a.md#cite=you', address: '/a.md', key: '/a.md', find: '', cite: 'you', counter: false }, 'one with no passage is the whole source');
  assert.equal(citationOf('plain words'), null);
});

test('numbers go by first appearance of each passage: other words of the same source the next, the same words their own', async () => {
  const { citationNumbers, citationOf, citationPassage } = await citeModel();
  const lines = [`Reading slows ${NOTE} and readers skim ${PAPER}.`, `- Against it ${AGAINST}, though ${PAPER_SAME} and ${NOTE_AGAIN}, as said ${NOTE}.`];
  const n = citationNumbers(lines), of = (link) => n.get(citationPassage(citationOf(link)));
  assert.deepEqual([NOTE, PAPER, AGAINST, PAPER_SAME, NOTE_AGAIN].map(of), [1, 2, 3, 4, 5], 'a number a passage, the same source or not');
  assert.equal(n.size, 5, 'the same words quoted again keep theirs');
  assert.equal(of(PAPER.replace('www.', '')), 2, 'www. and a trailing slash are the same page');
  assert.deepEqual([...citationNumbers(lines.join('\n'))], [...n], 'the answer whole or line by line: the same numbers');
  assert.equal(citationNumbers(`only ${PLAIN}`).size, 0);
});

test('a run of one or two draws every circle; three or more fold into the first and "…"', async () => {
  const { citationRuns } = await citeModel();
  const { INLINE } = await docModel();
  const toks = (s) => s.split(INLINE).filter(Boolean);
  assert.ok(citationRuns(toks(`a ${NOTE} b`)).every((r) => r === null));
  assert.ok(citationRuns(toks(`a ${NOTE} ${PAPER} b`)).every((r) => r === null), 'two side by side: both drawn');
  const three = toks(`claim ${NOTE} ${PAPER}${AGAINST}.`);
  const runs = citationRuns(three);
  const first = three.indexOf(NOTE), last = three.indexOf(AGAINST);
  assert.deepEqual(runs[first], { run: first, role: 'first', last, more: 2 });
  assert.equal(runs[first + 1].role, 'rest', 'the space between them folds with them');
  assert.equal(runs[last].role, 'rest');
  assert.equal(runs[0], null);
  assert.equal(runs[last + 1], null);
  assert.ok(citationRuns(toks(`${NOTE} and ${PAPER} and ${AGAINST}`)).every((r) => r === null), 'words between: no run');
});

test('a citation shows no text and is one unit; an ordinary link is as it was', async () => {
  const { tokShown, rawOffset } = await docModel();
  assert.deepEqual(tokShown(NOTE), { shown: '', pre: 1, unit: true });
  assert.deepEqual(tokShown(PLAIN), { shown: 'a document link', pre: 1 });
  // "Slow " then the circle then "." : the shown text is "Slow .", and a place after the circle is after its source.
  const text = `Slow ${NOTE}.`;
  assert.equal(rawOffset({ type: 'p', text }, 5, text), 5, 'right before the circle');
  assert.equal(rawOffset({ type: 'p', text }, 6, text), text.length, 'after the "." past it');
});

test('inlineHtml draws circles: numbered, flagged, folded; the markdown keeps the link', async () => {
  const { inlineHtml } = await docModel();
  const html = inlineHtml(`Slow ${NOTE} but ${AGAINST} and ${PLAIN}.`);
  const circles = [...html.matchAll(/<a href="([^"]*)" data-link="1" data-cite="(\w+)" data-n="(\d+)"[^>]*><\/a>/g)];
  assert.equal(circles.length, 2, 'each citation a circle with no text in it');
  assert.deepEqual(circles.map((m) => [m[2], m[3]]), [['you', '1'], ['other', '2']]);
  assert.match(circles[0][0], /data-you="1"/);
  assert.match(circles[1][0], /data-counter="1"/);
  assert.doesNotMatch(circles[0][0], /data-counter/);
  assert.match(circles[0][0], /data-label="You · Oct 12"/);
  assert.match(circles[0][0], /data-find="reading is slow when the figures come late"/);
  assert.match(circles[0][0], /data-source="My note\.md"/);
  assert.match(html, /<a href="https:\/\/example\.org\/doc#find=the%20first%20words" data-link="1" style="color:#0070f3;[^"]*">a document link<\/a>/, 'the ordinary link as before');
  const { citationNumbers } = await citeModel();
  const given = inlineHtml(`Later ${AGAINST}`, { cites: citationNumbers([`${NOTE} ${PAPER}`, `${AGAINST}`]) });
  assert.match(given, /data-n="3"/, 'the answer\'s numbers when given');
  const folded = inlineHtml(`Claim ${NOTE} ${PAPER} ${AGAINST}.`);
  assert.match(folded, /^Claim <span data-cite-run="1"><a [^>]*data-n="1"[^>]*><\/a><span data-cite-more="1" data-n="…"[^>]*><\/span><span data-cite-rest="1"> <a [^>]*data-n="2"[^>]*><\/a> <a [^>]*data-n="3"[^>]*><\/a><\/span><\/span>\.$/);
  assert.match(inlineHtml(`x ${NOTE}`, { citeFocus: true, citeSource: () => 'Reading notes' }), /data-source="Reading notes"[^>]*tabindex="0"/);
  assert.match(inlineHtml('[You · Oct 1](/p/Agents/workspace.md#find=a%20b%20c&cite=you)'), /data-source="Agents"/, 'a workspace\'s document by the workspace');
});

test('the card a chip shows is the quote, then where and when it is from, an agent\'s words by name', async () => {
  const { citationCard, libraryName, CITE_CSS } = await citeModel();
  assert.match(CITE_CSS, /a\[data-cite\]::after\{content:attr\(data-n\)/, 'the circle shows its number');
  assert.doesNotMatch(CITE_CSS, /data-you\]\{border-color/, 'no darker ring for the person\'s own words');
  const el = { dataset: { cite: 'you', label: 'You · Oct 12', find: 'reading is slow', source: 'flow' } };
  assert.deepEqual(citationCard(el), { quote: 'reading is slow', lead: '', where: 'flow', when: 'Oct 12', counter: false });
  assert.deepEqual(citationCard({ dataset: { ...el.dataset, cite: 'other', label: 'Chat · Oct 12', counter: '1' } }), { quote: 'reading is slow', lead: 'Chat', where: 'flow', when: 'Oct 12', counter: true });
  assert.equal(citationCard({ dataset: { ...el.dataset, cite: 'other', label: 'Meeting · Oct 15', source: 'Standup' } }).lead, '', 'a meeting, a colleague: where it is from');
  assert.deepEqual(citationCard({ dataset: { cite: 'source', label: 'TutorTrace p. 6', find: 'x', source: 'TutorTrace' } }), { quote: 'x', lead: '', where: 'TutorTrace p. 6', when: '', counter: false });
  const { citationCardHtml } = await citeModel();
  const html = citationCardHtml(citationCard(el));
  assert.match(html, /“reading is slow”/);
  assert.match(html, /<\/span><span [^>]*><span[^>]*>flow<\/span> · Oct 12<\/span>/, 'where and when, no "You wrote this in"');
  assert.match(citationCardHtml(citationCard({ dataset: { ...el.dataset, cite: 'other', label: 'Chat · Oct 12' } })), />Chat · <span[^>]*>flow<\/span> · Oct 12/);
  const rows = [{ name: 'A paper', path: '/lib/a.pdf' }, { name: 'The page', url: 'https://www.example.org/x/' }, { name: 'Interviews', type: 'folder', path: '/lib/Interviews' }];
  assert.equal(libraryName(rows, '/lib/a.pdf'), 'A paper');
  assert.equal(libraryName(rows, 'https://example.org/x'), 'The page');
  assert.equal(libraryName(rows, '/lib/Interviews/p3.md'), 'Interviews / p3.md');
  assert.equal(libraryName(rows, '/elsewhere.md'), null);
});

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-cite-circles-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.js': 'jsx' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}

function mounted(DocEditor, lines) {
  const props = { docKey: 'k', text: lines.join('\n'), onChange: (next) => { props.text = next; } };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return editor;
}

test('an answer in the document numbers its circles across its lines, with or without the caret on one', async () => {
  const DocEditor = load('DocEditor.jsx').default;
  const { parseLine } = await docModel();
  const answer = `Reading slows when figures come late ${NOTE}.\n- Readers skim figures first ${PAPER}.\n- Not everyone agrees ${AGAINST}, though you said it again ${NOTE_AGAIN}.`;
  const lines = ['@bart how do people read papers?', ...replyLines(answer, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false }), ''];
  const editor = mounted(DocEditor, lines);
  try {
    const ls = editor.lines(), last = ls.findIndex((l) => l.includes('Not everyone agrees'));
    assert.ok(last > 0);
    for (const active of [false, true]) {
      const html = editor.lineHtml(last, ls[last], parseLine(ls[last]), active, false, editor.layout(ls).get(last), false);
      const ns = [...html.matchAll(/data-cite="\w+" data-n="(\d+)"/g)].map((m) => m[1]);
      assert.deepEqual(ns, ['3', '4'], `${active ? 'caret on it' : 'drawn'}: the answer's numbers, the note's other words the next`);
    }
    assert.ok(ls.some((l) => l.includes(NOTE_AGAIN)), 'the document keeps the whole link');
    const said = ls.findIndex((l) => l.includes('Readers skim'));
    ls[said] = ls[said].replace('figures first ', 'figures first: ');
    const drawn = editor.lineHtml(said, ls[said], parseLine(ls[said]), false, false, editor.layout(ls).get(said), false);
    assert.match(drawn, /figures first <a [^>]*data-cite/, 'drawn: the colon before the circle left out');
    assert.match(ls[said], /figures first: \[/, 'the document keeps it');
  } finally {
    delete globalThis.getSelection; delete globalThis.document; delete globalThis.window;
  }
});

test('a click on a folded run\'s "…" opens the run; any other click is left alone', async () => {
  const { openCitationRun } = await citeModel();
  const run = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const more = { dataset: { citeMore: '1' }, closest: (sel) => (sel === '[data-cite-run]' ? run : null) };
  assert.equal(openCitationRun({ closest: (sel) => (sel === '[data-cite-more]' ? more : null) }), true);
  assert.deepEqual(run.attrs, { 'data-open': '1' });
  assert.equal(openCitationRun({ closest: () => null }), false);
  assert.equal(openCitationRun({ closest: () => ({}) }), false, 'something that is no "…"');
  assert.equal(openCitationRun(null), false);
});

test('an answer still arriving shows no citation, and no link still being written at its end', async () => {
  const { streamingText } = await citeModel();
  assert.equal(streamingText(`We chose OpenAlex ${NOTE}. Then more.`), 'We chose OpenAlex. Then more.', 'a whole citation is left out');
  assert.equal(streamingText('Chosen [You · Oct 12](/a/b.md#find=papers (use openalex) and&cite=you).'), 'Chosen.', 'one the model left parentheses in too');
  assert.equal(streamingText('We chose OpenAlex [You · Oct 1'), 'We chose OpenAlex', 'a label still arriving');
  assert.equal(streamingText('We chose OpenAlex [You · Oct 12](/Users/me/x.md#find=I%20mean'), 'We chose OpenAlex', 'a target still arriving');
  assert.equal(streamingText(`Read ${PLAIN} and - [ ] this [aside] here.`), `Read ${PLAIN} and - [ ] this [aside] here.`, 'an ordinary link, a box and brackets stay');
});

test('an answer\'s sources: one a source, by the numbers quoting it and what it is, each number linking to its passage', async () => {
  const { citationSources, citationSourcesHtml } = await citeModel();
  const names = { '/Users/me/Meetings/Standup.md': 'Standup' };
  const sources = citationSources(`A ${NOTE} b ${PAPER} c ${NOTE_AGAIN} d ${AGAINST} e ${NOTE}.`, { citeSource: (address) => names[address] || null });
  assert.deepEqual(sources.map((s) => [s.name, s.passages.map((p) => p.n)]), [['My note.md', [1, 3]], ['example.org', [2]], ['Standup', [4]]], 'in the order first cited, the same source once');
  assert.match(sources[0].href, /find=reading%20is%20slow/, 'its first passage');
  assert.match(sources[0].passages[1].href, /find=figures%20first/, 'each number its own');
  const html = citationSourcesHtml(sources);
  assert.match(html, /^<div[^>]*>Sources<\/div>/);
  assert.equal((html.match(/data-cite-source="\d"/g) || []).length, 4);
  assert.match(html, /<div data-cite-row="1"><a href="[^"]*reading[^"]*" data-link="1" data-cite-source="1" data-n="1"[^>]*><\/a><a href="[^"]*figures%20first[^"]*" data-link="1" data-cite-source="3" data-n="3"[^>]*><\/a><a href="[^"]*reading[^"]*" data-link="1" data-cite-name="1"[^>]*>My note\.md<\/a><\/div>/);
  assert.match(html, /data-cite-source="4" data-n="4"[^>]*><\/a><a [^>]*data-cite-name="1"[^>]*>Standup<\/a>/);
  const { citationCard } = await citeModel();
  const attrs = (n) => Object.fromEntries([...html.match(new RegExp(`<a [^>]*data-cite-source="${n}"[^>]*>`))[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(([, k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
  assert.deepEqual(citationCard({ dataset: attrs(3) }), { quote: 'figures first then text', lead: '', where: 'My note.md', when: 'Oct 14', counter: false }, 'a number in the list has the card its circle has');
  assert.equal(citationCard({ dataset: attrs(4) }).counter, true);
  assert.equal(citationSourcesHtml(citationSources('No citations here.')), '', 'nothing for an answer that cites nothing');
});

test('a colon or dash right before a citation is left out where the circle is drawn', async () => {
  const { inlineHtml } = await docModel();
  const shown = (text) => inlineHtml(text).replace(/<a [^>]*data-cite[^>]*><\/a>/g, '①');
  assert.equal(shown(`They are your beliefs, not just "the process": ${NOTE}.`), 'They are your beliefs, not just &quot;the process&quot; ①.');
  assert.equal(shown(`The first step toward preservation — ${NOTE}.`), 'The first step toward preservation ①.');
  assert.equal(shown(`**It says**: ${NOTE}.`), '<strong style="font-weight:600">It says</strong> ①.', 'after bold too');
  assert.equal(shown(`Times like 10:30 matter ${NOTE}.`), 'Times like 10:30 matter ①.', 'a colon inside the words stays');
  assert.equal(shown(`\`a:\` ${NOTE}`).includes('a:'), true, 'code keeps its colon');
  assert.equal(shown('No citation here: just words.'), 'No citation here: just words.');
});

test('a whole source (2026-10-22): its own number beside its passages, a card with no quote, a row in Sources', async () => {
  const { citationNumbers, citationOf, citationPassage, citationHtml, citationSources, citationSourcesHtml, citationCardHtml } = await citeModel();
  const WHOLE = '[Welcome](/Users/me/Downloads/Welcome%20map.pdf#cite=source)';
  const PART = '[Welcome p. 2](/Users/me/Downloads/Welcome%20map.pdf#find=a%20map%20of%20beliefs&cite=source)';
  const text = `The demo is your project ${WHOLE}. It maps beliefs ${PART}, as said ${WHOLE}.`;
  const n = citationNumbers(text);
  assert.deepEqual([WHOLE, PART].map((l) => n.get(citationPassage(citationOf(l)))), [1, 2]);
  const html = citationHtml(citationOf(WHOLE), { cites: n });
  assert.match(html, /data-n="1"/);
  assert.match(html, /data-find=""/);
  assert.match(html, /The whole source/);
  const sources = citationSources(text, { cites: n });
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].passages.map((p) => [p.n, p.find]), [[1, ''], [2, 'a map of beliefs']]);
  assert.match(citationSourcesHtml(sources), /aria-label="1: Welcome map.pdf. The whole source"/);
  const card = citationCardHtml({ quote: '', lead: '', where: 'Welcome', when: '', counter: false });
  assert.doesNotMatch(card, /“/);
  assert.doesNotMatch(card, /border-top/, 'no divider under a quote that is not there');
  assert.match(citationCardHtml({ quote: 'a map', lead: '', where: 'Welcome', when: '', counter: false }), /border-top/);
});
