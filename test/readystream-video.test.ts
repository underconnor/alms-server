import { createSchoolPlayback } from '../src/school-playback.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, context, noop, observation, signal } from './helpers/school-video-fixture.js';
import { readystreamXml } from './helpers/readystream-fixture.js';
import { createVideoStreamer, type PreparedVideoSource } from '../src/video-stream.js';

test('readystream verifies single-UPF media before manual binding and reuses proof for unchanged fresh launches', async () => {
  const f = await fixture(); f.setType('readystream');
  const driver = await f.sessions.prepare(context, noop, signal());
  try {
    assert.equal(f.counts().requests, 9); assert.equal(f.counts().reports, 0);
    const media = await driver.prepareMedia(noop, signal());
    assert.equal(media.resourceType, 'readystream'); assert.match(media.mediaUrl, /synthetic_video\(01\)-part_1.mp4$/);
    assert.equal(f.counts().requests, 9);
    const second = await f.sessions.prepare(context, noop, signal());
    assert.equal(f.paths.filter(path => path === '/em/synthetic-video').length, 1); second.close();
    driver.observe(observation);
    const result = await driver.report('playing', noop, signal());
    assert.equal(result.transport, 'acknowledged'); assert.equal(result.school.evidence?.resourceType, 'readystream');
    assert.equal(result.school.evidence?.schoolAttendanceStatus, 'none'); assert.equal(result.school.recognized, null);
    assert.equal(f.counts().reports, 1);
    assert.doesNotMatch(JSON.stringify(result), /https|contentId|viewer|90000001|synthetic-video/);
  } finally { driver.close(); }
});

test('readystream direct worker preparation rejects before metadata, lease admission or reporting', async () => {
  const f = await fixture({ workerOnly: true }); f.setType('readystream');
  await assert.rejects(f.sessions.prepare(context, noop, signal()), { code: 'unsupported' });
  assert.equal(f.paths.some(path => path.startsWith('/em/')), false); assert.equal(f.counts().reports, 0);
});

test('readystream unknown or legacy course mode, ambiguous media and source drift never open manual reports', async () => {
  for (const mode of ['legacy', 'unknown', 'slides', 'duration', 'foreign']) {
    const f = await fixture(); f.setType('readystream');
    if (mode === 'legacy') f.setPureCanvas(false);
    if (mode === 'unknown') f.setPureCanvas(null);
    if (mode === 'slides') f.setXml(readystreamXml().replace('</story>', '<slides/></story>'));
    if (mode === 'duration') f.setXml(readystreamXml('synthetic-video', 601));
    if (mode === 'foreign') f.setXml(readystreamXml('foreign-video'));
    await assert.rejects(f.sessions.prepare(context, noop, signal()), undefined, mode);
    assert.equal(f.counts().reports, 0);
  }
});

test('readystream changed baseline obtains a new proof; logout and changed native identity reject cache hits', async () => {
  const f = await fixture(); f.setType('readystream');
  (await f.sessions.prepare(context, noop, signal())).close(); f.setProgress(2);
  (await f.sessions.prepare(context, noop, signal())).close();
  assert.equal(f.paths.filter(path => path === '/em/synthetic-video').length, 2);
  f.setProfile(false); await assert.rejects(f.sessions.prepare(context, noop, signal()), { code: 'identity_mismatch' });
  assert.equal(f.paths.filter(path => path === '/em/synthetic-video').length, 2);
  f.setProfile(true); f.reset(); (await f.sessions.prepare(context, noop, signal())).close();
  assert.equal(f.paths.filter(path => path === '/em/synthetic-video').length, 3); assert.equal(f.counts().reports, 0);
});

