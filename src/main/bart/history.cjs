'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { readJson, writeJson } = require('../store/home.cjs');
const projects = require('../store/projects.cjs');

// Durable provenance, not the rebuildable context catalog or an agent's expiring
// resume cache. Answers still live in their original documents/archives.
function filename(ctx, pid, askId) {
  if (!/^[\w-]{1,64}$/.test(askId)) throw new Error('Invalid question ID.');
  return path.join(projects.findProject(ctx, pid).dir, '.bart', 'questions', `${askId}.json`);
}
function snapshot(repo) {
  return { repoId: repo.repoId, libraryId: repo.libraryId, name: repo.name, directory: repo.directory, inherited: repo.inherited, defaultRepoId: repo.defaultRepoId || null };
}
function begin(ctx, pid, input, repo) {
  const file = filename(ctx, pid, input.askId), previous = readJson(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (previous && previous.repository.repoId !== repo.repoId) throw new Error('This question already started in another repository. Send a new question to use the new connection.');
  const record = previous || { version: 1, askId: input.askId, projectId: pid, workspaceId: input.workspaceId, ref: input.ref, questionHash: createHash('sha256').update(input.text).digest('hex'), repository: snapshot(repo), startedAt: new Date().toISOString() };
  writeJson(file, { ...record, status: 'running' });
  return record.repository;
}
function finish(ctx, pid, askId, status) {
  const file = filename(ctx, pid, askId), record = readJson(file);
  if (record) writeJson(file, { ...record, status, finishedAt: new Date().toISOString() });
}
module.exports = { begin, finish, snapshot };
