'use strict';

// The screen before Connect your library (2026-10-11, David's mockup "All your context in one place"; MATH-142):
// src/renderer/screens/ConnectIntro.jsx, why Engelbart asks for the person's tools and where the data goes, its
// questions (the first open), the apps it works with, and the foot it shares with Connect's page.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '__connect-intro.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/screens/ConnectIntro.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: ConnectIntro, introLead, introQuestions, worksWith, INTRO_WIDTH } = compiled.exports;

test('the lead says project in a new user\'s flow and research in the guided setup, which has no project of theirs', () => {
  assert.equal(introLead(false), 'Bring in your work once, so you never have to re\u2011explain your project again.');
  assert.equal(introLead(true), 'Bring in your work once, so you never have to re\u2011explain your research again.');
});

test('three questions, the first open: where the data goes, whether anyone else sees it, taking things out', () => {
  assert.deepEqual(introQuestions().map((item) => item.q), ['Where does my data go?', 'Does anyone else see it?', 'Can I take things out later?']);
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.match(html, /<h1[^>]*>All your context in one place<\/h1>/);
  assert.match(html, /data-connect-intro-a="where"/, 'the first answer shows');
  assert.doesNotMatch(html, /data-connect-intro-a="(others|later)"/, 'the others are closed');
  assert.match(html, /It’s saved only on this Mac\./);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
});

test('"Works with": eight apps, each named once for screen readers, then a tile counting the rest; the foot has Skip for now and Continue', () => {
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.match(html, />Works with</);
  const named = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(named, ['Zotero', 'Overleaf', 'Obsidian', 'Google Drive', 'Granola', 'Claude', 'Codex', 'GitHub']);
  const { shown, more } = worksWith();
  assert.equal(shown.length, 8);
  assert.ok(more > 0);
  assert.match(html, new RegExp(`<button[^>]*data-connect-intro-more="1"[^>]*>\\+${more}<`), 'a button: pressed, it shows the rest');
  assert.match(html, /data-connect-intro-tiles="some"/);
  assert.doesNotMatch(html, /cx-belt|@keyframes/, 'no moving belt');
  assert.match(html, /data-onboarding-skip="1"[^>]*>Skip for now</);
  assert.match(html, /data-onboarding-continue="1"><button[^>]*>Continue/);
});

test('drawn to the K6 design: a 640px column, the heading at 34px, the questions in a card of 16px rows', () => {
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.equal(INTRO_WIDTH, 640);
  assert.match(html, /width:min\(640px, 100%\)/);
  assert.match(html, /<h1 style="[^"]*font:500 34px\/1.2/);
  assert.match(html, /data-connect-intro-card="1" style="[^"]*border:1px solid #eaeaea;border-radius:14px/);
  assert.match(html, /\.cx-faq\{[^}]*padding:20px 0;[^}]*font:500 16px/);
});
