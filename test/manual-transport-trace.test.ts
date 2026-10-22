import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logManualReportResult, manualTransportTrace } from '../src/manual-transport-trace.js';

const traceId = 'a1234567-1234-4567-89ab-123456789abc';
function fixture(header: unknown = traceId) {
  const rows: Record<string, unknown>[] = [];
  const raw = Object.assign(new EventEmitter(), { writableFinished: false });
  const request = { headers: { 'x-alms-trace-id': header, cookie: 'secret-cookie' },
    body: { nonce: 'secret-nonce' }, url: '/private-target', log: { info: (value: Record<string, unknown>) => rows.push(value) } } as unknown as FastifyRequest;
  const reply = { raw, statusCode: 200 } as unknown as FastifyReply;
  return { rows, raw, request, reply, hooks: manualTransportTrace('observation') };
}
test('manual trace links receipt and completion without request content', async () => {
  const f = fixture(); await f.hooks.onRequest(f.request, f.reply);
  f.raw.writableFinished = true; f.raw.emit('close');
  await f.hooks.onResponse(f.request, f.reply);
  assert.deepEqual(f.rows.map(row => [row.traceId, row.stage, row.statusCode]), [[traceId, 'received', null], [traceId, 'completed', 200]]);
  for (const row of f.rows) assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'event', 'role', 'stage', 'statusCode', 'traceId']);
  assert.doesNotMatch(JSON.stringify(f.rows), /secret|private-target|nonce|cookie/);
  assert.equal(f.raw.listenerCount('close'), 0);
});
test('response disconnect before finish is distinct from a completed response', async () => {
  const f = fixture(); await f.hooks.onRequest(f.request, f.reply); f.raw.emit('close');
  await f.hooks.onResponse(f.request, f.reply);
  assert.deepEqual(f.rows.map(row => row.stage), ['received', 'closed_before_finish']);
  assert.equal(f.rows[1]!.statusCode, null);
});
test('malformed, repeated, absent or non-v4 correlation values are ignored', async () => {
  for (const value of [undefined, [traceId, traceId], traceId + ', ' + traceId, 'school-secret', traceId.toUpperCase(), traceId.replace('-4567-', '-1567-'), traceId + '\n']) {
    const f = fixture(value); if (value === undefined) delete f.request.headers['x-alms-trace-id'];
    await f.hooks.onRequest(f.request, f.reply); await f.hooks.onResponse(f.request, f.reply);
    assert.deepEqual(f.rows, []); assert.equal(f.raw.listenerCount('close'), 0);
  }
});
test('diagnostic logger failures do not affect request completion', async () => {
  const f = fixture(); f.request.log.info = (() => { throw new Error('unavailable log'); }) as typeof f.request.log.info;
  await f.hooks.onRequest(f.request, f.reply); await f.hooks.onResponse(f.request, f.reply);
  assert.equal(f.raw.listenerCount('close'), 0);
});
test('validated report result keeps event and ACK separate from transport completion', () => {
  const f = fixture();
  logManualReportResult(f.request, 'update', { report: 'acknowledged', state: 'ready' });
  logManualReportResult(f.request, 'ended', { report: 'unknown', state: 'closed' });
  assert.deepEqual(f.rows, [
    { event: 'manual_report_result', traceId, reportEvent: 'update', report: 'acknowledged', state: 'ready' },
    { event: 'manual_report_result', traceId, reportEvent: 'ended', report: 'unknown', state: 'closed' },
  ]);
  delete f.request.headers['x-alms-trace-id'];
  logManualReportResult(f.request, 'playing', { report: 'acknowledged', state: 'ready' });
  assert.equal(f.rows.length, 2);
  f.request.headers['x-alms-trace-id'] = traceId;
  f.request.log.info = (() => { throw new Error('log failed'); }) as typeof f.request.log.info;
  assert.doesNotThrow(() => logManualReportResult(f.request, 'ended', { report: 'acknowledged', state: 'closed' }));
});
