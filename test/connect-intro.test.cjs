'use strict';

// The screen before Connect your library (2026-10-11, David's mockup "All your context in one place"; MATH-142):
// src/renderer/screens/ConnectIntro.jsx, why Engelbart asks for the person's tools and where the data goes, its
// questions (the first open), the belt of apps, and the foot it shares with Connect's page.

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
const { default: ConnectIntro, introLead, introQuestions } = compiled.exports;

test('the lead says project in a new user\'s flow and research in the guided setup, which has no project of theirs', () => {
  assert.equal(introLead(false), 'Next, connect the tools you use. Engelbart brings what’s related to your project into one place, so it can connect the dots across all of it.');
  assert.match(introLead(true), /related to your research into one place/);
});

test('three questions, the first open: where the data goes, whether Mathetic sees it, taking things out', () => {
  assert.deepEqual(introQuestions().map((item) => item.q), ['Where does my data go?', 'Does Mathetic see any of it?', 'Can I take things out later?']);
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.match(html, /<h1[^>]*>All your context in one place<\/h1>/);
  assert.match(html, /data-connect-intro-a="where"/, 'the first answer shows');
  assert.doesNotMatch(html, /data-connect-intro-a="(mathetic|later)"/, 'the others are closed');
  assert.match(html, /It’s saved only on this Mac\./);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
});

test('the belt names each app once for screen readers, and runs twice so it loops; the foot has Skip for now and Continue', () => {
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.match(html, /Connects to/);
  const named = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(named.includes('Google Drive') && named.includes('GitHub') && named.includes('Zotero'), named.join(', '));
  assert.equal(new Set(named).size, named.length, 'each named once');
  assert.equal((html.match(/role="img"/g) || []).length, named.length * 2, 'the list twice');
  assert.match(html, /prefers-reduced-motion: reduce\)\{\.cx-belt\{animation:none\}/, 'still with reduced motion');
  assert.match(html, /data-onboarding-skip="1"[^>]*>Skip for now</);
  assert.match(html, /data-onboarding-continue="1"><button[^>]*>Continue/);
});

test('the block sits in the middle of the window\'s height, with more room between the lead, the questions and the belt (2026-10-12)', () => {
  const html = renderToStaticMarkup(React.createElement(ConnectIntro, { onContinue() {}, onSkip() {} }));
  assert.match(html, /data-connect-intro-scroll="1" style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column/);
  assert.match(html, /data-connect-intro-block="1" style="margin:auto 0;display:flex;flex-direction:column;gap:44px"/, 'centered by its auto margins while it fits; at the top, scrolling, when it does not');
  assert.ok(html.indexOf('data-connect-intro-block') < html.indexOf('data-connect-foot'), 'the foot outside it, where it was');
});
