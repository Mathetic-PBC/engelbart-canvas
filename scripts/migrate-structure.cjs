#!/usr/bin/env node
// Convert every project under a data root from <project>/<Goal>/<Topic>/ to <project>/<Workspace>/.
//   npm run migrate -- --dry-run          # say what would move, touch nothing
//   npm run migrate                       # ~/.engelbart and ~/.engelbart/test
//   npm run migrate -- --root /some/dir   # another data root
// Nothing is deleted: see src/main/store/migrate.cjs. Quit Engelbart first — the app converts
// projects by itself when it opens them, so this script is for doing it (or previewing it) by hand.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProjectDir } = require('../src/main/store/migrate.cjs');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootFlag = args.indexOf('--root');
const home = path.join(os.homedir(), '.engelbart');
const roots = rootFlag >= 0 && args[rootFlag + 1] ? [path.resolve(args[rootFlag + 1])] : [home, path.join(home, 'test')];

let converted = 0;
for (const root of roots) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.name.startsWith('.') || !fs.existsSync(path.join(dir, 'project.json'))) continue;
    const report = migrateProjectDir(dir, { dryRun });
    if (!report) { console.log(`ok       ${dir} (already workspaces)`); continue; }
    if (report.deferred) {
      console.log(`deferred ${dir} (open this project in Engelbart to finish its safe workspace migration)`);
      for (const conflict of report.conflicts) console.log(`           ${conflict.message}`);
      continue;
    }
    converted += 1;
    console.log(`${dryRun ? 'would    ' : 'converted'} ${dir}`);
    for (const move of report.moved) console.log(`           ${move.from}  →  ${move.to}`);
    if (report.goals.length) console.log(`           goals ${dryRun ? 'would be' : 'were'} parked in .legacy/: ${report.goals.join(', ')}`);
    for (const entry of report.folders) console.log(`           context folders ${dryRun ? 'would be' : 'were'} flattened in "${entry.workspace}": ${entry.removed.join(', ')}`);
    console.log(`           backup: ${report.backup}${dryRun ? ' (not written in a dry run)' : ''}`);
  }
}
console.log(converted ? `${converted} project${converted === 1 ? '' : 's'} ${dryRun ? 'would be converted' : 'converted'}.` : 'Nothing to convert.');
