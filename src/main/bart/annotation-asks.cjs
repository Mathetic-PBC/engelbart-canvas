'use strict';

const annotations = require('../store/interface-annotations.cjs');
const projects = require('../store/projects.cjs');
const { failureLines } = require('./reply.cjs');

// Main owns these runs. Streaming state is transient and scoped to the exact
// annotation + ask, but can be recovered when its popup mounts again.
function createAnnotationAsks({ bart, notify, readPageContext = async () => ({ status: 'unavailable', reason: 'The annotated tab is not available.' }) }) {
  const running = new Map();
  const track = fn => { try { fn(); notify('engelbart:nav', {}); } catch { /* bookkeeping only */ } };
  const get = (projectId, annotationId, askId) => {
    const run = running.get(askId);
    return run?.projectId === projectId && run?.annotationId === annotationId ? run.progress : null;
  };
  function start(ctx, projectId, workspaceId, note, tabId) {
    const askId = note.reply.askId, ref = { kind: 'workspace', workspaceId };
    const run = { projectId, annotationId: note.id, stopped: false, sequence: 0, progress: null };
    running.set(askId, run);
    const progress = update => {
      if (run.stopped) return;
      run.progress = { ...run.progress, ...(update.step ? { lines: [], activity: '' } : {}), ...update,
        askId, projectId, annotationId: note.id, sequence: ++run.sequence };
      notify('engelbart:bart-progress', run.progress);
    };
    progress({ activity: 'Reading selected element…', lines: [] });
    track(() => projects.agentStarted(ctx, { id: askId, kind: 'bart', projectId, workspaceId, doc: ref }));
    run.done = (async () => {
      let result;
      try {
        let page;
        try { page = await readPageContext(tabId, note); }
        catch { page = { status: 'unavailable', reason: 'The live page could not be inspected.' }; }
        if (run.stopped) result = { stopped: true };
        else {
          progress({ activity: page?.status === 'available' ? 'Thinking about this element…' : 'Using the saved annotation…' });
          result = await bart.ask(ctx, projectId, {
            askId, workspaceId, ref, text: note.reply.question,
            turns: (note.replyHistory || []).filter(reply => reply.status === 'complete' && reply.text).map(reply => ({ question: reply.question, answer: reply.text })),
            annotation: { id: note.id, url: note.url, anchor: note.anchor, page },
          }, { onProgress: progress });
          if (run.stopped) result = { stopped: true };
        }
      } catch (error) { result = error.kind === 'stopped' || run.stopped ? { stopped: true } : { failed: true, lines: failureLines(error.message) }; }
      try { await annotations.finishReply(ctx, { projectId }, note.id, askId, result); }
      catch (error) { console.warn('Could not save annotation reply:', error.message); }
      finally {
        track(() => result.stopped ? projects.agentStopped(ctx, askId) : projects.agentFinished(ctx, askId));
        running.delete(askId);
        notify('engelbart:library-changed', {});
      }
    })();
  }
  function stop(askId) {
    const run = running.get(askId);
    if (!run) return false;
    run.stopped = true; bart.stop(askId); return true;
  }
  async function stopAll() {
    const runs = [...running];
    for (const [askId] of runs) stop(askId);
    await Promise.all(runs.map(([, run]) => run.done));
  }
  return { start, get, stop, stopAll };
}

module.exports = { createAnnotationAsks };
