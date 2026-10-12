'use strict';

// Connect your library's starting screen (2026-10-12): under the dots, a line that moves through what is happening (the
// jobs' labels) every 2.5 s, fading between them, with no fade under reduced motion; the count stays.
// src/renderer/model/connect.js startingLines, src/renderer/screens/ConnectLibrary.jsx CyclingLine, run here on a small
// stand-in for React's hooks and node:test's mock timers (there is no DOM in these tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { buildSync } = require('esbuild');

const load = (entry, name, shim = null) => {
  const filename = path.join(__dirname, name);
  const built = buildSync({ entryPoints: [path.join(__dirname, entry)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = function (id) { return id === 'react' && shim ? shim : Module.prototype.require.call(this, id); };
  const previousWindow = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(built.outputFiles[0].text, filename); }
  finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
  return compiled.exports;
};

const { startingLines, STARTING_LINE_MS } = load('../src/renderer/model/connect.js', '__connect-starting-model.cjs');

/** useState and useEffect for one component rendered by hand: render(props) → its element, effects run after each render. */
function hooks() {
  const states = [];
  const effects = [];
  let at = 0;
  const shim = {
    ...React,
    default: null,
    useState(init) { const n = at++; if (!(n in states)) states[n] = typeof init === 'function' ? init() : init; return [states[n], (value) => { states[n] = typeof value === 'function' ? value(states[n]) : value; }]; },
    useEffect(fn, deps) {
      const n = at++;
      const before = effects[n];
      if (before && deps && before.deps && deps.length === before.deps.length && deps.every((dep, k) => Object.is(dep, before.deps[k]))) return;
      if (before && typeof before.cleanup === 'function') before.cleanup();
      effects[n] = { deps, cleanup: fn() };
    },
  };
  shim.default = shim;
  return { shim, reset: () => { at = 0; } };
}

const jobs = [
  { kind: 'survey', label: 'Looking through ChatGPT', status: 'running' },
  { kind: 'recall', label: 'Asking Claude what it remembers', status: 'running' },
  { kind: 'survey', label: 'Looking for your Obsidian vaults', status: 'done' },
  { kind: 'survey', label: 'Looking through ChatGPT', status: 'queued' },
  { kind: 'memory', label: 'Writing MEMORY.md', status: 'running' },
];

test('the starting screen says what is happening: the labels of the jobs not yet done, once each; all of them once every job is done', () => {
  assert.deepEqual(startingLines(jobs), ['Looking through ChatGPT', 'Asking Claude what it remembers']);
  assert.deepEqual(startingLines(jobs.map((job) => ({ ...job, status: 'done' }))), ['Looking through ChatGPT', 'Asking Claude what it remembers', 'Looking for your Obsidian vaults']);
  assert.deepEqual(startingLines([]), []);
  assert.equal(STARTING_LINE_MS, 2500);
});

test('the line moves through the labels every 2.5 s, fading out and in; under reduced motion it changes with no fade', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { shim, reset } = hooks();
  const { CyclingLine } = load('../src/renderer/screens/ConnectLibrary.jsx', '__connect-starting.cjs', shim);
  const lines = ['Looking through ChatGPT', 'Asking Claude what it remembers', 'Looking for your Obsidian vaults'];
  const render = (props) => { reset(); return CyclingLine(props); };
  const seen = (element) => [element.props['data-connect-starting-line'], element.props.style.opacity];

  let element = render({ lines });
  assert.deepEqual(seen(element), ['Looking through ChatGPT', 1]);
  assert.match(element.props.style.transition, /^opacity 280ms/);
  t.mock.timers.tick(2499);
  assert.deepEqual(seen(render({ lines })), ['Looking through ChatGPT', 1], 'held for 2.5 s');
  t.mock.timers.tick(1);
  assert.deepEqual(seen(render({ lines })), ['Looking through ChatGPT', 0], 'fading out');
  t.mock.timers.tick(280);
  assert.deepEqual(seen(render({ lines })), ['Asking Claude what it remembers', 1], 'the next, fading in');
  const next = () => { t.mock.timers.tick(2220); t.mock.timers.tick(280); return seen(render({ lines })); }; // the fade starts in the first step
  assert.deepEqual(next(), ['Looking for your Obsidian vaults', 1]);
  assert.deepEqual(next(), ['Looking through ChatGPT', 1], 'round again');

  // Reduced motion: no transition, and the line changes at once.
  const still = hooks();
  const { CyclingLine: Still } = load('../src/renderer/screens/ConnectLibrary.jsx', '__connect-starting-still.cjs', still.shim);
  const quiet = (props) => { still.reset(); return Still(props); };
  element = quiet({ lines, reduced: true });
  assert.equal(element.props.style.transition, 'none');
  t.mock.timers.tick(2500);
  assert.deepEqual(seen(quiet({ lines, reduced: true })), ['Asking Claude what it remembers', 1], 'never at 0: no fade');

  // One line: shown, never moving; none: nothing.
  const one = hooks();
  const { CyclingLine: One } = load('../src/renderer/screens/ConnectLibrary.jsx', '__connect-starting-one.cjs', one.shim);
  t.mock.timers.tick(10_000);
  one.reset();
  assert.deepEqual(seen(One({ lines: ['Looking through ChatGPT'] })), ['Looking through ChatGPT', 1]);
  one.reset();
  assert.equal(One({ lines: [] }), null);
});
