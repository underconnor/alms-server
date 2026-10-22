import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';
import { takePlaybackStartDiagnostic } from '../src/playback-start-diagnostics.js';
import { AppError } from '../src/errors.js';
const paused = { ...observation, paused: true };

test('explicit start accepts result true with a non-null legacy error field without granting learning credit', async () => {
  const f = await fixture({ allowPlaybackStart: true }); f.setProgress(45);
  f.setReportResponse(callback => new Response(callback + '({"result":true,"error_code":"synthetic-legacy-field"});',
    { headers: { 'content-type': 'text/javascript' } }));
  const driver = await f.sessions.prepare(context, noop, signal());
  try {
    const result = await driver.confirmStart!(paused, noop, signal());
    assert.equal(result.transport, 'acknowledged');
    assert.equal(result.school.progressPercent, 7.5);
    assert.equal(result.school.recognized, null);
    assert.equal(takePlaybackStartDiagnostic(result), null);
    assert.equal(f.counts().starts, 1); assert.equal(f.counts().reports, 0);
    await assert.rejects(driver.confirmStart!(paused, noop, signal()));
    assert.equal(f.counts().starts, 1);
  } finally { driver.close(); }
});

test('explicit school start uses fresh server baseline once and never records extra learned time', async () => {
  const f = await fixture({allowPlaybackStart: true}); f.setProgress(45);
  const driver = await f.sessions.prepare(context, noop, signal());
  assert.equal(f.counts().starts, 0); f.setProgress(60);
  const result = await driver.confirmStart!({...paused, positionSeconds: 40}, noop, signal());
  assert.equal(result.transport, 'acknowledged'); assert.equal(result.school.progressPercent, 10);
  assert.equal(result.school.recognized, null); assert.equal(f.counts().starts, 1);
  assert.equal(takePlaybackStartDiagnostic(result), null);
  assert.equal(f.counts().reports, 0); assert.equal(f.counts().invalidated, 1);
  await assert.rejects(driver.confirmStart!(paused, noop, signal())); assert.equal(f.counts().starts, 1); driver.close();
});
test('refused start retains a fresh school observation without retrying the write', async () => {
  const f = await fixture({allowPlaybackStart: true}); f.setAck(false);
  const driver = await f.sessions.prepare(context, noop, signal());
  const result = await driver.confirmStart!(paused, noop, signal());
  assert.equal(result.transport, 'unknown'); assert.equal(result.school.progressPercent, 0);
  assert.deepEqual(takePlaybackStartDiagnostic(result), { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().invalidated, 1); driver.close();
});

test('actual SDK swallowed start schema, network and authentication failures remain classified without retry or recognition', async () => {
  const cases = [
    { response: (callback: string) => new Response(callback + '({"result":"true","error_code":null});', { headers: { 'content-type': 'text/javascript' } }), code: 'unexpected_response', responseFailure: 'ack_schema' },
    { response: () => { throw new Error('private-network-url-token'); }, code: 'upstream_unavailable' },
    ...[401, 403].map(status => ({ response: () => new Response('private-auth-body', { status }), code: 'authentication_required' })),
    { response: () => new Response('private-error-body', { status: 500 }), code: 'upstream_unavailable' },
  ];
  for (const example of cases) {
    const f = await fixture({ allowPlaybackStart: true }); f.setReportResponse(example.response);
    const driver = await f.sessions.prepare(context, noop, signal());
    try {
      const result = await driver.confirmStart!(paused, noop, signal());
      assert.equal(result.transport, 'unknown'); assert.equal(result.school.progressPercent, 0); assert.equal(result.school.recognized, null);
      const diagnostic = takePlaybackStartDiagnostic(result);
      assert.deepEqual(diagnostic, { stage: 'transmission', code: example.code, mayHaveWritten: true,
        ...('responseFailure' in example ? { responseFailure: example.responseFailure } : {}) });
      assert.doesNotMatch(JSON.stringify(diagnostic), /private|body|url|token/);
      assert.doesNotMatch(JSON.stringify(result), /stage|code|mayHaveWritten|responseFailure/);
      await assert.rejects(driver.confirmStart!(paused, noop, signal()));
      assert.equal(f.counts().starts, 1); assert.equal(f.counts().reports, 0); assert.equal(f.counts().invalidated, 1);
    } finally { driver.close(); }
  }
});

test('pretransport school authority failure and post-ACK jar failure preserve their original errors and write facts', async () => {
  for (const mode of ['identity', 'cas'] as const) {
    const f = await fixture({ allowPlaybackStart: true }), driver = await f.sessions.prepare(context, noop, signal());
    if (mode === 'identity') f.setProfile(false); else f.setCas(false);
    try {
      await assert.rejects(driver.confirmStart!(paused, noop, signal()), error => {
        assert.deepEqual(takePlaybackStartDiagnostic(error), mode === 'identity'
          ? { stage: 'validation', code: 'identity_mismatch', mayHaveWritten: false }
          : { stage: 'refresh', code: 'SCHOOL_SESSION_CHANGED', mayHaveWritten: true });
        return (error as { code: string }).code === (mode === 'identity' ? 'identity_mismatch' : 'SCHOOL_SESSION_CHANGED');
      });
      assert.equal(f.counts().starts, mode === 'identity' ? 0 : 1); assert.equal(f.counts().reports, 0);
    } finally { driver.close(); }
  }
});

test('observed transport rejection survives a later fresh-read or cache-invalidation failure without replacing the original error', async () => {
  for (const mode of ['refresh', 'invalidation'] as const) {
    const f = await fixture({ allowPlaybackStart: true }), driver = await f.sessions.prepare(context, noop, signal()); f.setAck(false);
    const invalidationError = new AppError(503, 'PLAYBACK_START_UNAVAILABLE', 'private-invalidation-error');
    if (mode === 'refresh') f.onReturn(async () => { if (f.counts().starts > 0) f.setDetails({ published: false }); });
    else f.setInvalidationError(invalidationError);
    try {
      await assert.rejects(driver.confirmStart!(paused, noop, signal()), error => {
        assert.deepEqual(takePlaybackStartDiagnostic(error), { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
        if (mode === 'invalidation') assert.equal(error, invalidationError);
        else assert.equal((error as { code: string }).code, 'unsupported');
        return true;
      });
      assert.equal(f.counts().starts, 1); assert.equal(f.counts().reports, 0); assert.equal(f.counts().invalidated, 1);
    } finally { driver.close(); }
  }
});
test('native playing, seek, ended, rate and ahead-of-baseline observations cannot start school progress', async () => {
  for (const changed of [{paused:false}, {seeking:true}, {ended:true}, {playbackRate:2}, {positionSeconds:10}, {visible:false}]) {
    const f = await fixture({allowPlaybackStart: true}), driver = await f.sessions.prepare(context, noop, signal());
    await assert.rejects(driver.confirmStart!({...paused,...changed}, noop, signal()));
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().reports, 0); driver.close();
  }
});
test('fresh identity, enrollment, target and generation remain mandatory for explicit school start', async () => {
  for (const mode of ['identity','enrollment','target','generation','closed']) {
    const f = await fixture({allowPlaybackStart: true}), driver = await f.sessions.prepare(context, noop, signal());
    if (mode==='identity') f.setProfile(false);
    if (mode==='enrollment') f.setOwned(false);
    if (mode==='target') f.setType('movie');
    if (mode==='generation') f.reset();
    if (mode==='closed') driver.close();
    await assert.rejects(driver.confirmStart!(paused, noop, signal()));
    assert.equal(f.counts().starts, 0); driver.close();
  }
});
test('lost jar CAS after a start remains uncertain and still invalidates exact JSON', async () => {
  const f = await fixture({allowPlaybackStart: true}), driver = await f.sessions.prepare(context, noop, signal());
  f.setCas(false);
  await assert.rejects(driver.confirmStart!(paused, noop, signal()), {code:'SCHOOL_SESSION_CHANGED'});
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().invalidated, 1); driver.close();
});
