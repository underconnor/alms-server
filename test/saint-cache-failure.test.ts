import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSaintReader } from '../src/saint-reader.js';
import { encryptSchoolSession } from '../src/crypto.js';
import { AppError } from '../src/errors.js';
import type { SchoolCacheScope, SchoolReadCache } from '../src/school-read-cache.js';
import type { SchoolSessionLockRunner } from '../src/school-session-lock.js';

const owner = 'synthetic-saint-owner';
const timetable = { selectedYear: 2026, selectedSemester: '092' as const, entries: [] };
const fresh = async () => ({ timetable, jar: {} });
function fixture() {
  const key = randomBytes(32);
  const seal = (generation: string) => encryptSchoolSession({ version: 1, generation,
    identity: { studentId: '90000001' }, jar: {} }, key, owner, 'ssu');
  const generation = randomUUID();
  let encrypted = seal(generation);
  const store = {
    getEncryptedSchoolSession: async () => encrypted,
    replaceEncryptedSchoolSession: async (_owner: string, _provider: string, previous: string, next: string) => {
      if (encrypted !== previous) return false;
      encrypted = next; return true;
    },
  };
  return { key, generation, store, current: () => encrypted,
    replace: (nextGeneration = generation) => { encrypted = seal(nextGeneration); } };
}

for (const changedGeneration of [true, false]) test(`late Saint failure preserves a replacement cache with ${changedGeneration ? 'new generation' : 'same generation and new seal'}`, async () => {
  const f = fixture(), initialSeal = f.current();
  let releaseDelete!: () => void, enteredDelete!: () => void;
  const deleting = new Promise<void>(resolve => { enteredDelete = resolve; });
  const gate = new Promise<void>(resolve => { releaseDelete = resolve; });
  let cached: { scope: SchoolCacheScope; value: unknown } | null = null;
  let deleteScope: unknown[] = [];
  const durable: SchoolReadCache = {
    get: async () => null,
    put: async (scope, value) => { cached = { scope, value }; return true; },
    delete: async (...scope) => {
      deleteScope = scope; enteredDelete(); await gate;
      const [userId, provider, resource, generation, expectedSeal] = scope;
      // Model the owning SQL's atomic generation and current school seal predicate.
      if (cached && cached.scope.owner === userId && cached.scope.provider === provider
        && cached.scope.resource === resource && (!generation || cached.scope.generation === generation)
        && (!expectedSeal || f.current() === expectedSeal)) cached = null;
    },
  };
  const broken = createSaintReader(f.store, f.key, async () => { throw new Error('synthetic upstream failure'); }, durable);
  const working = createSaintReader(f.store, f.key, fresh, durable);
  const rejected = assert.rejects(broken.timetable(owner), { code: 'SCHOOL_UPSTREAM_UNAVAILABLE' });
  await deleting;
  f.replace(changedGeneration ? randomUUID() : f.generation);
  await working.timetable(owner);
  assert.ok(cached);
  releaseDelete(); await rejected;
  assert.deepEqual(deleteScope, [owner, 'ssu', 'saint:timetable', f.generation, initialSeal]);
  assert.ok(cached, 'the old failed request must not remove the replacement cache');
});

for (const code of ['SCHOOL_SESSION_BUSY', 'SCHOOL_SESSION_LOCK_LOST', 'SCHOOL_SESSION_LOCK_REENTRANT'])
  test(`Saint retains a valid memory cache after ${code}`, async () => {
    const f = fixture(); let failure = false, connects = 0, deletes = 0;
    const coordinate: SchoolSessionLockRunner = async (_owner, run) => {
      if (failure) throw new AppError(503, code, 'synthetic coordination failure');
      return run(new AbortController().signal);
    };
    const durable: SchoolReadCache = { get: async () => null, put: async () => true, delete: async () => { deletes++; } };
    const reader = createSaintReader({ ...f.store, runWithSchoolSessionLock: coordinate }, f.key,
      async () => { connects++; return fresh(); }, durable);
    const first = await reader.timetable(owner);
    failure = true; await assert.rejects(reader.timetable(owner), { code, statusCode: 503 });
    failure = false; assert.equal(await reader.timetable(owner), first);
    assert.equal(connects, 1); assert.equal(deletes, 0);
  });

test('a coordinator loss after a verified cache hit rejects that request without evicting its data', async () => {
  const f = fixture(); let failAfterRun = false, connects = 0, deletes = 0;
  const coordinate: SchoolSessionLockRunner = async (_owner, run) => {
    const value = await run(new AbortController().signal);
    if (failAfterRun) throw new AppError(503, 'SCHOOL_SESSION_LOCK_LOST', 'synthetic unlock failure');
    return value;
  };
  const durable: SchoolReadCache = { get: async () => null, put: async () => true, delete: async () => { deletes++; } };
  const reader = createSaintReader({ ...f.store, runWithSchoolSessionLock: coordinate }, f.key,
    async () => { connects++; return fresh(); }, durable);
  const first = await reader.timetable(owner);
  failAfterRun = true; await assert.rejects(reader.timetable(owner), { code: 'SCHOOL_SESSION_LOCK_LOST' });
  failAfterRun = false; assert.equal(await reader.timetable(owner), first);
  assert.equal(connects, 1); assert.equal(deletes, 0);
});

test('a genuine source failure still removes only the current failed timetable scope', async () => {
  const f = fixture(), initialSeal = f.current(); let removed: unknown[] = [];
  const durable: SchoolReadCache = { get: async () => null, put: async () => true, delete: async (...scope) => { removed = scope; } };
  const reader = createSaintReader(f.store, f.key, async () => { throw new Error('synthetic source failure'); }, durable);
  await assert.rejects(reader.timetable(owner), { code: 'SCHOOL_UPSTREAM_UNAVAILABLE' });
  assert.deepEqual(removed, [owner, 'ssu', 'saint:timetable', f.generation, initialSeal]);
});
