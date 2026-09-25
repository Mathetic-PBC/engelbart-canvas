'use strict';

const { randomUUID } = require('node:crypto');
const { environmentReport, environmentReportOf } = require('../../shared/environment.cjs');

const githubRepo = (value) => {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/i.exec(value);
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) return null;
  return { owner: match[1], name: match[2], url: `https://github.com/${match[1]}/${match[2]}` };
};

function runStore(db) {
  return {
    async get(id) { return (await db.query('select * from sandbox_runs where id = $1', [id]))[0] || null; },
    async active(libraryId) { return (await db.query("select * from sandbox_runs where library_id = $1 and status in ('starting', 'ready')", [libraryId]))[0] || null; },
    async latest() {
      return db.query('select distinct on (library_id) * from sandbox_runs order by library_id, created_at desc, id desc');
    },
    async environment(libraryId) {
      const [run] = await db.query(`select id, env_report, build_log from sandbox_runs
        where library_id = $1 and (env_report is not null or exists (
          select 1 from jsonb_array_elements(build_log) entry
          where entry->'data'->>'phase' = 'environment'
            and jsonb_typeof(entry->'data'->'variables') = 'array'
        )) order by created_at desc, id desc limit 1`, [libraryId]);
      return environmentReportOf(run);
    },
    async create(libraryId) {
      return (await db.query('insert into sandbox_runs (id, library_id) values ($1, $2) on conflict do nothing returning *', [randomUUID(), libraryId]))[0] || null;
    },
    async record(id, message, details = {}) {
      const at = new Date().toISOString();
      const report = environmentReport(details.data, id, at);
      return (await db.query(`update sandbox_runs set build_log = (
        select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb) from
        jsonb_array_elements(build_log || $2::jsonb) with ordinality as log(value, ordinal)
        where ordinal > jsonb_array_length(build_log) - 299
      ), env_report = coalesce($3::jsonb, env_report), updated_at = now() where id = $1 returning *`,
      [id, JSON.stringify([{ time: at, message, ...details }]), report ? JSON.stringify(report) : null]))[0] || null;
    },
    async reopen(id, revision) {
      return (await db.query("update sandbox_runs set status = 'starting', preview_url = null, error = null, finished_at = null, env_revision = $2, updated_at = now() where id = $1 and status in ('ready', 'failed') returning *", [id, revision]))[0] || null;
    },
    async stoppedAfterFailure(id) {
      return (await db.query("update sandbox_runs set status = 'stopped', finished_at = now(), updated_at = now() where id = $1 and status = 'failed' returning *", [id]))[0] || null;
    },
    async update(id, fields) {
      const allowed = ['sandbox_id', 'status', 'preview_url', 'port', 'error', 'finished_at', 'env_revision'];
      const keys = Object.keys(fields);
      if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new Error('Invalid sandbox run update');
      const set = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      return (await db.query(`update sandbox_runs set ${set}, updated_at = now() where id = $1 and status in ('starting', 'ready') returning *`, [id, ...keys.map((key) => fields[key])]))[0] || null;
    },
  };
}

module.exports = { githubRepo, runStore };
