import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningxClient, SchoolError } from '@alms/ssu-api';
import { videoReportDiagnostic } from '../src/video-report-diagnostics.js';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const profilePath = '/api/v1/users/self/profile';

test('a received post-ACK 5xx permits one fresh status operation without repeating the report or session transaction', async t => {
  for (const type of ['mp4', 'readystream', 'everlec']) await t.test(type, async () => {
    const f = await fixture(); f.setType(type);
    let persisted = 0, statusAttempts = 0, moduleReads = 0;
    const readSignals: Array<AbortSignal | undefined> = [], originalRead = LearningxClient.prototype.moduleLearningStatus;
    const mock = t.mock.method(LearningxClient.prototype, 'moduleLearningStatus', async function (this: LearningxClient, ...args) {
      readSignals.push(args[2]); return originalRead.apply(this, args);
    });
    const replace = f.store.replaceEncryptedSchoolSession;
    f.store.replaceEncryptedSchoolSession = async (...args) => { persisted++; return replace(...args); };
    const driver = await f.sessions.prepare(context, noop, signal());
    try {
      driver.observe(observation);
      f.setPostReportReadResponse(url => {
        if (url.pathname === profilePath) statusAttempts++;
        if (url.pathname.endsWith('/modules') && ++moduleReads === 1) return json({}, 503);
      });
      const result = await driver.report('playing', noop, signal());
      assert.equal(result.transport, 'acknowledged'); assert.equal(result.state, 'ready');
      assert.equal(result.school.recognized, null);
      assert.equal(statusAttempts, 2); assert.equal(moduleReads, 2);
      assert.equal(readSignals.length, 2); assert.equal(readSignals[0], readSignals[1]);
      assert.equal(f.counts().reports, 1); assert.equal(f.counts().starts, 0); assert.equal(persisted, 2);
      assert.deepEqual(videoReportDiagnostic(result).transmission, { outcome: 'acknowledged', code: 'none' });
    } finally { mock.mock.restore(); driver.close(); }
  });
});

test('a second 5xx closes the actual SDK controller and never sends a third status operation or another report', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); let statusAttempts = 0;
  try {
    driver.observe(observation);
    f.setPostReportReadResponse(url => {
      if (url.pathname === profilePath) { statusAttempts++; return json({}, 503); }
    });
    await assert.rejects(driver.report('playing', noop, signal()), error => {
      const facts = videoReportDiagnostic(error);
      assert.equal(facts.stage, 'refresh'); assert.equal(facts.code, 'upstream_unavailable'); assert.equal(facts.mayHaveWritten, true);
      assert.deepEqual(facts.transmission, { outcome: 'acknowledged', code: 'none' });
      assert.deepEqual(facts.reportFailure, { phase: 'fresh_read', reportSignalAborted: false, lifetimeAborted: false });
      return true;
    });
    assert.equal(statusAttempts, 2); assert.equal(f.counts().reports, 1);
    await assert.rejects(driver.report('playing', noop, signal()));
    assert.equal(statusAttempts, 2); assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});

test('authentication, nonretryable HTTP, rate limits, schema and generic fetch failures never authorize a second status operation', async t => {
  for (const kind of ['401', '404', '429', '429-backoff', 'backoff', 'schema', 'fetch'] as const) await t.test(kind, async () => {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); let statusAttempts = 0;
    try {
      driver.observe(observation);
      f.setPostReportReadResponse(url => {
        if (url.pathname !== profilePath) return;
        statusAttempts++;
        if (kind === 'fetch') throw new Error('synthetic-network-failure');
        if (kind === 'backoff') return json({}, 503, { 'retry-after': '60' });
        if (kind === '429-backoff') return json({}, 429, { 'retry-after': '60' });
        return kind === 'schema' ? json({ invalid: true }) : json({}, Number(kind));
      });
      await assert.rejects(driver.report('playing', noop, signal()));
      assert.equal(statusAttempts, 1); assert.equal(f.counts().reports, 1);
    } finally { driver.close(); }
  });
});

test('a rejected or malformed native ACK cannot authorize recovery from a status 503', async t => {
  for (const kind of ['rejected', 'malformed'] as const) await t.test(kind, async () => {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); let statusAttempts = 0;
    try {
      driver.observe(observation);
      if (kind === 'rejected') f.setAck(false);
      else f.setReportResponse(callback => new Response(callback + '({"result":true});', { headers: { 'content-type': 'text/javascript' } }));
      f.setPostReportReadResponse(url => {
        if (url.pathname === profilePath) { statusAttempts++; return json({}, 503); }
      });
      await assert.rejects(driver.report('playing', noop, signal()), error => {
        assert.equal(videoReportDiagnostic(error).transmission?.outcome, 'failed'); return true;
      });
      assert.equal(statusAttempts, 1); assert.equal(f.counts().reports, 1);
    } finally { driver.close(); }
  });
});

test('cancellation and generation changes during a received 503 stop before any extra school request', async t => {
  for (const kind of ['abort', 'generation'] as const) await t.test(kind, async () => {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()), cancelled = new AbortController();
    let statusAttempts = 0;
    try {
      driver.observe(observation);
      f.setPostReportReadResponse(url => {
        if (url.pathname !== profilePath) return;
        statusAttempts++; if (kind === 'abort') cancelled.abort(); else f.reset();
        return json({}, 503);
      });
      await assert.rejects(driver.report('playing', noop, cancelled.signal));
      assert.equal(statusAttempts, 1); assert.equal(f.counts().reports, 1);
    } finally { driver.close(); }
  });
});

test('a one-off authority guard failure cannot be normalized into a recoverable school response', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
  let armed = false, failed = false, statusAttempts = 0;
  try {
    driver.observe(observation);
    f.setPostReportReadResponse(url => {
      if (url.pathname === profilePath) { statusAttempts++; armed = true; return json({}, 503); }
    });
    await assert.rejects(driver.report('playing', async () => {
      if (armed && !failed) { failed = true; throw new SchoolError('upstream_unavailable', true); }
    }, signal()));
    assert.equal(failed, true); assert.equal(statusAttempts, 1); assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});

test('retry authority fences and later jar CAS failures are not retried', async t => {
  for (const kind of ['guard', 'cas'] as const) await t.test(kind, async () => {
    const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal());
    let statusAttempts = 0, afterResponse = false, checks = 0;
    try {
      driver.observe(observation);
      f.setPostReportReadResponse(url => {
        if (url.pathname !== profilePath) return;
        statusAttempts++;
        if (statusAttempts === 1) { afterResponse = true; return json({}, 503); }
      });
      if (kind === 'cas') f.setCas(false);
      await assert.rejects(driver.report('playing', async () => {
        // The first check is guardedFetch's post-response guard; the next is
        // the explicit recovery fence, outside the status-read catch.
        if (kind === 'guard' && afterResponse && ++checks === 2) throw new SchoolError('upstream_unavailable', true);
      }, signal()));
      assert.equal(statusAttempts, kind === 'guard' ? 1 : 2); assert.equal(f.counts().reports, 1);
    } finally { driver.close(); }
  });
});

test('a valid incomplete school result is returned immediately without polling for recognition', async () => {
  const f = await fixture(), driver = await f.sessions.prepare(context, noop, signal()); let statusAttempts = 0;
  try {
    driver.observe(observation);
    f.setPostReportReadResponse(url => { if (url.pathname === profilePath) statusAttempts++; });
    const result = await driver.report('playing', noop, signal());
    assert.equal(result.transport, 'acknowledged'); assert.equal(result.school.recognized, null);
    assert.equal(statusAttempts, 1); assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});
