'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { missingModules } = require('../scripts/check-app-modules.cjs');

/** An app as { 'dir/package.json': {...} }: every folder above a package.json exists. */
function app(packages) {
  const dirs = new Map([['', new Set()]]);
  for (const file of Object.keys(packages)) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      const parent = path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir);
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent).add(path.posix.basename(dir));
    }
  }
  return {
    list: (dir) => (dirs.has(dir) ? [...dirs.get(dir)] : null),
    readJson: (file) => packages[file] ?? null,
    bundled: (name) => name === 'react',
  };
}

const root = { dependencies: { e2b: '2.49.1', react: '19.3.0' } };

test('check-app-modules: hoisted and nested dependencies both resolve', () => {
  assert.deepEqual(missingModules(app({
    'package.json': root,
    'node_modules/e2b/package.json': { dependencies: { chalk: '^5', 'openapi-fetch': '^0.14' } },
    'node_modules/e2b/node_modules/chalk/package.json': {},
    'node_modules/openapi-fetch/package.json': { dependencies: { 'openapi-typescript-helpers': '*' } },
    'node_modules/openapi-typescript-helpers/package.json': {},
  })), []);
});

test('check-app-modules: release 0.1.2, with only what npm had nested inside each package', () => {
  assert.deepEqual(missingModules(app({
    'package.json': root,
    'node_modules/e2b/package.json': { dependencies: { chalk: '^5', 'openapi-fetch': '^0.14' } },
    'node_modules/chalk/package.json': {},
  })), ['e2b → openapi-fetch']);
});

test('check-app-modules: a missing top-level package, a bundled one and an optional one', () => {
  assert.deepEqual(missingModules(app({ 'package.json': root })), ['package.json → e2b']);
  assert.deepEqual(missingModules(app({
    'package.json': { dependencies: { 'pdfjs-dist': '6' } },
    'node_modules/pdfjs-dist/package.json': { optionalDependencies: { '@napi-rs/canvas': '^1' } },
  })), []);
});

test('check-app-modules: a scoped package finds its dependency at the top', () => {
  assert.deepEqual(missingModules(app({
    'package.json': { dependencies: { '@modelcontextprotocol/sdk': '1' } },
    'node_modules/@modelcontextprotocol/sdk/package.json': { dependencies: { ajv: '8' } },
    'node_modules/ajv/package.json': {},
  })), []);
});
