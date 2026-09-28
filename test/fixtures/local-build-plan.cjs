'use strict';
// Scripted planner output, never used by production.
module.exports = function fixturePlan(codeSteps = 1) {
  return { name: 'Workspace timer', summary: 'Build a small timer using the workspace context.', by: 'Claude (fixture)', model: 'fixture', steps: [
    ...Array.from({ length: codeSteps }, (_, n) => ({ phase: 'code', title: n ? 'Connect the timer controls' : 'Create the timer layout', instructions: n ? 'Wire the timer interaction and write the final launch manifest.' : 'Implement the requested timer interface.' })),
    { phase: 'install', title: 'Prepare dependencies', instructions: 'Install dependencies only when needed.' },
    { phase: 'compile', title: 'Prepare the interface', instructions: 'Compile if the chosen stack requires it.' },
    { phase: 'start', title: 'Start the local timer', instructions: 'Start the owned foreground loopback server.' },
    { phase: 'verify', title: 'Check the timer in a browser', instructions: 'Verify a rendered interface before opening Stage.' },
  ] };
};
