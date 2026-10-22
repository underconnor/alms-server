import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createApiResourceCloser, apiDrainTimeoutMs, apiPoolCloseTimeoutMs, apiShutdownHardLimitMs } from '../src/api-shutdown.js';

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
test('Fastify reverse close hooks drain both consumers concurrently before the pool and never repeat cleanup', async () => {
  const app = Fastify(), order: string[] = [], assignment = gate(), manual = gate();
  let assignmentClose: Promise<void> | undefined, manualClose: Promise<void> | undefined;
  const stopAssignment = () => assignmentClose ??= (async () => { order.push('assignment_start'); await assignment.promise; order.push('assignment_done'); })();
  const stopManual = () => manualClose ??= (async () => { order.push('manual_start'); await manual.promise; order.push('manual_done'); })();
  app.addHook('onClose', async () => { order.push('assignment_hook'); await stopAssignment(); });
  app.addHook('onClose', async () => { order.push('manual_hook'); await stopManual(); });
  const closeResources = createApiResourceCloser([stopAssignment, stopManual], async () => { order.push('pool'); });
  app.addHook('onClose', async () => { order.push('server_hook'); await closeResources(); });
  await app.ready(); const closed = app.close(); await flush();
  assert.deepEqual(order, ['server_hook', 'assignment_start', 'manual_start']);
  manual.release(); await flush(); assert.equal(order.includes('pool'), false); assignment.release(); await closed;
  assert.deepEqual(order, ['server_hook', 'assignment_start', 'manual_start', 'manual_done', 'assignment_done', 'pool', 'manual_hook', 'assignment_hook']);
  await closeResources(); assert.equal(order.filter(value => value === 'pool').length, 1);
});
test('consumer failures still close the pool and disclose only a fixed error', async () => {
  const calls: string[] = [], close = createApiResourceCloser([
    async () => { calls.push('first'); throw new Error('private-driver-detail'); },
    async () => { calls.push('second'); },
  ], async () => { calls.push('pool'); });
  await assert.rejects(close(), { message: 'API_SHUTDOWN_FAILED' }); assert.deepEqual(calls, ['first', 'second', 'pool']);
  await assert.rejects(close(), { message: 'API_SHUTDOWN_FAILED' }); assert.equal(calls.filter(value => value === 'pool').length, 1);
});
test('stalled consumers and pool are bounded inside the process hard limit', async t => {
  const native = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => native(fn, ms === apiDrainTimeoutMs || ms === apiPoolCloseTimeoutMs ? 15 : ms, ...args));
  let poolCalls = 0; const never = () => new Promise<void>(() => {});
  const close = createApiResourceCloser([never], () => { poolCalls++; return never(); });
  await assert.rejects(close(), { message: 'API_SHUTDOWN_FAILED' }); assert.equal(poolCalls, 1);
  assert.ok(apiDrainTimeoutMs + apiPoolCloseTimeoutMs < apiShutdownHardLimitMs);
});
