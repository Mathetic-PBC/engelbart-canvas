'use strict';

// One readers–writer lock per tool (2026-09-23; design D14). Runs of a program (@bart turns, summaries,
// later Build) share it; installing or updating that program takes it alone, after the runs in progress
// end, and runs asked for meanwhile wait for the update. A waiting update goes first, so a steady stream
// of questions cannot hold it off for ever.

function createLock() {
  let readers = 0;
  let writing = false;
  const writers = [];
  const waiting = [];
  const wake = () => {
    if (writing) return;
    if (writers.length) {
      if (readers === 0) { writing = true; writers.shift()(); }
      return;
    }
    while (waiting.length) { readers += 1; waiting.shift()(); }
  };
  return {
    async shared(fn) {
      await new Promise((resolve) => {
        if (!writing && !writers.length) { readers += 1; resolve(); } else waiting.push(resolve);
      });
      try { return await fn(); } finally { readers -= 1; wake(); }
    },
    async exclusive(fn) {
      await new Promise((resolve) => {
        if (!writing && readers === 0) { writing = true; resolve(); } else writers.push(resolve);
      });
      try { return await fn(); } finally { writing = false; wake(); }
    },
    state: () => ({ readers, writing, waiting: writers.length + waiting.length }),
  };
}

module.exports = { createLock };
