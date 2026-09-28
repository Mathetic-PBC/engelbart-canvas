'use strict';

const { randomUUID } = require('node:crypto');
const { rememberPreview } = require('../store/captured-sites.cjs');
const { environmentReport, environmentReportOf } = require('../../shared/environment.cjs');
const { milestoneKey, isAgentActivity, AGENT_LOG_LIMIT } = require('../../shared/build-history.cjs');

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
      const entry = { ...details, id: randomUUID(), time: at, message };
      const key = milestoneKey(entry);
      // Sequence is assigned in the same update as retention, so concurrent
      // events sharing a millisecond keep their order even inside JSONB objects.
      const stored = "($2::jsonb || jsonb_build_object('seq', coalesce((build_log -> -1 ->> 'seq')::bigint, 0) + 1))";
      return (await db.query(`update sandbox_runs set build_log = (
        select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb) from
        jsonb_array_elements(build_log || jsonb_build_array(${stored})) with ordinality as log(value, ordinal)
        where ordinal > jsonb_array_length(build_log) - 299
      ), build_milestones = (case when $4::text is null then coalesce(build_milestones, '{}'::jsonb) else
        coalesce(build_milestones, '{}'::jsonb) || jsonb_build_object($4::text, jsonb_build_object(
          'first', coalesce(build_milestones -> $4::text -> 'first', ${stored}),
          'last', ${stored})) end) || case when $5::boolean then
        jsonb_build_object('agent:activity', jsonb_build_object('entries', (
          select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb) from
          jsonb_array_elements(coalesce(build_milestones #> '{agent:activity,entries}', '[]'::jsonb) || jsonb_build_array(${stored}))
            with ordinality as activity(value, ordinal)
          where ordinal > coalesce(jsonb_array_length(build_milestones #> '{agent:activity,entries}'), 0) - ${AGENT_LOG_LIMIT - 1}
        ))) else '{}'::jsonb end,
      env_report = coalesce($3::jsonb, env_report), updated_at = now() where id = $1 returning *`,
      [id, JSON.stringify(entry), report ? JSON.stringify(report) : null, key, isAgentActivity(entry)]))[0] || null;
    },
    async reopen(id, revision) {
      await rememberPreview(db, await this.get(id));
      return (await db.query("update sandbox_runs set status = 'starting', preview_url = null, error = null, finished_at = null, build_milestones = '{}', env_revision = $2, updated_at = now() where id = $1 and status in ('ready', 'failed') returning *", [id, revision]))[0] || null;
    },
    async stoppedAfterFailure(id) {
      return (await db.query("update sandbox_runs set status = 'stopped', finished_at = now(), updated_at = now() where id = $1 and status = 'failed' returning *", [id]))[0] || null;
    },
    async update(id, fields) {
      const allowed = ['sandbox_id', 'status', 'preview_url', 'port', 'error', 'finished_at', 'env_revision'];
      const keys = Object.keys(fields);
      if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new Error('Invalid sandbox run update');
      const set = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      const run = (await db.query(`update sandbox_runs set ${set}, updated_at = now() where id = $1 and status in ('starting', 'ready') returning *`, [id, ...keys.map((key) => fields[key])]))[0] || null;
      if (fields.preview_url) await rememberPreview(db, run);
      return run;
    },
  };
}

module.exports = { githubRepo, runStore };
