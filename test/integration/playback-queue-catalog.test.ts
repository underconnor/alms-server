import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../../src/migrations.js';
import { PgStore } from '../../src/store.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
test('migration019 preserves all prior catalog objects and histories and creates empty scheduling metadata', { skip: !url }, async t => {
  const schema = 'qa_catalog_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url, max: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'alms-queue-catalog-'));
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    const files = (await readdir(resolve('migrations'))).filter(name => /^(00[1-9]|01[0-8])-.*\.sql$/.test(name)).sort();
    assert.equal(files.length, 18);
    for (const name of files) await copyFile(resolve('migrations', name), join(directory, name));
    await migrate(pool, directory);
    const store = new PgStore(pool);
    await assert.rejects(store.health(), /migrations are pending/);
    const session = await store.issueVerifiedSession({ provider: 'queue-catalog-qa', subject: randomUUID() }, 3600,
      { provider: 'ssu', seal: () => 'synthetic-catalog-seal' });
    const historical = randomUUID(), generation = randomUUID(), token = 'a'.repeat(64);
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,
      accepted_generation,last_execution_token_hash,execution_outcome,error_code)
      VALUES($1,$2,'10','20','needs_verification',clock_timestamp(),$3,'synthetic',$4,$5,'interrupted','PLAYBACK_REPORT_UNKNOWN')`,
    [historical, session.user.id, randomUUID(), generation, token]);
    await pool.query('INSERT INTO job_outbox(job_id,dispatched_at) VALUES($1,clock_timestamp())', [historical]);
    await pool.query(`INSERT INTO playback_job_progress(job_id,execution_token_hash,observation,report_ack)
      VALUES($1,$2,$3::jsonb,$4::jsonb)`, [historical, token,
      JSON.stringify({ observedAt: '2026-01-01T00:00:00.000Z', positionSeconds: 1, durationSeconds: 100, percent: 1, paused: true, ended: false }),
      JSON.stringify({ event: 'playing', acknowledgedAt: '2026-01-01T00:00:00.000Z' })]);
    const protectedTables = ['users', 'sessions', 'school_sessions', 'playback_jobs', 'job_outbox', 'playback_job_progress',
      'playback_auth_waits', 'playback_start_consents', 'playback_job_start_consents', 'playback_start_attempts', 'playback_start_consent_revocations'];
    const histories = async () => Object.fromEntries(await Promise.all(protectedTables.map(async name => [name,
      (await pool!.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(row)::text,'' ORDER BY to_jsonb(row)::text),'')) AS hash FROM ${name} row`)).rows[0]])));
    const historiesBefore = await histories();
    const spec = JSON.parse(await readFile(new URL('../helpers/playback-queue-catalog-queries.json', import.meta.url), 'utf8'));
    const catalog = async () => Object.fromEntries(await Promise.all(Object.entries(spec.queries as Record<string, string>).map(async ([name, sql]) =>
      [name, (await pool!.query(sql.replaceAll("'public'", "'" + schema + "'"))).rows])));
    const before = await catalog();
    const migration = await readFile(resolve('migrations/019-playback-queue-metadata.sql'), 'utf8');
    await copyFile(resolve('migrations/019-playback-queue-metadata.sql'), join(directory, '019-playback-queue-metadata.sql'));
    await migrate(pool, directory);
    const after = await catalog(), added: Record<string, unknown[]> = {};
    assert.deepEqual(await histories(), historiesBefore);
    for (const [kind, prior] of Object.entries(before)) {
      const remaining = [...after[kind] as unknown[]];
      for (const item of prior as unknown[]) {
        const index = remaining.findIndex(value => JSON.stringify(value) === JSON.stringify(item));
        assert.ok(index >= 0, 'Existing catalog object changed: ' + kind);
        remaining.splice(index, 1);
      }
      added[kind] = remaining;
    }
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM playback_queue_metadata')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 19);
    await store.health();
    assert.equal(added.functions!.length, 0); assert.equal(added.policies!.length, 0);
    assert.deepEqual((added.indexes as Array<{ name: string }>).map(value => value.name).sort(),
      ['playback_queue_metadata_dispatch_id_key', 'playback_queue_metadata_pkey', 'playback_queue_ready_order_idx']);
    // Schema-only evidence: no credentials, row data, school payloads or URLs.
    // Normalize only the generated isolated schema name for the release review.
    const normalized = JSON.parse(JSON.stringify({ before, after, added }).replaceAll(schema, 'public'));
    t.diagnostic('ALMS_QUEUE_019_CATALOG=' + JSON.stringify({ version: 1, actualPostgres: true, migrationCount: 19,
      newMetadataCount: 0, health: 'passed', sourceSnapshotJsSha256: spec.sourceSnapshotJsSha256,
      migrationSha256: createHash('sha256').update(migration).digest('hex'), schemaNameNormalized: true, historiesBefore, historiesAfter: await histories(), ...normalized }));
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
