import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPgSchoolSessionLockRunner } from '../../src/pg-school-session-lock.js';
const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise<void>(r => setImmediate(r));
describe('school session owner coordination across real PostgreSQL connections', { skip: !url }, () => {
  let api: Pool, worker: Pool, operational: Pool;
  before(() => {
    api = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    worker = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    operational = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    for (const pool of [api, worker, operational]) pool.on('error', () => {});
  });
  after(async () => { await Promise.all([api.end(), worker.end(), operational.end()]); });
  it('two process-like pools serialize one school owner without blocking operational SQL', async () => {
    const owner = randomUUID(), held = deferred(), started = deferred(), waiting = deferred(); const seen: string[] = [];
    const first = createPgSchoolSessionLockRunner(api), second = createPgSchoolSessionLockRunner(worker);
    const a = first(owner, async () => { seen.push('api'); started.resolve(); await held.promise; seen.push('api-done'); });
    await started.promise;
    const b = second(owner, async () => { seen.push('worker'); waiting.resolve(); });
    try {
      const response = await operational.query('SELECT 1 AS healthy'); assert.equal(response.rows[0]?.healthy, 1);
      await turn(); assert.deepEqual(seen, ['api']); held.resolve(); await Promise.all([a, b, waiting.promise]);
      assert.deepEqual(seen, ['api', 'api-done', 'worker']);
    } finally { held.resolve(); await Promise.allSettled([a, b]); }
  });
  it('a different school owner is not serialized behind another owner', async () => {
    const held = deferred(), started = deferred(); const first = createPgSchoolSessionLockRunner(api), second = createPgSchoolSessionLockRunner(worker);
    const a = first(randomUUID(), async () => { started.resolve(); await held.promise; });
    await started.promise; let ran = false;
    try { await second(randomUUID(), async () => { ran = true; }); assert.equal(ran, true); }
    finally { held.resolve(); await a; }
  });
  it('an aborted waiter never runs or releases the first owner lifetime', async () => {
    const owner = randomUUID(), held = deferred(), started = deferred(), abort = new AbortController(); let ran = false;
    const first = createPgSchoolSessionLockRunner(api), second = createPgSchoolSessionLockRunner(worker);
    const a = first(owner, async () => { started.resolve(); await held.promise; }); await started.promise;
    const b = second(owner, async () => { ran = true; }, abort.signal); const rejected = assert.rejects(b);
    try {
      await turn(); abort.abort(); await rejected; assert.equal(ran, false);
      const probe = await operational.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`alms:ssu:school-session:v1:${owner}`]);
      assert.equal(probe.rows[0]?.acquired, false);
    } finally { abort.abort(); held.resolve(); await Promise.allSettled([a, b, rejected]); }
    await second(owner, async () => {});
  });
  it('a thrown callback releases its exact connection lock and preserves the original failure', async () => {
    const owner = randomUUID(), expected = new Error('synthetic failure'), run = createPgSchoolSessionLockRunner(api);
    await assert.rejects(run(owner, async () => { throw expected; }), error => error === expected);
    let resumed = false; await createPgSchoolSessionLockRunner(worker)(owner, async () => { resumed = true; }); assert.equal(resumed, true);
  });
});
