'use strict';

// Paths, not the currently selected project/repository, define dependencies.
// Repository operations also depend on descendants (Git metadata/worktrees);
// independent terminal directories only depend on the folder they run in.
function affectedBy({ projectId, roots = [], workspaceIds = [] }, activity) {
  const { contains } = require('./workspace-repositories.cjs');
  if (activity.projectId === projectId && (activity.unscoped || workspaceIds.includes(activity.workspaceId))) return true;
  return (activity.paths || []).some(file => file && roots.some(root => contains(root, file)))
    || (activity.repositories || []).some(dir => dir && roots.some(root => contains(root, dir) || contains(dir, root)));
}

function busyReason(scope, { terminals = [], previews = [], builds = null } = {}) {
  if (terminals.some(session => ['running', 'starting', 'closing'].includes(session.status) && affectedBy(scope, { paths: [session.cwd] }))) return 'Close terminals and coding agents using this folder before moving it.';
  if (previews.some(row => ['planning', 'confirming', 'building', 'installing', 'starting', 'checking', 'repairing', 'ready'].includes(row.status) && affectedBy(scope, { projectId: row.projectId, workspaceId: row.workspaceId, repositories: [row.directory] }))) return 'Stop the local interface preview before moving its repository.';
  if (builds?.busy(scope.projectId, scope.roots, scope.workspaceIds)) return 'Stop Build work and previews before moving this folder.';
  return null;
}

module.exports = { affectedBy, busyReason };
