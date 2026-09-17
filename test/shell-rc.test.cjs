'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareZshDir, environmentWithHiddenPrompt } = require('../src/main/shell-rc.cjs');
const { sanitizeEnvironment } = require('../src/main/terminal/launch.cjs');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-zsh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('prepareZshDir writes the wrappers once and the environment carries ZDOTDIR through sanitising', (t) => {
  const userData = temporaryDirectory(t);
  const dir = prepareZshDir(userData);
  assert.equal(dir, path.join(userData, 'zsh'));
  for (const name of ['.zshenv', '.zprofile', '.zshrc']) assert.ok(fs.existsSync(path.join(dir, name)), name);
  const rc = fs.readFileSync(path.join(dir, '.zshrc'), 'utf8');
  assert.match(rc, /source "\$ZDOTDIR\/\.zshrc"/);
  assert.match(rc, /precmd_functions\+=\(engelbart_hide_prompt\)/);
  const before = fs.statSync(path.join(dir, '.zshrc')).mtimeMs;
  prepareZshDir(userData);
  assert.equal(fs.statSync(path.join(dir, '.zshrc')).mtimeMs, before, 'unchanged files are not rewritten');
  const env = sanitizeEnvironment(environmentWithHiddenPrompt({ PATH: '/usr/bin', HOME: '/tmp/x' }, userData));
  assert.equal(env.ZDOTDIR, dir);
});

test('zsh runs the user rc files and ends with an empty prompt, even when their precmd sets one', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const userData = temporaryDirectory(t);
  const home = temporaryDirectory(t);
  fs.writeFileSync(path.join(home, '.zshenv'), 'export FROM_ZSHENV=1\n');
  fs.writeFileSync(path.join(home, '.zprofile'), 'export FROM_ZPROFILE=1\n');
  fs.writeFileSync(path.join(home, '.zshrc'), "export FROM_ZSHRC=1\nPROMPT='user> '\nRPROMPT='right'\nmy_prompt() { PROMPT='again> ' }\nprecmd_functions+=(my_prompt)\n");
  const dir = prepareZshDir(userData);
  const script = 'for f in $precmd_functions; do $f; done; print -r -- "env=$FROM_ZSHENV$FROM_ZPROFILE$FROM_ZSHRC prompt=[$PROMPT] rprompt=[$RPROMPT] zdotdir=[$ZDOTDIR]"';
  const result = spawnSync('/bin/zsh', ['-ilc', script], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', ZDOTDIR: dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /env=111 prompt=\[\] rprompt=\[\] zdotdir=\[.*\]/);
  assert.ok(result.stdout.includes(`zdotdir=[${home}]`), `children see the user directory again: ${result.stdout}`);
});
