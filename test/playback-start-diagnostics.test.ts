import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolError, SchoolVideoPlaybackStartError } from '@alms/ssu-api';
import { AppError } from '../src/errors.js';
import { playbackStartFailureDiagnostic, rememberPlaybackStartDiagnostic, copyPlaybackStartDiagnostic, takePlaybackStartDiagnostic } from '../src/playback-start-diagnostics.js';

test('start SDK stages and possible writes stay fixed without original exception fields', () => {
  const source = new SchoolVideoPlaybackStartError('authentication_required', 'refresh', true);
  Object.assign(source, { body: 'private-body', url: 'private-url', token: 'private-token', cause: new Error('private-stack') });
  const result = {};
  rememberPlaybackStartDiagnostic(result, playbackStartFailureDiagnostic(source, 'validation', false));
  assert.deepEqual(takePlaybackStartDiagnostic(result), { stage: 'refresh', code: 'authentication_required', mayHaveWritten: true });
  assert.deepEqual(result, {}); assert.equal(takePlaybackStartDiagnostic(result), null);
});
test('untrusted errors and altered SDK values cannot supply arbitrary diagnostic data', () => {
  assert.deepEqual(playbackStartFailureDiagnostic({ stage: 'transmission', code: 'private-code', mayHaveWritten: true, responseFailure: 'ack_result_rejected' }),
    { stage: 'unknown', code: 'unknown', mayHaveWritten: null });
  const error = new SchoolVideoPlaybackStartError('unsupported', 'validation', false);
  Object.assign(error, { stage: 'private-stage', code: 'private-code', mayHaveWritten: 'private-value' });
  assert.deepEqual(playbackStartFailureDiagnostic(error), { stage: 'unknown', code: 'unknown', mayHaveWritten: null });
});
test('diagnostic transfer is private and routes can consume a cached result only once', () => {
  const source = {}, exposed = new AppError(503, 'PLAYBACK_START_UNAVAILABLE', 'fixed');
  const facts = { stage: 'transmission' as const, code: 'unexpected_response' as const, mayHaveWritten: true,
    responseFailure: 'ack_schema' as const, body: 'private-body' };
  rememberPlaybackStartDiagnostic(source, facts); copyPlaybackStartDiagnostic(exposed, source);
  Object.assign(facts, { responseFailure: 'private-response', code: 'private-code' });
  assert.deepEqual(takePlaybackStartDiagnostic(exposed), { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_schema' });
  assert.equal(takePlaybackStartDiagnostic(exposed), null);
  assert.doesNotMatch(JSON.stringify(exposed), /stage|mayHaveWritten|responseFailure|private/);
});
test('malformed attachments and absent private records never expose supplied payloads', () => {
  const target = { responseFailure: 'ack_result_rejected', body: 'private-body' };
  assert.equal(takePlaybackStartDiagnostic(target), null);
  rememberPlaybackStartDiagnostic(target, { stage: 'private-stage', code: 'private-code', mayHaveWritten: 'private-write', responseFailure: 'private-response',
    userId: 'private-owner' } as any);
  assert.deepEqual(takePlaybackStartDiagnostic(target), { stage: 'unknown', code: 'unknown', mayHaveWritten: null });
  const hostile = new SchoolError('unsupported'); Object.defineProperty(hostile, 'code', { get: () => { throw new Error('private'); } });
  assert.deepEqual(playbackStartFailureDiagnostic(hostile), { stage: 'unknown', code: 'unknown', mayHaveWritten: null });
  assert.doesNotThrow(() => rememberPlaybackStartDiagnostic({}, null as any));
});
