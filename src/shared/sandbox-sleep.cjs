'use strict';
// A ready E2B preview sleeps instead of ending (src/main/sandbox/worker.cjs), and stays asleep until a request wakes it.
// One nobody has opened for EXPIRE_MS is ended by the manager's sweep, which marks the end in its log so that clicking
// the repository builds it again instead of showing the stopped build (model/sandbox-notifications.js's repositoryClick),
// and so that a new session's automatic preparation leaves it alone (manager.cjs's start).
const EXPIRE_MS = 7 * 24 * 60 * 60_000;
const EXPIRED = 'expired';

const expiredRun = (run) => run?.status === 'stopped' && Array.isArray(run.build_log) && run.build_log.some((entry) => entry?.data?.lifecycle === EXPIRED);

module.exports = { EXPIRE_MS, EXPIRED, expiredRun };
