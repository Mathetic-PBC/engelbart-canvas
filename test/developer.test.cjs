'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BUILD_FILE, hasTestMode } = require('../src/main/developer.cjs');

test('test mode: always from a checkout; in a package only when it was a developer build (2026-09-28)', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-dist-'));
  const write = (text) => fs.writeFileSync(path.join(dist, BUILD_FILE), text);
  assert.equal(hasTestMode({ packaged: false, distDir: dist }), true, '`npm start`, `electron .`');
  assert.equal(hasTestMode({ packaged: true, distDir: dist }), false, 'a package with no build.json');
  write('{"developer":false}\n');
  assert.equal(hasTestMode({ packaged: true, distDir: dist }), false, 'what ships');
  write('{"developer":true}\n');
  assert.equal(hasTestMode({ packaged: true, distDir: dist }), true, '`npm run relaunch`');
  write('{"developer":"true"}\n');
  assert.equal(hasTestMode({ packaged: true, distDir: dist }), false, 'only true itself');
  write('{"developer":tr');
  assert.equal(hasTestMode({ packaged: true, distDir: dist }), false, 'unreadable');
  // ENGELBART_TEST_MODE=off: a developer's copy as it ships (`npm run new-mac`); nothing else in it counts.
  assert.equal(hasTestMode({ packaged: false, distDir: dist, env: { ENGELBART_TEST_MODE: 'off' } }), false);
  write('{"developer":true}\n');
  assert.equal(hasTestMode({ packaged: true, distDir: dist, env: { ENGELBART_TEST_MODE: 'off' } }), false);
  write('{"developer":false}\n');
  assert.equal(hasTestMode({ packaged: true, distDir: dist, env: { ENGELBART_TEST_MODE: 'on' } }), false);
});