test('explicit readystream school start binds the fresh proven launch and preserves native report type', async () => {
  const f = await fixture({ allowPlaybackStart: true }); f.setType('readystream');
  const driver = await f.sessions.prepare(context, noop, signal());
  try {
    const result = await driver.confirmStart!({ ...observation, paused: true }, noop, signal());
    assert.equal(result.transport, 'acknowledged'); assert.equal(result.school.evidence?.resourceType, 'readystream');
    assert.equal(f.counts().starts, 1); assert.equal(f.counts().reports, 0);
    assert.equal(f.paths.filter(path => path === '/em/synthetic-video').length, 1);
  } finally { driver.close(); }
});

const source = (url: string): PreparedVideoSource => ({ contentId: 'synthetic', mediaUrl: url, resourceType: 'readystream', validate: noop });
const url = 'https://ssu-toast.commonscdn.com/contents31/ssu1000001/synthetic/contents/media_files/issued_video(01).mp4';
test('readystream exact issued CDN tuple alone adds fixed Commons Referer for anonymous HEAD and Range', async () => {
  let calls = 0;
  const stream = createVideoStreamer(async (requested, init) => {
    calls++; assert.equal(requested, url); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
    assert.deepEqual(init?.headers, { Accept: 'video/mp4', 'Accept-Encoding': 'identity', Referer: 'https://commons.ssu.ac.kr/',
      ...(init?.method === 'GET' ? { Range: 'bytes=0-0' } : {}) });
    return new Response(init?.method === 'GET' ? 'x' : null, { status: init?.method === 'GET' ? 206 : 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '1', ...(init?.method === 'GET' ? { 'Content-Range': 'bytes 0-0/1' } : {}) } });
  });
  const head = await stream('owner', async () => source(url), { method: 'HEAD', signal: signal(), validate: noop }); assert.equal(head.status, 200);
  const range = await stream('owner', async () => source(url), { method: 'GET', range: 'bytes=0-0', signal: signal(), validate: noop });
  range.body?.destroy(); assert.equal(range.status, 206); assert.equal(calls, 2);
});
test('readystream byte transport rejects foreign hosts/content/layout, encoding, Unicode and missing source discriminator', async () => {
  let calls = 0; const stream = createVideoStreamer(async () => { calls++; throw new Error('must not fetch'); });
  const urls = [url.replace('ssu-toast.', 'foreign.'), url.replace('/synthetic/', '/other/'), url.replace('/ssu1000001/', '/ssu1000002/'),
    url.replace('/contents31/', '/contents29/'), url.replace('/media_files/', '/media_files/mobile/'), url.replace('(01)', '%2801%29'),
    url.replace('(01)', '（01）'), url.replace('issued_', '한글_'), url + '?a=1', url + '#x'];
  for (const value of urls) await assert.rejects(stream('owner', async () => source(value), { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  await assert.rejects(stream('owner', async () => ({ ...source(url), resourceType: undefined }), { method: 'HEAD', signal: signal(), validate: noop }), { code: 'VIDEO_UNAVAILABLE' });
  assert.equal(calls, 0);
});

test('server playback admission cannot create proof, worker runtime or lease for a readystream request', async () => {
  const f = await fixture({ workerOnly: true }); f.setType('readystream');
  let admission = 0, runtime = 0, lease = 0;
  const adapter = createSchoolPlayback({ school: f.sessions,
    leases: { acquire: async () => { lease++; return true; } } as any,
    validateClaim: noop, validateFinalClaim: noop,
    createAdmission: () => { admission++; return {}; }, createFinalProof: () => ({}),
    runtime: { createSource: () => { runtime++; return {}; }, play: async () => ({ended: true, browserClosed: true, processExited: true}), dispose: noop },
  });
  await assert.rejects(adapter.authorizePlayback({userId: context.owner}, {courseId: '10', lectureId: '20'}, {signal: signal(), validate: noop}), {code: 'unsupported'});
  assert.deepEqual({admission, runtime, lease, reports: f.counts().reports, starts: f.counts().starts}, {admission: 0, runtime: 0, lease: 0, reports: 0, starts: 0});
});
