'use strict';

// The organizations the person works in (src/main/github/orgs.cjs, MATH-111): the owners of this Mac's GitHub remotes,
// and which of them the App is not installed on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { remoteOwner, remoteUrls, macOrgs, missingOrgs, installUrlFor } = require('../src/main/github/orgs.cjs');

function repo(root, name, config) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), config);
  return dir;
}
const remote = (name, url) => `[remote "${name}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`;

test('remoteOwner: https, git@, ssh:// and git:// on github.com; any other host or a malformed one is nobody', () => {
  assert.equal(remoteOwner('https://github.com/Lab-A/tutor.git'), 'Lab-A');
  assert.equal(remoteOwner('https://user@github.com/lab-a/tutor'), 'lab-a');
  assert.equal(remoteOwner('git@github.com:lab-b/agents.git'), 'lab-b');
  assert.equal(remoteOwner('ssh://git@github.com/lab-c/x.git'), 'lab-c');
  assert.equal(remoteOwner('git://github.com/lab-d/x'), 'lab-d');
  assert.equal(remoteOwner('https://www.github.com/lab-e/x'), 'lab-e');
  assert.equal(remoteOwner('https://gitlab.com/lab-a/tutor.git'), null);
  assert.equal(remoteOwner('git@bitbucket.org:lab-a/tutor.git'), null);
  assert.equal(remoteOwner('https://github.com/lab-a'), null, 'an owner alone is not a repository');
  assert.equal(remoteOwner('/Users/me/elsewhere/repo'), null);
  assert.equal(remoteOwner('https://github.com/-bad/x'), null);
  assert.deepEqual(remoteUrls(`[core]\n\turl = https://github.com/no/thanks\n${remote('origin', 'git@github.com:a/b.git')}[branch "main"]\n\tremote = origin\n[remote "up"]\n\tpushurl = "https://github.com/c/d"\n`), ['git@github.com:a/b.git', 'https://github.com/c/d']);
});

test('macOrgs: each owner once with its repositories, the person\'s own login and other hosts left out; a worktree reads its main config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-orgs-'));
  const a1 = repo(root, 'a1', remote('origin', 'https://github.com/lab-a/tutor.git'));
  const a2 = repo(root, 'a2', remote('origin', 'git@github.com:LAB-A/agents.git') + remote('fork', 'git@github.com:Hudsonmp/agents.git'));
  const b = repo(root, 'b', remote('origin', 'git@github.com:lab-b/study.git'));
  const mine = repo(root, 'mine', remote('origin', 'https://github.com/hudsonmp/site'));
  const gitlab = repo(root, 'gl', remote('origin', 'https://gitlab.com/lab-z/x.git'));
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(path.join(a1, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(a1, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(a1, '.git', 'worktrees', 'wt')}\n`);
  const found = macOrgs([a1, a2, b, mine, gitlab, worktree, a1, path.join(root, 'nothing')], { login: 'HudsonMP' });
  assert.deepEqual(found, [{ login: 'lab-a', repos: [a1, a2, worktree] }, { login: 'lab-b', repos: [b] }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('missingOrgs: GitHub\'s and the Mac\'s, less the installed and the person, case-insensitively, each with its install page', () => {
  const base = 'https://github.com/apps/engelbart/installations/new';
  const found = missingOrgs({
    accounts: [{ login: 'Lab-A' }],
    fromGithub: [{ login: 'LAB-B', id: 22 }, { login: 'lab-c', id: 33 }, { login: 'lab-a', id: 11 }],
    fromMac: [{ login: 'lab-a', repos: ['/r/a'] }, { login: 'lab-b', repos: ['/r/b1', '/r/b2'] }, { login: 'hudsonmp', repos: ['/r/me'] }, { login: 'lab-d', repos: ['/r/d'] }],
    login: 'HudsonMP',
    base,
    ids: new Map([['lab-d', '44']]),
  });
  assert.deepEqual(found, [
    { login: 'LAB-B', id: '22', repos: ['/r/b1', '/r/b2'], installUrl: `${base}/permissions?target_id=22` },
    { login: 'lab-c', id: '33', repos: [], installUrl: `${base}/permissions?target_id=33` },
    { login: 'lab-d', id: '44', repos: ['/r/d'], installUrl: `${base}/permissions?target_id=44` },
  ]);
  assert.equal(installUrlFor(base, null), base, 'without an id, the page that lets them pick');
});
