import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolHttpClient, LearningxClient, SchoolError } from '@alms/ssu-api';
import { AppError } from '../src/errors.js';
import { rememberVideoReportDiagnostic, videoReportDiagnostic, workerVideoReportDiagnostic } from '../src/video-report-diagnostics.js';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';

test('actual SDK retains the strict ordinary transport ACK when its subsequent fresh school read fails', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  try {
    driver.observe(observation);
    f.onReturn(async () => {
      if (f.counts().reports === 1 && f.paths.at(-1) === '/api/v1/users/self/profile')
        throw new Error('private-refresh-url-token-body');
    });
    await assert.rejects(driver.report('playing', noop, signal()), error => {
      const normalized = new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'fixed'); rememberVideoReportDiagnostic(normalized, error);
      const facts = workerVideoReportDiagnostic(normalized, 'playing');
      assert.equal(facts.stage, 'refresh'); assert.equal(facts.code, 'upstream_unavailable'); assert.equal(facts.mayHaveWritten, true);
      assert.deepEqual(facts.transmission, { outcome: 'acknowledged', code: 'none' });
      assert.deepEqual(facts.reportFailure, { phase: 'fresh_read', reportSignalAborted: false, lifetimeAborted: false });
      assert.equal(facts.outcome, undefined);
      assert.doesNotMatch(JSON.stringify(facts), /private|https|jQuery|90000001|body|token/);
      assert.doesNotMatch(JSON.stringify(normalized), /transmission|refresh/);
      return true;
    });
    assert.equal(f.counts().reports, 1);
    await assert.rejects(driver.report('playing', noop, signal()));
    assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});

test('actual SDK retains rejection and parser classifications when the following fresh school read also fails', async () => {
  for (const example of [
    { response: (callback: string) => new Response(callback + '({"result":false,"error_code":"private-rejection"});',
      { headers: { 'content-type': 'text/javascript' } }), kind: 'ack_result_rejected' },
    { response: () => new Response('private-html-response', { headers: { 'content-type': 'text/html' } }), kind: 'content_type' },
  ]) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
    try {
      driver.observe(observation); f.setReportResponse(example.response);
      f.onReturn(async () => {
        if (f.counts().reports === 1 && f.paths.at(-1) === '/api/v1/users/self/profile')
          throw new Error('private-refresh-url-token');
      });
      await assert.rejects(driver.report('playing', noop, signal()), error => {
        const facts = videoReportDiagnostic(error);
        assert.equal(facts.stage, 'refresh'); assert.equal(facts.code, 'upstream_unavailable'); assert.equal(facts.mayHaveWritten, true);
        assert.deepEqual(facts.transmission, { outcome: 'failed', code: 'unexpected_response', responseFailure: example.kind });
        assert.deepEqual(facts.reportFailure, { phase: 'fresh_read', reportSignalAborted: false, lifetimeAborted: false });
        assert.equal(facts.outcome, undefined);
        assert.doesNotMatch(JSON.stringify(facts), /private|https|jQuery|90000001|body|token/);
        return true;
      });
      assert.equal(f.counts().reports, 1);
      await assert.rejects(driver.report('playing', noop, signal()));
      assert.equal(f.counts().reports, 1);
    } finally { driver.close(); }
  }
});

test('a successful report keeps the HTTP result unchanged and a later jar failure retains its received ACK', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  try {
    driver.observe(observation); f.setCas(false);
    await assert.rejects(driver.report('playing', noop, signal()), error => {
      const facts = videoReportDiagnostic(error);
      assert.equal(facts.stage, 'post_report'); assert.equal(facts.code, 'SCHOOL_SESSION_CHANGED');
      assert.deepEqual(facts.transmission, { outcome: 'acknowledged', code: 'none' });
      assert.deepEqual(facts.reportFailure, { phase: 'session_persist', reportSignalAborted: false, lifetimeAborted: false });
      return true;
    });
    assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
  const g = await fixture(), other = await g.sessions.prepare(context, noop, signal());
  try {
    other.observe(observation);
    const result = await other.report('playing', noop, signal());
    assert.deepEqual(Object.keys(result).sort(), ['school', 'state', 'transport']);
    assert.equal(result.transport, 'acknowledged'); assert.equal(result.state, 'ready'); assert.equal(result.school.recognized, null);
    assert.deepEqual(videoReportDiagnostic(result).transmission, { outcome: 'acknowledged', code: 'none' });
    assert.doesNotMatch(JSON.stringify(result), /transmission|responseFailure|runtimeFirstFailure/);
    assert.equal(g.counts().reports, 1);
  } finally { other.close(); }
});

