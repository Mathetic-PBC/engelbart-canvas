'use strict';

// Version numbers as the three programs print them, and whether one is good enough (design D7).

const { REQUIREMENTS } = require('./requirements.cjs');

const LOOSE = /(?:^|[^\d.])(\d+)\.(\d+)(?:\.(\d+))?(?![\d.]*\d)/;

/** 'x.y.z' from what `--version` printed (the program's own pattern first, then any number that looks like one), or null. */
function parseVersion(text, name = null) {
  const output = String(text || '');
  const own = name && REQUIREMENTS[name] ? REQUIREMENTS[name].version.exec(output) : null;
  const found = own ? LOOSE.exec(` ${own[1]}`) : LOOSE.exec(output);
  if (!found) return null;
  return `${Number(found[1])}.${Number(found[2])}.${Number(found[3] || 0)}`;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const isVersion = (value) => typeof value === 'string' && VERSION_RE.test(value);

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * How a version stands against a tool's requirement.
 * → { status: 'ready' | 'outdated' | 'incompatible' | 'unknown', untested, why }
 * 'unknown' when the version could not be read: nothing can be said, so nothing is updated either.
 */
function judge(name, version, requirement = REQUIREMENTS[name]) {
  if (!isVersion(version)) return { status: 'unknown', untested: false, why: null };
  if (compareVersions(version, requirement.minimum) < 0) return { status: 'outdated', untested: false, why: `${requirement.name} ${version} is older than ${requirement.minimum}.` };
  const bad = requirement.incompatible.find((range) => compareVersions(version, range.from) >= 0 && compareVersions(version, range.to) < 0);
  if (bad) return { status: 'incompatible', untested: false, why: bad.why };
  return { status: 'ready', untested: Number(version.split('.')[0]) > requirement.testedMajor, why: null };
}

module.exports = { parseVersion, compareVersions, isVersion, judge };
