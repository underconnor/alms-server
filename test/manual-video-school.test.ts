import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolHttpClient } from '@alms/ssu-api';
import { encryptSchoolSession } from '../src/crypto.js';
import { createManualVideoSchool } from '../src/manual-video-school.js';
import type { PreparedManualVideo } from '../src/manual-video-types.js';

const noop = async () => {}, signal = () => AbortSignal.timeout(5_000);
const context = { owner: 'synthetic-owner', sessionHash: 'a'.repeat(64), courseId: '10', moduleItemId: '20' };
const observation = { positionSeconds: 0, durationSeconds: 600, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
async function fixture() {
  const key = randomBytes(32), seed = new SchoolHttpClient();
  await seed.jar.setCookie('xn_api_token=synthetic-learningx; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await seed.jar.setCookie('_canvas_session=synthetic-canvas; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const jar = await seed.jar.serialize(); let generation = randomUUID(), encrypted = '', released = 0, rawType = 'mp4', ack = true;
  const reset = () => { generation = randomUUID(); encrypted = encryptSchoolSession({ version: 1, generation, identity: { studentId: '90000001' }, jar }, key, context.owner, 'ssu'); }; reset();
  let owned = true, profile = true, details: Record<string, unknown> = {}, requests = 0, reports = 0, beforeReturn = async () => {}, cas = true, progress = 0;
  const paths: string[] = [];
  const store = { getEncryptedSchoolSession: async () => encrypted,
    replaceEncryptedSchoolSession: async (_owner: string, _provider: string, before: string, after: string) => { if (!cas || encrypted !== before) return false; encrypted = after; return true; } };
  const school = createManualVideoSchool(store, key, async () => { released++; }, async (input, init) => {
    const url = new URL(String(input)); requests++; paths.push(url.pathname); assert.equal(init?.method, 'GET');
    const resource = { content_type: rawType, content_id: 'synthetic-video', duration: 600 };
    let value: unknown, mime = 'application/json', body: string | undefined;
    if (url.pathname === '/mypage') { body = '<iframe id="fulliframe" src="https://canvas.ssu.ac.kr/learningx/dashboard"></iframe>'; mime = 'text/html'; }
    else if (url.pathname === '/learningx/dashboard') { body = '<div id="root" data-user_login="90000001" data-user_id="42" data-role="1" data-module_builder_tool_id="3" data-lecture_attendance_tool_id="4"></div>'; mime = 'text/html'; }
    else if (url.pathname === '/api/v1/users/self/profile') value = { id: profile ? 42 : 99, login_id: '90000001' };
    else if (url.pathname.endsWith('/terms')) value = { enrollment_terms: [{ id: 1, name: '합성 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) value = owned ? [{ id: 10, name: '합성 강좌', term_id: 1 }] : [];
    else if (url.pathname.endsWith('/modules')) value = [{ module_id: 7, module_items: [{ module_item_id: 20, content_type: 'attendance_item',
      content_data: { course_id: 10, item_id: 30, item_content_type: 'commons', item_content_data: resource } }] }];
    else if (url.pathname.endsWith('/attendance_items/30')) value = { course_id: 10, item_id: 30, title: '합성 영상', item_content_type: 'commons', published: true,
      opened: true, use_attendance: true, omit_progress: false, item_content_data: resource, attendance_data: { progress, last_at: 0, completed: false, attendance_status: 'none' },
      viewer_url: 'https://commons.ssu.ac.kr/em/synthetic-video?endat=' + progress + '&TargetUrl=' + encodeURIComponent('https://canvas.ssu.ac.kr/learningx/api/v1/courses/10/sections/17/components/30/progress?user_id=90000001&content_id=synthetic-video&content_type=' + rawType), ...details };
    else if (url.pathname.endsWith('/progress')) {
      reports++; assert.equal(url.searchParams.get('content_type'), rawType); assert.equal(url.searchParams.has('force_cancel'), false);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      if (ack) progress = Number(url.searchParams.get('cumulativeTime'));
      body = url.searchParams.get('callback') + `({"result":${ack},"error_code":null});`; mime = 'text/javascript';
    } else throw new Error('Unexpected synthetic request');
    await beforeReturn(); return new Response(body ?? JSON.stringify(value), { headers: { 'content-type': mime } });
  });
  return { school, store, reset, paths, counts: () => ({ requests, reports, invalidated: released }),
    setOwned: (v: boolean) => { owned = v; }, setProfile: (v: boolean) => { profile = v; }, setDetails: (v: Record<string, unknown>) => { details = v; },
    setType: (v: string) => { rawType = v; }, setAck: (v: boolean) => { ack = v; }, setCas: (v: boolean) => { cas = v; },
    setProgress: (value: number) => { progress = value; },
    onReturn: (fn: () => Promise<void>) => { beforeReturn = fn; }, prepare: () => school.prepare(context, noop, signal()) };
}
test('real SDK preparation reads native identity and owned launch without reports; observations perform no school I/O', async () => {
  const f = await fixture(), driver = await f.prepare(); try {
    assert.equal(f.counts().requests, 7); assert.equal(f.counts().reports, 0); assert.equal(driver.baseline, 0);
    await driver.validate(signal()); driver.observe(observation); assert.equal(f.counts().requests, 7);
    const result = await driver.report('playing', noop, signal());
    assert.equal(result.transport, 'acknowledged'); assert.equal(result.state, 'ready'); assert.equal(result.school.recognized, null);
    assert.equal(result.school.evidence?.resourceType, 'movie'); assert.equal(result.school.evidence?.completed, false);
    assert.deepEqual(f.counts(), { requests: 20, reports: 1, invalidated: 1 });
    assert.doesNotMatch(JSON.stringify(result), /90000001|synthetic-video|https|viewer|token|content_id/);
  } finally { driver.close(); }
});
test('missing ownership, native identity or explicit permission rejects before any report', async () => {
  for (const mode of ['ownership', 'identity', 'opened', 'attendance', 'omit']) {
    const f = await fixture(); if (mode === 'ownership') f.setOwned(false); if (mode === 'identity') f.setProfile(false);
    if (mode === 'opened') f.setDetails({ opened: false }); if (mode === 'attendance') f.setDetails({ use_attendance: null }); if (mode === 'omit') f.setDetails({ omit_progress: true });
    await assert.rejects(f.prepare()); assert.equal(f.counts().reports, 0);
  }
});
test('report rechecks original content type, ownership and permission; changed target is never reported', async () => {
  for (const mode of ['ownership', 'type', 'attendance', 'target']) {
    const f = await fixture(), driver = await f.prepare(); try {
      driver.observe(observation);
      if (mode === 'ownership') f.setOwned(false); if (mode === 'type') f.setType('movie');
      if (mode === 'attendance') f.setDetails({ use_attendance: false });
      if (mode === 'target') f.setDetails({ viewer_url: 'https://commons.ssu.ac.kr/em/synthetic-video?endat=0&TargetUrl=' + encodeURIComponent('https://canvas.ssu.ac.kr/learningx/api/v1/courses/10/sections/99/components/30/progress?user_id=90000001&content_id=synthetic-video&content_type=mp4') });
      await assert.rejects(driver.report('playing', noop, signal())); assert.equal(f.counts().reports, 0);
    } finally { driver.close(); }
  }
});
test('new login before or during reads and a lost jar CAS withhold stale preparation/results', async () => {
  const f = await fixture(), driver = await f.prepare(); driver.observe(observation); f.reset();
  await assert.rejects(driver.validate(signal()), { code: 'SCHOOL_SESSION_CHANGED' });
  await assert.rejects(driver.report('playing', noop, signal()), { code: 'SCHOOL_SESSION_CHANGED' }); assert.equal(f.counts().reports, 0); driver.close();
  const changed = await fixture(); changed.onReturn(async () => changed.reset()); await assert.rejects(changed.prepare(), { code: 'SCHOOL_SESSION_CHANGED' });
  assert.equal(changed.counts().requests, 1);
  const cas = await fixture(); cas.setCas(false); await assert.rejects(cas.prepare(), { code: 'SCHOOL_SESSION_CHANGED' }); assert.equal(cas.counts().reports, 0);
});
test('unknown acknowledgement reads fresh once, invalidates cached results and closes without retry', async () => {
  const f = await fixture(), driver = await f.prepare(); try {
    driver.observe(observation); f.setAck(false); const result = await driver.report('playing', noop, signal());
    assert.equal(result.transport, 'unknown'); assert.equal(result.state, 'closed'); assert.equal(result.school.recognized, null);
    assert.equal(f.counts().reports, 1); assert.equal(f.counts().invalidated, 1);
    await assert.rejects(driver.report('playing', noop, signal())); assert.equal(f.counts().reports, 1);
  } finally { driver.close(); }
});
test('a session change after transmission suppresses success while still invalidating old cached school state', async () => {
  const f = await fixture(), driver = await f.prepare(); try {
    driver.observe(observation); f.onReturn(async () => { if (f.counts().reports) f.reset(); });
    await assert.rejects(driver.report('playing', noop, signal())); assert.equal(f.counts().reports, 1); assert.equal(f.counts().invalidated, 1);
  } finally { driver.close(); }
});

test('external school progress changes stop before transmission rather than overwrite the newer observation', async () => {
  const f = await fixture(), driver = await f.prepare(); try {
    driver.observe(observation); f.setProgress(5);
    await assert.rejects(driver.report('playing', noop, signal()), { code: 'PLAYBACK_OBSERVATION_INVALID' });
    assert.equal(f.counts().reports, 0); assert.equal(f.counts().invalidated, 1);
  } finally { driver.close(); }
});
test('an acknowledged report updates the comparison baseline only from its fresh school response', async () => {
  const f = await fixture(), driver = await f.prepare(); try {
    driver.observe(observation); await driver.report('playing', noop, signal());
    driver.observe({ ...observation, positionSeconds: 0.2 }); const second = await driver.report('update', noop, signal());
    assert.equal(second.school.evidence?.progressSeconds, 0.2);
    driver.observe({ ...observation, positionSeconds: 0.3, paused: true });
    const last = await driver.report('unload', noop, signal()); assert.equal(last.state, 'closed');
    assert.equal(last.school.evidence?.progressSeconds, 0.3); assert.equal(last.school.recognized, null); assert.equal(f.counts().reports, 3);
  } finally { driver.close(); }
});
