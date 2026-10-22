import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@alms/ssu-api';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../src/errors.js';
import { manualVideoObservationFailureKind, projectManualVideoObservationFailure, rememberManualVideoObservationFailure } from '../src/manual-video-observation-diagnostics.js';
import { logManualObservationFailure } from '../src/manual-transport-trace.js';
import { ManualVideoService } from '../src/manual-video-service.js';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';

const installed = sdk as unknown as { inspectSchoolVideoObservationFailure?: (error: unknown) => unknown };
const traceId = 'a1234567-1234-4567-89ab-123456789abc';

test('diagnostic projection keeps only fixed kinds and never copies error text or timing', () => {
  assert.equal(projectManualVideoObservationFailure({ kind: 'pair_progress', positionSeconds: 100, token: 'private' }), 'pair_progress');
  for (const value of [null, undefined, 'pair_progress', {}, { kind: 'private-token' }, { kind: [] }, { kind: true }])
    assert.equal(projectManualVideoObservationFailure(value), null);
  assert.equal(manualVideoObservationFailureKind({ kind: 'pair_progress' }), null);
});

test('SDK fixed rejection survives service normalization without changing the public error or making a school report', async () => {
  const f = await fixture(); let releases = 0;
  const service = new ManualVideoService({ acquire: async () => true, renew: async () => true, release: async () => { releases++; } }, f.school);
  try {
    const start = await service.start(context, noop, signal());
    await assert.rejects(service.observe(context, start.playbackId, { nonce: start.nonce, sequence: 1,
      observation: { ...observation, positionSeconds: 1 } }, noop, signal()), error => {
      assert.ok(error instanceof AppError); assert.equal(error.code, 'PLAYBACK_OBSERVATION_INVALID');
      assert.equal(manualVideoObservationFailureKind(error), installed.inspectSchoolVideoObservationFailure ? 'initial_position' : null);
      assert.doesNotMatch(JSON.stringify(error), /90000001|synthetic-video|positionSeconds|capturedAtMs/);
      return true;
    });
    assert.equal(releases, 1); assert.equal(f.counts().reports, 0);
  } finally { await service.close(); }
});

test('validation logging requires an actual SDK diagnostic and a fresh valid trace shape', async () => {
  const f = await fixture(), driver = await f.prepare(), exposed = new AppError(409, 'PLAYBACK_OBSERVATION_INVALID', 'fixed');
  try {
    try { driver.observe({ ...observation, positionSeconds: 1 }); assert.fail('expected a fixed SDK rejection'); }
    catch (error) { rememberManualVideoObservationFailure(exposed, error); }
    const rows: unknown[] = [];
    const request = { headers: { 'x-alms-trace-id': traceId, cookie: 'private-cookie' }, body: { nonce: 'private-nonce', positionSeconds: 100 },
      log: { info: (value: unknown) => rows.push(value) } } as unknown as FastifyRequest;
    logManualObservationFailure(request, exposed);
    assert.deepEqual(rows, installed.inspectSchoolVideoObservationFailure
      ? [{ event: 'manual_observation_rejected', traceId, kind: 'initial_position' }] : []);
    assert.doesNotMatch(JSON.stringify(rows), /private|nonce|positionSeconds|capturedAtMs|cookie/);
    const count = rows.length; request.headers['x-alms-trace-id'] = traceId.toUpperCase(); logManualObservationFailure(request, exposed);
    request.headers['x-alms-trace-id'] = traceId; logManualObservationFailure(request, { kind: 'pair_progress' });
    assert.equal(rows.length, count);
    request.log.info = (() => { throw new Error('logger unavailable'); }) as typeof request.log.info;
    assert.doesNotThrow(() => logManualObservationFailure(request, exposed));
    assert.equal(f.counts().reports, 0);
  } finally { driver.close(); }
});
