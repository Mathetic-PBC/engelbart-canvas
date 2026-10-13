// Bart's routing, measured (2026-10-12): every line of fixtures/route-eval.jsonl ({ line, section, specAbove, specTitle?,
// expected, spec?, threads? }) is routed as the editor routes it (its rules first, src/renderer/model/route.js routeByRule, then the model,
// src/main/bart/route.cjs) and the pick compared with the expected agent. It reports the agreement, the costly misroutes
// (a line sent to Build that was not for it, or a line for Build that was not sent there) and the median time the model
// took. A line for Build that Bart sends to Chat is asked for the Build prompt, which is cheap; a costly misroute is one
// that starts a Build nobody asked for (2026-10-13: among them a Build of the spec above for a line, `spec: false`, that
// asked for something of its own), or that sends a line for Build to @brainstorm or @discover. It asks the real CLI (Haiku on Claude Code, or Luna with --codex), unless --fake.
//
//   node scripts/route-eval.mjs [--fake] [--codex] [--file fixtures/route-eval.jsonl]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { routeByRule } from '../src/renderer/model/route.js';

const require = createRequire(import.meta.url);
const { createRouter, createFakeRouter } = require('../src/main/bart/route.cjs');
const { DEFAULT_MODELS, normalizeModels } = require('../src/main/bart/models.cjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fileAt = args.indexOf('--file');
const file = fileAt >= 0 ? args[fileAt + 1] : path.join(root, 'fixtures/route-eval.jsonl');
const models = { ...normalizeModels(DEFAULT_MODELS), provider: args.includes('--codex') ? 'openai' : 'anthropic' };
const router = args.includes('--fake') ? createFakeRouter() : createRouter({ readModels: () => models });

const cases = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const rows = [];
for (const item of cases) {
  const rule = routeByRule(item.line, { models });
  const got = await router.route({ text: item.line, section: `${item.section || ''}\n@bart ${item.line}`, threads: item.threads || [], specAbove: !!item.specAbove, specTitle: item.specTitle || '', rule });
  // As the editor hands it over: build with no spec above, less than 0.8 sure, or not meaning that spec (got.spec,
  // 2026-10-13), is Chat asked for the Build prompt.
  const lands = got.agent === 'build' && !(item.specAbove && got.spec && got.sure >= 0.8) && got.by !== 'rule' ? 'chat' : got.agent;
  rows.push({ ...item, pick: got.agent, sure: got.sure, by: got.by, ms: got.ms, lands, error: got.error });
  console.log(`${got.agent === item.expected ? 'ok  ' : 'MISS'} ${String(got.agent).padEnd(10)} (want ${item.expected.padEnd(10)}) sure ${Number(got.sure).toFixed(2)}${item.specAbove && got.agent === 'build' ? ` spec ${got.spec ? 'yes' : 'no '}${item.spec != null && !!got.spec !== item.spec ? ' (MISS)' : '      '}` : ''} ${String(got.ms).padStart(6)} ms ${got.by === 'rule' ? '[rule] ' : ''}${got.error ? `[${got.error}] ` : ''}${item.line}`);
}
const agree = rows.filter((row) => row.pick === row.expected).length;
const costly = rows.filter((row) => (row.lands === 'build' && (row.expected !== 'build' || row.spec === false)) || (row.expected === 'build' && (row.pick === 'brainstorm' || row.pick === 'discover')));
const timed = rows.filter((row) => row.by === 'model').map((row) => row.ms).sort((a, b) => a - b);
const median = timed.length ? timed[Math.floor((timed.length - 1) / 2)] : null;
console.log(`\nagreement ${agree}/${rows.length} (${Math.round((100 * agree) / Math.max(1, rows.length))}%)`);
console.log(`costly misroutes ${costly.length}${costly.length ? `: ${costly.map((row) => `"${row.line}" → ${row.lands}`).join('; ')}` : ''}`);
console.log(`median model time ${median == null ? 'n/a' : `${median} ms`} over ${timed.length} line${timed.length === 1 ? '' : 's'}`);
