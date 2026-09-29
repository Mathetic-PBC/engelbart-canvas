'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

const CACHE_ENV = Object.freeze({
  npm_config_cache: '/home/user/.npm',
  npm_config_prefer_offline: 'true',
  PIP_CACHE_DIR: '/home/user/.cache/pip',
});
const TOOLS = '/opt/engelbart/cache-tools';
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function relative(value, allowRoot = false) {
  return typeof value === 'string' && ((allowRoot && value === '.')
    || /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value)
      && !value.split('/').some((part) => part === '.' || part === '..'));
}

function validateProfile(profile) {
  if (profile?.version !== 1 || !Array.isArray(profile.repositories) || !profile.repositories.length || profile.repositories.length > 10) throw new Error('Invalid cache profile');
  const seen = new Set();
  for (const repo of profile.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.name || '') || seen.has(repo.name) || !/^[a-f0-9]{40}$/.test(repo.commit || '')) throw new Error('Cache seeds must name unique repositories and immutable commits');
    seen.add(repo.name);
    if (!Array.isArray(repo.files) || !repo.files.length || repo.files.length > 30 || repo.files.some((file) => !relative(file)
      || !['package.json', 'package-lock.json', 'requirements.txt'].includes(path.posix.basename(file)))) throw new Error('Only dependency manifests and locks may enter the cache seed');
    if (!Array.isArray(repo.installs) || !repo.installs.length || repo.installs.length > 10) throw new Error('Missing cache install steps');
    for (const step of repo.installs) {
      if (!['npm', 'pip'].includes(step.manager) || !relative(step.cwd, true)) throw new Error('Invalid cache install step');
      const manifest = path.posix.join(step.cwd, step.manager === 'npm' ? 'package.json' : 'requirements.txt');
      if (!repo.files.includes(manifest)) throw new Error(`Missing seed manifest: ${manifest}`);
      if (step.manager === 'npm' && !repo.files.includes(path.posix.join(step.cwd, 'package-lock.json'))) throw new Error('npm cache seeds require a lockfile');
    }
  }
  return profile;
}

function seedCommand(step, wheels) {
  return step.manager === 'npm'
    ? ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']]
    : ['python3', ['-m', 'pip', 'wheel', '--disable-pip-version-check', '--wheel-dir', wheels, '-r', 'requirements.txt']];
}

function cacheTemplate(Template, base, profile) {
  validateProfile(profile);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_/:.-]*$/.test(base || '')) throw new Error('Invalid base template');
  return Template({ fileContextPath: __dirname })
    .fromTemplate(base)
    .copy('common.cjs', `${TOOLS}/common.cjs`, { user: 'root' })
    .copy('seed.cjs', `${TOOLS}/seed.cjs`, { user: 'root' })
    .copy('profile.json', `${TOOLS}/profile.json`, { user: 'root' })
    .setEnvs(CACHE_ENV)
    .setUser('user')
    .setWorkdir('/home/user')
    .runCmd(`node ${TOOLS}/seed.cjs`)
    // Template ENV applies only at build time. Persist this non-secret npm
    // preference for ordinary SDK commands in newly created sandboxes too.
    .runCmd('npm config set prefer-offline=true --location=user');
}

module.exports = { CACHE_ENV, TOOLS, hash, quote, validateProfile, seedCommand, cacheTemplate };
