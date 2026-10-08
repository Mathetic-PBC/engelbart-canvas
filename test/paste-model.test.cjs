'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/paste.js')).href);

test('text copied from a PDF loses the page\'s layout: lines join, split words mend, ligatures and page numbers go (MATH-24)', async () => {
  const { pdfText } = await load();
  const copied = [
    'Large language models have shown remarkable abil-',
    'ities in a wide range of tasks, including the de-',
    'sign of experiments and the analysis of their re-',
    'sults. We study how ﬁne-tuning affects this.',
    '12',
    'In this paper we propose a method for the evalu-',
    'ation of such systems.',
  ].join('\n');
  assert.equal(pdfText(copied), 'Large language models have shown remarkable abilities in a wide range of tasks, including the design of experiments and the analysis of their results. We study how fine-tuning affects this. In this paper we propose a method for the evaluation of such systems.');
  assert.equal(pdfText('a self-\nSupervised approach that works across a great many different settings and across tasks'), 'a self-Supervised approach that works across a great many different settings and across tasks', 'a capital after the hyphen keeps it');
});

test('paragraphs and items keep their own lines; a short line that ends a sentence ends its paragraph', async () => {
  const { pdfText } = await load();
  assert.equal(pdfText('Introduction to the method that we developed over the course\nof three years of careful experimentation in the lab.\nShort final line.\nThe next paragraph begins here and continues on to\nthe following line without any break in the sentence.'),
    'Introduction to the method that we developed over the course of three years of careful experimentation in the lab. Short final line.\nThe next paragraph begins here and continues on to the following line without any break in the sentence.');
  assert.equal(pdfText('The first paragraph of the paper starts here and runs\non to a second line of the column.\n\nThe second paragraph also runs over two lines of\nthe same column on this page.'),
    'The first paragraph of the paper starts here and runs on to a second line of the column.\n\nThe second paragraph also runs over two lines of the same column on this page.');
  assert.equal(pdfText('The results are summarised in three main points that we\ndiscuss in turn below, each with its own section:\n1. the first point is about the data that we collected\n2. the second point is about the model we trained on it'),
    'The results are summarised in three main points that we discuss in turn below, each with its own section:\n1. the first point is about the data that we collected\n2. the second point is about the model we trained on it');
});

test('text that is not hard-wrapped keeps its line breaks', async () => {
  const { pdfText } = await load();
  for (const kept of ['apples\nbananas\npears', 'function f() {\n    return 1;\n    }', 'Line one ends here.\nLine two ends here.\nLine three ends here as well.', '```\nsome code that goes on and on and on and on\nand more code here too that is long\n```', 'one line alone'])
    assert.equal(pdfText(kept), kept);
  assert.equal(pdfText('eﬃcient and­soft'), 'efficient andsoft', 'ligatures, odd spaces and soft hyphens are cleaned even in one line');
});