test('a malformed transport stub never invents a strict ACK fact or changes the SDK unknown result', async t => {
  for (const response of [{ acknowledged: false }, { acknowledged: 'true' }, null]) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
    const mock = t.mock.method(SchoolHttpClient.prototype, 'forwardVideoReport', async () => response as any);
    try {
      driver.observe(observation);
      const result = await driver.report('playing', noop, signal());
      assert.equal(result.transport, 'unknown'); assert.equal(result.state, 'closed');
      assert.deepEqual(videoReportDiagnostic(result).transmission, { outcome: 'failed', code: 'unexpected_response' });
      assert.equal(mock.mock.callCount(), 1);
      await assert.rejects(driver.report('playing', noop, signal())); assert.equal(mock.mock.callCount(), 1);
    } finally { mock.mock.restore(); driver.close(); }
  }
});

test('cache invalidation failure keeps the earlier strict ACK or rejection without replacing the thrown error', async () => {
  for (const acknowledged of [true, false]) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
    const invalidationError = new AppError(503, 'VIDEO_REPORT_UNAVAILABLE', 'private-invalidation-message');
    try {
      driver.observe(observation); f.setAck(acknowledged); f.setInvalidationError(invalidationError);
      await assert.rejects(driver.report('playing', noop, signal()), error => {
        assert.equal(error, invalidationError);
        const facts = videoReportDiagnostic(error);
        assert.equal(facts.stage, 'cache_invalidation'); assert.equal(facts.mayHaveWritten, true);
        assert.deepEqual(facts.transmission, acknowledged ? { outcome: 'acknowledged', code: 'none' }
          : { outcome: 'failed', code: 'unexpected_response', responseFailure: 'ack_result_rejected' });
        assert.deepEqual(facts.reportFailure, { phase: 'cache_invalidation', reportSignalAborted: false, lifetimeAborted: false });
        assert.doesNotMatch(JSON.stringify(facts), /private|message|https|token/);
        return true;
      });
      assert.equal(f.counts().reports, 1); assert.equal(f.counts().invalidated, 1);
    } finally { driver.close(); }
  }
});

test('actual SDK distinguishes its post-transport and post-refresh guards without reclassifying a received ACK', async t => {
  for (const phase of ['post_transport_guard', 'post_refresh_guard'] as const) {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
    let armed = false, failed = false;
    const originalTransport = SchoolHttpClient.prototype.forwardVideoReport;
    const originalRead = LearningxClient.prototype.moduleLearningStatus;
    const mock = phase === 'post_transport_guard'
      ? t.mock.method(SchoolHttpClient.prototype, 'forwardVideoReport', async function (this: SchoolHttpClient, ...args) {
        const result = await originalTransport.apply(this, args); armed = true; return result;
      })
      : t.mock.method(LearningxClient.prototype, 'moduleLearningStatus', async function (this: LearningxClient, ...args) {
        const result = await originalRead.apply(this, args); armed = true; return result;
      });
    try {
      driver.observe(observation);
      await assert.rejects(driver.report('playing', async () => {
        if (armed && !failed) { failed = true; throw new SchoolError('upstream_unavailable'); }
      }, signal()), error => {
        const facts = videoReportDiagnostic(error);
        assert.equal(facts.stage, 'refresh'); assert.equal(facts.code, 'upstream_unavailable'); assert.equal(facts.mayHaveWritten, true);
        assert.deepEqual(facts.transmission, { outcome: 'acknowledged', code: 'none' });
        assert.deepEqual(facts.reportFailure, { phase, reportSignalAborted: false, lifetimeAborted: false });
        return true;
      });
      assert.equal(f.counts().reports, 1); assert.equal(failed, true);
      await assert.rejects(driver.report('playing', noop, signal())); assert.equal(f.counts().reports, 1);
    } finally { mock.mock.restore(); driver.close(); }
  }
});

test('report cancellation is captured before outer cleanup rather than inferred from the SDK self-close', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()), cancelled = new AbortController();
  try {
    driver.observe(observation);
    f.onReturn(async () => {
      if (f.counts().reports === 1 && f.paths.at(-1) === '/api/v1/users/self/profile') cancelled.abort();
    });
    await assert.rejects(driver.report('playing', noop, cancelled.signal), error => {
      const facts = videoReportDiagnostic(error);
      assert.deepEqual(facts.transmission, { outcome: 'acknowledged', code: 'none' });
      assert.deepEqual(facts.reportFailure, { phase: 'fresh_read', reportSignalAborted: true, lifetimeAborted: false });
      assert.equal(Object.isFrozen(facts.reportFailure), true);
      return true;
    });
    assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});
