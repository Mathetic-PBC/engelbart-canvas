'use strict';

// Bart remains read-only. Its interface proposal goes through the existing
// notification approval, then becomes a normal Hudson Build, never a second
// coding engine. Legacy local-app records and servers stay available unchanged.
const { randomUUID } = require('node:crypto');
const projects = require('../store/projects.cjs');
const { readQuestion, withChoice } = require('../bart/question.cjs');
const { normalizePlan } = require('../local-preview/plan.cjs');

function createInterfaceBuilds({ builds, legacy, planner, readModels, notify = () => {}, closePlanner = async () => {} }) {
  const proposals = new Map();
  const keyOf = (ctx, pid, wid) => `${ctx.dataRoot}:${pid}:${wid}`;
  const stopped = () => Object.assign(new Error('Stopped.'), { kind: 'stopped' });
  const publish = (held, patch) => {
    held.state = { ...held.state, ...patch, updatedAt: new Date().toISOString() };
    notify({ preview: { ...held.state }, dataRoot: held.ctx.dataRoot });
  };
  async function build(ctx, pid, input, { onProgress = () => {} } = {}) {
    const key = keyOf(ctx, pid, input.workspaceId);
    if (proposals.get(key)?.work) throw new Error('This workspace already has a build proposal waiting.');
    const { project, workspace } = projects.findWorkspace(ctx, pid, input.workspaceId);
    const pre = await builds.preflight(ctx, pid);
    if (!pre.ok) throw new Error(`${pre.problems[0].message} Open the workspace Build panel to set up its history.`);
    const controller = new AbortController();
    const held = { ctx, controller, approval: null, state: { id: `build-proposal:${pid}:${workspace.id}`, projectId: pid, workspaceId: workspace.id, directory: project.directory, workspaceName: workspace.name, name: workspace.name, askId: input.askId, runId: randomUUID(), status: 'planning', logs: [], url: null, startedAt: new Date().toISOString() } };
    proposals.set(key, held);
    const check = () => { if (controller.signal.aborted) throw stopped(); };
    const progress = update => { onProgress(update); if (update.activity) publish(held, { activity: update.activity }); };
    held.work = (async () => {
      publish(held, {});
      onProgress({ localBuild: { id: held.state.id }, lines: [], activity: 'Claude is preparing the build plan' });
      const plan = await planner(ctx, pid, input, { directory: project.directory, signal: controller.signal, onProgress: progress });
      check();
      const validated = { ...normalizePlan(plan), by: plan.by || 'Claude', model: plan.model || null };
      const approval = { id: randomUUID(), workspaceId: workspace.id, kind: 'build', message: validated.summary, detail: `Build in an isolated copy of ${project.directory}. Review and Accept before changes reach your code folder.`, label: 'Start Build' };
      let finish;
      const decision = new Promise(resolve => { finish = resolve; });
      held.approval = { id: approval.id, finish };
      const abort = () => finish(false);
      controller.signal.addEventListener('abort', abort, { once: true });
      publish(held, { name: validated.name, plan: validated, status: 'confirming', approval, activity: 'Waiting for your approval' });
      onProgress({ buildApproval: approval, activity: 'Waiting for your approval' });
      try { if (!(await decision)) throw stopped(); }
      finally { controller.signal.removeEventListener('abort', abort); held.approval = null; publish(held, { approval: null }); onProgress({ buildApproval: null }); }
      check();
      const models = readModels();
      const read = readQuestion(input.choice ? withChoice(input.text, models, input.choice) : input.text, models);
      const level = read.steps[0];
      const task = await builds.start(ctx, pid, {
        workspaceId: workspace.id, provider: read.provider, model: level.key, effort: level.effort,
        interfaceIntent: { request: input.buildRequest || read.question, plan: validated, turns: input.turns || [] },
      });
      publish(held, { status: 'handed-off', buildId: task.id, activity: 'Build started in its own worktree', askId: null });
      return { lines: [`build> ${task.id}`], build: task };
    })().catch(error => {
      publish(held, { status: controller.signal.aborted || error.kind === 'stopped' ? 'stopped' : 'failed', approval: null, error: error.kind === 'stopped' ? null : error.message, activity: '', askId: null });
      throw error;
    }).finally(() => { held.work = null; });
    return held.work;
  }
  return {
    ...legacy,
    build,
    get(ctx, pid, wid) { const held = proposals.get(keyOf(ctx, pid, wid)); return held?.work ? held.state : legacy.get(ctx, pid, wid) || held?.state || null; },
    async list(ctx) { return [...await legacy.list(ctx), ...[...proposals.values()].filter(held => held.ctx.dataRoot === ctx.dataRoot).map(held => ({ ...held.state }))]; },
    approve(ctx, pid, wid, id, value) {
      const held = proposals.get(keyOf(ctx, pid, wid));
      if (!held?.approval || held.approval.id !== id) return legacy.approve(ctx, pid, wid, id, value);
      if (typeof value !== 'boolean') throw new TypeError('Approval must be true or false.');
      const approval = held.approval;
      held.approval = null;
      approval.finish(value);
      return true;
    },
    stopAsk(id) { for (const held of proposals.values()) if (held.work && held.state.askId === id) { held.controller.abort(); return true; } return legacy.stopAsk(id); },
    async stop(ctx, pid, wid) {
      const held = proposals.get(keyOf(ctx, pid, wid));
      if (!held?.work) return legacy.stop(ctx, pid, wid);
      held.controller.abort(); await held.work.catch(() => {}); return held.state;
    },
    async close() {
      for (const held of proposals.values()) held.controller.abort();
      await Promise.all([...proposals.values()].map(held => held.work?.catch(() => {})));
      proposals.clear();
      await closePlanner();
      await legacy.close();
    },
  };
}

module.exports = { createInterfaceBuilds };
