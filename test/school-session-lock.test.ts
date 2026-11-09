import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../src/errors.js';
import { withSchoolSessionLock } from '../src/school-session-lock.js';
import { createPgSchoolSessionLockRunner } from '../src/pg-school-session-lock.js';

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { while (!check()) await tick(); }
class Database {
  readonly locks = new Map<string, Client>();
  readonly clients: Client[] = [];
  attempts = 0;
  pool(connect?: () => Promise<Client>) {
    return { connect: connect ?? (async () => { const client = new Client(this); this.clients.push(client); return client; }) } as unknown as Pool;
  }
}
class Client extends EventEmitter {
  releases: boolean[] = [];
  unlockWorks = true;
  constructor(readonly db: Database) { super(); }
  async query(sql: string, params: string[]) {
    assert.equal(params.length, 1); const key = params[0]!;
    if (sql.includes('pg_try_advisory_lock')) {
      this.db.attempts++;
      const acquired = !this.db.locks.has(key);
      if (acquired) this.db.locks.set(key, this);
      return { rows: [{ acquired }] };
    }
    assert.match(sql, /pg_advisory_unlock/);
    const unlocked = this.unlockWorks && this.db.locks.get(key) === this;
    if (unlocked) this.db.locks.delete(key);
    return { rows: [{ unlocked }] };
  }
  release(destroy: boolean) {
    this.releases.push(destroy);
    assert.equal(this.releases.length, 1, 'one checked-out connection is released exactly once');
    if (destroy) for (const [key, value] of this.db.locks) { if (value === this) this.db.locks.delete(key); }
    else assert.equal([...this.db.locks.values()].includes(this), false, 'no held owner lock returns to the pool');
  }
}
const runner = (db: Database, pool = db.pool()) => createPgSchoolSessionLockRunner(pool, { pollMs: 2, waitTimeoutMs: 1000, unlockTimeoutMs: 100 });

test('independent API and worker coordinators serialize one owner and release before the next callback', async () => {
  const db = new Database(), first = runner(db), second = runner(db), gate = deferred(); const events: string[] = [];
  const a = first('owner', async () => { events.push('api'); await gate.promise; events.push('api-done'); });
  await until(() => events.length === 1);
  const b = second('owner', async () => { events.push('worker'); });
  await until(() => db.attempts > 1); assert.deepEqual(events, ['api']);
  gate.resolve(); await Promise.all([a, b]);
  assert.deepEqual(events, ['api', 'api-done', 'worker']); assert.equal(db.locks.size, 0);
  assert.ok(db.clients.every(c => c.releases.length === 1 && c.releases[0] === false));
});
test('another owner proceeds while the first owner is doing school IO', async () => {
  const db = new Database(), run = runner(db), gate = deferred(); let first = false, second = false;
  const a = run('first', async () => { first = true; await gate.promise; });
  await until(() => first); await run('second', async () => { second = true; });
  assert.equal(second, true); gate.resolve(); await a;
});
test('cancelling a waiting owner never starts its callback and does not unlock another holder', async () => {
  const db = new Database(), run = runner(db), gate = deferred(), abort = new AbortController(); let started = false, waiter = false;
  const a = run('owner', async () => { started = true; await gate.promise; });
  await until(() => started);
  const b = run('owner', async () => { waiter = true; }, abort.signal); const rejected = assert.rejects(b);
  await until(() => db.attempts > 1); abort.abort(); await rejected;
  assert.equal(waiter, false); assert.equal(db.locks.size, 1); assert.deepEqual(db.clients[1]!.releases, [true]);
  gate.resolve(); await a;
});
test('a late connection after acquisition timeout is destroyed once and cannot execute school IO', async () => {
  const db = new Database(), connected = deferred<Client>(), client = new Client(db); let called = false;
  const run = createPgSchoolSessionLockRunner(db.pool(() => connected.promise), { waitTimeoutMs: 15, pollMs: 2 });
  await assert.rejects(run('owner', async () => { called = true; }), { code: 'SCHOOL_SESSION_BUSY', statusCode: 503 });
  connected.resolve(client); await tick();
  assert.deepEqual(client.releases, [true]); assert.equal(db.attempts, 0); assert.equal(called, false);
});
test('a lost coordinator connection aborts guarded school IO and cannot be mistaken for login expiry', async () => {
  const db = new Database(), run = runner(db); let calls = 0;
  await assert.rejects(run('owner', async signal => {
    calls++; const stopped = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    db.clients[0]!.emit('error', new Error('private connection detail'));
    await stopped;
  }), error => { assert.ok(error instanceof AppError); assert.equal(error.code, 'SCHOOL_SESSION_LOCK_LOST'); assert.equal(error.statusCode, 503); assert.doesNotMatch(error.message, /private/); return true; });
  assert.equal(calls, 1); assert.equal(db.locks.size, 0); assert.deepEqual(db.clients[0]!.releases, [true]);
});
test('a callback failure is preserved exactly once and its session lock is destroyed', async () => {
  const db = new Database(), run = runner(db), failure = new AppError(409, 'SCHOOL_SESSION_CHANGED', 'fixed'); let calls = 0;
  await assert.rejects(run('owner', async () => { calls++; throw failure; }), e => e === failure);
  assert.equal(calls, 1); assert.equal(db.locks.size, 0); await run('owner', async () => {});
});
test('failed explicit unlock never returns a locked connection to its pool', async () => {
  const db = new Database(), run = runner(db); let calls = 0;
  await assert.rejects(run('owner', async () => { calls++; db.clients[0]!.unlockWorks = false; }), { code: 'SCHOOL_SESSION_LOCK_LOST' });
  assert.equal(calls, 1); assert.deepEqual(db.clients[0]!.releases, [true]); assert.equal(db.locks.size, 0);
});
test('same-owner nested local acquisition fails promptly instead of deadlocking; another owner is independent', async () => {
  await withSchoolSessionLock('nested', async () => {
    await assert.rejects(withSchoolSessionLock('nested', async () => {}), { code: 'SCHOOL_SESSION_LOCK_REENTRANT' });
    assert.equal(await withSchoolSessionLock('another', async () => 42), 42);
  });
  assert.equal(await withSchoolSessionLock('nested', async () => 7), 7);
});
test('a cancelled local waiter never enters a coordinator or school callback', async () => {
  const gate = deferred(), abort = new AbortController(); let started = false, coordinate = 0, callbacks = 0;
  const a = withSchoolSessionLock('local-wait', async () => { started = true; await gate.promise; }); await until(() => started);
  const b = withSchoolSessionLock('local-wait', async () => { callbacks++; }, { signal: abort.signal,
    coordinate: async (_owner, run, signal) => { coordinate++; return run(signal!); } });
  const rejected = assert.rejects(b); abort.abort(); gate.resolve(); await Promise.all([a, rejected]);
  assert.equal(coordinate, 0); assert.equal(callbacks, 0);
});
