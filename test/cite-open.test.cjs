'use strict';

// Where a citation of the person's own thinking opens (src/renderer/model/cite-open.js, 2026-10-21): a workspace's
// document or a note goes beside the document in front, at the line the quoted words start on; anything else a
// citation names goes to the Stage as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { citeHref } = require('../src/shared/passage-link.cjs');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/cite-open.js')).href);

const PROJECT = '/Users/me/.engelbart/engelbart';
const index = (() => {
  const onboarding = { id: 'w1', name: 'Onboarding', folder: 'Onboarding' };
  const day = { id: 'w2', name: 'Oct 12', folder: 'oct-12' };
  const odd = { id: 'w3', name: 'Notes (old)', folder: 'Notes (old)' };
  return new Map([['w1', { node: onboarding, parent: null }], ['w2', { node: day, parent: onboarding }], ['w3', { node: odd, parent: null }]]);
})();
const notes = [{ id: 'n1', name: 'Hints', path: `${PROJECT}/Hints.md` }];
const where = { projectDir: PROJECT, index, notes };

test('citedDoc: a workspace\'s document, nested or with parentheses in its folder, and a note open in the middle column', async () => {
  const { citedDoc } = await model();
  const href = (address, cite = 'you') => citeHref({ address, find: 'ask about the project first', cite });
  assert.deepEqual(citedDoc(href(`${PROJECT}/Onboarding/oct-12/workspace.md`), where), { kind: 'workspace', id: 'w2', name: 'Oct 12', find: 'ask about the project first', cite: 'you' });
  assert.equal(citedDoc(href(`${PROJECT}/Onboarding/workspace.md`), where).id, 'w1');
  assert.equal(citedDoc(href(`${PROJECT}/Notes (old)/workspace.md`), where).id, 'w3');
  assert.deepEqual(citedDoc(href(`${PROJECT}/Hints.md`, 'other'), where), { kind: 'note', id: 'n1', name: 'Hints', find: 'ask about the project first', cite: 'other' });
});

test('citedDoc: a paper, a page, another project\'s workspace, a plain #find= link and a mention stay with the Stage', async () => {
  const { citedDoc } = await model();
  assert.equal(citedDoc(citeHref({ address: '/Users/me/Papers/TutorTrace.pdf', find: 'learners who waited', cite: 'source' }), where), null);
  assert.equal(citedDoc(citeHref({ address: 'https://example.org/struggle', find: 'productive struggle', cite: 'source' }), where), null);
  assert.equal(citedDoc(citeHref({ address: '/Users/me/.engelbart/other/Theirs/workspace.md', find: 'their words', cite: 'you' }), where), null);
  assert.equal(citedDoc(`${PROJECT}/Hints.md#find=ask%20about`, where), null, 'not a citation');
  assert.equal(citedDoc('https://example.org', where), null);
});

test('passageLine: the line the words start on, prefixes and marks let go; the person\'s own line first for their words', async () => {
  const { passageLine } = await model();
  const lines = [
    '@bart what should the first build be?',
    'bart+> Build: **Ask about the project** before Connect your library.',
    '@bart --build Ask about the project before Connect your library.',
    'And the previews should sleep, not be',
    'deleted when nobody uses them.',
  ];
  assert.equal(passageLine(lines, 'Ask about the project before Connect your library', 'you'), 2, 'the person repeated it: their line');
  assert.equal(passageLine(lines, 'Ask about the project before Connect your library', 'other'), 1, 'someone else\'s words: the answer line');
  assert.equal(passageLine(lines, 'what should the first build be', 'you'), 0, 'a question, its @bart let go');
  assert.equal(passageLine(lines, 'previews should sleep, not be deleted', 'you'), 3, 'across two lines: where it starts');
  assert.equal(passageLine(lines, 'words that are nowhere here', 'you'), -1);
});
