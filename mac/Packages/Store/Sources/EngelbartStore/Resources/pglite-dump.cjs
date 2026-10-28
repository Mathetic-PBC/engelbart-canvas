'use strict';

// Engelbart for Mac (Swift) importer: dumps one PGlite database (a COPY of library.pglite or a project's notes.pglite)
// to JSON, so the Swift store can insert it into SQLite. Run by StoreImporter with the Electron app's own runtime
// (ELECTRON_RUN_AS_NODE=1, NODE_PATH=<app.asar.unpacked/node_modules>) or with `node` and a checkout's node_modules.
//   node pglite-dump.cjs <pglite directory> <output.json>
// Output: { "<table>": { "columns": [{ column_name, data_type }], "rows": [{ column: value }] } }; timestamps as ISO
// strings, text[] as arrays, jsonb as objects, as PGlite hands them over.

const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) throw new Error('usage: pglite-dump.cjs <pglite directory> <output.json>');
  const db = new PGlite(dir);
  await db.waitReady;
  const tables = (await db.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name")).rows.map((row) => row.table_name);
  const dump = {};
  for (const table of tables) {
    const columns = (await db.query('select column_name, data_type from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position', ['public', table])).rows;
    const rows = (await db.query(`select * from "${table.replace(/"/g, '""')}"`)).rows.map((row) => {
      const plain = {};
      for (const [key, value] of Object.entries(row)) plain[key] = value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value;
      return plain;
    });
    dump[table] = { columns, rows };
  }
  await db.close();
  fs.writeFileSync(out, JSON.stringify(dump));
}

main().catch((error) => {
  process.stderr.write(`${(error && error.stack) || error}\n`);
  process.exit(1);
});
