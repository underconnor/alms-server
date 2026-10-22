import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyllabusCache } from '../src/syllabus-cache.js';
import { AppError } from '../src/errors.js';
const document = (id = 'x') => ({ bytes: Buffer.from('%PDF-1.7\n' + id.repeat(20) + '\n%%EOF'), pageCount: 1 });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('default export reuse spans a reading session but refreshes at thirty minutes', async (t) => {
  let now = 1000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const cache = createSyllabusCache();
  const load = async () => { calls++; return document(String(calls)); };
  const first = await cache.read('owner', 'generation', 'course', load);
  now += 6 * 60_000;
  assert.equal(await cache.read('owner', 'generation', 'course', load), first);
  now += 23 * 60_000;
  assert.equal(await cache.read('owner', 'generation', 'course', load), first);
  assert.equal(calls, 1);
  now += 60_000;
  assert.equal(cache.isCurrent('owner', 'generation', 'course', first), false);
  const next = await cache.read('owner', 'generation', 'course', load);
  assert.notEqual(next.documentVersion, first.documentVersion);
  assert.equal(calls, 2);
});

test('syllabus bytes deduplicate by owner generation course and produce SHA256 version', async () => {
  const cache = createSyllabusCache(); let calls = 0;
  const load = async () => { calls++; return document(); };
  const [a, b] = await Promise.all([cache.read('a', 'g1', '1', load), cache.read('a', 'g1', '1', load)]);
  assert.equal(a, b); assert.equal(calls, 1); assert.match(a.documentVersion, /^[a-f0-9]{64}$/);
  await cache.read('b', 'g1', '1', load); await cache.read('a', 'g2', '1', load); assert.equal(calls, 3);
  assert.equal(cache.isCurrent('a', 'g1', '1', a), false);
});
test('explicit refresh aborts old work and prevents its late result replacing fresh bytes', async () => {
  const cache = createSyllabusCache(), wait = gate(); let aborted = false;
  const old = cache.read('a', 'g', '1', async signal => { signal.addEventListener('abort', () => { aborted = true; }); await wait.promise; return document('old'); });
  await flush(); const rejection = assert.rejects(old, error => error instanceof AppError && error.statusCode === 409);
  const next = cache.read('a', 'g', '1', async () => document('new'), true);
  wait.release(); await rejection; const result = await next;
  assert.equal(aborted, true); assert.deepEqual(result.bytes, document('new').bytes); assert.ok(cache.isCurrent('a', 'g', '1', result));
});
test('renderer queue limits concurrency and owner contention, then frees cancelled waiting slots', async () => {
  const cache = createSyllabusCache(), wait = gate(); let running = 0, maximum = 0;
  const load = async () => { running++; maximum = Math.max(maximum, running); await wait.promise; running--; return document(); };
  const first = cache.read('a', 'g', '1', load); await flush();
  const pending = ['b', 'c', 'd', 'e'].map(owner => cache.read(owner, 'g', '1', load));
  await assert.rejects(cache.read('f', 'g', '1', load), error => error instanceof AppError && error.statusCode === 429);
  await assert.rejects(cache.read('a', 'g', '2', load), error => error instanceof AppError && error.statusCode === 429);
  const rejected = assert.rejects(pending[0]!, error => error instanceof AppError && error.statusCode === 409);
  cache.invalidate('b'); await rejected;
  const replacement = cache.read('f', 'g', '1', load);
  wait.release(); await Promise.all([first, ...pending.slice(1), replacement]); assert.equal(maximum, 1);
});
test('TTL, byte bounds and revocation never return expired or failed PDF data', async () => {
  const cache = createSyllabusCache({ ttlMs: 1, maximumBytes: document().bytes.length });
  const first = await cache.read('a', 'g', '1', async () => document());
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(cache.isCurrent('a', 'g', '1', first), false);
  const second = await cache.read('a', 'g', '1', async () => document('n')); assert.notEqual(first, second);
  cache.invalidate('a'); assert.equal(cache.isCurrent('a', 'g', '1', second), false);
  await assert.rejects(cache.read('a', 'g', '1', async () => ({ ...document(), pageCount: 0 })));
  await assert.rejects(cache.read('a', 'g', '1', async () => ({ bytes: Buffer.alloc(16 * 1024 * 1024 + 1), pageCount: 1 })));
});
test('original caller cancellation removes queued work without starting its loader or holding a queue slot', async () => {
  const cache = createSyllabusCache(), wait = gate(), controller = new AbortController(); let cancelledCalls = 0;
  const first = cache.read('a', 'g', '1', async () => { await wait.promise; return document(); });
  await flush();
  const cancelled = cache.read('b', 'g', '1', async () => { cancelledCalls++; return document(); }, false, controller.signal);
  const rejected = assert.rejects(cancelled);
  controller.abort(); await rejected;
  const queued = ['c', 'd', 'e', 'f'].map(owner => cache.read(owner, 'g', '1', async () => document()));
  wait.release(); await Promise.all([first, ...queued]); assert.equal(cancelledCalls, 0);
  await assert.rejects(cache.read('b', 'g', '1', async () => { cancelledCalls++; return document(); }, false, controller.signal));
  assert.equal(cancelledCalls, 0);
});
