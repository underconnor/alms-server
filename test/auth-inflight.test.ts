import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CookieCallbackFlights } from '../src/auth-inflight.js';
import { AppError } from '../src/errors.js';

const key = 'a'.repeat(64), otherKey = 'b'.repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('same pending key shares one execution, removes the lookup on completion, and does not cache a resolved value', async () => {
  const registry = new CookieCallbackFlights<number>(); const gate = deferred<number>(); let executions = 0;
  try {
    const run = () => { executions++; return gate.promise; };
    const first = registry.run(key, run), duplicate = registry.run(key, run);
    await turn(); assert.equal(executions, 1); assert.equal(registry.pendingCount, 1);
    gate.resolve(7); assert.deepEqual(await Promise.all([first, duplicate]), [7, 7]);
    assert.equal(registry.pendingCount, 0);
    assert.equal(await registry.run(key, async () => { executions++; return 9; }), 9);
    assert.equal(executions, 2); assert.equal(registry.pendingCount, 0);
  } finally { registry.close(); }
});

test('a shared failure preserves the original error and clears its pending lookup', async () => {
  const registry = new CookieCallbackFlights<number>(); const gate = deferred<number>();
  const error = new AppError(401, 'SCHOOL_AUTH_FAILED', 'synthetic-only'); let executions = 0;
  try {
    const run = () => { executions++; return gate.promise; };
    const first = assert.rejects(registry.run(key, run), value => value === error);
    const duplicate = assert.rejects(registry.run(key, run), value => value === error);
    gate.reject(error); await Promise.all([first, duplicate]);
    assert.equal(executions, 1); assert.equal(registry.pendingCount, 0);
  } finally { registry.close(); }
});

test('only a duplicate wait times out: the original finishes once later without cancellation or retry', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const registry = new CookieCallbackFlights<number>({duplicateWaitMs: 15, retentionMs: 60}); const gate = deferred<number>(); let executions = 0;
  try {
    const run = () => { executions++; return gate.promise; };
    const first = registry.run(key, run);
    const duplicate = assert.rejects(registry.run(key, run), error => error instanceof AppError
      && error.statusCode === 502 && error.code === 'SCHOOL_UPSTREAM_UNAVAILABLE');
    await turn(); t.mock.timers.tick(15); await duplicate;
    assert.equal(executions, 1); assert.equal(registry.pendingCount, 1);
    gate.resolve(11); assert.equal(await first, 11); assert.equal(registry.pendingCount, 0);
  } finally { registry.close(); }
});

test('lookup expiry only prevents new joins; the accepted original and existing duplicate continue', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const registry = new CookieCallbackFlights<number>({retentionMs: 10, duplicateWaitMs: 50}); const gate = deferred<number>(); let executions = 0;
  try {
    const run = () => { executions++; return gate.promise; };
    const first = registry.run(key, run), joined = registry.run(key, run);
    await turn(); t.mock.timers.tick(10); assert.equal(registry.pendingCount, 0);
    assert.equal(await registry.run(key, async () => { executions++; return 3; }), 3);
    gate.resolve(12); assert.deepEqual(await Promise.all([first, joined]), [12, 12]);
    assert.equal(executions, 2); assert.equal(registry.pendingCount, 0);
  } finally { registry.close(); }
});

test('an expired lookup cannot remove a newer same-key rendezvous when its original finally settles', async () => {
  let now = 0;
  const registry = new CookieCallbackFlights<number>({retentionMs: 10, now: () => now});
  const oldGate = deferred<number>(), newGate = deferred<number>();
  try {
    const old = registry.run(key, () => oldGate.promise); await turn(); now = 11;
    const newer = registry.run(key, () => newGate.promise); await turn(); assert.equal(registry.pendingCount, 1);
    oldGate.resolve(1); assert.equal(await old, 1); assert.equal(registry.pendingCount, 1);
    newGate.resolve(2); assert.equal(await newer, 2); assert.equal(registry.pendingCount, 0);
  } finally { registry.close(); }
});

test('flight and duplicate-participant overflow use the original unshared execution without cancelling accepted work', async () => {
  const registry = new CookieCallbackFlights<number>({maxFlights: 1, maxParticipants: 1}); const gate = deferred<number>(); let executions = 0;
  try {
    const first = registry.run(key, () => { executions++; return gate.promise; });
    const joined = registry.run(key, () => { executions++; return Promise.resolve(10); });
    const overflowDuplicate = registry.run(key, async () => { executions++; return 20; });
    const overflowFlight = registry.run(otherKey, async () => { executions++; return 30; });
    assert.equal(await overflowDuplicate, 20); assert.equal(await overflowFlight, 30);
    assert.equal(registry.pendingCount, 1);
    gate.resolve(5); assert.deepEqual(await Promise.all([first, joined]), [5, 5]); assert.equal(executions, 3);
  } finally { registry.close(); }
});

test('close clears lookup bookkeeping without cancelling or changing an accepted execution', async () => {
  const registry = new CookieCallbackFlights<number>(); const gate = deferred<number>();
  const first = registry.run(key, () => gate.promise); await turn(); registry.close(); assert.equal(registry.pendingCount, 0);
  gate.resolve(4); assert.equal(await first, 4);
});

test('invalid limits or unframed keys never run an authentication operation', () => {
  for (const name of ['maxFlights', 'maxParticipants', 'retentionMs', 'duplicateWaitMs'])
    for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new CookieCallbackFlights({[name]: value}), RangeError);
  let executions = 0; const registry = new CookieCallbackFlights<number>();
  try { assert.throws(() => registry.run('raw-private-token', async () => ++executions), RangeError); assert.equal(executions, 0); }
  finally { registry.close(); }
});

test('pending sharing timers never keep an otherwise finished Node process alive', {timeout: 5000}, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {CookieCallbackFlights} from './src/auth-inflight.ts';
    const registry = new CookieCallbackFlights();
    const never = () => new Promise(() => {});
    void registry.run('${key}', never);
    void registry.run('${key}', never);
  `], {stdio: ['ignore', 'ignore', 'pipe']});
  try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 0); assert.equal(signal, null); }
  finally { child.kill('SIGKILL'); }
});
