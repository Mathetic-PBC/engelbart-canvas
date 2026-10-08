'use strict';

// scripts/check-app-modules.cjs: a packaged app's app.asar holds every package its main process needs (2026-09-30,
// after 0.1.2 shipped without 35 of them).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAppModules, assertAppModules } = require('../scripts/check-app-modules.cjs');

const asar = require(require.resolve('@electron/asar', { paths: [path.dirname(require.resolve('app-builder-lib'))] }));

/** An Engelbart.app whose app.asar holds `files` ({ 'node_modules/x/package.json': {...} }) → its path */
async function appWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-asar-'));
  const src = path.join(dir, 'src');
  for (const [file, json] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    fs.writeFileSync(path.join(src, file), JSON.stringify(json));
  }
  const app = path.join(dir, 'Engelbart.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  await asar.createPackage(src, path.join(app, 'Contents', 'Resources', 'app.asar'));
  return app;
}
const asarOf = (app) => path.join(app, 'Contents', 'Resources', 'app.asar');

test('a complete app passes: hoisted packages, a nested one taking precedence, renderer packages and optional ones skipped', async () => {
  const app = await appWith({
    'package.json': { dependencies: { e2b: '1', react: '19', '@xterm/xterm': '6' } },
    'node_modules/e2b/package.json': { dependencies: { 'openapi-fetch': '1', chalk: '5' }, optionalDependencies: { nothere: '1' } },
    'node_modules/e2b/node_modules/chalk/package.json': {},
    'node_modules/openapi-fetch/package.json': { dependencies: { 'openapi-typescript-helpers': '1' } },
    'node_modules/openapi-typescript-helpers/package.json': {},
  });
  const { checked, missing } = checkAppModules(asarOf(app));
  assert.deepEqual(missing, []);
  assert.equal(checked, 4);
  assert.equal(assertAppModules(app), 4);
});

test('0.1.2\'s layout fails: the top-level packages and what was nested in them, nothing npm hoisted', async () => {
  const app = await appWith({
    'package.json': { dependencies: { e2b: '1', 'electron-updater': '6' } },
    'node_modules/e2b/package.json': { dependencies: { 'openapi-fetch': '1', chalk: '5' } },
    'node_modules/e2b/node_modules/chalk/package.json': {},
    'node_modules/electron-updater/package.json': { dependencies: { 'fs-extra': '10' } },
  });
  const { missing } = checkAppModules(asarOf(app));
  assert.deepEqual(missing.map((item) => item.chain.join(' → ')).sort(), ['e2b → openapi-fetch', 'electron-updater → fs-extra']);
  assert.throws(() => assertAppModules(app, 'The arm64 app'), /The arm64 app is missing 2 packages it needs:\n {2}openapi-fetch {2}\(e2b → openapi-fetch\)/);
});

test('a package nested under another is not found from a third (Node would not find it either)', async () => {
  const app = await appWith({
    'package.json': { dependencies: { a: '1', b: '1' } },
    'node_modules/a/package.json': {},
    'node_modules/a/node_modules/shared/package.json': {},
    'node_modules/b/package.json': { dependencies: { shared: '1' } },
  });
  assert.deepEqual(checkAppModules(asarOf(app)).missing.map((item) => item.chain.join(' → ')), ['b → shared']);
});
