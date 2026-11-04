import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceReadFlights } from '../src/source-read-flight.js';
import { AppError } from '../src/errors.js';
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const scope = { owner: 'a', generation: 'one', resource: 'course:10', policy: 'resource' };

test('equivalent source reads coalesce and validate every caller before and after the shared result', async () => {
  const share = createSourceReadFlights(), wait = gate(); let calls = 0, a = 0, b = 0;
  const run = async (options: any) => { calls++; await options.validate(); await wait.promise; await options.validate(); return { items: [1, 2] }; };
  const first = share(scope, { validate: async () => { a++; } }, run);
  const second = share(scope, { validate: async () => { b++; } }, run);
  await flush(); assert.equal(calls, 1); wait.release();
  assert.deepEqual(await first, await second); assert.ok(a >= 2 && b >= 2);
});
test('cancelling the first waiter preserves another caller and its personal mapping read', async () => {
  const share = createSourceReadFlights(), wait = gate(), controller = new AbortController(); let signal!: AbortSignal;
  const run = async (options: any) => { signal = options.signal; await wait.promise; await options.validate(); return options.personalCompletionCourses(['10']); };
  const first = share(scope, { signal: controller.signal, personalCompletionCourses: async () => { throw new Error('must not use cancelled observer'); } }, run);
  const second = share(scope, { personalCompletionCourses: async () => ['10'] }, run);
  await flush(); controller.abort(); await assert.rejects(first, { code: 'SCHOOL_PROVIDER_UNAVAILABLE' });
  assert.equal(signal.aborted, false); wait.release(); assert.deepEqual(await second, ['10']);
});
test('all waiter cancellation aborts work and the next request starts a new flight', async () => {
  const share = createSourceReadFlights(), controller = new AbortController(); let signal!: AbortSignal;
  const first = share(scope, { signal: controller.signal }, async options => { signal = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); });
  await flush(); controller.abort(); await assert.rejects(first); assert.equal(signal.aborted, true);
  assert.equal(await share(scope, {}, async () => 2), 2);
});
test('logout withholds one waiter without borrowing the remaining caller authorization', async () => {
  const share = createSourceReadFlights(), wait = gate(); let active = true;
  const first = share(scope, { validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic'); } }, async options => { await wait.promise; await options.validate(); return 2; });
  const second = share(scope, {}, async () => 3);
  await flush(); active = false; wait.release(); await assert.rejects(first, { statusCode: 401 }); assert.equal(await second, 2);
});
test('owner, generation, resource and policy isolate fresh work', async () => {
  const share = createSourceReadFlights(), wait = gate(); let calls = 0;
  const scopes = [scope, { ...scope, owner: 'b' }, { ...scope, generation: 'two' }, { ...scope, resource: 'tasks' }, { ...scope, policy: 'all' }];
  const work = scopes.map(value => share(value, {}, async () => { calls++; await wait.promise; return calls; }));
  await flush(); assert.equal(calls, 5); wait.release(); await Promise.all(work);
});
test('one owner cannot occupy every source-read slot and settled work releases its budget', async () => {
  const share = createSourceReadFlights(), wait = gate();
  const work = Array.from({ length: 8 }, (_, index) => share({ ...scope, resource: `course:${index}` }, {}, async () => { await wait.promise; return index; }));
  await flush();
  await assert.rejects(share({ ...scope, resource: 'course:99' }, {}, async () => 99), { statusCode: 429 });
  assert.equal(await share({ ...scope, owner: 'b' }, {}, async () => 9), 9);
  wait.release(); await Promise.all(work);
  assert.equal(await share({ ...scope, resource: 'course:99' }, {}, async () => 99), 99);
});
test('an expired waiter cannot replace another caller mapping failure with its own 401', async () => {
  const share = createSourceReadFlights(), wait = gate(); let active = true;
  const first = share(scope, { validate: async () => { if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic expired'); },
    personalCompletionCourses: async () => [] }, async options => { await wait.promise; return options.personalCompletionCourses!(['10']); });
  const second = share(scope, { personalCompletionCourses: async () => { throw new AppError(502, 'SCHOOL_UPSTREAM_UNAVAILABLE', 'synthetic unavailable'); } }, async () => []);
  await flush(); active = false; wait.release();
  await assert.rejects(first, { statusCode: 401 }); await assert.rejects(second, { statusCode: 502 });
});
